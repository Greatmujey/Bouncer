import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalsFromModel, planObjective, validatePlanningConfig } from '../agent/goal-planner.mjs';
import { compareApprovedQuotes } from '../agent/quote-comparison.mjs';
import { planFromQuotes, routedResourceProvider, runResourceAgent } from '../agent/resource-agent.mjs';
import { orderMemo } from '../services/resource-provider.mjs';

const config = () => ({
  version: 1, contract_id: 'bouncer.testnet', owner_account_id: 'bouncer.testnet',
  provider_url: 'https://primary.example', max_tasks: 2, required_resources: ['compute', 'storage'],
  resources: {
    compute: { policy_id: 'compute-a', token: 'wrap.testnet', payee: 'a.testnet',
      max_amount: '100000000000000000000', max_tasks: 1, max_total_amount: '100000000000000000000',
      alternatives: [{ id: 'cheaper', provider_url: 'https://alternative.example', policy_id: 'compute-b', payee: 'b.testnet', max_amount: '100000000000000000000' }] },
    storage: { policy_id: 'storage-a', token: 'storage.testnet', payee: 'a.testnet', max_amount: '200', max_tasks: 1, max_total_amount: '200',
      alternatives: [{ id: 'second', provider_url: 'https://alternative.example', policy_id: 'storage-b', payee: 'b.testnet', max_amount: '200' }] },
  },
});
const proposal = () => ({ tasks: [
  { resource: 'compute', input: { text: 'work', rounds: 2 } },
  { resource: 'storage', input: { name: 'note', content: 'test' } },
] });
const products = () => ({
  'https://primary.example': {
    compute: { policy_id: 'compute-a', token: 'wrap.testnet', payee: 'a.testnet', amount: '9007199254740994' },
    storage: { policy_id: 'storage-a', token: 'storage.testnet', payee: 'a.testnet', amount: '40' },
  },
  'https://alternative.example': {
    compute: { policy_id: 'compute-b', token: 'wrap.testnet', payee: 'b.testnet', amount: '9007199254740993' },
    storage: { policy_id: 'storage-b', token: 'storage.testnet', payee: 'b.testnet', amount: '50' },
  },
});
function clientFactory(table, calls = []) {
  return url => ({ getQuote: async order => {
    calls.push({ url, order: structuredClone(order) });
    const p = table[url][order.resource];
    return { resource: order.resource, ...p, memo: orderMemo(order.resource, order.input) };
  } });
}
async function compare(c = config(), table = products(), calls = []) {
  return compareApprovedQuotes({ config: c, proposedGoals: goalsFromModel(proposal(), c), createClient: clientFactory(table, calls) });
}

test('selects the cheapest authorized quote independently per FT using exact integers', async () => {
  const c = config(), calls = [];
  let modelInput;
  const proposed = await planObjective({ objective: 'Do the two tasks', config: c, modelClient: async x => { modelInput = x; return proposal(); } });
  const result = await compareApprovedQuotes({ config: c, proposedGoals: proposed, createClient: clientFactory(products(), calls) });
  assert.deepEqual(modelInput, { objective: 'Do the two tasks', allowedResources: ['compute', 'storage'] });
  assert.equal(JSON.stringify(modelInput).includes('alternative.example'), false);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => Object.keys(c.order).join(',') === 'resource,input'));
  assert.deepEqual(result.goals.map(g => [g.id, g.provider_id, g.payee, g.token, g.quote_amount]), [
    ['compute-1', 'cheaper', 'b.testnet', 'wrap.testnet', '9007199254740993'],
    ['storage-1', 'primary', 'a.testnet', 'storage.testnet', '40'],
  ]);
  assert.deepEqual(result.quote_comparisons.map(c => c.selected_provider), ['cheaper', 'primary']);
  assert.equal(result.quote_comparisons[0].quotes[0].amount, '9007199254740994');
});

