import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLiveReadOnlyRelay } from '../scripts/check-live-readonly-relay.mjs';

const site = 'https://bouncer-near.vercel.app';
const allowed = { 'access-control-allow-origin': site, 'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type', vary: 'Origin' };
const makeFetch = (change = {}) => {
  const calls = [];
  return { calls, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return new Response(null, { status: change.allowedStatus ?? 204,
      headers: { ...allowed, ...(change.allowedHeaders || {}) } });
    if (calls.length === 2) return new Response(null, { status: change.otherStatus ?? 403,
      headers: change.otherHeaders || {} });
    return new Response(change.unsignedBody ?? '{"error":"read-only request unavailable"}',
      { status: change.unsignedStatus ?? 502, headers: { 'access-control-allow-origin': change.unsignedOrigin ?? site } });
  } };
};

test('live relay probe uses only preflights and one deliberately unsigned request', async () => {
  const mock = makeFetch();
  assert.deepEqual(await checkLiveReadOnlyRelay(mock.fetch), { site_cors_allowed: true,
    other_origin_denied: true, unsigned_job_denied: true, signed_or_sent_transaction: false,
    backend_or_receipt_verified: false });
  assert.equal(mock.calls.length, 3);
  assert(mock.calls.every(call => call.url === 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read'));
  assert.deepEqual(mock.calls.map(call => call.method), ['OPTIONS', 'OPTIONS', 'POST']);
  assert.equal(mock.calls[2].body, '{}');
  assert.equal(mock.calls[2].redirect, 'error');
  assert.equal(mock.calls[2].headers.origin, site);
});

test('stops when site CORS, cross-origin denial or unsigned-job denial are wrong', async () => {
  for (const change of [
    { allowedStatus: 403 }, { allowedHeaders: { 'access-control-allow-origin': '*' } },
    { allowedHeaders: { 'access-control-allow-methods': 'GET' } },
    { allowedHeaders: { 'access-control-allow-headers': 'authorization' } },
    { allowedHeaders: { vary: 'Accept' } }, { otherStatus: 204 },
    { otherHeaders: { 'access-control-allow-origin': '*' } }, { unsignedStatus: 200 },
    { unsignedOrigin: '*' }, { unsignedBody: '{"error":"unexpected"}' },
    { unsignedBody: 'x'.repeat(1025) },
  ]) await assert.rejects(checkLiveReadOnlyRelay(makeFetch(change).fetch));
  await assert.rejects(checkLiveReadOnlyRelay(async () => { throw Error('offline'); }));
});
