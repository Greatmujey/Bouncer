// Offline only. These tests create local synthetic journals and send no payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FileJournal, openConfiguredFileJournal } from '../agent/procurement.mjs';
import { FILE_JOURNAL_FORMAT, MAX_ENCRYPTED_JOURNAL_FILE, MAX_ENCRYPTED_JOURNAL_PLAINTEXT,
  readFileJournalKeyFile } from '../agent/file-journal-crypto.mjs';
import { initializeFileJournalKey } from '../scripts/init-file-journal-key.mjs';

const contract = 'bouncer.testnet', owner = 'owner.testnet';
const secret = 'SYNTHETIC-REPLAYABLE-CLAIM-DO-NOT-LEAK';
const cli = fileURLToPath(new URL('../scripts/encrypt-file-journal.mjs', import.meta.url));
const crash = fileURLToPath(new URL('./fixtures/encrypt-file-journal-crash.mjs', import.meta.url));
const keyCli = fileURLToPath(new URL('../scripts/init-file-journal-key.mjs', import.meta.url));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-file-crypto-'));
  const file = path.join(dir, 'journal.json'), keyFile = path.join(dir, 'key');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return { dir, file, keyFile, key, cleanup() { key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function seedPlain(file) {
  const journal = new FileJournal(file, contract, owner);
  try {
    journal.put('pending', { fingerprint: 'pending-fingerprint', status: 'pending', tx_hash: 'original-hash',
      resource_authorization: { signature: secret }, extra: { task: 'private input' } });
    journal.put('completed', { fingerprint: 'completed-fingerprint', status: 'completed', tx_hash: 'completed-hash' });
    return journal.list();
  } finally { journal.close(); }
}
function open(f, key = f.key, options = {}) { return new FileJournal(f.file, contract, owner, { encryptionKey: key, ...options }); }
function runCli(f, args = ['--state', f.file, '--contract', contract, '--owner', owner]) {
  return spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: f.keyFile }, encoding: 'utf8', timeout: 10_000 });
}
function altered(value) { const b = Buffer.from(value, 'base64'); b[0] ^= 1; return b.toString('base64'); }

test('encrypted journals keep claims and hashes out of files and reopen with the original key', () => {
  const f = fixture();
  try {
    const supplied = Buffer.from(f.key);
    let journal = open(f, supplied);
    supplied.fill(0); // The journal keeps its own key until it is closed.
    journal.put('pending', { status: 'pending', fingerprint: 'fp', tx_hash: 'original-hash', resource_authorization: { signature: secret } });
    const first = fs.readFileSync(f.file, 'utf8'), envelope = JSON.parse(first);
    assert.equal(envelope.format, FILE_JOURNAL_FORMAT); assert.equal(envelope.cipher, 'aes-256-gcm');
    assert.doesNotMatch(first, /SYNTHETIC-REPLAYABLE|original-hash|resource_authorization/);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    journal.put('completed', { status: 'completed', fingerprint: 'done', tx_hash: 'completed-hash' });
    const second = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.notEqual(envelope.nonce, second.nonce); assert.notEqual(envelope.ciphertext, second.ciphertext);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['journal.json', 'journal.json.lock', 'key']);
    journal.close(); assert.throws(() => journal.put('x', { status: 'pending', fingerprint: 'x' }), /closed/);
    journal = open(f);
    assert.equal(journal.get('pending').tx_hash, 'original-hash');
    assert.equal(journal.get('pending').resource_authorization.signature, secret);
    assert.equal(journal.get('completed').tx_hash, 'completed-hash'); journal.close();
  } finally { f.cleanup(); }
});

