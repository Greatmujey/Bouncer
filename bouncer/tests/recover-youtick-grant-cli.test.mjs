import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { FileJournal } from '../agent/procurement.mjs';

const script = path.resolve('agent/recover-youtick-grant.mjs');
const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env,
  BOUNCER_FILE_JOURNAL_KEY_FILE: '', ...extra }, timeout: 10_000 });

test('grant recovery CLI offers help and fails closed on missing key, bad identity or duplicate options', () => {
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /never signs or sends/);
  const good = ['--state', '/tmp/not-a-real-journal', '--vault', 'vault.testnet', '--owner', 'owner.testnet', '--grant', 'grant1'];
  const noKey = run(good); assert.equal(noKey.status, 1); assert.match(noKey.stderr, /original BOUNCER_FILE_JOURNAL_KEY_FILE/);
  const invalid = run([...good.slice(0, 3), 'vault.near', ...good.slice(4)]);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /testnet vault/);
  const duplicate = run([...good, '--grant', 'replacement']); assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /duplicate/);
});

test('grant recovery CLI never creates a replacement journal and refuses a different owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-grant-cli-'));
  try {
    const key = crypto.randomBytes(32), keyFile = path.join(dir, 'key'), file = path.join(dir, 'original.json');
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    const args = ['--state', file, '--vault', 'vault.testnet', '--owner', 'owner.testnet', '--grant', 'grant1', '--rpc', 'http://127.0.0.1:1'];
    const missing = run(args, { BOUNCER_FILE_JOURNAL_KEY_FILE: keyFile });
    assert.equal(missing.status, 1); assert.match(missing.stderr, /original journal not found/); assert.equal(fs.existsSync(file), false);
    const journal = new FileJournal(file, 'vault.testnet', 'owner.testnet', { encryptionKey: key });
    journal.put('example', { fingerprint: 'a', status: 'pending' }); journal.close();
    const wrong = run(args.map((v, i) => i === 5 ? 'other.testnet' : v), { BOUNCER_FILE_JOURNAL_KEY_FILE: keyFile });
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /failed authentication|different contract\/account/);
    const absent = run(args, { BOUNCER_FILE_JOURNAL_KEY_FILE: keyFile });
    assert.equal(absent.status, 1); assert.match(absent.stderr, /original owner grant journal entry is missing/);
    key.fill(0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
