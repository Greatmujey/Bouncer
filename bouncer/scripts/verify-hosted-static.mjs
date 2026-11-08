#!/usr/bin/env node
/**
 * Read-only comparison of an HTTPS static preview with the reviewed staged
 * files. It never loads a wallet, signs a message, or sends a transaction.
 * A passing result establishes served bytes and headers at this instant only;
 * it does not prove provenance, an audit, a backend, or a real-wallet flow.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walletOriginAllowed } from '../web-src/wallet-core.mjs';
import { PUBLIC_WEB_FILES, stagePublicWeb } from './stage-public-web.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const CSP = "script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https://accounts.google.com; object-src 'none'; base-uri 'none'";
const HTML_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function httpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('An exact dedicated HTTPS origin is required'); }
  if (url.origin !== value || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password ||
      url.search || url.hash || url.port || !/^[a-z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.') ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) || ['localhost','github.io','madethis.website'].some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    throw new Error('An exact dedicated HTTPS origin is required');
  }
  return url;
}

function checkHtmlHeaders(headers) {
  for (const [name, expected] of Object.entries(HTML_HEADERS)) {
    if (headers.get(name) !== expected) throw new Error(`Unexpected HTML ${name} header`);
  }
  const cache = (headers.get('cache-control') || '').toLowerCase();
  if (!/(?:^|,)\s*no-cache\s*(?:,|$)/.test(cache) || !/(?:^|,)\s*max-age=0\s*(?:,|$)/.test(cache) ||
      !/(?:^|,)\s*must-revalidate\s*(?:,|$)/.test(cache) || /\b(?:immutable|s-maxage=\d+)\b/.test(cache)) {
    throw new Error('HTML must be revalidated rather than cached as immutable');
  }
}

function checkContentType(file, headers) {
  const type = (headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const ext = path.extname(file);
  const allowed = {
    '.html':['text/html'], '.css':['text/css'], '.mjs':['text/javascript','application/javascript'],
    '.js':['text/javascript','application/javascript'], '.json':['application/json'],
    '.jpg':['image/jpeg'], '.svg':['image/svg+xml'], '.woff2':['font/woff2','application/font-woff2'],
    '.zip':['application/zip','application/octet-stream'], '.txt':['text/plain'],
  }[ext];
  if (!allowed?.includes(type)) throw new Error(`Unexpected content type for ${file}`);
}

// Do not buffer an unbounded remote response. Content-Length may describe the
// compressed representation, so enforce the bound again on decoded body chunks.
async function readExact(response, expected, file) {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > expected.length * 2 + 1024) throw new Error(`Oversized response for ${file}`);
  if (!response.body) throw new Error(`Missing response body for ${file}`);
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > expected.length) throw new Error(`Oversized response for ${file}`);
    hash.update(chunk);
  }
  if (size !== expected.length || hash.digest('hex') !== sha256(expected)) throw new Error(`Served bytes differ for ${file}`);
}

/**
 * Compare every allowlisted public file and the two HTML paths. Requires the
 * expected wallet origin explicitly: no host may approve itself merely by
 * claiming to do so. If previewOnly is true, verify that the wallet code will
 * reject the preview origin even at top level and without a direct-test fence.
 */
export async function verifyHostedStatic({ origin, walletOrigin, walletConnectProjectId = '', previewOnly = true,
  source = WEB, fetchImpl = globalThis.fetch } = {}) {
  const target = httpsOrigin(origin);
  httpsOrigin(walletOrigin);
  if (typeof fetchImpl !== 'function' || typeof previewOnly !== 'boolean') throw new Error('Invalid verification options');
  if (previewOnly && walletOriginAllowed(target, true, walletOrigin, null)) throw new Error('Preview origin would allow a wallet');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-static-verify-'));
  try {
    const staged = path.join(parent, 'site');
    stagePublicWeb(staged, source, { walletOrigin, walletConnectProjectId });
    const expected = new Map(PUBLIC_WEB_FILES.map(file => [file, fs.readFileSync(path.join(staged, file))]));
    const probe = async (pathname, file, html = false) => {
      const response = await fetchImpl(new URL(pathname, target), { method:'GET', redirect:'manual',
        headers:{ 'cache-control':'no-cache' }, signal:AbortSignal.timeout(30_000) });
      if (response.status !== 200) throw new Error(`Unexpected HTTP ${response.status} for ${pathname}`);
      if (html) checkHtmlHeaders(response.headers);
      checkContentType(file, response.headers);
      await readExact(response, expected.get(file), file);
    };
    await probe('/', 'index.html', true);
    for (const file of PUBLIC_WEB_FILES) await probe(`/${file}`, file, file === 'index.html');
    // A static preview must not silently point to an active mission service.
    // GET only: no owner identity, journal, challenge, or payment is requested.
    const api = await fetchImpl(new URL('/api/native-mission/config', target), { method:'GET', redirect:'manual', signal:AbortSignal.timeout(30_000) });
    if (api.status !== 404) throw new Error(`Expected absent mission backend, got HTTP ${api.status}`);
    await api.body?.cancel();
    return { origin:target.origin, wallet_origin:walletOrigin, wallet_blocked_on_preview:previewOnly,
      files_verified:PUBLIC_WEB_FILES.length, index_sha256:sha256(expected.get('index.html')),
      wallet_bundle_sha256:sha256(expected.get('wallet.bundle.js')), mission_backend:'absent (HTTP 404)',
      scope:'read-only bytes and headers at verification time; no wallet, signature or transaction' };
  } finally { fs.rmSync(parent, { recursive:true, force:true }); }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = await verifyHostedStatic({ origin:process.env.BOUNCER_STATIC_PREVIEW_ORIGIN,
      walletOrigin:process.env.BOUNCER_STATIC_EXPECTED_WALLET_ORIGIN,
      walletConnectProjectId:process.env.BOUNCER_STATIC_WALLETCONNECT_PROJECT_ID || '' });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`Static preview verification failed: ${error.message}`); process.exitCode = 1; }
}