test('ties use owner order, not asynchronous response order', async () => {
  const table = products(); table['https://alternative.example'].compute.amount = table['https://primary.example'].compute.amount;
  const c = config(); const calls = [];
  const createClient = url => ({ getQuote: async order => {
    if (url === 'https://primary.example') await new Promise(resolve => setTimeout(resolve, 10));
    return clientFactory(table, calls)(url).getQuote(order);
  } });
  const result = await compareApprovedQuotes({ config: c, proposedGoals: goalsFromModel(proposal(), c), createClient });
  assert.equal(result.goals[0].provider_id, 'primary');
  assert.equal(calls[0].url, 'https://alternative.example');
});

test('mismatched token, payee, policy, memo, invalid prices and unavailable providers abort all selection', async () => {
  const cases = [
    [{ token: 'other.testnet' }, /does not match/], [{ payee: 'attacker.testnet' }, /does not match/],
    [{ policy_id: 'other' }, /does not match/], [{ resource: 'api' }, /does not match/],
    [{ amount: '100000000000000000001' }, /exceeds/], [{ amount: '0' }, /U128/], [{ amount: 'NaN' }, /U128/],
    [{ memo: orderMemo('compute', { text: 'other', rounds: 2 }) }, /exact order/],
  ];
  for (const [changes, pattern] of cases) {
    const c = config(), table = products(), base = clientFactory(table);
    const createClient = url => ({ getQuote: async order => {
      const q = await base(url).getQuote(order);
      return url === 'https://alternative.example' && order.resource === 'compute' ? { ...q, ...changes } : q;
    } });
    await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: goalsFromModel(proposal(), c), createClient }), pattern);
  }
  const c = config(), base = clientFactory(products());
  await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: goalsFromModel(proposal(), c), createClient: url => ({ getQuote: async order => {
    if (url === 'https://alternative.example') throw new Error('offline\u001b[2J');
    return base(url).getQuote(order);
  } }) }), error => /comparison failed: offline/.test(error.message) && !/[\x00-\x1f\x7f]/.test(error.message));
});

test('invalid owner alternatives or smuggled financial authority fail before contacting providers', async () => {
  const mutations = [
    c => { c.resources.compute.alternatives[0].token = 'other.testnet'; },
    c => { c.resources.compute.alternatives[0].id = 'primary'; },
    c => { c.resources.compute.alternatives.push(structuredClone(c.resources.compute.alternatives[0])); },
    c => { c.resources.compute.alternatives[0].payee = 'attacker.near'; },
    c => { c.resources.compute.alternatives[0].policy_id = '../other'; },
    c => { c.resources.compute.alternatives[0].provider_url = 'http://attacker.example'; },
    c => { c.resources.compute.alternatives[0].max_amount = '100000000000000000001'; },
    c => { c.resources.compute.alternatives = Array.from({ length: 5 }, (_, i) => ({ ...c.resources.compute.alternatives[0], id: `vendor${i}` })); },
  ];
  for (const mutate of mutations) {
    const c = config(); mutate(c); let contacted = false;
    await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: {}, createClient: () => { contacted = true; } }));
    assert.equal(contacted, false);
  }
  const changes = [
    g => { g.goals[0].payee = 'attacker.testnet'; },
    g => { g.goals[0].token = 'other.testnet'; },
    g => { g.goals[0].max_amount = '100000000000000000001'; },
    g => { g.goals[0].provider_url = 'https://attacker.example'; },
    g => { g.goals[0].quote_amount = '1'; },
    g => { g.owner_account_id = 'attacker.testnet'; },
  ];
  for (const mutate of changes) {
    const c = config(), g = goalsFromModel(proposal(), c); mutate(g); let contacted = false;
    await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: g, createClient: () => { contacted = true; } }));
    assert.equal(contacted, false);
  }
  assert.equal(validatePlanningConfig(config()).resources.compute.alternatives[0].payee, 'b.testnet');
});

