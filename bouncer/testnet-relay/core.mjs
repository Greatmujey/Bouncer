/**
 * Narrow, read-only NEAR RPC relay for an experimental Bouncer preview.
 *
 * The server, not the browser, chooses each pending RPC request. The relay
 * fetches a one-use job from a fixed backend over HTTPS with its Vercel OIDC
 * identity, performs only allowlisted testnet reads, and posts the exact bytes
 * back using an audience-bound OIDC token. It never returns either token to the
 * browser, signs a NEAR transaction, broadcasts a transaction, or takes keys.
 *
 * The callback origin and browser site origin are fixed deployment settings.
 * This transport authenticates the relay, not the underlying RPC. It is not a
 * consensus proof and is not an independent wallet-prompt or payment journal.
 */
import crypto from 'node:crypto';

const VIEW_TYPES = new Set(['view_account', 'view_access_key_list', 'view_access_key', 'call_function']);
const IDS = new Set(['bouncer-read-only', 'bouncer-pinned-presence', 'bouncer-read-only-receipts']);
const TESTNET_RPC = 'https://test.rpc.fastnear.com';
const ARCHIVAL_RPC = 'https://archival-rpc.testnet.near.org';
const MAX_INPUT = 16_384;
const MAX_OUTPUT = 4_000_000;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const isJob = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
const isHash = s => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(s);
const isAccount = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 &&
  (/^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)*testnet$/.test(s) || /^[a-f0-9]{64}$/.test(s));

/** Reject everything that could submit or mutate an on-chain transaction. */
export function validateReadOnlyJob(job) {
  if (!record(job) || Object.keys(job).sort().join(',') !== 'id,jsonrpc,method,params' ||
      job.jsonrpc !== '2.0' || !IDS.has(job.id)) throw new Error('invalid read-only RPC job');
  const { method, params, id } = job;
  if (method === 'status' && id === 'bouncer-read-only' && (params === undefined || Array.isArray(params) && params.length === 0)) return job;
  if (method === 'block' && id === 'bouncer-read-only' && record(params) &&
      Object.keys(params).length === 1 && (params.finality === 'final' || isHash(params.block_id))) return job;
  if (method === 'EXPERIMENTAL_protocol_config' && id === 'bouncer-read-only' && record(params) &&
      Object.keys(params).length === 1 && isHash(params.block_id)) return job;
  if (method === 'gas_price' && id === 'bouncer-read-only' && Array.isArray(params) &&
      params.length === 1 && isHash(params[0])) return job;
  if (method === 'query' && ['bouncer-read-only', 'bouncer-pinned-presence'].includes(id) && record(params) &&
      VIEW_TYPES.has(params.request_type) && isAccount(params.account_id) && isHash(params.block_id)) {
    const common = ['request_type', 'account_id', 'block_id'];
    const extras = params.request_type === 'view_access_key' ? ['public_key'] :
      params.request_type === 'call_function' ? ['method_name', 'args_base64'] : [];
    if (Object.keys(params).sort().join(',') !== [...common, ...extras].sort().join(',')) throw new Error('invalid query');
    if (params.request_type === 'view_access_key' &&
        (typeof params.public_key !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(params.public_key))) throw new Error('invalid query key');
    if (params.request_type === 'call_function' &&
        (typeof params.method_name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(params.method_name) ||
         typeof params.args_base64 !== 'string' || params.args_base64.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.args_base64))) throw new Error('invalid query call');
    if (id === 'bouncer-pinned-presence' && params.request_type !== 'view_account') throw new Error('invalid presence query');
    return job;
  }
  if (method === 'EXPERIMENTAL_tx_status' && id === 'bouncer-read-only-receipts' && record(params) &&
      Object.keys(params).sort().join(',') === 'sender_account_id,tx_hash,wait_until' && isHash(params.tx_hash) &&
      isAccount(params.sender_account_id) && params.wait_until === 'FINAL') return job;
  throw new Error('read-only RPC method denied');
}

function httpsOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('fixed HTTPS origin required'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || value.length > 255) throw new Error('fixed HTTPS origin required');
  return value;
}

