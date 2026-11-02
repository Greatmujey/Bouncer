// Read-only smoke test of the verified production URL from a networked runner.
// Compare published bytes to the allowed website files and sample paths
// that must not expose the private checkout. This never sends a transaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_WEB_FILES, validatePublicWeb } from './stage-public-web.mjs';

const origin = 'https://bouncer-near.vercel.app/';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const typeFor = file => file.endsWith('.html') ? 'text/html'
  : file.endsWith('.css') ? 'text/css'
    : file.endsWith('.svg') ? 'image/svg+xml'
      : file.endsWith('.jpg') ? 'image/jpeg'
        : file.endsWith('.woff2') ? 'font/woff2'
          : file.endsWith('.txt') ? 'text/plain' : 'javascript';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
validatePublicWeb(web);

await Promise.all(PUBLIC_WEB_FILES.map(async file => {
  const response = await fetch(new URL(file, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${file}: HTTP ${response.status}`);
  assert.ok(response.headers.get('content-type')?.toLowerCase().includes(typeFor(file)), `${file}: unexpected content type`);
  const actual = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(actual), sha256(fs.readFileSync(path.join(web, file))), `${file}: public bytes differ from reviewed source`);
}));

for (const file of ['.git/HEAD', '.github/workflows/ci.yml', 'bouncer/agent/procurement.mjs', 'scripts/stage-public-web.mjs', 'package.json']) {
  const response = await fetch(new URL(file, origin), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 404, `Unexpected public response for ${file}: HTTP ${response.status}`);
}
console.log(`Public website: all ${PUBLIC_WEB_FILES.length} files match the reviewed checkout; sampled private paths returned 404.`);