test('selected quote cannot change up or down between comparison and execution', async () => {
  const result = await compare();
  const goal = result.goals[0], amount = BigInt(goal.quote_amount);
  const quote = price => ({ resource: goal.resource, policy_id: goal.policy_id, token: goal.token, payee: goal.payee,
    amount: price.toString(), memo: orderMemo(goal.resource, goal.input) });
  for (const price of [amount - 1n, amount + 1n]) {
    await assert.rejects(planFromQuotes({ contractId: result.contract_id, ownerAccountId: result.owner_account_id,
      goals: [goal], getQuote: async () => quote(price) }), /selected quote changed/);
  }
  let paid = 0, redeemed = 0;
  await assert.rejects(runResourceAgent({ contractId: result.contract_id, ownerAccountId: result.owner_account_id, goals: [goal],
    getQuote: async () => quote(amount + 1n), fulfill: async () => { redeemed++; },
    provider: {}, account: { callFunctionRaw: () => { paid++; } }, publicKey: {}, journal: { get: () => undefined, put: () => {} }, execute: true }), /selected quote changed/);
  assert.equal(paid, 0); assert.equal(redeemed, 0);
});

test('a catalog-approved but on-chain-disallowed selected payee blocks instead of falling back or paying', async () => {
  const selected = await compare(), goal = selected.goals[0];
  let paid = 0, redeemed = 0;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } }; },
    async callFunction(_id, method) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '100000000000000000000', daily_cap: '100000000000000000000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [false, 'payee not allowed'];
      throw new Error(`unexpected chain call: ${method}`);
    },
  };
  const calls = [];
  const result = await runResourceAgent({ contractId: selected.contract_id, ownerAccountId: selected.owner_account_id, goals: [goal],
    getQuote: clientFactory(products(), calls)(goal.provider_url).getQuote,
    fulfill: async () => { redeemed++; }, provider, account: { accountId: 'bouncer.testnet', callFunctionRaw: () => { paid++; } },
    publicKey: { toString: () => 'ed25519:test' }, journal: { get: () => undefined, put: () => {} }, execute: true, log: () => {} });
  assert.equal(result.payments.blocked, 1);
  assert.equal(paid, 0); assert.equal(redeemed, 0);
  assert.deepEqual(calls.map(call => call.url), ['https://alternative.example']);
});

test('storage readback is routed to the same goal-pinned origin', async () => {
  const selected = await compare(); const urls = [];
  const router = routedResourceProvider({ providerUrl: selected.provider_url, goals: selected.goals, fetchImpl: async (url, options) => {
    urls.push([String(url), options.method, options.redirect]);
    return new Response('stored');
  } });
  const objectId = 'b'.repeat(64);
  const bytes = await router.readStorage(objectId, { goalId: 'storage-1' });
  assert.equal(bytes.toString(), 'stored');
  assert.deepEqual(urls, [[`https://primary.example/storage/${objectId}`, 'GET', 'error']]);
  assert.throws(() => router.readStorage(objectId, { goalId: 'unknown' }), /missing approved/);
});

test('routed provider pins origins per goal, rejects unknown routes, and never forwards routing metadata', async () => {
  const selected = await compare(); const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url: String(url), body });
    const product = products()[new URL(url).origin][body.resource];
    return new Response(JSON.stringify(String(url).endsWith('/quote') ?
      { ok: true, quote: { resource: body.resource, ...product, memo: orderMemo(body.resource, body.input) } } :
      { ok: true, result: { type: body.resource } }));
  };
  const router = routedResourceProvider({ providerUrl: selected.provider_url, goals: selected.goals, fetchImpl });
  const g0 = selected.goals[0], g1 = selected.goals[1];
  await router.getQuote({ resource: g0.resource, input: g0.input }, { goalId: g0.id });
  await router.fulfill({ tx_hash: 'tx', resource: g1.resource, input: g1.input }, { goalId: g1.id });
  assert.equal(requests[0].url, 'https://alternative.example/quote');
  assert.equal(requests[1].url, 'https://primary.example/redeem');
  assert.equal(Object.hasOwn(requests[0].body, 'goalId'), false);
  assert.throws(() => router.getQuote({}, { goalId: 'unknown' }), /missing approved/);
  const changed = structuredClone(selected.goals); changed[0].provider_url = 'http://attacker.example';
  assert.throws(() => routedResourceProvider({ providerUrl: selected.provider_url, goals: changed, fetchImpl }), /HTTPS/);
});
