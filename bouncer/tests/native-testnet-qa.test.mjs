import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { inspectQaSigned, qaPresignedAccount, qaReadOnlyFetch, qaSnapshotAccount, markQaAttempt } from '../scripts/native-testnet-qa.mjs';

const { transactions: tx, utils } = nearApi;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair);
  const signerId = 'qa.testnet', receiverId = 'vault.qa.testnet', publicKey = String(pair.getPublicKey());
  const actions = [tx.functionCall('execute_outlayer_native_project', { amount: '1' }, 300n * 10n ** 12n, 0n)];
  const transaction = tx.createTransaction(signerId, pair.getPublicKey(), receiverId, 10n, actions, Uint8Array.from({ length: 32 }, (_, i) => i));
  const [hash, signed] = await signer.signTransaction(transaction);
  const bytes = Buffer.from(tx.encodeTransaction(signed));
  return { bytes, signerId, receiverId, publicKey, actions, txHash: utils.serialize.base_encode(hash), signedSha256: digest(bytes) };
}

test('QA retries and serializes only RPC reads, never transaction sends', async () => {
  let calls = 0, active = 0, maxActive = 0, pauses = 0;
  const fetchImpl = async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response('{}', { status: calls === 1 ? 429 : 200 });
  };
  const fetchView = qaReadOnlyFetch({ fetchImpl, pause: async () => { pauses++; } });
  const request = method => ({ method: 'POST', body: JSON.stringify({ method, params: {} }) });
  const responses = await Promise.all([fetchView('https://rpc.testnet.near.org', request('status')),
    fetchView('https://rpc.testnet.near.org', request('block'))]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(calls, 3); assert.equal(pauses, 1); assert.equal(maxActive, 1);
  assert.throws(() => fetchView('https://rpc.testnet.near.org', request('send_tx')), /only permits JSON-RPC views/);
  assert.throws(() => fetchView('https://rpc.testnet.near.org', { method: 'POST', body: '{"method":"query","params":{"request_type":"send_transaction"}}' }), /only permits JSON-RPC views/);
  assert.equal(calls, 3);
});

test('QA signs exactly FINAL snapshot nonce plus one, without the SDK double increment', async () => {
  const pair = nearApi.KeyPair.fromRandom('ed25519'), block = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const account = qaSnapshotAccount({ accountId: 'qa.testnet', pair, nonce: '100', blockHash: utils.serialize.base_encode(block) });
  const actions = [tx.functionCall('method', {}, 1n, 0n)];
  const transaction = await account.createTransaction('vault.qa.testnet', actions, pair.getPublicKey());
  assert.equal(transaction.nonce, 101n);
  assert.deepEqual(Uint8Array.from(transaction.blockHash), block);
  await assert.rejects(account.createTransaction('vault.qa.testnet', actions, pair.getPublicKey()), /cannot be replaced/);
  assert.throws(() => qaSnapshotAccount({ accountId: 'qa.testnet', pair, nonce: '-1', blockHash: utils.serialize.base_encode(block) }), /verified FINAL/);
  assert.throws(() => qaSnapshotAccount({ accountId: 'qa.testnet', pair, nonce: '9007199254740991', blockHash: utils.serialize.base_encode(block) }), /verified FINAL/);
  assert.throws(() => qaSnapshotAccount({ accountId: 'qa.testnet', pair, nonce: '100', blockHash: 'bad' }), /verified FINAL/);
});

test('QA original validates exact signed payload, hash and public key', async () => {
  const f = await fixture(), checked = inspectQaSigned(f);
  assert.equal(checked.txHash, f.txHash);
  assert.deepEqual(Buffer.from(tx.encodeTransaction(checked.signed)), f.bytes);
  assert.throws(() => inspectQaSigned({ ...f, signedSha256: '0'.repeat(64) }), /differs/);
  assert.throws(() => inspectQaSigned({ ...f, txHash: '11111111111111111111111111111111' }), /differs/);
  assert.throws(() => inspectQaSigned({ ...f, receiverId: 'other.qa.testnet' }), /differs/);
  assert.throws(() => inspectQaSigned({ ...f, publicKey: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) }), /differs/);
  assert.throws(() => inspectQaSigned({ ...f, actions: [tx.functionCall('execute_outlayer_native_project', { amount: '2' }, 300n * 10n ** 12n, 0n)] }), /differs/);
  const corrupt = Buffer.from(f.bytes); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => inspectQaSigned({ ...f, bytes: corrupt, signedSha256: digest(corrupt) }), /differs/);
});

test('presigned QA account exposes only the original and cannot be reused', async () => {
  const f = await fixture(), checked = inspectQaSigned(f), account = qaPresignedAccount(checked, f.publicKey);
  await assert.rejects(account.signer.signTransaction(checked.transaction), /cannot be replaced/);
  await assert.rejects(account.createTransaction('wrong.qa.testnet', f.actions, utils.PublicKey.from(f.publicKey)), /cannot be replaced/);
  const transaction = await account.createTransaction(f.receiverId, f.actions, utils.PublicKey.from(f.publicKey));
  const [returned, signed] = await account.signer.signTransaction(transaction);
  assert.equal(utils.serialize.base_encode(returned), f.txHash);
  assert.deepEqual(Buffer.from(tx.encodeTransaction(signed)), f.bytes);
  await assert.rejects(account.signer.signTransaction(transaction), /cannot be replaced/);
  await assert.rejects(account.createTransaction(f.receiverId, f.actions, utils.PublicKey.from(f.publicKey)), /cannot be replaced/);
});

test('different actions cannot use a QA original', async () => {
  const f = await fixture(), account = qaPresignedAccount(inspectQaSigned(f), f.publicKey);
  const other = [tx.functionCall('execute_outlayer_native_project', { amount: '2' }, 300n * 10n ** 12n, 0n)];
  await assert.rejects(account.createTransaction(f.receiverId, other, utils.PublicKey.from(f.publicKey)), /cannot be replaced/);
});

test('one-shot local marker is exclusive even after uncertainty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-qa-marker-'));
  try {
    const marker = path.join(dir, 'sent');
    markQaAttempt(marker, { tx_hash: 'original', artifact_id: '123' });
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { tx_hash: 'original', artifact_id: '123' });
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    assert.throws(() => markQaAttempt(marker, { tx_hash: 'replacement' }), { code: 'EEXIST' });
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).tx_hash, 'original');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('QA command rejects execution outside the exact authorized CI run', () => {
  const script = path.resolve('scripts/native-testnet-qa.mjs');
  assert.throws(() => execFileSync(process.execPath, [script, 'init'], {
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }), error => /restricted to the reviewed GitHub run/.test(String(error.stderr)));
});
