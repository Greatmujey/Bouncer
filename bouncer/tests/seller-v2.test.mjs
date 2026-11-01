// Offline only: synthetic FINAL receipts, real seller state and buyer logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceProvider, normalizeOrder, orderMemo, orderMemoV2, challengeFromOrderMemo, MAX_SELLER_QUOTES } from '../services/resource-provider.mjs';
import { httpResourceProvider, planFromQuotes, runResourceAgent } from '../agent/resource-agent.mjs';
import { requestFingerprint } from '../agent/procurement.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'wrap.testnet', payee = 'vendor.testnet';
const products = () => Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: 'resources', token, payee, amount: '10' }]));
const input = { text: 'same work', rounds: 2 };
const goal = () => ({ id: 'work', resource: 'compute', policy_id: 'resources', token, payee,
  max_amount: '100', order_binding: 'seller-v2', input });
const issued = (inputValue = input, challenge = '00112233445566778899aabbccddeeff') => ({
  resource: 'compute', policy_id: 'resources', token, payee, amount: '10', memo: orderMemoV2('compute', inputValue, challenge) });
const quotePlan = (goals, getQuote, journal) => planFromQuotes({ contractId: contract, ownerAccountId: owner, goals, getQuote, journal });
function evidence(hash, memo, product = products().compute) {
  return mockGuardedPayment({ hash, owner, contract, args: { policy_id: product.policy_id, expected_token: product.token,
    payee: product.payee, amount: product.amount, memo } });
}
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-seller-v2-')), receipts = new Map();
  let calls = 0;
  const rpcProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash, id, wait) {
    calls++; assert.equal(id, owner); assert.equal(wait, 'FINAL');
    if (!receipts.has(hash)) throw new Error('unknown synthetic transaction');
    return structuredClone(receipts.get(hash));
  }, ...overrides.rpcProvider };
  const options = { rpcProvider, contractId: contract, ownerAccountId: owner, products: products(), dataDir: dir, ...overrides.options };
  return { dir, options, receipts, get calls() { return calls; },
    create() { return createResourceProvider(options); }, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
const quoteRequest = (resource, order) => ({ resource, input: order, order_binding: 'seller-v2' });
const redemption = (resource, order, memo, hash) => ({ tx_hash: hash, resource, input: order, memo });

test('v2 memo has a stable domain-separated vector and preserves legacy vectors', () => {
  const challenge = '00112233445566778899aabbccddeeff';
  const normalized = normalizeOrder('compute', { rounds: 2, text: 'same work' });
  const expectedDigest = crypto.createHash('sha256').update(`bouncer-order-v2\0compute\0${challenge}\0${JSON.stringify(normalized)}`).digest('hex');
  const memo = orderMemoV2('compute', input, challenge);
  assert.equal(memo, `bouncer-order-v2:compute:${challenge}:${expectedDigest}`);
  assert.equal(memo, 'bouncer-order-v2:compute:00112233445566778899aabbccddeeff:88425334a4bb614fc54e3425a4d9cb3203fa9b4548ac732e006fd3d53d315fc5');
  assert.equal(orderMemoV2('compute', { text: 'A\nπ😀', rounds: 3 }, 'ffeeddccbbaa99887766554433221100'),
    'bouncer-order-v2:compute:ffeeddccbbaa99887766554433221100:e014b592b4181aa13caeb34013188ae2dff73c4c7d75379de2ad0c1c1ccb5417');
  assert.equal(challengeFromOrderMemo('compute', input, memo), challenge);
  assert.notEqual(memo, orderMemoV2('compute', input, 'f'.repeat(32)));
  assert.notEqual(memo, orderMemoV2('compute', { ...input, text: 'other' }, challenge));
  assert.equal(orderMemo('compute', { rounds: 2, text: 'same work' }), orderMemo('compute', input));
  for (const invalid of ['f'.repeat(31), 'F'.repeat(32), 'z'.repeat(32), '', null]) assert.throws(() => orderMemoV2('compute', input, invalid), /challenge/);
  assert.throws(() => challengeFromOrderMemo('compute', { ...input, rounds: 3 }, memo), /exact order/);
  assert.throws(() => challengeFromOrderMemo('api', { text: 'same work' }, memo), /exact order/);
  assert.throws(() => challengeFromOrderMemo('compute', input, `${memo}x`), /exact order/);
  const inherited = Object.assign(Object.create({ text: 'inherited' }), { rounds: 2, unrelated: true });
  assert.throws(() => normalizeOrder('compute', inherited), /compute needs/);
});

test('buyer requires owner opt-in, rejects downgrade, tampering, reused challenges and invalid later goals', async () => {
  const g = goal(); let calls = 0;
  const plan = await quotePlan([g], async order => { calls++; assert.deepEqual(order, quoteRequest('compute', input)); return issued(); });
  assert.equal(calls, 1); assert.equal(plan.requests[0].memo, issued().memo);
  const legacy = { ...g }; delete legacy.order_binding;
  await assert.rejects(quotePlan([g], async () => ({ ...issued(), memo: orderMemo('compute', input) })), /exact order/);
  await assert.rejects(quotePlan([legacy], async () => issued()), /exact order/);
  for (const changed of [{ payee: 'attacker.testnet' }, { token: 'other.testnet' }, { amount: '101' },
    { memo: orderMemoV2('compute', { text: 'other', rounds: 2 }, '0'.repeat(32)) }]) {
    await assert.rejects(quotePlan([g], async () => ({ ...issued(), ...changed })));
  }
  const second = { ...g, id: 'second', input: { text: 'different', rounds: 2 } };
  await assert.rejects(quotePlan([g, second], async ({ input: current }) => issued(current)), /challenge was reused/);
  let contacted = 0;
  const invalidLater = { ...second, order_binding: 'unknown' };
  await assert.rejects(quotePlan([g, invalidLater], async () => { contacted++; return issued(); }), /unsupported/);
  assert.equal(contacted, 0);
  await assert.rejects(quotePlan([g, { ...g }], async () => { contacted++; return issued(); }), /duplicate/);
  assert.equal(contacted, 0);
  const pending = { get: id => id === second.id ? { status: 'pending' } : undefined };
  await assert.rejects(quotePlan([g, second], async () => { contacted++; return issued(); }, pending), /unresolved pending/);
  assert.equal(contacted, 0);
});

test('reviewed goals and input remain fixed even if a quote callback mutates the caller', async () => {
  const g = goal(), original = structuredClone(g), second = { ...structuredClone(g), id: 'second' };
  let count = 0;
  const result = await quotePlan([g, second], async order => {
    assert.equal(Object.isFrozen(order.input), true);
    g.payee = 'attacker.testnet'; second.input.text = 'changed';
    return issued(order.input, (++count).toString(16).padStart(32, '0'));
  });
  assert.equal(result.requests[0].payee, original.payee);
  assert.equal(challengeFromOrderMemo('compute', original.input, result.requests[1].memo), '0'.repeat(31) + '2');
});

test('buyer reuses the journaled v2 challenge without a new quote and refuses mode changes', async () => {
  const g = goal(), first = await quotePlan([g], async () => issued()), request = first.requests[0];
  const journal = { get: () => ({ status: 'completed', request, fingerprint: requestFingerprint(request) }) };
  const reused = await quotePlan([g], async () => { throw new Error('must not quote'); }, journal);
  assert.deepEqual(reused, first);
  const legacy = { ...g }; delete legacy.order_binding;
  await assert.rejects(quotePlan([legacy], async () => { throw new Error('must not quote'); }, journal), /recorded payment does not match/);
  const missing = { get: () => ({ status: 'completed', fingerprint: requestFingerprint(request) }) };
  await assert.rejects(quotePlan([g], async () => { throw new Error('must not quote'); }, missing), /original recorded request/);
  let quoted = false;
  await assert.rejects(runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: [g], execute: true,
    journal: { get() {}, put() {} }, getQuote: async () => { quoted = true; }, fulfill: async () => {}, log: () => {} }), /durable signed-hash/);
  assert.equal(quoted, false);
});

