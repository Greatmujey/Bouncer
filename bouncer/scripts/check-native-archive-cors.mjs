#!/usr/bin/env node
/** Public, read-only browser-origin check for one already known FINAL testnet
 * block. It never signs, submits, creates an account or queries a wallet. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const ENDPOINT = 'https://archival-rpc.testnet.near.org';
const ORIGIN = 'https://bouncer-near.vercel.app';
const BLOCK = 'DWvgKDnvo57VTMap6W8HtHszgP7gKWVUSY8JRec8t7SZ';
const ID = 'bouncer-archive-cors-read-only';
const fail = () => new Error('archival browser-origin check unavailable');
const originAllowed = res => ['*', ORIGIN].includes(res.headers.get('access-control-allow-origin'));
const allows = (res, name, value) => (res.headers.get(name) || '').toLowerCase().split(',').map(x => x.trim()).some(x => x === '*' || x === value);

export async function checkNativeArchiveCors(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw fail();
  const preflight = await fetchImpl(ENDPOINT, { method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  if (!preflight.ok || !originAllowed(preflight) || !allows(preflight, 'access-control-allow-methods', 'post') ||
      !allows(preflight, 'access-control-allow-headers', 'content-type')) throw fail();
  await preflight.body?.cancel();
  const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { origin: ORIGIN, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ID, method: 'block', params: { block_id: BLOCK } }) });
  if (!response.ok || !originAllowed(response)) throw fail();
  const body = await readBoundedJson(response, { maxBytes: 2_000_000, label: 'archival block' });
  if (body?.jsonrpc !== '2.0' || body.id !== ID || body.error || body.result?.header?.hash !== BLOCK) throw fail();
  return { known_block_read: true, browser_origin_header_allowed: true, real_phone_verified: false,
    original_receipt_verified: false, signed_or_sent_transaction: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkNativeArchiveCors().then(result => {
    console.log('::notice title=Archival testnet RPC CORS::' + JSON.stringify(result));
  }).catch(() => {
    console.log('::warning title=Archival testnet RPC CORS::Read-only browser compatibility is unconfirmed; no transaction was sent.');
    process.exitCode = 1;
  });
}
