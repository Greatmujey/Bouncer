import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderMemo } from '../services/resource-provider.mjs';
import { runResourceAgent } from '../agent/resource-agent.mjs';
import { computeResult } from './mock-delivery.mjs';

const publicKey = { toString: () => 'ed25519:fake-agent' };
const goal = (id, text, policy = 'shared') => ({
  id, resource: 'compute', input: { text, rounds: 2 }, policy_id: policy,
  token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100',
});
const makeQuote = ({ resource, input }) => ({
  resource, policy_id: input.text === 'other-policy' ? 'other' : 'shared', token: 'wrap.testnet',
  payee: 'vendor.testnet', amount: '80', memo: orderMemo(resource, input),
});
function fixture({ daily = '1000', initialSpent = '0', vault = '1000', blocked = false, wrongSecondToken = false, changePolicy = false } = {}) {
  let calls = 0, balance = 0n, policyReads = 0;
  const entries = new Map();
  const journal = { get: id => entries.get(id), put: (id, value) => entries.set(id, value) };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } }; },
    async callFunction(id, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') {
        policyReads++;
        const token = (wrongSecondToken && args.policy_id === 'other') || (changePolicy && policyReads > 2) ? 'changed.testnet' : 'wrap.testnet';
        return { token, per_tx_cap: '1000', daily_cap: daily };
      }
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'daily_spent') return (BigInt(initialSpent) + balance).toString();
      if (method === 'vault_balance') return (BigInt(vault) - balance).toString();
      if (method === 'check') return blocked && args.policy_id === 'other' ? [false, 'not allowed'] : [true, 'ok'];
      if (method === 'ft_balance_of') return balance.toString();
      throw new Error(`unexpected ${id}.${method}`);
    },
  };
  const account = { accountId: 'bouncer.testnet', async callFunctionRaw() {
    calls++; balance += 80n;
    return { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { id: `tx-${calls}` }, receipts_outcome: [{ outcome: { executor_id: 'wrap.testnet', status: { SuccessValue: '' } } }] };
  } };
  const base = { contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', goals: [goal('one', 'first'), goal('two', 'second')],
    getQuote: async order => makeQuote(order), fulfill: async ({ input }) => computeResult(input),
    provider, account, publicKey, journal, execute: true, log: () => {} };
  return { base, get calls() { return calls; }, entries };
}

test('combined daily budget blocks the whole live batch before any payment', async () => {
  const f = fixture({ daily: '150' });
  const result = await runResourceAgent(f.base);
  assert.equal(result.payments.blocked, 1);
  assert.equal(result.payments.ready, 1);
  assert.match(result.checks[1].reason, /rolling daily budget/);
  assert.equal(f.calls, 0);
  assert.equal(f.entries.size, 0);
  assert.equal(result.deliveries.length, 0);
});

test('two separate policies cannot each reserve the same shared token vault', async () => {
  const f = fixture({ vault: '150' });
  f.base.goals[1] = goal('two', 'other-policy', 'other');
  const result = await runResourceAgent(f.base);
  assert.equal(result.payments.blocked, 1);
  assert.match(result.checks[1].reason, /token vault balance/);
  assert.equal(f.calls, 0);
});

test('a later individual policy rejection or mismatched token stops earlier payments', async () => {
  for (const opts of [{ blocked: true }, { wrongSecondToken: true }]) {
    const f = fixture(opts);
    f.base.goals[1] = goal('two', 'other-policy', 'other');
    if (opts.blocked) {
      const result = await runResourceAgent(f.base);
      assert.equal(result.payments.blocked, 1);
    } else await assert.rejects(runResourceAgent(f.base), /expected token/);
    assert.equal(f.calls, 0);
    assert.equal(f.entries.size, 0);
  }
});

test('policy changes between checks and reservations fail closed before payment', async () => {
  const f = fixture({ changePolicy: true });
  await assert.rejects(runResourceAgent(f.base), /policy changed during batch preflight/);
  assert.equal(f.calls, 0);
});

test('completed journal entries are not reserved twice and remain recoverable', async () => {
  const f = fixture({ daily: '160', vault: '160' });
  const first = await runResourceAgent({ ...f.base, goals: [f.base.goals[0]] });
  assert.equal(first.payments.paid, 1);
  const second = await runResourceAgent(f.base);
  assert.equal(second.payments.skipped, 1);
  assert.equal(second.payments.paid, 1);
  assert.deepEqual(second.checks.map(c => c.status), ['SKIPPED', 'READY']);
  assert.equal(f.calls, 2);
  const third = await runResourceAgent(f.base);
  assert.equal(third.payments.skipped, 2);
  assert.equal(f.calls, 2);
});

test('a changed on-chain policy after preview can still cause partial execution', async () => {
  const f = fixture();
  const call = f.base.provider.callFunction;
  let checks = 0;
  f.base.provider.callFunction = async (...args) => {
    if (args[1] === 'check' && ++checks === 4) return [false, 'changed after preview'];
    return call(...args);
  };
  const result = await runResourceAgent(f.base);
  assert.equal(result.payments.paid, 1);
  assert.equal(result.payments.blocked, 1);
  assert.equal(result.deliveries.length, 1);
  assert.equal(f.calls, 1);
});

test('an invalid or unavailable aggregate view is not treated as approval', async () => {
  for (const bad of ['-1', '1e3', (1n << 128n).toString(), null]) {
    const f = fixture();
    const call = f.base.provider.callFunction;
    f.base.provider.callFunction = async (...args) => args[1] === 'vault_balance' ? bad : call(...args);
    await assert.rejects(runResourceAgent(f.base), /contract amount/);
    assert.equal(f.calls, 0);
  }
});
