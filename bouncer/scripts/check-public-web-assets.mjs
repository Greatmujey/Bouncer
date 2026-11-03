// Read-only smoke test of the verified production URL from a networked runner.
// Compare published bytes to the allowed website files and sample paths
// that must not expose the private checkout. This never sends a transaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES, validatePublicWeb } from './stage-public-web.mjs';
import { hasLargeClockSkew } from '../web-src/wallet-core.mjs';

const origin = 'https://bouncer-near.vercel.app/';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const typeFor = file => file.endsWith('.html') ? 'text/html'
  : file.endsWith('.css') ? 'text/css'
    : file.endsWith('.svg') ? 'image/svg+xml'
      : file.endsWith('.jpg') ? 'image/jpeg'
        : file.endsWith('.woff2') ? 'font/woff2'
          : file.endsWith('.txt') ? 'text/plain'
            : file.endsWith('.json') ? 'application/json'
              : file.endsWith('.zip') ? 'application/zip' : 'javascript';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
validatePublicWeb(web);

await Promise.all(PUBLIC_WEB_FILES.map(async file => {
  const started = Date.now();
  const response = await fetch(new URL(file, origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const finished = Date.now();
  assert.equal(response.status, 200, `${file}: HTTP ${response.status}`);
  assert.ok(response.headers.get('content-type')?.toLowerCase().includes(typeFor(file)), `${file}: unexpected content type`);
  const actual = Buffer.from(await response.arrayBuffer());
  if (file === 'walletconnect-config.json') {
    // Deployment may substitute its public project ID; no other keys or code
    // are accepted. It is intentionally different from the blank Git template.
    assert.ok(actual.length <= 256, 'WalletConnect configuration is too large');
    const config = JSON.parse(actual.toString('utf8'));
    assert.deepEqual(Object.keys(config), ['projectId']);
    assert.ok(typeof config.projectId === 'string' && (config.projectId === '' || /^[a-f0-9]{32}$/i.test(config.projectId)));
    const date = response.headers.get('date'), age = response.headers.get('age');
    if (date) assert.equal(hasLargeClockSkew(date, age, started, finished), false, 'a current production response must not produce a false clock warning');
    else console.warn('Production response has no Date header; clock warning is unavailable.');
  } else {
    assert.equal(sha256(actual), sha256(fs.readFileSync(path.join(web, file))), `${file}: public bytes differ from reviewed source`);
  }
}));

const homepage = await fetch(origin, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
assert.equal(homepage.status, 200);
assert.match(homepage.headers.get('cache-control') || '', /no-cache.*must-revalidate/i, 'the deployed HTML must revalidate');

for (const file of ['.git/HEAD', '.github/workflows/ci.yml', 'bouncer/agent/procurement.mjs', 'scripts/stage-public-web.mjs', 'package.json']) {
  const response = await fetch(new URL(file, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 404, `Unexpected public response for ${file}: HTTP ${response.status}`);
}
console.log(`Public website: ${PUBLIC_WEB_FILES.length - 1} files match the reviewed checkout, WalletConnect configuration is valid, and sampled private paths returned 404.`);
