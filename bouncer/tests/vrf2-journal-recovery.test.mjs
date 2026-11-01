import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { deriveVrf2JournalKey, writePrivateVrf2JournalKey } from '../scripts/unseal-vrf2-journal-key.mjs';
import { FileJournal } from '../agent/procurement.mjs';

function fixture() {
  const keys = Array.from({ length: 4 }, () => nearApi.KeyPair.fromRandom('ed25519'));
  const payload = { version: 3, purpose: 'outlayer-vrf-testnet', owner_account_id: 'owner.testnet', contract_id: 'vault.testnet',
    owner_secret: keys[0].toString(), contract_secret: keys[1].toString(), funding_secret: keys[2].toString(), project_secret: keys[3].toString() };
  const identity = { owner: payload.owner_account_id, vault: payload.contract_id, purpose: 'fresh-testnet-fake-token-independent-vrf-diagnostic',
    owner_public_key: keys[0].getPublicKey().toString(), vault_public_key: keys[1].getPublicKey().toString(),
    funding_public_key: keys[2].getPublicKey().toString(), project_public_key: keys[3].getPublicKey().toString() };
  return { payload, identity };
}

test('VRF2 key recovery binds all disposable public keys and reopens the original encrypted journal', () => {
  const { payload, identity } = fixture(), expected = crypto.createHash('sha256').update('bouncer-vrf2-journal-v1\0').update(payload.contract_secret).digest();
  const recovered = deriveVrf2JournalKey(payload, identity); assert.deepEqual(recovered, expected);
  for (const field of ['owner_public_key', 'vault_public_key', 'funding_public_key', 'project_public_key']) {
    assert.throws(() => deriveVrf2JournalKey(payload, { ...identity, [field]: 'ed25519:wrong' }), /does not match/);
  }
  assert.throws(() => deriveVrf2JournalKey(payload, { ...identity, owner: 'other.testnet' }), /does not match/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrf2-journal-'));
  const journalFile = path.join(dir, 'journal.enc.json'), keyFile = path.join(dir, 'key');
  try {
    let journal = new FileJournal(journalFile, identity.vault, identity.owner, { encryptionKey: recovered });
    journal.put('pending-order', { status: 'pending', fingerprint: 'f', tx_hash: 'original-hash' }); journal.close();
    writePrivateVrf2JournalKey(keyFile, recovered);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600); assert.equal(fs.readFileSync(keyFile).length, 32);
    assert.throws(() => writePrivateVrf2JournalKey(keyFile, recovered));
    journal = new FileJournal(journalFile, identity.vault, identity.owner, { encryptionKey: fs.readFileSync(keyFile), requireExisting: true });
    assert.equal(journal.get('pending-order').tx_hash, 'original-hash'); journal.close();
    assert.ok(!fs.readFileSync(keyFile).includes(Buffer.from(payload.contract_secret)));
  } finally { recovered.fill(0); expected.fill(0); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('journal key output refuses non-private directories and symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrf2-key-')), key = crypto.randomBytes(32);
  try {
    fs.chmodSync(dir, 0o755); assert.throws(() => writePrivateVrf2JournalKey(path.join(dir, 'key'), key), /owner-only/);
    fs.chmodSync(dir, 0o700); fs.writeFileSync(path.join(dir, 'existing'), 'unchanged');
    fs.symlinkSync(path.join(dir, 'existing'), path.join(dir, 'key'));
    assert.throws(() => writePrivateVrf2JournalKey(path.join(dir, 'key'), key));
    assert.equal(fs.readFileSync(path.join(dir, 'existing'), 'utf8'), 'unchanged');
  } finally { key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); }
});
