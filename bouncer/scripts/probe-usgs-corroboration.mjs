#!/usr/bin/env node
/** Unpaid live USGS connectivity and response-shape check. It projects one
 * directly fetched USGS result into a SYNTHETIC seller response, then fetches
 * USGS independently a second time. No seller, wallet, vault or blockchain
 * is involved. A matching result is not independent provider delivery. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { TollgateResponseStore } from '../agent/tollgate-response-store.mjs';
import { makeTollgateQuakesReview, tollgateQuakesReviewHash, QUAKES_PRICE_YOCTO } from '../agent/tollgate-quakes-v13.mjs';
import { corroborateTollgateQuakes, canonicalUsgsComparisonUrl } from '../agent/tollgate-quakes-corroboration.mjs';

const now = Date.now(), start = new Date(Math.floor((now - 24 * 3600_000) / 60_000) * 60_000).toISOString();
const source = canonicalUsgsComparisonUrl(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=5&starttime=${encodeURIComponent(start)}&limit=10`);
const first = await fetch(source, { method: 'GET', redirect: 'error', credentials: 'omit',
  headers: { accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(20_000) });
if (!first.ok || first.redirected) throw new Error(`direct USGS request unavailable (${first.status})`);
const bytes = await readBoundedBytes(first, { maxBytes: 2 * 1024 * 1024, label: 'USGS preflight' });
let upstream;
try { upstream = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
catch { throw new Error('USGS response is not JSON'); }
if (upstream?.type !== 'FeatureCollection' || !Array.isArray(upstream.features) || upstream.features.length > 10) throw new Error('unexpected USGS GeoJSON');
const quakes = upstream.features.map(f => ({ id: f.id, magnitude: f.properties?.mag, place: f.properties?.place,
  time: new Date(f.properties?.time).toISOString() }));
const owner = nearApi.KeyPair.fromRandom('ed25519'), agent = nearApi.KeyPair.fromRandom('ed25519'), voucher = nearApi.KeyPair.fromRandom('ed25519');
const ownerPlan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet', public_key: String(owner.getPublicKey()) };
const review = makeTollgateQuakesReview({ ownerPlan, intentId: 'synthetic-usgs-probe', agentPublicKey: String(agent.getPublicKey()),
  voucherPublicKey: String(voucher.getPublicKey()), expiresAtMs: String(now + 120_000) });
const fetchedAt = Date.now();
const body = { source: 'USGS Earthquake Hazards Program, FDSN event API', source_url: source,
  fetched_at: new Date(fetchedAt).toISOString(), cached: false, query: { min_magnitude: 5, hours: 24, limit: 10 },
  count: quakes.length, quakes, paid: { channel_id: '0', nonce: '1', price_yocto: QUAKES_PRICE_YOCTO } };
const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'bouncer-usgs-probe-')); fs.chmodSync(dir, 0o700);
try {
  const store = new TollgateResponseStore(dir), reviewHash = tollgateQuakesReviewHash(review);
  const saved = store.save({ reviewHash, channelId: '0', observedAtMs: fetchedAt, rawBytes: Buffer.from(JSON.stringify(body)) });
  const synthetic = { status: 'PROVIDER_RETURNED_DATA', network: 'testnet', owner: review.owner, vault: review.vault,
    review_hash: reviewHash, intent_id: review.intent_id, channel_id: '0', price_yocto: review.price_yocto,
    seller_claimed_acceptance: true, response_locally_retained: true, response_sha256: saved.response_sha256, data: body };
  const checked = await corroborateTollgateQuakes({ review, purchase: synthetic, responseStore: store });
  console.log(JSON.stringify({ status: checked.status, upstream_event_count: quakes.length,
    sample_event: quakes.length ? { id: quakes[0].id, magnitude: quakes[0].magnitude, time: quakes[0].time } : null,
    source_data_corroborated: checked.source_data_corroborated, synthetic_seller_projection: true,
    independent_provider_delivery_verified: false, live_seller_contacted: false, paid_request_sent: false,
    wallet_key_used: false, blockchain_transaction: false, scope: 'two unpaid direct USGS reads; synthetic seller projection only' }));
  if (checked.status === 'UPSTREAM_COMPARISON_UNAVAILABLE') process.exitCode = 2;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
