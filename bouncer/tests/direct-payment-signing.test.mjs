import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { runProcurement } from '../agent/procurement.mjs';

const keyPair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(keyPair), key = keyPair.getPublicKey();
const plan = { contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', requests: [{ id: 'p', resource: 'api', policy_id: 'p',
  token: 'wrap.testnet', payee: 'vendor.testnet', amount: '1', memo: 'reviewed' }] };
function fixture() {
  let sends = 0, writes = 0;
  const account = { accountId: plan.owner_account_id, signer: {
    getPublicKey: () => signer.getPublicKey(), signTransaction: tx => signer.signTransaction(tx),
  }, async createTransaction(receiver, actions) {
    return nearApi.transactions.createTransaction(plan.owner_account_id, key, receiver, 1n, actions, Buffer.alloc(32, 2));
  } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: plan.contract_id, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v7';
      if (method === 'get_policy') return { token: 'wrap.testnet' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'ft_balance_of') return '0';
      throw new Error('unexpected view');
    },
    async sendTransactionUntil() { sends++; throw new Error('must not broadcast'); },
    async txStatusReceipts() { throw new Error('must not read receipts'); },
  };
  const journal = { get() {}, put() { writes++; } };
  return { account, provider, journal, get sends() { return sends; }, get writes() { return writes; } };
}
const run = f => runProcurement({ plan, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, durablePayment: true, execute: true, log: () => {} });

test('changed prepared transactions fail before signing, journaling or broadcast', async () => {
  for (const mutate of [
    tx => { tx.receiverId = 'other.testnet'; }, tx => { tx.signerId = 'other.testnet'; },
    tx => { tx.actions[0].functionCall.deposit = 1n; }, tx => { tx.actions[0].functionCall.gas = 1n; },
    tx => { tx.actions[0].functionCall.args = Buffer.from('{}'); }, tx => { tx.actions.push(tx.actions[0]); },
  ]) {
    const f = fixture(), original = f.account.createTransaction;
    f.account.createTransaction = async (...args) => { const tx = await original(...args); mutate(tx); return tx; };
    await assert.rejects(run(f), /prepared transaction does not match/);
    assert.equal(f.writes, 0); assert.equal(f.sends, 0);
  }
});

test('mismatched returned hash, signed payload and signature fail before journal or broadcast', async () => {
  for (const mutate of [
    ([hash]) => { hash[0] ^= 1; },
    ([, signed]) => { signed.transaction.receiverId = 'other.testnet'; },
    ([, signed]) => { signed.signature.data[0] ^= 1; },
  ]) {
    const f = fixture(), original = f.account.signer.signTransaction;
    f.account.signer.signTransaction = async tx => { const result = await original(tx); mutate(result); return result; };
    await assert.rejects(run(f), /signed transaction does not match/);
    assert.equal(f.writes, 0); assert.equal(f.sends, 0);
  }
});

test('durable direct procurement prefers one-shot send and never falls back after ambiguity', async () => {
  const f = fixture(); let oneShots = 0;
  f.provider.sendTransactionOnce = async (_signed, wait) => { oneShots++; assert.equal(wait, 'FINAL'); throw new Error('ambiguous one-shot result'); };
  await assert.rejects(run(f), /payment could not be confirmed.*do not retry automatically.*ambiguous one-shot result/);
  assert.equal(oneShots, 1); assert.equal(f.sends, 0); assert.equal(f.writes, 1);
});
