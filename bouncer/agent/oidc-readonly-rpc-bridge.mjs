/**
 * Ephemeral read-only RPC job queue for the phone preview. This is a transport,
 * not a payment or wallet-prompt fence. A pinned Vercel deployment obtains each
 * one-use request, then authenticates the exact response bytes with an OIDC
 * token whose audience contains the random job ID and SHA-256. The browser can
 * trigger jobs but cannot select or authenticate RPC results. Do not expose an
 * endpoint capable of mutating NEAR state through this bridge.
 */
import crypto from 'node:crypto';
import { validateReadOnlyJob, browserJobMessage, browserEnvelopeAad } from '../testnet-relay/core.mjs';

const JOB = /^[a-f0-9]{32}$/, DIGEST = /^[a-f0-9]{64}$/;
const bytesHash = value => crypto.createHash('sha256').update(value).digest('hex');
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
function httpsOrigin(value) {
  let u; try { u = new URL(value); } catch { throw new Error('fixed HTTPS origin required'); }
  if (typeof value !== 'string' || u.protocol !== 'https:' || u.origin !== value || u.username || u.password ||
      u.pathname !== '/' || u.search || u.hash || value.length > 255) throw new Error('fixed HTTPS origin required');
  return value;
}
function decodeJson(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid token');
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value || raw.length > 16_384) throw new Error('invalid token');
  const parsed = JSON.parse(raw.toString('utf8'));
  if (!plain(parsed)) throw new Error('invalid token');
  return parsed;
}

/** Verify against an operator-pinned JWKS and exact deployment identity. Key
 * rotation requires an independently verified pin update. Failure is closed. */
export function createVercelOidcVerifier({ jwks, issuer, owner, ownerId, project, projectId, deploymentId,
  environment, now = Date.now } = {}) {
  let url; try { url = new URL(issuer); } catch { throw new Error('fixed issuer required'); }
  if (typeof issuer !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href.replace(/\/$/, '') !== issuer.replace(/\/$/, '') || issuer.length > 255 ||
      typeof owner !== 'string' || !/^[a-z0-9-]{1,100}$/.test(owner) ||
      typeof ownerId !== 'string' || !/^team_[A-Za-z0-9]+$/.test(ownerId) ||
      typeof project !== 'string' || !/^[a-z0-9-]{1,100}$/.test(project) ||
      typeof projectId !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(projectId) ||
      typeof deploymentId !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId) ||
      !['production', 'preview'].includes(environment) || typeof now !== 'function' ||
      !plain(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 8) {
    throw new Error('pinned Vercel issuer, keys and deployment required');
  }
  const expectedSub = `owner:${owner}:project:${project}:environment:${environment}`;
  const keys = new Map();
  for (const key of jwks.keys) {
    if (!plain(key) || key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' ||
        typeof key.kid !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(key.kid) || keys.has(key.kid)) {
      throw new Error('invalid pinned Vercel key');
    }
    let publicKey; try { publicKey = crypto.createPublicKey({ key, format: 'jwk' }); } catch { throw new Error('invalid pinned Vercel key'); }
    if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('invalid pinned Vercel key');
    keys.set(key.kid, publicKey);
  }
  return function verify(token, expectedAudience) {
    try {
      if (typeof token !== 'string' || token.length < 100 || token.length > 32_768 ||
          typeof expectedAudience !== 'string' || expectedAudience.length < 1 || expectedAudience.length > 1024) return false;
      const parts = token.split('.');
      if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
      const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !keys.has(header.kid) ||
          ['jku', 'x5u', 'crit', 'zip'].some(k => Object.hasOwn(header, k))) return false;
      const sig = Buffer.from(parts[2], 'base64url');
      if (sig.toString('base64url') !== parts[2] ||
          !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), keys.get(header.kid), sig)) return false;
      const clock = now(), seconds = Math.floor(clock / 1000);
      if (!Number.isSafeInteger(clock) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
          payload.iat > seconds + 30 || payload.iat < seconds - 7_230 || payload.exp <= seconds - 30 ||
          payload.exp <= payload.iat || payload.exp - payload.iat > 7_230 ||
          (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > seconds + 30))) return false;
      return payload.iss === issuer && payload.aud === expectedAudience && payload.sub === expectedSub &&
        payload.owner === owner && payload.owner_id === ownerId && payload.project === project &&
        payload.project_id === projectId && payload.deployment_id === deploymentId && payload.environment === environment;
    } catch { return false; }
  };
}

/** Fixed HTTPS callback plus exact default OIDC audience. The returned fetch is
 * designed only for ReadOnlyNearRpcProvider/ReadOnlyNearReceiptProvider. */
