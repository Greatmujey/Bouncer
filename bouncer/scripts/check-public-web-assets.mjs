// Read-only production smoke, run only after the reviewed version is deployed.
// Never signs in, exposes a credential or sends a transaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES, validatePublicWeb } from './stage-public-web.mjs';

const origin = 'https://bouncer-near.vercel.app/';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const typeFor = file => file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' :
  file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.jpg') ? 'image/jpeg' :
    file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.zip') ? 'application/zip' : file.endsWith('.txt') ? 'text/plain' : 'javascript';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
validatePublicWeb(web);
await Promise.all(PUBLIC_WEB_FILES.map(async file => {
  const response = await fetch(new URL(file, origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${file}: HTTP ${response.status}`);
  assert.ok(response.headers.get('content-type')?.toLowerCase().includes(typeFor(file)), `${file}: unexpected content type`);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(fs.readFileSync(path.join(web, file))), `${file}: public bytes differ from reviewed source`);
}));
const homepage = await fetch(origin, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
assert.equal(homepage.status, 200);
assert.match(homepage.headers.get('cache-control') || '', /no-cache.*must-revalidate/i);
for (const file of ['.git/HEAD', '.github/workflows/ci.yml', 'bouncer/agent/procurement.mjs', 'scripts/stage-public-web.mjs', 'package.json', 'walletconnect.bundle.js', 'api/wc-relay']) {
  const response = await fetch(new URL(file, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 404, `Unexpected public response for ${file}: HTTP ${response.status}`);
}
const account = await fetch(new URL('api/google-session', origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
assert.ok([200, 503].includes(account.status), `Unexpected account endpoint status ${account.status}`);
assert.match(account.headers.get('cache-control') || '', /no-store/);
console.log(`Public website: ${PUBLIC_WEB_FILES.length} reviewed files match; retired WalletConnect and sampled private paths return 404. Google login was not attempted.`);
