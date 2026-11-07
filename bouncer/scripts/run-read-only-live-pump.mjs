/** Temporary GitHub-runner diagnostic. Receives only read-only RELAY session
 * keys encrypted to this job's ephemeral public key. No wallet key, seed,
 * transaction, payment, seller order or signed transaction is accepted. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fetchBufferReadinessPreview } from '../web-src/buffer-readiness-preview.mjs';

const site = 'https://4173-inmo7hprqq1v5gwehl2sd.e2b.app';
const callback = 'https://8787-inmo7hprqq1v5gwehl2sd.e2b.app';
const relay = 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
const runId = process.env.GITHUB_RUN_ID, token = process.env.GH_TOKEN, temp = process.env.RUNNER_TEMP;
if (!/^\d{1,20}$/.test(runId ?? '') || !token || !temp) throw Error('workflow context unavailable');
const handoffPath = path.join(temp, 'bouncer-read-only-handoff-private.pem');
const privateKey = crypto.createPrivateKey(fs.readFileSync(handoffPath));
if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength !== 2048) throw Error('invalid handoff key');
const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const fingerprint = crypto.createHash('sha256').update(der).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = `https://api.github.com/repos/Greatmujey/Bouncer/contents/bouncer/evidence/relay-live-pump/${runId}.json?ref=arena%2F0ee9ab70-near-hub`;
let envelope;
for (let n = 0; n < 140; n++) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28', 'user-agent': 'bouncer-read-only-diagnostic' }, signal: AbortSignal.timeout(8000) });
  if (response.ok) {
    const doc = await response.json();
    envelope = JSON.parse(Buffer.from(doc.content, 'base64').toString('utf8'));
    break;
  }
  if (response.status !== 404) throw Error('encrypted diagnostic handoff unavailable');
  await sleep(2000);
}
if (!envelope || envelope.version !== 1 || envelope.run_id !== runId || envelope.recipient_sha256 !== fingerprint ||
    typeof envelope.key !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' ||
    typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 15_000) throw Error('encrypted diagnostic handoff unavailable');
const shared = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
  Buffer.from(envelope.key, 'base64'));
let plaintext;
try {
  if (shared.length !== 32) throw Error();
  const decipher = crypto.createDecipheriv('aes-256-gcm', shared, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`bouncer-read-only-ci-v1\n${runId}\n${fingerprint}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
} finally { shared.fill(0); }
let data; try { data = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
if (!data || typeof data.signing !== 'string' || typeof data.encryption !== 'string' ||
    data.signing.length > 10_000 || data.encryption.length > 10_000) throw Error('invalid read-only session');
const signPath = path.join(temp, 'bouncer-read-only-sign.pem'), decryptPath = path.join(temp, 'bouncer-read-only-decrypt.pem');
fs.writeFileSync(signPath, data.signing, { mode: 0o600, flag: 'wx' });
fs.writeFileSync(decryptPath, data.encryption, { mode: 0o600, flag: 'wx' });
data = null;
let backend;
try {
  backend = spawn(process.execPath, ['scripts/read-only-preview-backend.mjs'], { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'], env: {
    ...process.env, PORT: '18787', BOUNCER_RELAY_CALLBACK_ORIGIN: callback, BOUNCER_RELAY_SITE_ORIGIN: site,
    BOUNCER_RELAY_DEPLOYMENT_ID: 'dpl_6PG3aKAFJXpSmjaNqBCe3mPgBoGP', BOUNCER_RELAY_ENVIRONMENT: 'production',
    BOUNCER_V12_WASM_PATH: path.join(temp, 'v12-reviewed.wasm'), BOUNCER_RELAY_SIGNING_KEY_PATH: signPath,
    BOUNCER_RELAY_ENCRYPTION_KEY_PATH: decryptPath } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('read-only backend did not start')), 12_000);
    backend.stdout.on('data', chunk => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    backend.once('exit', () => { clearTimeout(timer); reject(Error('read-only backend exited')); });
    backend.once('error', () => { clearTimeout(timer); reject(Error('read-only backend unavailable')); });
  });
  const preflight = await fetch(relay, { method: 'OPTIONS', headers: { origin: site, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== site ||
      !preflight.headers.get('access-control-allow-methods')?.includes('POST')) throw Error('relay CORS preflight unavailable');
  let relayCalls = 0;
  const transport = async (address, options = {}) => {
    const local = typeof address === 'string' && address.startsWith('/');
    if (!local && address !== relay) throw Error('unexpected address');
    const headers = new Headers(options.headers || {}); headers.set('origin', site);
    const response = await fetch(local ? `http://127.0.0.1:18787${address}` : address,
      { ...options, headers, redirect: 'error' });
    if (!local) {
      relayCalls++;
      if (response.headers.get('access-control-allow-origin') !== site) throw Error('relay CORS header missing');
    }
    return response;
  };
  const result = await fetchBufferReadinessPreview({ fetch: transport });
  if (result.state !== 'complete' || result.snapshot?.owner !== 'great_mujey.testnet' || !result.review?.review_sha256 || relayCalls < 5) {
    throw Error('read-only review unavailable');
  }
  const summary = { test: 'real encrypted relay and browser job-pump module', network: result.snapshot.network,
    owner: result.snapshot.owner, block_hash: result.snapshot.block_hash, block_height: result.snapshot.block_height,
    owner_circle_atoms: result.snapshot.owner_circle_atoms, blockers: result.snapshot.blockers,
    review_sha256: result.review.review_sha256, relay_calls: relayCalls, cors_preflight: true,
    actual_browser_or_phone_tested: false, wallet_prompted: false, transaction_sent: false,
    seller_order_created: false, seller_delivery_verified: false };
  const text = JSON.stringify(summary);
  if (text.length > 3000) throw Error('diagnostic summary too large');
  console.log(`::notice title=BOUNCER_LIVE_READ_ONLY_PUMP::${text}`);
  console.log('Real relay pump completed. No wallet, payment, seller order or delivery.');
} finally {
  backend?.kill('SIGTERM');
  try { fs.unlinkSync(signPath); } catch { /* runner filesystem is ephemeral */ }
  try { fs.unlinkSync(decryptPath); } catch { /* runner filesystem is ephemeral */ }
  try { fs.unlinkSync(handoffPath); } catch { /* runner filesystem is ephemeral */ }
}