async function bounded(response, limit) {
  if (!response?.ok || !response.body || typeof response.body.getReader !== 'function') throw new Error('read-only transport unavailable');
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('read-only response too large');
  const reader = response.body.getReader(), chunks = []; let n = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) { await reader.cancel().catch(() => {}); throw new Error('read-only response too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, n);
}

/** Execute one pending job. Arguments other than jobId come from trusted server
 * configuration. Never log tokens, return tokens to the browser, or relay a
 * request body supplied by the browser. */
export async function executeReadOnlyJob({ jobId, callbackOrigin, getToken, fetchImpl = globalThis.fetch } = {}) {
  if (!isJob(jobId) || typeof getToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('invalid relay request');
  const origin = httpsOrigin(callbackOrigin);
  const jobUrl = `${origin}/internal/read-only-jobs/${jobId}`;
  const baseToken = await getToken();
  if (typeof baseToken !== 'string' || !baseToken) throw new Error('relay identity unavailable');
  const work = await fetchImpl(jobUrl, { method: 'GET', headers: { authorization: `Bearer ${baseToken}` },
    redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const rawJob = await bounded(work, MAX_INPUT);
  let job; try { job = JSON.parse(rawJob.toString('utf8')); } catch { throw new Error('invalid read-only RPC job'); }
  validateReadOnlyJob(job);
  const rpc = job.method === 'EXPERIMENTAL_tx_status' || (job.method === 'block' && isHash(job.params.block_id))
    ? ARCHIVAL_RPC : TESTNET_RPC;
  const upstream = await fetchImpl(rpc, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(job), signal: AbortSignal.timeout(15_000) });
  const bytes = await bounded(upstream, MAX_OUTPUT);
  // Validate an envelope before signing the result. RPC error envelopes are
  // relayed unchanged because an exact UNKNOWN_ACCOUNT can establish absence.
  let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid RPC envelope'); }
  if (!record(result) || result.jsonrpc !== '2.0' || result.id !== job.id ||
      (Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error'))) throw new Error('invalid RPC envelope');
  const digest = hash(bytes), resultUrl = `${origin}/internal/read-only-results/${jobId}/${digest}`;
  const resultToken = await getToken({ audience: resultUrl });
  if (typeof resultToken !== 'string' || !resultToken) throw new Error('relay result identity unavailable');
  const posted = await fetchImpl(resultUrl, { method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${resultToken}`, 'content-type': 'application/json' },
    body: bytes, signal: AbortSignal.timeout(10_000) });
  if (!posted?.ok) throw new Error('read-only result rejected');
  await posted.body?.cancel().catch(() => {});
  return { delivered: true };
}

/** Public browser trigger. Knowing a job ID cannot change its RPC request;
 * the fixed backend gives a job only to the pinned relay deployment. */
export function createReadOnlyRelayHandler({ callbackOrigin, siteOrigin, getToken, fetchImpl = globalThis.fetch } = {}) {
  httpsOrigin(callbackOrigin); const site = httpsOrigin(siteOrigin);
  if (typeof getToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('relay dependencies required');
  return async function handler(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const origin = req.headers?.origin;
    if (origin === site) { res.setHeader('access-control-allow-origin', site); res.setHeader('vary', 'Origin'); }
    if (req.method !== 'GET' || (origin && origin !== site)) return res.status(405).json({ error: 'unavailable' });
    const id = typeof req.query?.job === 'string' ? req.query.job : '';
    if (!isJob(id) || Object.keys(req.query ?? {}).length !== 1) return res.status(400).json({ error: 'invalid request' });
    try {
      await executeReadOnlyJob({ jobId: id, callbackOrigin, getToken, fetchImpl });
      return res.status(200).json({ delivered: true });
    } catch {
      // Do not leak job, bearer token, backend or RPC response details.
      return res.status(502).json({ error: 'read-only request unavailable' });
    }
  };
}

// Browser-mediated transport for private Arena preview networks. The browser
// cannot edit the operator-signed job or read the OIDC token: the whole result
// is encrypted to a pinned, ephemeral backend key. Encrypted data is not an
// authorization for a wallet or a transaction.
const SIGNING_DOMAIN = 'bouncer-read-only-job-v1';
const ENVELOPE_DOMAIN = 'bouncer-read-only-envelope-v1';
const exact = (x, fields) => record(x) && Object.keys(x).sort().join(',') === [...fields].sort().join(',');
const canonical64 = (s, max) => {
  if (typeof s !== 'string' || s.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('invalid encoding');
  const b = Buffer.from(s, 'base64'); if (b.toString('base64') !== s) throw new Error('invalid encoding'); return b;
};
export function browserJobMessage({ job_id, request_sha256, expires_at_ms }) {
  return `${SIGNING_DOMAIN}\n${job_id}\n${request_sha256}\n${expires_at_ms}`;
}
export function browserEnvelopeAad({ job_id, request_sha256 }) {
  return Buffer.from(`${ENVELOPE_DOMAIN}\n${job_id}\n${request_sha256}`, 'utf8');
}

/** The browser can transport but cannot select an operator-signed RPC job. */
export async function executeEncryptedBrowserJob({ signedJob, callbackOrigin, signingPublicKey, encryptionPublicKey,
  getToken, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const origin = httpsOrigin(callbackOrigin);
  if (!exact(signedJob, ['job_id', 'request_sha256', 'expires_at_ms', 'request_json', 'signature_base64']) ||
      !isJob(signedJob.job_id) || !/^[a-f0-9]{64}$/.test(signedJob.request_sha256 ?? '') ||
      !Number.isSafeInteger(signedJob.expires_at_ms) || typeof signedJob.request_json !== 'string' ||
      Buffer.byteLength(signedJob.request_json) > MAX_INPUT || typeof getToken !== 'function' ||
      typeof fetchImpl !== 'function' || typeof now !== 'function') throw new Error('invalid signed read-only job');
  const clock = now();
  if (!Number.isSafeInteger(clock) || signedJob.expires_at_ms <= clock || signedJob.expires_at_ms > clock + 60_000 ||
      hash(Buffer.from(signedJob.request_json)) !== signedJob.request_sha256) throw new Error('expired or changed read-only job');
  let signKey, encKey;
  try { signKey = crypto.createPublicKey(signingPublicKey); encKey = crypto.createPublicKey(encryptionPublicKey); }
  catch { throw new Error('invalid session public keys'); }
  if (signKey.asymmetricKeyType !== 'ed25519' || encKey.asymmetricKeyType !== 'rsa' ||
      encKey.asymmetricKeyDetails?.modulusLength < 2048 ||
      !crypto.verify(null, Buffer.from(browserJobMessage(signedJob)), signKey, canonical64(signedJob.signature_base64, 128))) {
    throw new Error('invalid signed read-only job');
  }
  let job; try { job = JSON.parse(signedJob.request_json); } catch { throw new Error('invalid signed read-only job'); }
  validateReadOnlyJob(job);
  const rpc = job.method === 'EXPERIMENTAL_tx_status' || (job.method === 'block' && isHash(job.params.block_id))
    ? ARCHIVAL_RPC : TESTNET_RPC;
  const upstream = await fetchImpl(rpc, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: signedJob.request_json, signal: AbortSignal.timeout(15_000) });
  // Keep the encrypted response well below serverless body limits. Oversized
  // receipts stay unknown; callers must not infer a failed original.
  const resultBytes = await bounded(upstream, 1_000_000);
  let result; try { result = JSON.parse(resultBytes.toString('utf8')); } catch { throw new Error('invalid RPC envelope'); }
  if (!record(result) || result.jsonrpc !== '2.0' || result.id !== job.id ||
      (Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error'))) throw new Error('invalid RPC envelope');
  const responseHash = hash(resultBytes);
  const audience = `${origin}/internal/read-only-results/${signedJob.job_id}/${signedJob.request_sha256}/${responseHash}`;
  const oidc = await getToken({ audience });
  if (typeof oidc !== 'string' || oidc.length < 100 || oidc.length > 32_768) throw new Error('relay identity unavailable');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(browserEnvelopeAad(signedJob));
    const plaintext = Buffer.from(JSON.stringify({ token: oidc, response_base64: resultBytes.toString('base64') }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const encryptedKey = crypto.publicEncrypt({ key: encKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, key);
    return { version: 1, job_id: signedJob.job_id, request_sha256: signedJob.request_sha256,
      encrypted_key_base64: encryptedKey.toString('base64'), iv_base64: iv.toString('base64'),
      tag_base64: cipher.getAuthTag().toString('base64'), ciphertext_base64: ciphertext.toString('base64') };
  } finally { key.fill(0); }
}

/** POST-only encrypted result. Cross-origin requests are limited to the fixed
 * preview origin; forged CORS headers do not create a valid signed job. */
export function createEncryptedBrowserRelayHandler({ callbackOrigin, siteOrigin, signingPublicKey, encryptionPublicKey,
  getToken, fetchImpl = globalThis.fetch } = {}) {
  httpsOrigin(callbackOrigin); const site = httpsOrigin(siteOrigin);
  if (!signingPublicKey || !encryptionPublicKey || typeof getToken !== 'function' || typeof fetchImpl !== 'function') throw new Error('relay dependencies required');
  return async function handler(req, res) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    const origin = req.headers?.origin;
    if (origin !== site) return res.status(403).json({ error: 'unavailable' });
    res.setHeader('access-control-allow-origin', site); res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      return res.status(204).end();
    }
    if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return res.status(405).json({ error: 'unavailable' });
    }
    try {
      const envelope = await executeEncryptedBrowserJob({ signedJob: req.body, callbackOrigin, signingPublicKey,
        encryptionPublicKey, getToken, fetchImpl });
      return res.status(200).json(envelope);
    } catch { return res.status(502).json({ error: 'read-only request unavailable' }); }
  };
}
