// Optional, one-shot PUBLIC guest preview. Only the explicitly listed static
// website files are uploaded; no repo checkout, keys, journals, or private data.
// The third-party host automatically expires the resulting link. Never run this
// implicitly on normal CI pushes: see .github/workflows/web-preview.yml.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const host = 'https://www.madethis.website';
let ttlSeconds = 604800; // Prefer seven days; older hosts support only 24 hours.
const zip = path.join(os.tmpdir(), `bouncer-web-preview-${process.pid}.zip`);
const files = ['index.html', 'styles.css', 'favicon.svg', 'evidence.mjs', 'app.mjs'];

async function postJson(route, body) {
  const response = await fetch(`${host}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${route}: non-JSON response (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  for (const file of files) {
    const stat = fs.lstatSync(path.join(web, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unexpected website file ${file}`);
  }
  execFileSync('zip', ['-q', zip, ...files], { cwd: web });
  const bytes = fs.readFileSync(zip);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid preview ZIP size');
  let init;
  try {
    init = await postJson('/api/upload/init', { totalBytes: bytes.length, ttlSeconds });
  } catch (error) {
    if (!/invalid_ttl/.test(error.message)) throw error;
    ttlSeconds = 86400;
    init = await postJson('/api/upload/init', { totalBytes: bytes.length, ttlSeconds });
  }
  if (!/^[a-z2-9]{16}$/.test(init.uploadId) || !Number.isInteger(init.chunkSize) || init.chunkSize < bytes.length) {
    throw new Error('Unexpected preview host upload parameters');
  }
  const chunk = await fetch(`${host}/api/upload/chunk`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-upload-id': init.uploadId, 'x-chunk-index': '0' },
    body: bytes, signal: AbortSignal.timeout(30_000),
  });
  if (!chunk.ok) throw new Error(`Upload chunk: HTTP ${chunk.status}`);
  const fin = await postJson('/api/upload/finalize', {
    uploadId: init.uploadId, totalChunks: 1, ttlSeconds, sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  if (!fin.ok || !/^\/s\/[a-z2-9]{6,16}\/$/.test(fin.url) || fin.files !== files.length || !Number.isFinite(fin.expiresAt)) {
    throw new Error(`Unexpected preview host result: ${JSON.stringify(fin)}`);
  }
  const url = `${host}${fin.url}`;
  for (const [file, expectedType] of [['', 'text/html'], ['styles.css', 'text/css'], ['app.mjs', 'javascript'], ['evidence.mjs', 'javascript']]) {
    const response = await fetch(url + file, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.headers.get('content-type')?.includes(expectedType)) {
      throw new Error(`Preview ${file || 'index.html'} is not reachable with the expected content type (HTTP ${response.status})`);
    }
    // Ensure the published document is the site we intended, not an interstitial.
    if (!file && !(await response.text()).includes('Bouncer helps it get them.')) throw new Error('Preview homepage was replaced by another page');
  }
  const expires = new Date(fin.expiresAt).toISOString();
  const urlFile = process.env.BOUNCER_PREVIEW_URL_FILE;
  if (urlFile) fs.writeFileSync(urlFile, `${url}\n`);
  console.log(`PUBLIC PREVIEW ${url} EXPIRES ${expires}`);
  console.log(`::notice title=Bouncer public preview::${url} (expires ${expires}; static testnet snapshot)`);
}
try { await main(); } finally { try { fs.unlinkSync(zip); } catch {} }
