import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { signReviewedProbeSetup, assertProbeRuntime, redactProbeReceipt } from '../scripts/probe-youtick-owner-grant.mjs';

function setup() {
  const key = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(key), signerId = 'vault.testnet';
  const actions = [nearApi.transactions.deployContract(Buffer.from('test-bytes')),
    nearApi.transactions.functionCall('new', { owner: 'owner.testnet' }, 100_000_000_000_000n, 0n),
    nearApi.transactions.deleteKey(key.getPublicKey())];
  const account = { accountId: signerId, signer, createTransaction: async (receiver, a, pk) =>
    nearApi.transactions.createTransaction(signerId, pk, receiver, 1n, a, Buffer.alloc(32, 1)) };
  return { account, signerId, publicKey: key.getPublicKey(), receiverId: signerId, actions };
}
test('reviewed diagnostic setup signs only exact deployment, initialization and key-removal actions', async () => {
  const s = setup(), signed = await signReviewedProbeSetup(s);
  assert.equal(typeof signed.txHash, 'string'); assert.equal(signed.signed.transaction.actions.length, 3);
  for (const alter of [
    s => { const old = s.account.createTransaction; s.account.createTransaction = async (receiver, actions, key) => old('other.testnet', actions, key); },
    s => { const old = s.account.createTransaction; s.account.createTransaction = async (receiver, actions, key) => {
      actions[1].functionCall.deposit = 1n; return old(receiver, actions, key); }; },
    s => { const old = s.account.signer.signTransaction.bind(s.account.signer); s.account.signer.signTransaction = async tx => {
      const [hash, signed] = await old(tx); hash[0] ^= 1; return [hash, signed]; }; },
  ]) {
    const s = setup(); alter(s); await assert.rejects(signReviewedProbeSetup(s), /differs from review/);
  }
});

test('diagnostic rejects mainnet, unknown/old protocol and unexpected storage before creating accounts', () => {
  const valid = { chain_id: 'testnet', protocol_version: 84, runtime_config: { storage_amount_per_byte: '10000000000000000000' } };
  assert.doesNotThrow(() => assertProbeRuntime(valid));
  for (const bad of [{ ...valid, chain_id: 'mainnet' }, { ...valid, protocol_version: 83 },
    { ...valid, protocol_version: '84' }, { ...valid, runtime_config: {} }, null]) {
    assert.throws(() => assertProbeRuntime(bad), /not compatible/);
  }
});

test('retained diagnostic receipts omit signature, nonce and block hash without mutating live evidence', () => {
  const raw = { transaction: { hash: 'public', signer_id: 'owner.testnet', signature: 'public-chain-signature', nonce: 10,
    block_hash: 'public-block', actions: [{ FunctionCall: { method_name: 'issue_youtick_play_grant' } }] },
    status: { SuccessValue: 'e30=' } };
  const saved = redactProbeReceipt(raw);
  assert.equal(saved.transaction.signature, undefined); assert.equal(saved.transaction.nonce, undefined);
  assert.equal(saved.transaction.block_hash, undefined); assert.equal(raw.transaction.signature, 'public-chain-signature');
  assert.equal(saved.transaction.actions[0].FunctionCall.method_name, 'issue_youtick_play_grant');
});
