import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderMemo } from '../services/resource-provider.mjs';
import { httpResourceProvider, planFromQuotes, runResourceAgent } from '../agent/resource-agent.mjs';

const goal = () => ({
  id: 'compute-1', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet',
  max_amount: '100', input: { text: 'work', rounds: 2 },
});
const quote = g => ({ resource: g.resource, policy_id: g.policy_id, token: g.token, payee: g.payee, amount: '80', memo: orderMemo(g.resource, g.input) });
const plan = (g, getQuote) => planFromQuotes({ contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', goals: [g], getQuote });

test('quotes become a token-bound plan with an exact payload commitment', async () => {
  const g = goal();
  const result = await plan(g, async order => {
    assert.deepEqual(order, { resource: g.resource, input: g.input });
    return quote(g);
  });
  assert.equal(result.requests[0].amount, '80');
  assert.equal(result.requests[0].memo, orderMemo(g.resource, g.input));
});

test('untrusted quote cannot swap policy, token, payee, payload or exceed max', async () => {
  const g = goal();
  const cases = [
    [{ policy_id: 'evil' }, /does not match/], [{ token: 'evil.testnet' }, /does not match/],
    [{ payee: 'evil.testnet' }, /does not match/], [{ resource: 'storage' }, /does not match/],
    [{ amount: '101' }, /exceeds/], [{ amount: '1e3' }, /U128/], [{ amount: '0' }, /U128/],
    [{ memo: orderMemo('compute', { text: 'other', rounds: 2 }) }, /exact order/],
  ];
  for (const [changes, message] of cases) await assert.rejects(plan(g, async () => ({ ...quote(g), ...changes })), message);
  g.max_amount = '0';
  await assert.rejects(plan(g, async () => quote(g)), /positive U128/);
});

test('dry-run quotes and preflights but never pays or redeems', async () => {
  const g = goal(); let paid = 0, redeemed = 0, observedPlan;
  const provider = {
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } }; },
    async callFunction(_contract, method) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '1000', daily_cap: '1000' };
      if (method === 'daily_spent') return '0';
      if (method === 'vault_balance') return '1000';
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error('unexpected view');
    },
  };
  const result = await runResourceAgent({
    contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', goals: [g], getQuote: async () => quote(g),
    fulfill: async () => { redeemed++; }, onPlan: p => { observedPlan = p; }, provider,
    account: { accountId: 'bouncer.testnet', callFunctionRaw: () => { paid++; } },
    publicKey: { toString: () => 'ed25519:abc' }, execute: false, log: () => {},
  });
  assert.equal(result.payments.ready, 1);
  assert.equal(result.deliveries.length, 0);
  assert.equal(paid, 0); assert.equal(redeemed, 0);
  assert.equal(observedPlan.requests[0].memo, orderMemo(g.resource, g.input));
});

test('HTTP helper rejects insecure remote providers and validates responses', async () => {
  assert.throws(() => httpResourceProvider('http://external.example'), /HTTPS/);
  assert.throws(() => httpResourceProvider('https://user:pass@vendor.example'), /without credentials/);
  assert.throws(() => httpResourceProvider('https://vendor.example/path'), /bare origin/);
  const requests = [];
  const client = httpResourceProvider('https://vendor.example', async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true, quote: { amount: '80' }, result: { type: 'api' } }) };
  });
  assert.deepEqual(await client.getQuote({ resource: 'api' }), { amount: '80' });
  assert.deepEqual(await client.fulfill({ resource: 'api' }), { type: 'api' });
  assert.equal(requests[0].url, 'https://vendor.example/quote');
  assert.equal(requests[0].options.redirect, 'error');
  const broken = httpResourceProvider('http://127.0.0.1:1234', async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'bad quote' }) }));
  await assert.rejects(broken.getQuote({}), /bad quote/);
});

test('a delivery outage after payment is recoverable without a duplicate payment', async () => {
  const g = goal(); let paid = 0, redeemed = 0, balance = 0n;
  const entries = new Map();
  const journal = { get: id => entries.get(id), put: (id, value) => entries.set(id, { ...value }) };
  const provider = {
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } }; },
    async callFunction(_contract, method) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '1000', daily_cap: '1000' };
      if (method === 'daily_spent') return '0';
      if (method === 'vault_balance') return '1000';
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'ft_balance_of') return balance.toString();
      throw new Error('unexpected view');
    },
  };
  const account = { accountId: 'bouncer.testnet', async callFunctionRaw() {
    paid++; balance += 80n;
    return { transaction_outcome: { id: 'tx-1' }, receipts_outcome: [{ outcome: { executor_id: 'wrap.testnet', status: { SuccessValue: '' } } }] };
  } };
  const opts = {
    contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', goals: [g], getQuote: async () => quote(g),
    fulfill: async () => { if (++redeemed === 1) throw new Error('vendor temporarily unavailable'); return { type: 'compute', result: 'done' }; },
    provider, account, publicKey: { toString: () => 'ed25519:abc' }, journal, execute: true, log: () => {},
  };
  await assert.rejects(runResourceAgent(opts), /vendor temporarily unavailable/);
  assert.equal(journal.get(g.id).status, 'completed');
  const retry = await runResourceAgent(opts);
  assert.equal(retry.payments.skipped, 1);
  assert.equal(retry.deliveries.length, 1);
  assert.equal(paid, 1);
  assert.equal(redeemed, 2);
});