test('missing or wrong key, wrong scope, and ciphertext/header tampering fail closed without overwriting', () => {
  const f = fixture();
  try {
    let journal = open(f); journal.put('pending', { status: 'pending', fingerprint: 'fp', tx_hash: 'original-hash', claim: secret }); journal.close();
    const original = fs.readFileSync(f.file, 'utf8'), parsed = JSON.parse(original);
    assert.throws(() => new FileJournal(f.file, contract, owner), /original key/);
    assert.throws(() => open(f, crypto.randomBytes(32)), /failed authentication/);
    assert.throws(() => new FileJournal(f.file, 'other.testnet', owner, { encryptionKey: f.key }), /failed authentication/);
    assert.throws(() => new FileJournal(f.file, contract, 'other.testnet', { encryptionKey: f.key }), /failed authentication/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    for (const mutate of [
      v => { v.nonce = altered(v.nonce); }, v => { v.ciphertext = altered(v.ciphertext); }, v => { v.tag = altered(v.tag); },
      v => { v.cipher = 'other'; }, v => { v.tag += '!'; }, v => { v.nonce = ''; }, v => { v.extra = 'x'; },
      v => { v.format = 'changed'; },
    ]) {
      const value = structuredClone(parsed); mutate(value);
      fs.writeFileSync(f.file, JSON.stringify(value)); const before = fs.readFileSync(f.file, 'utf8');
      assert.throws(() => open(f), /invalid|authentication|plaintext/);
      assert.equal(fs.readFileSync(f.file, 'utf8'), before);
      assert.equal(fs.existsSync(`${f.file}.lock`), false);
    }
    // Configured encryption refuses an unauthenticated plaintext downgrade.
    const substituted = JSON.stringify({ version: 1, contract_id: contract, owner_account_id: owner, entries: [] });
    fs.writeFileSync(f.file, substituted);
    assert.throws(() => open(f), /explicit in-place encryption/); assert.equal(fs.readFileSync(f.file, 'utf8'), substituted);
    fs.writeFileSync(f.file, original);
    journal = open(f); assert.equal(journal.get('pending').tx_hash, 'original-hash'); journal.close();
  } finally { f.cleanup(); }
});

test('encrypted journal paths reject symlinks, extra hardlinks, unsafe permissions and oversized files', () => {
  const f = fixture();
  try {
    const journal = open(f); journal.put('pending', { status: 'pending', fingerprint: 'fp' }); journal.close();
    const original = fs.readFileSync(f.file);
    fs.chmodSync(f.file, 0o644); assert.throws(() => open(f), /owner-only regular file/); fs.chmodSync(f.file, 0o600);
    const link = path.join(f.dir, 'link'); fs.linkSync(f.file, link); assert.throws(() => open(f), /owner-only regular file/); fs.unlinkSync(link);
    fs.renameSync(f.file, link); fs.symlinkSync(link, f.file);
    assert.throws(() => open(f), /ELOOP|symlink|symbolic/i);
    fs.unlinkSync(f.file); fs.renameSync(link, f.file);
    fs.truncateSync(f.file, MAX_ENCRYPTED_JOURNAL_FILE + 1); assert.throws(() => open(f), /size limit/);
    fs.writeFileSync(f.file, original);
    const ok = open(f); assert.equal(ok.get('pending').fingerprint, 'fp'); ok.close();
  } finally { f.cleanup(); }
});

test('key files must be private, regular, single-linked and exactly 32 bytes', () => {
  const f = fixture();
  try {
    assert.deepEqual(readFileJournalKeyFile(f.keyFile), f.key);
    fs.chmodSync(f.keyFile, 0o644); assert.throws(() => readFileJournalKeyFile(f.keyFile), /owner-only/); fs.chmodSync(f.keyFile, 0o600);
    const link = path.join(f.dir, 'link'); fs.symlinkSync(f.keyFile, link);
    assert.throws(() => readFileJournalKeyFile(link), /owner-only/); fs.unlinkSync(link);
    fs.linkSync(f.keyFile, link); assert.throws(() => readFileJournalKeyFile(f.keyFile), /owner-only/); fs.unlinkSync(link);
    fs.writeFileSync(f.keyFile, 'too short'); assert.throws(() => readFileJournalKeyFile(f.keyFile), /32 random bytes/);
    assert.throws(() => readFileJournalKeyFile(f.dir), /owner-only/);
    assert.throws(() => readFileJournalKeyFile(''), /required/);
    assert.throws(() => open(f, Buffer.alloc(31)), /32-byte key|invalid file journal encryption/);
  } finally { f.cleanup(); }
});

test('key initializer creates an owner-only random key and refuses to overwrite or use an unsafe directory', () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(f.keyFile);
    let result = spawnSync(process.execPath, [keyCli, '--key-file', f.keyFile], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /already exists/); assert.deepEqual(fs.readFileSync(f.keyFile), original);
    const fresh = path.join(f.dir, 'fresh.key');
    result = spawnSync(process.execPath, [keyCli, '--key-file', fresh], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr); const bytes = readFileJournalKeyFile(fresh);
    assert.equal(bytes.length, 32); assert.notDeepEqual(bytes, Buffer.alloc(32));
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
    assert.ok(!(result.stdout + result.stderr).includes(bytes.toString('hex')));
    assert.ok(!(result.stdout + result.stderr).includes(bytes.toString('base64'))); bytes.fill(0);
    fs.chmodSync(f.dir, 0o755);
    assert.throws(() => initializeFileJournalKey(path.join(f.dir, 'bad.key')), /owner-only directory/);
    assert.equal(fs.existsSync(path.join(f.dir, 'bad.key')), false);
    fs.chmodSync(f.dir, 0o700);
    const link = `${f.dir}-link`; fs.symlinkSync(f.dir, link);
    try { assert.throws(() => initializeFileJournalKey(path.join(link, 'another.key')), /owner-only directory/); }
    finally { fs.unlinkSync(link); }
  } finally { f.cleanup(); }
});