test('seller persists fresh, distinct quotes and honors an earlier product snapshot', async () => {
  const f = fixture(), provider = f.create(); let reopened;
  try {
    const first = provider.quote(quoteRequest('compute', input)), second = provider.quote(quoteRequest('compute', input));
    const firstChallenge = challengeFromOrderMemo('compute', input, first.memo), secondChallenge = challengeFromOrderMemo('compute', input, second.memo);
    assert.notEqual(firstChallenge, secondChallenge); assert.notEqual(first.memo, second.memo);
    let state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.version, 3); assert.equal(state.quotes[firstChallenge].tx_hash, null);
    assert.deepEqual(state.quotes[firstChallenge].product, products().compute);
    await provider.close();
    // Price changes must not silently reinterpret a quote that was already issued.
    f.options.products = products(); f.options.products.compute.amount = '99';
    reopened = f.create(); const hash = mockHash('v2-first'); f.receipts.set(hash, evidence(hash, first.memo));
    const result = await reopened.redeem(redemption('compute', input, first.memo, hash));
    assert.equal(result.type, 'compute'); assert.equal(result.rounds, 2);
    state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.quotes[firstChallenge].tx_hash, hash); assert.equal(state.redemptions[hash].status, 'completed');
    assert.equal(f.calls, 1); assert.deepEqual(await reopened.redeem(redemption('compute', input, first.memo, hash)), result); assert.equal(f.calls, 1);
    const other = mockHash('v2-second-payment'); f.receipts.set(other, evidence(other, first.memo));
    await assert.rejects(reopened.redeem(redemption('compute', input, first.memo, other)), /already claimed/); assert.equal(f.calls, 1);
    await assert.rejects(reopened.redeem(redemption('compute', { ...input, text: 'tampered' }, first.memo, hash)), /exact order/);
    await assert.rejects(reopened.redeem(redemption('compute', input, orderMemoV2('compute', input, '0'.repeat(32)), hash)), /quote is missing/);
  } finally { await provider.close(); if (reopened) await reopened.close(); f.cleanup(); }
});

