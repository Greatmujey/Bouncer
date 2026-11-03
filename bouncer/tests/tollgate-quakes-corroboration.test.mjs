import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { TollgateResponseStore } from '../agent/tollgate-response-store.mjs';
import { makeTollgateQuakesReview, tollgateQuakesReviewHash, QUAKES_PRICE_YOCTO } from '../agent/tollgate-quakes-v13.mjs';
import { canonicalUsgsComparisonUrl, corroborateTollgateQuakes } from '../agent/tollgate-quakes-corroboration.mjs';

const k = () => nearApi.KeyPair.fromRandom('ed25519'), pub = x => String(x.getPublicKey());
function fixture(t, { empty = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-quakes-source-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TollgateResponseStore(dir), now = Date.now(), owner = k(), agent = k(), voucher = k();
  const ownerPlan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', public_key: pub(owner) };
  const review = makeTollgateQuakesReview({ ownerPlan, intentId: 'one-quake', agentPublicKey: pub(agent),
    voucherPublicKey: pub(voucher), expiresAtMs: String(now + 120_000) });
  const start = new Date(now - 24 * 3600_000).toISOString(), time = new Date(now - 3000).toISOString();
  const quake = { id: 'us-event-test', magnitude: 5.3, place: 'Synthetic Ocean', time, depth_km: 12 };
  const body = { source: 'USGS Earthquake Hazards Program, FDSN event API',
    source_url: `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=5&starttime=${encodeURIComponent(start)}&limit=10`,
    fetched_at: new Date(now).toISOString(), cached: false, query: { min_magnitude: 5, hours: 24, limit: 10 },
    count: empty ? 0 : 1, quakes: empty ? [] : [quake], paid: { channel_id: '7', nonce: '1', price_yocto: QUAKES_PRICE_YOCTO } };
  const raw = Buffer.from(JSON.stringify(body)), reviewHash = tollgateQuakesReviewHash(review);
  const saved = store.save({ reviewHash, channelId: '7', observedAtMs: now, rawBytes: raw });
  const purchase = { status: 'PROVIDER_RETURNED_DATA', network: 'testnet', owner: review.owner, vault: review.vault,
    review_hash: reviewHash, intent_id: review.intent_id, channel_id: '7', price_yocto: review.price_yocto,
    seller_claimed_acceptance: true, response_locally_retained: true, response_sha256: saved.response_sha256, data: body };
  const upstream = { type: 'FeatureCollection', features: empty ? [] : [{ type: 'Feature', id: quake.id,
    properties: { mag: quake.magnitude, place: quake.place, time: Date.parse(quake.time) } }] };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; const u = new URL(url); assert.equal(u.origin, 'https://earthquake.usgs.gov');
    assert.equal(u.pathname, '/fdsnws/event/1/query'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['x-payment'], undefined);
    return Response.json(upstream);
  };
  return { review, purchase, store, body, upstream, now, fetchImpl, calls: () => calls };
}
const args = f => ({ review: f.review, purchase: f.purchase, responseStore: f.store, fetchImpl: f.fetchImpl, now: () => f.now });

test('exact retained seller bytes match an independently fetched synthetic USGS result', async t => {
  const f = fixture(t), out = await corroborateTollgateQuakes(args(f));
  assert.equal(f.calls(), 1); assert.equal(out.status, 'UPSTREAM_DATA_CORROBORATED');
  assert.equal(out.source_data_corroborated, true); assert.equal(out.settlement_verified, false);
  assert.equal(out.payment_sent, false); assert.equal(out.seller_contacted, false);
  assert.equal(out.seller_response_sha256, f.purchase.response_sha256);
  assert.equal(out.upstream_response_sha256, crypto.createHash('sha256').update(JSON.stringify(f.upstream)).digest('hex'));
  assert.deepEqual(out.compared_fields, ['id', 'magnitude', 'place', 'time']);
});

test('upstream changes and empty results do not falsely claim independent event data', async t => {
  const f = fixture(t); f.upstream.features[0].properties.mag = 5.4;
  const different = await corroborateTollgateQuakes(args(f));
  assert.equal(different.status, 'UPSTREAM_DATA_DIFFERED_AT_RECHECK'); assert.equal(different.source_data_corroborated, false);
  const z = fixture(t, { empty: true }), empty = await corroborateTollgateQuakes(args(z));
  assert.equal(empty.status, 'UPSTREAM_EMPTY_RESULT_MATCHED'); assert.equal(empty.source_data_corroborated, false);
});

test('changed seller bytes, wrong review, channel or forged result fail before any upstream call', async t => {
  const f = fixture(t);
  for (const changed of [{ ...f.purchase, channel_id: '8' }, { ...f.purchase, response_sha256: 'f'.repeat(64) },
    { ...f.purchase, price_yocto: '1' }, { ...f.purchase, response_locally_retained: false },
    { ...f.purchase, data: { ...f.purchase.data, count: 99 } }]) {
    await assert.rejects(corroborateTollgateQuakes({ ...args(f), purchase: changed }));
  }
  assert.equal(f.calls(), 0);
});

test('late comparisons, unavailable data and malformed USGS payloads remain unverified', async t => {
  const f = fixture(t), late = await corroborateTollgateQuakes({ ...args(f), now: () => f.now + 601_000 });
  assert.equal(late.status, 'UPSTREAM_COMPARISON_TOO_LATE_OR_CLOCK_SKEWED'); assert.equal(f.calls(), 0);
  for (const response of [new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'x', properties: { mag: '5' } }] })]) {
    const out = await corroborateTollgateQuakes({ ...args(f), fetchImpl: async () => response });
    assert.equal(out.status, 'UPSTREAM_COMPARISON_UNAVAILABLE'); assert.equal(out.source_data_corroborated, false);
  }
});

test('USGS URL canonicalization rejects host substitution, credentials, path, duplicate and extra parameters', () => {
  const u = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=5&starttime=2026-11-02T00%3A00%3A00Z&limit=10';
  assert.equal(new URL(canonicalUsgsComparisonUrl(u)).hostname, 'earthquake.usgs.gov');
  for (const bad of [u.replace('earthquake.usgs.gov', 'attacker.invalid'), u.replace('https:', 'http:'),
    u.replace('earthquake.usgs.gov', 'user@earthquake.usgs.gov'), u.replace('/query?', '/other?'),
    `${u}&limit=10`, `${u}&evil=1`, `${u}#fragment`, u.replace('limit=10', 'limit=100')]) {
    assert.throws(() => canonicalUsgsComparisonUrl(bad));
  }
});
