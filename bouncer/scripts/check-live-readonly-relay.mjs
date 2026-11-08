#!/usr/bin/env node
/**
 * Read-only deployment boundary check. It sends only CORS preflights and one
 * deliberately invalid, unsigned job. No wallet, bearer material, RPC job or
 * transaction is sent. Passing does not prove backend or receipt availability.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RELAY = 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
const SITE = 'https://bouncer-near.vercel.app';
const OTHER = 'https://not-bouncer.example';
const fail = () => new Error('read-only relay boundary check failed');
const tokens = (response, header) => (response.headers.get(header) || '').toLowerCase().split(',').map(x => x.trim());

export async function checkLiveReadOnlyRelay(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw fail();
  const request = (method, origin, extra = {}) => fetchImpl(RELAY, {
    method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    ...extra, headers: { origin, ...extra.headers },
  });
  const preflight = await request('OPTIONS', SITE, { headers: {
    'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
  } });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== SITE ||
      !tokens(preflight, 'access-control-allow-methods').includes('post') ||
      !tokens(preflight, 'access-control-allow-headers').includes('content-type') ||
      !tokens(preflight, 'vary').includes('origin')) throw fail();

  const wrongOrigin = await request('OPTIONS', OTHER, { headers: {
    'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
  } });
  if (wrongOrigin.status !== 403 || wrongOrigin.headers.has('access-control-allow-origin')) throw fail();

  const unsigned = await request('POST', SITE, { headers: { 'content-type': 'application/json' }, body: '{}' });
  if (unsigned.status !== 502 || unsigned.headers.get('access-control-allow-origin') !== SITE) throw fail();
  // Read a strictly bounded diagnostic, never a valid relay response or token.
  const declared = unsigned.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024)) throw fail();
  const reader = unsigned.body?.getReader();
  if (!reader) throw fail();
  let total = 0, raw = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1024) { await reader.cancel(); throw fail(); }
      raw += new TextDecoder().decode(value);
    }
  } finally { reader.releaseLock(); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw fail(); }
  if (!parsed || Object.keys(parsed).join(',') !== 'error' || parsed.error !== 'read-only request unavailable') throw fail();
  return { site_cors_allowed: true, other_origin_denied: true, unsigned_job_denied: true,
    signed_or_sent_transaction: false, backend_or_receipt_verified: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkLiveReadOnlyRelay().then(result => {
    console.log('::notice title=Read-only relay deployment boundary::' + JSON.stringify(result));
  }).catch(() => {
    console.error('::error title=Read-only relay deployment boundary::Check failed; no transaction was sent.');
    process.exitCode = 1;
  });
}
