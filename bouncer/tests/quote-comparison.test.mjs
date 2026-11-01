import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalsFromModel, planObjective, validatePlanningConfig } from '../agent/goal-planner.mjs';
import { compareApprovedQuotes } from '../agent/quote-comparison.mjs';
import { planFromQuotes, routedResourceProvider, runResourceAgent } from '../agent/resource-agent.mjs';
import { orderMemo, orderMemoV2, challengeFromOrderMemo } from '../services/resource-provider.mjs';

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

test('owner-pinned seller-v2 mode follows the selected offer and cannot be model-selected', async () => {
  for (const v2On of ['primary', 'alternative']) {
    const c = config(), table = products(), calls = [];
    if (v2On === 'primary') c.resources.compute.order_binding = 'seller-v2';
    else c.resources.compute.alternatives[0].order_binding = 'seller-v2';
    let nonce = 0;
    const createClient = url => ({ getQuote: async order => {
      calls.push({ url, order: structuredClone(order) });
      const product = table[url][order.resource];
      const memo = order.order_binding === 'seller-v2'
        ? orderMemoV2(order.resource, order.input, (++nonce).toString(16).padStart(32, '0')) : orderMemo(order.resource, order.input);
      return { resource: order.resource, ...product, memo };
    } });
    const proposed = goalsFromModel(proposal(), c);
    assert.equal(proposed.goals[0].order_binding, v2On === 'primary' ? 'seller-v2' : undefined);
    const result = await compareApprovedQuotes({ config: c, proposedGoals: proposed, createClient });
    const selected = result.goals[0]; assert.equal(selected.provider_id, 'cheaper');
    assert.equal(selected.order_binding, v2On === 'alternative' ? 'seller-v2' : undefined);
    const primary = calls.find(call => call.url === c.provider_url && call.order.resource === 'compute');
    const alt = calls.find(call => call.url !== c.provider_url && call.order.resource === 'compute');
    assert.equal(primary.order.order_binding, v2On === 'primary' ? 'seller-v2' : undefined);
    assert.equal(alt.order.order_binding, v2On === 'alternative' ? 'seller-v2' : undefined);
    const plan = await planFromQuotes({ contractId: c.contract_id, ownerAccountId: c.owner_account_id, goals: [selected],
      getQuote: createClient(selected.provider_url).getQuote });
    if (selected.order_binding) assert.equal(challengeFromOrderMemo('compute', selected.input, plan.requests[0].memo).length, 32);
    else assert.equal(plan.requests[0].memo, orderMemo('compute', selected.input));
    const tampered = structuredClone(proposed);
    if (v2On === 'primary') delete tampered.goals[0].order_binding;
    else tampered.goals[0].order_binding = 'seller-v2';
    const count = calls.length;
    await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: tampered, createClient }), /unauthorized financial/);
    assert.equal(calls.length, count);
  }
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

test('large comparisons bound quote concurrency and preserve owner order', async () => {
  const c = config();
  c.max_tasks = 10; c.required_resources = ['compute']; delete c.resources.storage;
  c.resources.compute.max_tasks = 10;
  c.resources.compute.max_total_amount = '1000000000000000000000';
  c.resources.compute.alternatives = Array.from({ length: 4 }, (_, i) => ({
    id: `alt${i}`, provider_url: `https://vendor${i}.example`, policy_id: `policy${i}`,
    payee: `vendor${i}.testnet`, max_amount: c.resources.compute.max_amount,
  }));
  const tasks = Array.from({ length: 10 }, (_, i) => ({ resource: 'compute', input: { text: `work ${i}`, rounds: 2 } }));
  const proposedGoals = goalsFromModel({ tasks }, c);
  let active = 0, maximum = 0, calls = 0;
  const createClient = url => ({ getQuote: async ({ resource, input }) => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, url === c.provider_url ? 4 : 2));
    active--;
    const index = c.resources.compute.alternatives.findIndex(offer => offer.provider_url === url);
    const offer = index < 0 ? c.resources.compute : c.resources.compute.alternatives[index];
    return { resource, policy_id: offer.policy_id, token: c.resources.compute.token, payee: offer.payee,
      amount: '80', memo: orderMemo(resource, input) };
  } });
  const result = await compareApprovedQuotes({ config: c, proposedGoals, createClient });
  assert.equal(calls, 50); assert.equal(maximum, 5); assert.equal(active, 0);
  assert.ok(result.goals.every(goal => goal.provider_id === 'primary'));
  assert.deepEqual(result.goals.map(goal => goal.id), tasks.map((_, i) => `compute-${i + 1}`));
  assert.deepEqual(result.quote_comparisons[0].quotes.map(quote => quote.provider_id), ['primary', 'alt0', 'alt1', 'alt2', 'alt3']);
});

test('a failed quote stops queued requests and waits for in-flight requests; no partial selection escapes', async () => {
  const c = config(); c.max_tasks = 4; c.required_resources = ['compute']; delete c.resources.storage;
  c.resources.compute.max_tasks = 4; c.resources.compute.max_total_amount = '400000000000000000000';
  const tasks = Array.from({ length: 4 }, (_, i) => ({ resource: 'compute', input: { text: `work ${i}`, rounds: 2 } }));
  let active = 0, calls = 0;
  const createClient = url => ({ getQuote: async ({ resource, input }) => {
    calls++; active++;
    if (url === c.provider_url && input.text === 'work 0') { active--; throw new Error('offline'); }
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    const offer = url === c.provider_url ? c.resources.compute : c.resources.compute.alternatives[0];
    return { resource, policy_id: offer.policy_id, token: c.resources.compute.token, payee: offer.payee,
      amount: '80', memo: orderMemo(resource, input) };
  } });
  await assert.rejects(compareApprovedQuotes({ config: c, proposedGoals: goalsFromModel({ tasks }, c), createClient }), /comparison failed: offline/);
  assert.ok(calls <= 5); assert.equal(active, 0);
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
    c => { c.resources.compute.alternatives[0].order_binding = 'unsupported'; },
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
