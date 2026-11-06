/** Offline experiment only. Synthetic host/token flows are not a NEAR chain,
 * an actual Buffer order, an audit, or evidence of independent delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { BUFFER_TESTNET_CONTRACT as SELLER, buildBufferForwarder, checkBufferOrderResponse, checkBufferQuoteResponse,
  validateBufferForwarderTerms } from '../experiments/buffer-forwarder/build.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SyntheticNearHost, OWNER, VAULT, AGENT_PK, AGENT_BYTES, TIME_NS } from './fixtures/v11-synthetic-host.mjs';

const ADAPTER = 'forward.owner.testnet', NOW = Number(TIME_NS / 1_000_000n), PRICE = '20000000';
const FORWARDER_BYTES = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 9)]);
const FORWARDER_PK = `ed25519:${nearApi.utils.serialize.base_encode(FORWARDER_BYTES.subarray(1))}`;
const BRIEF = 'Analyze recent testnet agent economies without spending real money.';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const terms = changes => ({ owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: FORWARDER_PK,
  vault_agent_public_key: AGENT_PK, policy_id: 'research', intent_id: 'buffer-1', amount: PRICE,
  expires_at_ms: NOW + 60_000, native_return_cap: '1000000000000000000000000',
  native_reserve: '1000000000000000000000000', api_order_id: '123e4567-e89b-12d3-a456-426614174000',
  onchain_order_id: 'o-123456789abc', sku: 'weekly-market-brief', brief_sha256: hash(BRIEF), ...changes });
const request = () => ({ brief: BRIEF, sku: 'weekly-market-brief', customerAccount: ADAPTER });
const response = () => ({ orderId: terms().api_order_id, onchainOrderId: terms().onchain_order_id, accessToken: 'ab'.repeat(24),
  payment: { tokenContract: TOKEN, method: 'ft_transfer_call', args: { receiver_id: SELLER, amount: PRICE,
    msg: JSON.stringify({ order_id: terms().onchain_order_id, sku: terms().sku }) },
    attachedDeposit: '1 yoctoNEAR', gas: '100 Tgas' }, nearCliCommand: 'not used' });
const build = changes => buildBufferForwarder(terms(changes), { nowMs: NOW });
const agent = changes => ({ current: ADAPTER, predecessor: OWNER, signer: OWNER, signerPk: FORWARDER_BYTES,
  deposit: 0n, timestamp: TIME_NS, balance: 10n ** 26n, ...changes });
const owner = changes => agent({ deposit: 1n, signerPk: Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 8)]), ...changes });
function host(wasm) {
  const h = new SyntheticNearHost(wasm);
  h.env.promise_batch_action_transfer = (index, ptr) => {
    const p = h.promises[Number(index)], b = h.read(ptr, 16); assert.ok(p);
    p.actions.push({ method: '$native_transfer', amount: (b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n)).toString() });
  };
  return h;
}

test('matches a reviewed Buffer order without returning its private bearer or brief', () => {
  const out = checkBufferOrderResponse(terms(), request(), response(), { nowMs: NOW });
  assert.equal(out.checked, true); assert.equal(out.execution_authorized, false);
  assert.equal(out.amount, PRICE); assert.equal(out.bearer_returned, false);
  assert(!JSON.stringify(out).includes(response().accessToken)); assert(!JSON.stringify(out).includes(BRIEF));
  const numeric = response(); numeric.payment.args.amount = Number(PRICE);
  assert.equal(checkBufferOrderResponse(terms(), request(), numeric, { nowMs: NOW }).checked, true);
});

test('order matching rejects modified token, destination, price, order, message, request and bearer', () => {
  const mutations = [
    x => { x.request.brief += ' altered'; }, x => { x.request.customerAccount = VAULT; },
    x => { x.request.sku = 'crosschain-brief'; }, x => { x.request.extra = 'x'; },
    x => { x.response.orderId = '123e4567-e89b-12d3-a456-426614174001'; },
    x => { x.response.onchainOrderId = 'o-123456789abd'; }, x => { x.response.accessToken = 'broken'; },
    x => { x.response.payment.tokenContract = 'attacker.testnet'; },
    x => { x.response.payment.args.receiver_id = 'attacker.testnet'; },
    x => { x.response.payment.args.amount = '19999999'; }, x => { x.response.payment.args.amount = 2 ** 53; },
    x => { x.response.payment.args.msg = JSON.stringify({ order_id: 'o-123456789abd', sku: terms().sku }); },
    x => { x.response.payment.args.msg = JSON.stringify({ order_id: terms().onchain_order_id, sku: terms().sku, referrer: 'attacker.testnet' }); },
    x => { x.response.payment.args.referrer = 'attacker.testnet'; }, x => { x.response.payment.method = 'ft_transfer'; },
    x => { x.response.payment.attachedDeposit = '0'; }, x => { x.response.payment.gas = '300 Tgas'; },
  ];
  for (const mutate of mutations) {
    const sample = { request: request(), response: response() }; mutate(sample);
    assert.throws(() => checkBufferOrderResponse(terms(), sample.request, sample.response, { nowMs: NOW }));
  }
  let accessed = false; const sample = response();
  Object.defineProperty(sample.payment.args, 'amount', { enumerable: true, get() { accessed = true; return PRICE; } });
  assert.throws(() => checkBufferOrderResponse(terms(), request(), sample, { nowMs: NOW }));
  assert.equal(accessed, false);
});

function quoteFixture() {
  const quoteTerms = terms({ onchain_order_id: 'q-123456789abc', sku: 'custom-brief', amount: '5000000' });
  const request = { request: BRIEF, customerAccount: ADAPTER };
  const response = { orderId: quoteTerms.api_order_id, accessToken: 'ab'.repeat(24) };
  const expiration = NOW + 120_000;
  const order = { id: quoteTerms.api_order_id, onchainOrderId: quoteTerms.onchain_order_id, contractId: SELLER,
    tokenContract: TOKEN, sku: 'custom-brief', priceUnits: quoteTerms.amount, state: 'AWAITING_PAYMENT',
    authorised: true, brief: BRIEF, quote: { expiresAt: new Date(expiration).toISOString(),
      quoteTx: mockHash('synthetic-quote'), maxExpenseUnits: '1000000' } };
  const chainQuote = { sku: 'custom-brief', amount: quoteTerms.amount, max_expense: '1000000',
    expires_ns: String(BigInt(expiration) * 1_000_000n), paid: false };
  return { quoteTerms, request, response, order, chainQuote };
}
test('matches a custom quote and short-lived chain-view terms without returning private data', async () => {
  const f = quoteFixture(), out = checkBufferQuoteResponse(f.quoteTerms, f.request, f.response, f.order, f.chainQuote, { nowMs: NOW });
  assert.equal(out.checked, true); assert.equal(out.amount, '5000000');
  assert.equal(out.chain_view_provenance_verified, false); assert.equal(out.execution_authorized, false);
  assert(!JSON.stringify(out).includes(BRIEF)); assert(!JSON.stringify(out).includes(f.response.accessToken));
  const withRoundedNs = { ...f.chainQuote, expires_ns: Number(f.chainQuote.expires_ns) };
  assert.equal(checkBufferQuoteResponse(f.quoteTerms, f.request, f.response, f.order, withRoundedNs, { nowMs: NOW }).checked, true);
  const artifact = await buildBufferForwarder(f.quoteTerms, { nowMs: NOW });
  const h = host(artifact.wasm), call = h.call('open', {}, agent());
  assert.deepEqual(call.promises[0].actions[0].args, { receiver_id: SELLER, amount: '5000000',
    memo: 'bouncer:experimental-forwarder', msg: JSON.stringify({ order_id: f.quoteTerms.onchain_order_id, sku: 'custom-brief' }) });
  assert.throws(() => checkBufferOrderResponse(f.quoteTerms, request(), response(), { nowMs: NOW }));
});
test('custom quote rejects substitutions, spent/expired quotes and expiry mismatches', () => {
  const changes = [
    x => { x.request.request += 'changed'; }, x => { x.request.customerAccount = VAULT; },
    x => { x.response.accessToken = 'bad'; }, x => { x.response.orderId = 'wrong'; },
    x => { x.order.authorised = false; }, x => { x.order.onchainOrderId = 'q-123456789abd'; },
    x => { x.order.contractId = 'attacker.testnet'; }, x => { x.order.tokenContract = 'attacker.testnet'; },
    x => { x.order.priceUnits = '4999999'; }, x => { x.order.sku = 'weekly-market-brief'; },
    x => { x.order.state = 'PAID'; }, x => { x.order.brief += 'changed'; },
    x => { x.order.quote.quoteTx = 'bad'; }, x => { x.order.quote.maxExpenseUnits = '10'; },
    x => { x.chainQuote.sku = 'crosschain-brief'; }, x => { x.chainQuote.amount = '1'; },
    x => { x.chainQuote.paid = true; }, x => { x.chainQuote.max_expense = '5000001'; },
    x => { x.order.quote.expiresAt = new Date(NOW + 300_000).toISOString(); },
    x => { x.chainQuote.expires_ns = String(BigInt(NOW + 65_000) * 1_000_000n); x.order.quote.expiresAt = new Date(NOW + 65_000).toISOString(); },
  ];
  for (const mutate of changes) { const f = quoteFixture(); mutate(f);
    assert.throws(() => checkBufferQuoteResponse(f.quoteTerms, f.request, f.response, f.order, f.chainQuote, { nowMs: NOW })); }
});

test('forwarder terms fail closed on malformed keys, IDs, prices, expiry and alternate destinations', async () => {
  for (const changes of [{ owner: 'owner.near' }, { vault: 'other.testnet' }, { adapter: VAULT },
    { adapter: 'x.y.owner.testnet' }, { forwarder_agent_public_key: AGENT_PK }, { vault_agent_public_key: 'ed25519:bad' },
    { policy_id: 1 }, { intent_id: '../x' }, { amount: '0' }, { amount: '01' }, { amount: String(1n << 128n) },
    { native_reserve: '999999999999999999999999' }, { native_return_cap: '-1' },
    { expires_at_ms: NOW }, { expires_at_ms: NOW + 24 * 60 * 60 * 1000 + 1 },
    { api_order_id: 'bad' }, { onchain_order_id: 'o-bad' }, { sku: 'custom-brief' },
    { brief_sha256: 'bad' }, { seller: 'attacker.testnet' }, { token: 'attacker.testnet' }]) {
    await assert.rejects(build(changes));
  }
  let accessed = false; const malformed = terms();
  Object.defineProperty(malformed, 'amount', { enumerable: true, get() { accessed = true; return PRICE; } });
  assert.throws(() => validateBufferForwarderTerms(malformed, { nowMs: NOW })); assert.equal(accessed, false);
});

test('fixed one-shot bytecode pins Buffer terms and cannot call arbitrary seller methods', async () => {
  const first = await build(), second = await build();
  assert.deepEqual(first.wasm, second.wasm); assert.equal(first.wasm_sha256, second.wasm_sha256);
  assert.equal(first.review.token, TOKEN); assert.equal(first.review.escrow, SELLER);
  assert.equal(first.review.signed, false); assert.equal(first.review.sent, false);
  assert(!JSON.stringify(first.review).includes(BRIEF)); assert(!JSON.stringify(first.review).includes(response().accessToken));
  assert.notEqual(first.wasm_sha256, (await build({ amount: '1' })).wasm_sha256);
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(first.wasm)).map(x => x.name).sort();
  assert.deepEqual(exports, ['configuration', 'memory', 'open', 'opened', 'return_native', 'return_tokens'].sort());
  assert(first.imports.every(x => !/deploy|delete|add_key|delegate|create_account/i.test(x)));
  for (const bad of [{ predecessor: 'attacker.testnet' }, { signer: 'attacker.testnet' }, { current: VAULT },
    { signerPk: AGENT_BYTES }, { deposit: 1n }, { timestamp: BigInt(NOW + 60_001) * 1_000_000n }]) {
    const h = host(first.wasm); assert.throws(() => h.call('open', {}, agent(bad)), /FORWARDER BLOCKED/);
    assert.equal(h.call('opened', {}, agent()).value, false);
  }
  const h = host(first.wasm), call = h.call('open', { receiver_id: 'attacker.testnet', amount: '1' }, agent());
  assert.equal(call.promises.length, 1); assert.equal(call.promises[0].receiver, TOKEN);
  assert.equal(call.promises[0].actions[0].method, 'ft_transfer_call'); assert.equal(call.promises[0].actions[0].deposit, '1');
  assert.deepEqual(call.promises[0].actions[0].args, { receiver_id: SELLER, amount: PRICE,
    memo: 'bouncer:experimental-forwarder', msg: JSON.stringify({ order_id: terms().onchain_order_id, sku: terms().sku }) });
  assert.equal(h.call('opened', {}, agent()).value, true);
  assert.throws(() => h.call('open', {}, agent()), /FORWARDER BLOCKED/);
});

test('a fixed return targets only the vault and preserves the owner 1-yocto boundary', async () => {
  const h = host((await build()).wasm);
  for (const value of ['0', '01', '-1', '20000001', '1e2', '1","receiver_id":"attacker.testnet']) {
    assert.throws(() => h.call('return_tokens', { amount: value }, agent()), /FORWARDER BLOCKED/);
  }
  assert.throws(() => h.call('return_tokens', { amount: '1', receiver_id: 'attacker.testnet' }, agent()), /FORWARDER BLOCKED/);
  assert.throws(() => h.call('return_native', { amount: '1' }, agent()), /FORWARDER BLOCKED/);
  for (const actor of [agent(), owner()]) {
    const p = h.call('return_tokens', { amount: PRICE }, actor).promises[0];
    assert.equal(p.receiver, TOKEN); assert.deepEqual(p.actions[0].args, { receiver_id: VAULT, amount: PRICE,
      memo: 'bouncer:forwarder-return', msg: 'bouncer:forwarder-return' });
  }
});

const v12Path = process.env.BOUNCER_V12_WASM_PATH;
test('reviewed V12 and Buffer forwarder compose under simulated immediate and late returns',
  { skip: v12Path ? false : 'set BOUNCER_V12_WASM_PATH to the hash-pinned V12 artifact' }, async () => {
  const stat = fs.lstatSync(v12Path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === 536_651);
  const bytes = fs.readFileSync(v12Path);
  assert.equal(hash(bytes), '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12');
  for (const scenario of ['immediate-rejection', 'late-plain-refund']) {
    const artifact = await build(), forwarder = host(artifact.wasm), vault = new SyntheticNearHost(bytes);
    const ownerCall = { predecessor: OWNER, deposit: 1n }, agentCall = { predecessor: OWNER, signerPk: AGENT_BYTES };
    vault.call('new', { owner: OWNER });
    vault.call('set_policy', { policy_id: 'research', token: TOKEN, per_tx_cap: PRICE, daily_cap: PRICE }, ownerCall);
    vault.call('allow_payee', { policy_id: 'research', payee: ADAPTER }, ownerCall);
    vault.call('grant_agent_key', { policy_id: 'research', public_key: AGENT_PK }, ownerCall);
    vault.call('lock_ft_policy_to_intents', { policy_id: 'research' }, ownerCall);
    const balances = new Map([[VAULT, BigInt(PRICE)], [ADAPTER, 0n], [SELLER, 0n]]);
    vault.call('ft_on_transfer', { sender_id: OWNER, amount: PRICE, msg: '' }, { predecessor: TOKEN });
    vault.call('set_exact_ft_intent', { intent_id: 'buffer-1', policy_id: 'research', expected_token: TOKEN,
      payee: ADAPTER, amount: PRICE, memo: artifact.review.intent_memo, review_hash: artifact.review.review_sha256,
      expires_at_ms: String(NOW + 60_000), agent_public_key: AGENT_PK }, ownerCall);
    const funding = vault.call('execute_exact_ft', { intent_id: 'buffer-1' }, agentCall);
    balances.set(VAULT, 0n); balances.set(ADAPTER, BigInt(PRICE));
    vault.call('after_exact_ft_transfer', funding.promises[1].actions[0].args, { predecessor: VAULT, promiseResult: 'success' });
    const opened = forwarder.call('open', {}, agent()).promises[0].actions[0];
    assert.equal(opened.args.receiver_id, SELLER); assert.equal(opened.args.amount, PRICE);
    if (scenario === 'late-plain-refund') {
      balances.set(ADAPTER, 0n); balances.set(SELLER, BigInt(PRICE));
      // Model a later plain-FT refund to the forwarder; V12 receives no hook.
      balances.set(SELLER, 0n); balances.set(ADAPTER, BigInt(PRICE));
    }
    assert.equal(vault.call('vault_balance', { token: TOKEN }).value, '0');
    const returned = forwarder.call('return_tokens', { amount: PRICE }, agent()).promises[0].actions[0];
    balances.set(ADAPTER, 0n); balances.set(VAULT, BigInt(PRICE));
    assert.equal(vault.call('ft_on_transfer', { sender_id: ADAPTER, amount: PRICE, msg: returned.args.msg },
      { predecessor: TOKEN }).value, '0');
    assert.equal(vault.call('vault_balance', { token: TOKEN }).value, PRICE);
    assert.equal(vault.call('daily_spent', { policy_id: 'research' }).value, PRICE);
    assert.equal(balances.get(VAULT), BigInt(PRICE)); assert.equal(balances.get(ADAPTER), 0n);
    assert.throws(() => forwarder.call('open', {}, agent()), /FORWARDER BLOCKED/);
    assert.throws(() => vault.call('execute_exact_ft', { intent_id: 'buffer-1' }, agentCall), /consumed, cancelled, expired or stale/);
  }
});
