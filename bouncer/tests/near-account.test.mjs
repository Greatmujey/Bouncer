import { test } from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { MonotonicAccount } from '../agent/near-account.mjs';

const key1 = nearApi.KeyPair.fromRandom('ed25519').getPublicKey();
const key2 = nearApi.KeyPair.fromRandom('ed25519').getPublicKey();

test('nonce selection advances locally when the optimistic RPC view is stale', async () => {
  let observed = 100, sends = 0;
  const provider = {
    async viewAccessKey() { return { nonce: observed }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil() { sends++; throw new Error('must not send'); },
  };
  const account = new MonotonicAccount('bouncer.testnet', provider);
  const one = await account.createTransaction('target.testnet', [], key1);
  const two = await account.createTransaction('target.testnet', [], key1);
  assert.ok(two.nonce > one.nonce);
  assert.equal(two.nonce, one.nonce + 1n);
  const otherKey = await account.createTransaction('target.testnet', [], key2);
  assert.equal(otherKey.nonce, one.nonce, 'nonce tracking is per public key');
  observed = 200;
  const current = await account.createTransaction('target.testnet', [], key1);
  assert.ok(current.nonce > 200n, 'a newer RPC nonce takes precedence');
  assert.equal(sends, 0, 'nonce selection never signs, sends or retries a payment');
});

test('sequential signed calls use distinct nonces and a send failure is never retried', async () => {
  const sent = [];
  const provider = {
    async viewAccessKey() { return { nonce: 100 }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil(signed, wait) {
      sent.push({ nonce: signed.transaction.nonce, wait });
      if (sent.length === 3) throw new Error('ambiguous timeout');
      return { status: { SuccessValue: '' } };
    },
  };
  const key = nearApi.KeyPair.fromRandom('ed25519');
  const account = new MonotonicAccount('bouncer.testnet', provider, new nearApi.KeyPairSigner(key));
  const call = () => account.callFunctionRaw({ contractId: 'bouncer.testnet', methodName: 'execute', args: {}, gas: 1n, deposit: 0n, waitUntil: 'FINAL' });
  await call(); await call();
  await assert.rejects(call(), /ambiguous timeout/);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(item => item.wait === 'FINAL'));
  assert.deepEqual(sent.map(item => item.nonce), [sent[0].nonce, sent[0].nonce + 1n, sent[0].nonce + 2n]);
});

test('RPC failures and nonce overflow are surfaced without sending', async () => {
  let sends = 0;
  const provider = {
    async viewAccessKey() { return { nonce: ((1n << 64n) - 1n).toString() }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil() { sends++; },
  };
  const account = new MonotonicAccount('bouncer.testnet', provider);
  await assert.rejects(account.createTransaction('target.testnet', [], key1), /nonce outside U64/);
  provider.viewAccessKey = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(account.createTransaction('target.testnet', [], key1), /RPC unavailable/);
  assert.equal(sends, 0);
});
