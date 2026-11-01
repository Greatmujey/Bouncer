import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { runProcurement } from '../agent/procurement.mjs';
import { orderMemoV3 } from '../packages/provider-sdk/index.mjs';

const key = nearApi.KeyPair.fromRandom('ed25519'), publicKey = key.getPublicKey(), signer = new nearApi.KeyPairSigner(key);
const contract = 'bouncer.testnet', owner = 'owner.testnet', origin = 'https://seller.example';
function fixture() {
  const entries = new Map(); let nonce = 0n, sends = 0, ready, release, reached = 0;
  const arrived = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const beforePayment = async () => { if (++reached === 2) ready(); await gate; };
  const journal = { get: id => entries.get(id), list: () => structuredClone([...entries.values()]),
    put: (id, value) => entries.set(id, { ...structuredClone(value), id }) };
  const account = { accountId: owner, signer, async createTransaction(receiver, actions) {
    return nearApi.transactions.createTransaction(owner, publicKey, receiver, ++nonce, actions, Buffer.alloc(32, 7));
  } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token: 'token.testnet' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'ft_balance_of') return '0';
      throw new Error('unexpected view');
    },
    async sendTransactionUntil() { sends++; throw new Error('synthetic ambiguous submission'); },
    async txStatusReceipts() { throw new Error('not reached'); } };
  return { journal, account, provider, beforePayment, arrived, release, get sends() { return sends; } };
}
function plan(id, memo) { return { contract_id: contract, owner_account_id: owner, requests: [{ id, resource: 'api', policy_id: 'api',
  token: 'token.testnet', payee: 'seller.testnet', amount: '1', memo }] }; }
function run(f, id, memo, v3 = false) {
  const routes = new Map([[id, { provider_id: null, provider_origin: origin }]]);
  return runProcurement({ plan: plan(id, memo), provider: f.provider, account: f.account, publicKey, journal: f.journal,
    journalRoutes: routes, ...(v3 ? { claimOrigins: new Map([[id, origin]]) } : {}), beforePayment: f.beforePayment,
    execute: true, durablePayment: true, log: () => {} });
}
test('a direct v3 memo cannot bypass the reviewed claim origin', async () => {
  const f = fixture(), memo = orderMemoV3('api', { text: 'hello' }, 'a'.repeat(32));
  await assert.rejects(run(f, 'requires-v3', memo), /reviewed authenticated claim origin/);
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
});

test('two concurrent callers sharing one journal cannot both broadcast the same goal ID', async () => {
  const f = fixture();
  const a = run(f, 'same', 'legacy-memo'), b = run(f, 'same', 'legacy-memo');
  await f.arrived; f.release(); const outcomes = await Promise.allSettled([a, b]);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('same').status, 'pending');
  assert.ok(outcomes.every(item => item.status === 'rejected'));
  assert.ok(outcomes.some(item => /journal entry appeared/.test(item.reason.message)));
  assert.ok(outcomes.some(item => /synthetic ambiguous submission/.test(item.reason.message)));
});
test('concurrent v3 goals cannot pay a reused seller challenge in one journal', async () => {
  const f = fixture(), memo = orderMemoV3('api', { text: 'same task' }, 'a'.repeat(32));
  const a = run(f, 'first', memo, true), b = run(f, 'second', memo, true);
  await f.arrived; f.release(); const outcomes = await Promise.allSettled([a, b]);
  assert.equal(f.sends, 1); assert.equal(f.journal.list().length, 1);
  assert.ok(outcomes.some(item => /seller challenge is already recorded/.test(item.reason?.message)));
  assert.ok(outcomes.some(item => /synthetic ambiguous submission/.test(item.reason?.message)));
});
