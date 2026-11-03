/** Independent, unpaid USGS comparison for a retained Tollgate quakes response.
 * This never contacts the seller, signs a voucher, sends a transaction or
 * changes a fence. It checks the exact bytes saved by the caller and compares
 * their selected event fields with a fresh public USGS result. Data can change
 * between observations; a mismatch is inconclusive, not evidence of fraud.
 * Matching public data does not prove payment, settlement, HTTP peer identity,
 * or that the seller actually fetched it at the claimed time. */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { validateTollgateQuakesReview, tollgateQuakesReviewHash, validTollgateQuakesBody } from './tollgate-quakes-v13.mjs';
import { TollgateResponseStore } from './tollgate-response-store.mjs';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(x) && BigInt(x) <= 0xffffffffn;
const MAX_AGE_MS = 10 * 60_000;

/** Construct the only allowed USGS URL from an already-validated seller
 * response, never forwarding arbitrary hosts, credentials or extra parameters. */
export function canonicalUsgsComparisonUrl(value) {
  let source;
  try { source = new URL(value); } catch { throw new Error('invalid USGS comparison URL'); }
  if (source.protocol !== 'https:' || source.hostname !== 'earthquake.usgs.gov' || source.port || source.username || source.password ||
      source.hash || source.pathname !== '/fdsnws/event/1/query' ||
      [...source.searchParams.keys()].sort().join(',') !== 'format,limit,minmagnitude,orderby,starttime' ||
      source.searchParams.get('format') !== 'geojson' || source.searchParams.get('orderby') !== 'time' ||
      source.searchParams.get('minmagnitude') !== '5' || source.searchParams.get('limit') !== '10' ||
      !Number.isFinite(Date.parse(source.searchParams.get('starttime') ?? ''))) throw new Error('invalid USGS comparison URL');
  const url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  for (const k of ['format', 'orderby', 'minmagnitude', 'starttime', 'limit']) url.searchParams.set(k, source.searchParams.get(k));
  return url.href;
}
function rows(value) {
  if (!record(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > 10) return null;
  const out = new Map();
  for (const feature of value.features) {
    const p = feature?.properties, time = p?.time;
    if (!record(feature) || feature.type !== 'Feature' || typeof feature.id !== 'string' || !feature.id || feature.id.length > 128 ||
        out.has(feature.id) || !record(p) || typeof p.mag !== 'number' || !Number.isFinite(p.mag) ||
        typeof p.place !== 'string' || p.place.length > 500 || !Number.isSafeInteger(time) || !Number.isFinite(Date.parse(new Date(time).toISOString()))) return null;
    const depth = feature.geometry?.coordinates?.[2] ?? null;
    if ((depth !== null && (typeof depth !== 'number' || !Number.isFinite(depth))) ||
        typeof p.url !== 'string' || p.url.length > 1000) return null;
    out.set(feature.id, { magnitude: p.mag, place: p.place, time: new Date(time).toISOString(),
      depth_km: depth, tsunami: Boolean(p.tsunami), url: p.url });
  }
  return out;
}

/** Read the saved seller bytes and make at most one independent unpaid USGS
 * GET. No assertion here upgrades a seller acknowledgement into settlement. */
export async function corroborateTollgateQuakes({ review: raw, purchase, responseStore, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const review = validateTollgateQuakesReview(raw), reviewHash = tollgateQuakesReviewHash(review);
  if (!(responseStore instanceof TollgateResponseStore) || typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !record(purchase) || purchase.status !== 'PROVIDER_RETURNED_DATA' || purchase.network !== 'testnet' ||
      purchase.owner !== review.owner || purchase.vault !== review.vault || purchase.review_hash !== reviewHash ||
      purchase.intent_id !== review.intent_id || !decimal(purchase.channel_id) || purchase.price_yocto !== review.price_yocto ||
      purchase.seller_claimed_acceptance !== true || purchase.response_locally_retained !== true ||
      !/^[a-f0-9]{64}$/.test(purchase.response_sha256 ?? '')) throw new Error('matching retained Tollgate purchase response required');
  const { record: saved, rawBytes } = responseStore.load({ reviewHash, channelId: purchase.channel_id });
  if (saved.response_sha256 !== purchase.response_sha256 || sha(rawBytes) !== purchase.response_sha256) {
    throw new Error('seller response hash differs from the retained bytes');
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)); }
  catch { throw new Error('retained seller response is not UTF-8 JSON'); }
  const observed = Number(saved.observed_at_ms), current = now();
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(observed) ||
      !isDeepStrictEqual(body, purchase.data) || !validTollgateQuakesBody(body, purchase.channel_id, observed)) {
    throw new Error('retained seller response does not match the purchase result');
  }
  const base = { review_hash: reviewHash, channel_id: purchase.channel_id, seller_response_sha256: purchase.response_sha256,
    seller_response_observed_at_ms: saved.observed_at_ms, unpaid_comparison_only: true, seller_contacted: false,
    voucher_signed: false, payment_sent: false, settlement_verified: false,
    scope: 'caller-retained seller bytes and a later direct USGS observation; not HTTP-origin proof, settlement proof, or proof of the seller’s upstream fetch' };
  if (current < observed - 30_000 || current - observed > MAX_AGE_MS) {
    return { ...base, status: 'UPSTREAM_COMPARISON_TOO_LATE_OR_CLOCK_SKEWED', source_data_corroborated: false };
  }
  const url = canonicalUsgsComparisonUrl(body.source_url);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res?.ok || res.redirected || !/^application\/(?:geo\+json|json)(?:\s*;|$)/i.test(res.headers?.get('content-type') ?? '')) {
      return { ...base, status: 'UPSTREAM_COMPARISON_UNAVAILABLE', source_data_corroborated: false };
    }
    const upstream = await readBoundedBytes(res, { maxBytes: 2 * 1024 * 1024, label: 'independent USGS response' });
    let geo;
    try { geo = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(upstream)); }
    catch { return { ...base, status: 'UPSTREAM_COMPARISON_UNAVAILABLE', source_data_corroborated: false }; }
    let upstreamRows;
    try { upstreamRows = rows(geo); } catch { upstreamRows = null; }
    if (!upstreamRows) return { ...base, status: 'UPSTREAM_COMPARISON_UNAVAILABLE', source_data_corroborated: false };
    const distinct = new Set(body.quakes.map(q => q.id));
    const fields = ['id', 'magnitude', 'place', 'time', 'depth_km', 'tsunami', 'url'];
    const matched = distinct.size === body.quakes.length && body.quakes.length === upstreamRows.size && body.quakes.every(q => {
      const u = upstreamRows.get(q.id);
      return Object.keys(q).sort().join(',') === [...fields].sort().join(',') && u && q.magnitude === u.magnitude &&
        q.place === u.place && q.time === u.time && q.depth_km === u.depth_km && q.tsunami === u.tsunami && q.url === u.url;
    });
    const detail = { source_url: url, upstream_response_sha256: sha(upstream), seller_count: body.quakes.length,
      upstream_count: upstreamRows.size, compared_fields: fields };
    if (!matched) return { ...base, ...detail, status: 'UPSTREAM_DATA_DIFFERED_AT_RECHECK', source_data_corroborated: false };
    if (!body.quakes.length) return { ...base, ...detail, status: 'UPSTREAM_EMPTY_RESULT_MATCHED', source_data_corroborated: false };
    return { ...base, ...detail, status: 'UPSTREAM_DATA_CORROBORATED', source_data_corroborated: true };
  } catch {
    return { ...base, status: 'UPSTREAM_COMPARISON_UNAVAILABLE', source_data_corroborated: false };
  } finally { try { await res?.body?.cancel() } catch { /* response already consumed */ } }
}
