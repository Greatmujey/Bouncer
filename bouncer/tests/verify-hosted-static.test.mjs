import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES, stagePublicWeb } from '../scripts/stage-public-web.mjs';
import { verifyHostedStatic } from '../scripts/verify-hosted-static.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const preview = 'https://deploy-preview-18--bouncer-near.netlify.app';
const walletOrigin = 'https://bouncer-near.netlify.app';
const headers = {
  'content-security-policy': "script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https://accounts.google.com; object-src 'none'; base-uri 'none'",
  'x-content-type-options':'nosniff', 'referrer-policy':'strict-origin-when-cross-origin',
  'cross-origin-opener-policy':'same-origin-allow-popups', 'permissions-policy':'camera=(), microphone=(), geolocation=()',
  'cache-control':'no-cache, max-age=0, must-revalidate',
};
const types = {'.html':'text/html', '.css':'text/css', '.mjs':'text/javascript', '.js':'application/javascript',
  '.json':'application/json', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.zip':'application/zip', '.txt':'text/plain'};
function fixture(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-hosted-static-test-'));
  t.after(() => fs.rmSync(tmp, { recursive:true, force:true }));
  const staged = path.join(tmp, 'served');
  stagePublicWeb(staged, web, { walletOrigin, walletConnectProjectId:'' });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url:String(url), init });
    assert.equal(url.origin, preview);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers?.authorization, undefined);
    if (url.pathname === '/api/native-mission/config') return new Response(null, { status:options.apiStatus || 404 });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!PUBLIC_WEB_FILES.includes(file)) return new Response(null, {status:404});
    if (file === options.redirectFile) return new Response(null, {status:302, headers:{location:'https://elsewhere.test/'}});
    let body = fs.readFileSync(path.join(staged, file));
    if (file === options.corruptFile) { body = Buffer.from(body); body[body.length - 1] ^= 1; }
    const responseHeaders = { ...headers, 'content-type':`${types[path.extname(file)]}; charset=utf-8` };
    if (file === options.badHeaderFile) responseHeaders['content-security-policy'] += "; script-src 'unsafe-inline'";
    if (file === options.badTypeFile) responseHeaders['content-type'] = 'text/plain';
    return new Response(body, {status:200, headers:responseHeaders});
  };
  return { fetchImpl, calls };
}

test('read-only hosted verification checks every staged byte, security headers and absent mission backend', async t => {
  const {fetchImpl,calls} = fixture(t);
  const result = await verifyHostedStatic({origin:preview,walletOrigin,fetchImpl});
  assert.equal(result.files_verified,19);
  assert.equal(result.wallet_blocked_on_preview,true);
  assert.equal(result.mission_backend,'absent (HTTP 404)');
  assert.match(result.index_sha256,/^[a-f0-9]{64}$/);
  assert.equal(calls.length,21); // /, 19 files, and the read-only 404 check
  assert.equal(new Set(calls.map(c=>c.url)).size,21);
});

test('rejects altered bytes, redirects, weakened headers, wrong MIME and an unexpected backend', async t => {
  for (const [option,pattern] of [
    [{corruptFile:'wallet.bundle.js'},/bytes differ/],
    [{redirectFile:'styles.css'},/HTTP 302/],
    [{badHeaderFile:'index.html'},/content-security-policy/],
    [{badTypeFile:'wallet.bundle.js'},/content type/],
    [{apiStatus:200},/Expected absent mission backend/],
  ]) {
    const {fetchImpl} = fixture(t,option);
    await assert.rejects(verifyHostedStatic({origin:preview,walletOrigin,fetchImpl}),pattern);
  }
});

test('refuses an unapproved wallet origin, shared hosts, paths and non-HTTPS targets', async t => {
  const {fetchImpl} = fixture(t);
  await assert.rejects(verifyHostedStatic({origin:preview,walletOrigin:preview,fetchImpl}),/would allow a wallet/);
  await assert.rejects(verifyHostedStatic({origin:preview,walletOrigin:'https://different.netlify.app',fetchImpl}),/bytes differ|Oversized/);
  for (const origin of ['http://x.netlify.app','https://user@x.netlify.app','https://x.netlify.app/path',
    'https://x.netlify.app/','https://owner.github.io','https://madethis.website','https://127.0.0.1']) {
    await assert.rejects(verifyHostedStatic({origin,walletOrigin,fetchImpl}),/dedicated HTTPS origin/);
  }
});
