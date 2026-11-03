import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { sealFaucetRecoveryKey, openFaucetRecoveryKey, faucetRecoveryBundleDigest } from '../agent/v3-faucet-sealed-recovery.mjs';

const OWNER = 'bouncer-owner-12f343b795633e357ae5560d.testnet';
const TEMP = `bouncer-faucet-${'a'.repeat(32)}.testnet`;
function fixture() {
  const owner = nearApi.KeyPair.fromRandom('ed25519'), temp = nearApi.KeyPair.fromRandom('ed25519');
  const key = crypto.randomBytes(32), journal = Buffer.from('{"format":"encrypted-ciphertext-only"}\n');
  const envelope = sealFaucetRecoveryKey({ key, ownerAccount: OWNER, ownerPublicKey: String(owner.getPublicKey()),
    temporaryAccount: TEMP, temporaryPublicKey: String(temp.getPublicKey()), journalBytes: journal });
  return { owner, key, journal, envelope };
}

test('sealed key opens only with matching owner; no private key or journal key is in the envelope', () => {
  for (let n = 0; n < 8; n++) {
    const f = fixture();
    const raw = JSON.stringify(f.envelope);
    assert(!raw.includes(f.owner.toString()));
    assert(!raw.includes(f.key.toString('base64')));
    const opened = openFaucetRecoveryKey({ envelope: f.envelope, journalBytes: f.journal, ownerSecretKey: f.owner.toString() });
    assert.deepEqual(opened, f.key); opened.fill(0); f.key.fill(0);
  }
});

test('wrong owner, changed ciphertext, changed context and changed journal fail closed', () => {
  const f = fixture(), other = nearApi.KeyPair.fromRandom('ed25519');
  const open = (envelope, journal = f.journal, owner = f.owner) =>
    openFaucetRecoveryKey({ envelope, journalBytes: journal, ownerSecretKey: owner.toString() });
  assert.throws(() => open(f.envelope, f.journal, other));
  assert.throws(() => open(f.envelope, Buffer.from('modified')));
  const changed = structuredClone(f.envelope);
  changed.context.temporary_account = `bouncer-faucet-${'b'.repeat(32)}.testnet`;
  assert.throws(() => open(changed));
  const bad = structuredClone(f.envelope); bad.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => open(bad));
  assert.throws(() => open({ ...f.envelope, ignored: true }));
  f.key.fill(0);
});

test('bundle digest binds exact bytes and their ordering', () => {
  const f = fixture(), e = Buffer.from(JSON.stringify(f.envelope));
  const d = faucetRecoveryBundleDigest(f.journal, e);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.notEqual(d, faucetRecoveryBundleDigest(Buffer.from('modified'), e));
  assert.notEqual(d, faucetRecoveryBundleDigest(e, f.journal));
  f.key.fill(0);
});

test('rejects noncanonical owner public keys and unsafe account scope', () => {
  const f = fixture();
  assert.throws(() => sealFaucetRecoveryKey({ key: f.key, ownerAccount: 'alice.near', ownerPublicKey: String(f.owner.getPublicKey()),
    temporaryAccount: TEMP, temporaryPublicKey: String(f.owner.getPublicKey()), journalBytes: f.journal }));
  assert.throws(() => sealFaucetRecoveryKey({ key: f.key, ownerAccount: OWNER, ownerPublicKey: 'ed25519:invalid',
    temporaryAccount: TEMP, temporaryPublicKey: String(f.owner.getPublicKey()), journalBytes: f.journal }));
  f.key.fill(0);
});