export function createOidcReadOnlyRpcBridge({ callbackOrigin, defaultAudience, verifyOidc, now = Date.now,
  timeoutMs = 25_000, maxPending = 32, signingPrivateKey, encryptionPrivateKey } = {}) {
  const origin = httpsOrigin(callbackOrigin);
  if (typeof defaultAudience !== 'string' || defaultAudience.length < 1 || defaultAudience.length > 255 ||
      typeof verifyOidc !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 || timeoutMs > 60_000 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100) {
    throw new Error('bounded authenticated relay configuration required');
  }
  let signKey = null, decryptKey = null;
  if (signingPrivateKey !== undefined || encryptionPrivateKey !== undefined) {
    try { signKey = crypto.createPrivateKey(signingPrivateKey); decryptKey = crypto.createPrivateKey(encryptionPrivateKey); }
    catch { throw new Error('both private relay session keys are required'); }
    if (signKey.asymmetricKeyType !== 'ed25519' || decryptKey.asymmetricKeyType !== 'rsa' ||
        decryptKey.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('invalid private relay session keys');
  }
  const jobs = new Map();
  function cleanup(id, error) {
    const job = jobs.get(id); if (!job) return;
    jobs.delete(id); clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.onAbort);
    if (error) job.reject(error);
  }
  function pending() {
    const clock = now();
    if (!Number.isSafeInteger(clock)) return [];
    return [...jobs.entries()].filter(([, job]) => !job.taken && clock < job.expires).map(([id]) => id);
  }
  async function readOnlyFetch(url, options = {}) {
    if (typeof url !== 'string' || new URL(url).href !== 'https://test.rpc.fastnear.com/' ||
        options.method !== 'POST' || options.redirect !== 'error' || typeof options.body !== 'string' ||
        Buffer.byteLength(options.body) > 16_384 || jobs.size >= maxPending) throw new Error('read-only relay request denied');
    let body; try { body = JSON.parse(options.body); } catch { throw new Error('invalid read-only request'); }
    validateReadOnlyJob(body);
    const clock = now();
    if (!Number.isSafeInteger(clock) || options.signal?.aborted) throw new Error('read-only request unavailable');
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const onAbort = () => cleanup(id, new Error('read-only request expired'));
      const timer = setTimeout(onAbort, timeoutMs); timer.unref?.();
      jobs.set(id, { request: structuredClone(body), taken: false, expires: clock + timeoutMs, resolve, reject,
        timer, signal: options.signal, onAbort });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }
  function take(id, token) {
    const job = JOB.test(id ?? '') ? jobs.get(id) : null;
    if (!job || job.taken || now() >= job.expires || !verifyOidc(token, defaultAudience)) return null;
    job.taken = true;
    return structuredClone(job.request);
  }
  function accept(id, digest, input, token, audience) {
    const job = JOB.test(id ?? '') ? jobs.get(id) : null;
    if (!job || !job.taken || now() >= job.expires || !DIGEST.test(digest ?? '') ||
        !(input instanceof Uint8Array) || input.length < 1 || input.length > 4_000_000 || bytesHash(input) !== digest ||
        !verifyOidc(token, audience)) return false;
    // Validate the same JSON-RPC envelope and ID a second time at the trusted
    // backend. The downstream provider still validates results and errors.
    let result; try { result = JSON.parse(Buffer.from(input).toString('utf8')); } catch { return false; }
    if (!plain(result) || result.jsonrpc !== '2.0' || result.id !== job.request.id ||
        (Object.hasOwn(result, 'result') === Object.hasOwn(result, 'error'))) return false;
    cleanup(id);
    job.resolve(new Response(Buffer.from(input), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
    return true;
  }
  function submit(id, digest, input, token) {
    return accept(id, digest, input, token, `${origin}/internal/read-only-results/${id}/${digest}`);
  }
  function takeForBrowser(id) {
    const job = signKey && JOB.test(id ?? '') ? jobs.get(id) : null;
    if (!job || job.taken || now() >= job.expires) return null;
    const requestJson = JSON.stringify(job.request);
    const body = { job_id: id, request_sha256: bytesHash(Buffer.from(requestJson)), expires_at_ms: job.expires,
      request_json: requestJson };
    const signature = crypto.sign(null, Buffer.from(browserJobMessage(body)), signKey);
    job.taken = true;
    return { ...body, signature_base64: signature.toString('base64') };
  }
  function from64(value, limit) {
    if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error();
    const raw = Buffer.from(value, 'base64'); if (raw.toString('base64') !== value) throw Error(); return raw;
  }
  function submitEncrypted(envelope) {
    try {
      const fields = ['version', 'job_id', 'request_sha256', 'encrypted_key_base64', 'iv_base64', 'tag_base64', 'ciphertext_base64'];
      if (!decryptKey || !plain(envelope) || Object.keys(envelope).sort().join(',') !== fields.sort().join(',') ||
          envelope.version !== 1 || !JOB.test(envelope.job_id ?? '') || !DIGEST.test(envelope.request_sha256 ?? '')) return false;
      const job = jobs.get(envelope.job_id);
      if (!job || !job.taken || now() >= job.expires ||
          bytesHash(Buffer.from(JSON.stringify(job.request))) !== envelope.request_sha256) return false;
      const encrypted = from64(envelope.encrypted_key_base64, 1024), iv = from64(envelope.iv_base64, 24),
        tag = from64(envelope.tag_base64, 32), ciphertext = from64(envelope.ciphertext_base64, 1_900_000);
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) return false;
      const key = crypto.privateDecrypt({ key: decryptKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, encrypted);
      try {
        if (key.length !== 32) return false;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(browserEnvelopeAad(envelope)); decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const content = JSON.parse(plaintext.toString('utf8'));
        if (!plain(content) || Object.keys(content).sort().join(',') !== 'response_base64,token' ||
            typeof content.token !== 'string' || content.token.length > 32_768) return false;
        const response = from64(content.response_base64, 1_400_000), digest = bytesHash(response);
        const audience = `${origin}/internal/read-only-results/${envelope.job_id}/${envelope.request_sha256}/${digest}`;
        return accept(envelope.job_id, digest, response, content.token, audience);
      } finally { key.fill(0); }
    } catch { return false; }
  }
  return Object.freeze({ fetch: readOnlyFetch, pending, take, submit, takeForBrowser, submitEncrypted });
}