test('key initializer leaves an uncertain file alone after a sync failure', () => {
  const f = fixture(), sync = fs.fsyncSync, fresh = path.join(f.dir, 'uncertain.key');
  try {
    fs.fsyncSync = () => { throw new Error('synthetic sync failure'); };
    assert.throws(() => initializeFileJournalKey(fresh), /did not complete.*file may exist/);
    fs.fsyncSync = sync; assert.equal(fs.existsSync(fresh), true);
    const saved = fs.readFileSync(fresh);
    assert.throws(() => initializeFileJournalKey(fresh), /refusing to overwrite/); assert.deepEqual(fs.readFileSync(fresh), saved);
  } finally { fs.fsyncSync = sync; f.cleanup(); }
});

test('concurrent key initializers never overwrite each other', async () => {
  const f = fixture(), fresh = path.join(f.dir, 'concurrent.key');
  const start = () => {
    const child = spawn(process.execPath, [keyCli, '--key-file', fresh], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
    return once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
  };
  try {
    const results = await Promise.all([start(), start()]);
    assert.deepEqual(results.map(r => r.code).sort(), [0, 1]);
    assert.match(results.find(r => r.code === 1).stderr, /already exists/);
    const key = readFileJournalKeyFile(fresh); assert.equal(key.length, 32); key.fill(0);
  } finally { f.cleanup(); }
});

test('live demo entry points reject a bad key before any network or setup', () => {
  const f = fixture(), preload = fileURLToPath(new URL('./fixtures/deny-test-network.mjs', import.meta.url));
  try {
    for (const name of ['demo-oracle-mission', 'demo-outlayer', 'demo-onchain-proof', 'demo-multi-resource', 'demo-ft-call', 'demo-circle-usdc']) {
      const script = fileURLToPath(new URL(`../${name}.mjs`, import.meta.url));
      const result = spawnSync(process.execPath, [`--import=${preload}`, script], {
        env: { ...process.env, BOUNCER_FILE_JOURNAL_KEY_FILE: path.join(f.dir, 'missing.key') }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`); assert.match(result.stderr, /file journal key/);
      assert.doesNotMatch(result.stdout + result.stderr, /unexpected network request/);
    }
  } finally { f.cleanup(); }
});

test('configured file journals do not silently convert legacy plaintext or ignore a missing key', () => {
  const f = fixture(), previous = process.env.BOUNCER_FILE_JOURNAL_KEY_FILE;
  try {
    const entries = seedPlain(f.file), original = fs.readFileSync(f.file, 'utf8');
    process.env.BOUNCER_FILE_JOURNAL_KEY_FILE = f.keyFile;
    assert.throws(() => openConfiguredFileJournal(f.file, contract, owner), /explicit in-place encryption/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    process.env.BOUNCER_FILE_JOURNAL_KEY_FILE = '';
    assert.throws(() => openConfiguredFileJournal(f.file, contract, owner), /key file is required/);
    delete process.env.BOUNCER_FILE_JOURNAL_KEY_FILE;
    const legacy = openConfiguredFileJournal(f.file, contract, owner); assert.deepEqual(legacy.list(), entries); legacy.close();
  } finally {
    if (previous === undefined) delete process.env.BOUNCER_FILE_JOURNAL_KEY_FILE; else process.env.BOUNCER_FILE_JOURNAL_KEY_FILE = previous;
    f.cleanup();
  }
});

test('configured journal detects a replaced or missing key before the next write', () => {
  const f = fixture(), previous = process.env.BOUNCER_FILE_JOURNAL_KEY_FILE;
  try {
    process.env.BOUNCER_FILE_JOURNAL_KEY_FILE = f.keyFile;
    const journal = openConfiguredFileJournal(f.file, contract, owner);
    journal.put('pending', { status: 'pending', fingerprint: 'fp', tx_hash: 'original-hash', claim: secret });
    const original = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(f.keyFile, crypto.randomBytes(32));
    assert.throws(() => journal.put('new', { status: 'pending', fingerprint: 'new' }), /key changed or is unreadable/);
    assert.throws(() => journal.get('pending'), /failed write/); assert.equal(fs.readFileSync(f.file, 'utf8'), original); journal.close();
    fs.writeFileSync(f.keyFile, f.key);
    let reopened = openConfiguredFileJournal(f.file, contract, owner); assert.equal(reopened.get('pending').tx_hash, 'original-hash');
    fs.unlinkSync(f.keyFile);
    assert.throws(() => reopened.put('new', { status: 'pending', fingerprint: 'new' }), /key changed or is unreadable/); reopened.close();
    fs.writeFileSync(f.keyFile, f.key, { mode: 0o600 });
    reopened = openConfiguredFileJournal(f.file, contract, owner); assert.equal(reopened.get('new'), undefined); reopened.close();
  } finally {
    if (previous === undefined) delete process.env.BOUNCER_FILE_JOURNAL_KEY_FILE; else process.env.BOUNCER_FILE_JOURNAL_KEY_FILE = previous;
    f.cleanup();
  }
});

test('explicit CLI conversion preserves every entry, never creates a replacement and is idempotent', () => {
  const f = fixture();
  try {
    const entries = seedPlain(f.file), original = fs.readFileSync(f.file, 'utf8');
    let result = runCli(f, ['--state', f.file, '--contract', 'other.testnet', '--owner', owner]);
    assert.equal(result.status, 1); assert.match(result.stderr, /different contract/); assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    const missing = path.join(f.dir, 'missing.json');
    result = runCli(f, ['--state', missing, '--contract', contract, '--owner', owner]);
    assert.equal(result.status, 1); assert.match(result.stderr, /original journal not found/); assert.equal(fs.existsSync(missing), false);
    const held = new FileJournal(f.file, contract, owner);
    try { result = runCli(f); assert.equal(result.status, 1); assert.match(result.stderr, /EEXIST/); }
    finally { held.close(); }
    result = runCli(f); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /2 entries/);
    const encrypted = fs.readFileSync(f.file, 'utf8');
    assert.doesNotMatch(encrypted, /SYNTHETIC-REPLAYABLE|original-hash|private input/);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC-REPLAYABLE|original-hash|private input/);
    const journal = open(f); assert.deepEqual(journal.list(), entries); journal.close();
    result = runCli(f); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /already encrypted/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), encrypted);
  } finally { f.cleanup(); }
});

for (const failure of [1, 2]) {
  test(`conversion stops on fsync failure ${failure} and preserves the same payment history`, () => {
    const f = fixture(), sync = fs.fsyncSync;
    try {
      const entries = seedPlain(f.file), original = fs.readFileSync(f.file, 'utf8'); let calls = 0;
      fs.fsyncSync = fd => { if (++calls === failure) throw new Error('synthetic fsync failure'); return sync(fd); };
      assert.throws(() => open(f, f.key, { migratePlaintext: true, requireExisting: true }), /synthetic fsync failure/);
      fs.fsyncSync = sync;
      assert.equal(fs.existsSync(`${f.file}.lock`), false);
      if (failure === 1) assert.equal(fs.readFileSync(f.file, 'utf8'), original);
      else assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).format, FILE_JOURNAL_FORMAT);
      const journal = failure === 1 ? new FileJournal(f.file, contract, owner) : open(f);
      assert.deepEqual(journal.list(), entries); journal.close();
      assert.deepEqual(fs.readdirSync(f.dir).sort(), ['journal.json', 'key']);
    } finally { fs.fsyncSync = sync; f.cleanup(); }
  });
}

for (const crashPoint of ['after-temp-sync', 'after-rename']) {
  test(`process death ${crashPoint} leaves only encrypted temporary output and the original entries`, () => {
    const f = fixture();
    try {
      const entries = seedPlain(f.file), original = fs.readFileSync(f.file, 'utf8');
      const child = spawnSync(process.execPath, [crash, f.file, f.keyFile, crashPoint], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const temps = fs.readdirSync(f.dir).filter(name => name.startsWith('journal.json.') && name.endsWith('.tmp'));
      for (const name of temps) {
        const contents = fs.readFileSync(path.join(f.dir, name), 'utf8');
        assert.equal(JSON.parse(contents).format, FILE_JOURNAL_FORMAT); assert.doesNotMatch(contents, /SYNTHETIC-REPLAYABLE|original-hash/);
      }
      if (crashPoint === 'after-temp-sync') assert.equal(fs.readFileSync(f.file, 'utf8'), original);
      else assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).format, FILE_JOURNAL_FORMAT);
      // This child is known to be dead. A real operator must independently
      // fence all workers and reconcile before handling a stale lock.
      fs.unlinkSync(`${f.file}.lock`);
      const journal = open(f, f.key, { migratePlaintext: true, requireExisting: true });
      assert.deepEqual(journal.list(), entries); journal.close();
    } finally { f.cleanup(); }
  });
}

test('an oversized encrypted write fails before replacing the journal and poisons the session', () => {
  const f = fixture();
  try {
    const journal = open(f); journal.put('pending', { status: 'pending', fingerprint: 'fp', tx_hash: 'original-hash' });
    const original = fs.readFileSync(f.file, 'utf8');
    assert.throws(() => journal.put('huge', { status: 'pending', fingerprint: 'fp2', data: 'x'.repeat(MAX_ENCRYPTED_JOURNAL_PLAINTEXT) }), /size limit/);
    assert.throws(() => journal.get('pending'), /failed write/); assert.equal(fs.readFileSync(f.file, 'utf8'), original); journal.close();
    const reopened = open(f); assert.equal(reopened.get('pending').tx_hash, 'original-hash'); assert.equal(reopened.get('huge'), undefined); reopened.close();
  } finally { f.cleanup(); }
});