test('HTTP v2 supports maximally JSON-escaped valid input while bounding oversized requests', async () => {
  const f = fixture(), provider = f.create();
  try {
    await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${provider.server.address().port}`;
    const client = httpResourceProvider(url, (target, options) => fetch(target, { ...options, headers: { ...options.headers, connection: 'close' } }));
    const data = { name: 'escaped', content: '\0'.repeat(4096) };
    const request = quoteRequest('storage', data);
    assert(Buffer.byteLength(JSON.stringify(request)) > 12_000);
    const quote = await client.getQuote(request), hash = mockHash('escaped-http-v2');
    f.receipts.set(hash, evidence(hash, quote.memo, products().storage));
    const result = await client.fulfill(redemption('storage', data, quote.memo, hash));
    assert.equal(result.bytes, 4096); assert.deepEqual(Buffer.from(await client.readStorage(result.object_id)), Buffer.alloc(4096));
    await assert.rejects(client.getQuote(quoteRequest('storage', { name: 'oversized', content: 'x'.repeat(33_000) })), /too large|fetch failed/);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(Object.keys(state.quotes).length, 1);
  } finally { await provider.close(); f.cleanup(); }
});

test('issuing a v2 quote upgrades a v1 redemption store without losing completed legacy payments', async () => {
  const f = fixture(), provider = f.create(); let reopened;
  try {
    const hash = mockHash('legacy-before-upgrade'), memo = orderMemo('compute', input);
    f.receipts.set(hash, evidence(hash, memo));
    const legacyOrder = { tx_hash: hash, resource: 'compute', input };
    const result = await provider.redeem(legacyOrder);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8')).version, 2);
    const quote = provider.quote(quoteRequest('compute', input));
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.version, 3); assert.equal(state.redemptions[hash].status, 'completed');
    assert.equal(Object.keys(state.quotes).length, 1); assert.ok(quote.memo.startsWith('bouncer-order-v2:'));
    await provider.close(); reopened = f.create();
    assert.deepEqual(await reopened.redeem(legacyOrder), result); assert.equal(f.calls, 1);
  } finally { await provider.close(); if (reopened) await reopened.close(); f.cleanup(); }
});

test('one seller challenge can claim only one of two concurrently verified transactions', async () => {
  let release, arrivals = 0, ready;
  const blocked = new Promise(resolve => { release = resolve; }), both = new Promise(resolve => { ready = resolve; });
  const f = fixture(), original = f.options.rpcProvider.txStatusReceipts;
  f.options.rpcProvider.txStatusReceipts = async (...args) => { arrivals++; if (arrivals === 2) ready(); await blocked; return original(...args); };
  const provider = f.create(), data = { name: 'once', content: 'one object' };
  try {
    const quote = provider.quote(quoteRequest('storage', data)), a = mockHash('v2-race-a'), b = mockHash('v2-race-b');
    f.receipts.set(a, evidence(a, quote.memo, products().storage)); f.receipts.set(b, evidence(b, quote.memo, products().storage));
    const pending = [provider.redeem(redemption('storage', data, quote.memo, a)), provider.redeem(redemption('storage', data, quote.memo, b))];
    await both; release(); const results = await Promise.allSettled(pending);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /already claimed/);
    assert.equal(fs.readdirSync(path.join(f.dir, 'objects')).length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(Object.keys(state.redemptions).length, 1);
    assert.equal(Object.values(state.redemptions)[0].status, 'completed');
  } finally { release(); await provider.close(); f.cleanup(); }
});

test('a v2 quote write failure returns no quote and poisons the seller until reconciliation', async () => {
  const f = fixture(), provider = f.create(), original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('synthetic fsync failure'); };
    assert.throws(() => provider.quote(quoteRequest('compute', input)), /persistence failed/);
    fs.fsyncSync = original;
    assert.throws(() => provider.quote(quoteRequest('compute', input)), /persistence failed/);
    await assert.rejects(provider.redeem({ tx_hash: mockHash('unused'), resource: 'compute', input }), /persistence failed/);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, 'objects')), []);
  } finally { fs.fsyncSync = original; await provider.close(); f.cleanup(); }
});

test('a failed v2 storage side effect keeps the quote claimed and never repeats work after restart', async () => {
  const f = fixture(), provider = f.create(), original = fs.fsyncSync; let reopened;
  try {
    const data = { name: 'pending', content: 'once only' }, quote = provider.quote(quoteRequest('storage', data));
    const hash = mockHash('v2-failed-storage'), other = mockHash('v2-failed-other');
    f.receipts.set(hash, evidence(hash, quote.memo, products().storage)); f.receipts.set(other, evidence(other, quote.memo, products().storage));
    let calls = 0;
    // Pending state file + directory sync succeed; object-file sync fails.
    fs.fsyncSync = fd => { if (++calls === 3) throw new Error('injected object sync failure'); return original(fd); };
    await assert.rejects(provider.redeem(redemption('storage', data, quote.memo, hash)), /object persistence failed/);
    fs.fsyncSync = original;
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    const challenge = challengeFromOrderMemo('storage', data, quote.memo);
    assert.equal(state.quotes[challenge].tx_hash, hash); assert.equal(state.redemptions[hash].status, 'pending');
    await provider.close(); reopened = f.create();
    await assert.rejects(reopened.redeem(redemption('storage', data, quote.memo, hash)), /manual reconciliation/);
    await assert.rejects(reopened.redeem(redemption('storage', data, quote.memo, other)), /already claimed/);
    assert.equal(f.calls, 1);
  } finally { fs.fsyncSync = original; await provider.close(); if (reopened) await reopened.close(); f.cleanup(); }
});

test('saved v2 quote corruption, inconsistent claims and capacity fail closed on restart', async () => {
  const f = fixture(), provider = f.create();
  try {
    const quote = provider.quote(quoteRequest('compute', input)), challenge = challengeFromOrderMemo('compute', input, quote.memo);
    await provider.close(); const file = path.join(f.dir, 'redemptions.json'), original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const variants = [
      state => { state.quotes[challenge].tx_hash = mockHash('orphaned-claim'); },
      state => { state.quotes[challenge].product.payee = 'attacker.near'; },
      state => { state.quotes[challenge].memo = state.quotes[challenge].memo.replace(challenge, '0'.repeat(32)); },
      state => { state.quotes[challenge].read_only = true; },
      state => { state.network = 'mainnet'; },
    ];
    for (const mutate of variants) {
      const changed = structuredClone(original); mutate(changed); fs.writeFileSync(file, JSON.stringify(changed));
      assert.throws(() => f.create());
    }
    // Capacity is bounded before issuing another quote; no open order is evicted.
    const full = structuredClone(original), sample = full.quotes[challenge]; full.quotes = {};
    for (let i = 0; i < MAX_SELLER_QUOTES; i++) {
      const nonce = i.toString(16).padStart(32, '0');
      full.quotes[nonce] = { ...sample, memo: orderMemoV2('compute', input, nonce) };
    }
    fs.writeFileSync(file, JSON.stringify(full)); const atCapacity = f.create();
    try { assert.throws(() => atCapacity.quote(quoteRequest('compute', input)), /capacity reached/); }
    finally { await atCapacity.close(); }
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).quotes).length, MAX_SELLER_QUOTES);
  } finally { await provider.close(); f.cleanup(); }
});

test('read-only API failure preserves the claim and can retry only the original transaction after restart', async () => {
  let fetches = 0;
  const dataFetch = async () => ++fetches === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({
    private: false, full_name: 'near/near-api-js', id: 12345, description: null,
    stargazers_count: 1, forks_count: 2, open_issues_count: 3, license: null,
  }));
  const f = fixture({ options: { dataFetch } }), provider = f.create(); let reopened;
  try {
    const repo = { repo: 'near/near-api-js' }, quote = provider.quote(quoteRequest('api', repo));
    const nonce = challengeFromOrderMemo('api', repo, quote.memo), hash = mockHash('v2-github');
    f.receipts.set(hash, evidence(hash, quote.memo, products().api));
    await assert.rejects(provider.redeem(redemption('api', repo, quote.memo, hash)), /HTTP 503/);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'redemptions.json'), 'utf8'));
    assert.equal(state.quotes[nonce].tx_hash, hash); assert.equal(state.redemptions[hash], undefined);
    await provider.close(); reopened = f.create();
    const other = mockHash('v2-github-duplicate'); f.receipts.set(other, evidence(other, quote.memo, products().api));
    await assert.rejects(reopened.redeem(redemption('api', repo, quote.memo, other)), /already claimed/);
    const result = await reopened.redeem(redemption('api', repo, quote.memo, hash));
    assert.equal(result.repository, 'near/near-api-js'); assert.equal(fetches, 2);
    assert.deepEqual(await reopened.redeem(redemption('api', repo, quote.memo, hash)), result); assert.equal(fetches, 2);
  } finally { await provider.close(); if (reopened) await reopened.close(); f.cleanup(); }
});
