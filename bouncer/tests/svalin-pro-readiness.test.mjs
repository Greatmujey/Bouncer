import test from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE, probeSvalinProOffer, summarizeSvalinProOffer,
  validateSvalinProCheckout } from '../agent/svalin-pro-readiness.mjs';

const NOW = Date.parse('2026-11-01T19:25:00.000Z');
function offer() {
  return { plans: [{ id: 'month', usd: 5, days: 30 }, { id: 'year', usd: 48, days: 365 }],
    callsPerDay: 100, near: { network: 'near:testnet', environment: 'testnet',
      payTo: SVALIN_PAYEE, token: CIRCLE_TESTNET_USDC }, solana: null };
}
function checkout() {
  return { plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: CIRCLE_TESTNET_USDC,
    amount: '5.004217', expiresAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString() };
}

test('public offer is identified as testnet observation, never fulfillment', () => {
  assert.deepEqual(summarizeSvalinProOffer(offer(), NOW), {
    status: 'PUBLIC_OFFER_ONLY', observed_at: '2026-11-01T19:25:00.000Z', network: 'near:testnet',
    environment: 'testnet', token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE, plan: 'month',
    price_atoms: '5000000', checkout_amount_min_atoms: '5000001', checkout_amount_max_atoms: '5009999',
    duration_days: 30, advertised_calls_per_day: 100, signed_offer: false, reservation_created: false,
    payment_sent: false, fulfillment_verified: false,
  });
});

test('offer validation fails closed for mainnet, drift, duplicate plans and malformed data', () => {
  const mutations = [
    o => { o.near.network = 'near:mainnet'; }, o => { o.near.environment = 'mainnet'; },
    o => { o.near.payTo = 'other.testnet'; }, o => { o.near.token = 'other.testnet'; },
    o => { o.near = null; }, o => { o.callsPerDay = 99; },
    o => { o.plans[0].usd = 6; }, o => { o.plans[0].usd = '5'; }, o => { o.plans[0].days = 31; },
    o => { o.plans.push({ ...o.plans[0] }); }, o => { o.plans = []; },
    o => { o.plans = Array(11).fill(o.plans[0]); },
  ];
  for (const mutate of mutations) { const input = offer(); mutate(input); assert.throws(() => summarizeSvalinProOffer(input, NOW)); }
  for (const invalid of [null, [], {}, 'offer']) assert.throws(() => summarizeSvalinProOffer(invalid, NOW));
  for (const invalid of [0, NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => summarizeSvalinProOffer(offer(), invalid));
  }
});

test('synthetic checkout uses exact integer atoms and never copies an injected bearer code', () => {
  const input = checkout();
  input.code = 'svp_fake-secret-not-for-logs';
  const result = validateSvalinProCheckout({ offer: offer(), checkout: input, nowMs: NOW });
  assert.equal(result.amount_atoms, '5004217');
  assert.equal(result.authorization, 'NOT_APPROVED');
  assert.equal(result.quote_signed, false);
  assert.equal(JSON.stringify(result).includes('svp_fake'), false);
  for (const [value, atoms] of [['5.000001', '5000001'], ['5.009999', '5009999']]) {
    const c = checkout(); c.amount = value;
    assert.equal(validateSvalinProCheckout({ offer: offer(), checkout: c, nowMs: NOW }).amount_atoms, atoms);
  }
});

test('synthetic checkout rejects amount, payer terms, network and expiry substitutions', () => {
  const mutations = [
    c => { c.amount = '5.000000'; }, c => { c.amount = '5.010000'; }, c => { c.amount = '5'; },
    c => { c.amount = '5.1'; }, c => { c.amount = '05.000001'; }, c => { c.amount = 5.000001; },
    c => { c.amount = '-5.004217'; }, c => { c.amount = '5.0042170'; },
    c => { c.payTo = 'other.testnet'; }, c => { c.token = 'other.testnet'; },
    c => { c.network = 'near:mainnet'; }, c => { c.plan = 'year'; },
    c => { c.expiresAt = '2026-11-03'; }, c => { c.expiresAt = 'not-a-date'; },
    c => { c.expiresAt = new Date(NOW + 599_999).toISOString(); },
    c => { c.expiresAt = new Date(NOW + 48 * 3600_000 + 300_001).toISOString(); },
  ];
  for (const mutate of mutations) { const c = checkout(); mutate(c); assert.throws(() => validateSvalinProCheckout({ offer: offer(), checkout: c, nowMs: NOW })); }
  assert.throws(() => validateSvalinProCheckout({ offer: { ...offer(), callsPerDay: 0 }, checkout: checkout(), nowMs: NOW }));
});

test('readiness probe makes exactly one bounded, anonymous GET and refuses redirects or a broken offer', async () => {
  const calls = [];
  const response = () => new Response(JSON.stringify(offer()), { status: 200 });
  const result = await probeSvalinProOffer({ nowMs: NOW, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.equal(result.status, 'PUBLIC_OFFER_ONLY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SVALIN_ORIGIN}/v1/pro`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.authorization, undefined);
  await assert.rejects(probeSvalinProOffer({ nowMs: NOW, fetchImpl: async () => new Response('no', { status: 404 }) }), /HTTP 404/);
  await assert.rejects(probeSvalinProOffer({ nowMs: NOW, fetchImpl: async () => new Response('x'.repeat(65_537)) }), /too large/);
  await assert.rejects(probeSvalinProOffer({ nowMs: NOW, fetchImpl: async () => new Response('{broken') }), /invalid JSON/);
  const wrong = offer(); wrong.near.environment = 'mainnet';
  await assert.rejects(probeSvalinProOffer({ nowMs: NOW, fetchImpl: async () => new Response(JSON.stringify(wrong)) }), /testnet profile/);
});
