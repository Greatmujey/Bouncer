// Google identity only. This endpoint never accepts NEAR keys or authorizes
// transactions. It validates Google's ID token before creating a short-lived,
// host-only, HttpOnly session. A session is re-verified on every request.
import { createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

const PRODUCTION_ORIGIN = 'https://bouncer-near.vercel.app';
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const SESSION_COOKIE = '__Host-bouncer_session';
const NONCE_COOKIE = '__Host-bouncer_nonce';
const CLIENT_ID_RE = /^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;
// Keep the token below normal per-cookie limits including cookie attributes.
const TOKEN_LIMIT = 3500;
const BODY_LIMIT = 12288;
const MAX_SESSION_SECONDS = 3600;
let cachedKeys;
let cachedUntil = 0;
let lastForcedRefresh = 0;

function decodePart(part, maxBytes) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part) || part.length > maxBytes * 2) throw new Error('invalid token');
  const bytes = Buffer.from(part, 'base64url');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64url') !== part) throw new Error('invalid token');
  return bytes;
}

function parsePart(part, maxBytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(decodePart(part, maxBytes));
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid token');
  return value;
}

/** Verify a compact RS256 ID token using keys fetched only from Google's fixed
 * HTTPS JWKS URL. `keys`, `now` and `nonce` are injected in tests; production
 * always uses the configured app audience and Google-issued keys. */
export function verifyGoogleIdToken(token, { audience, keys, now = Date.now(), nonce } = {}) {
  if (typeof token !== 'string' || token.length > TOKEN_LIMIT || !CLIENT_ID_RE.test(audience || '') || !Array.isArray(keys)) throw new Error('invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid token');
  const header = parsePart(parts[0], 1024), claims = parsePart(parts[1], 4096);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) throw new Error('invalid token');
  // Refuse ambiguous key IDs as well as algorithms or keys outside Google's
  // documented RSA signing set.
  const matching = keys.filter(key => key && key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig' && (!key.alg || key.alg === 'RS256'));
  if (matching.length !== 1) throw new Error('unknown signing key');
  let publicKey;
  try { publicKey = createPublicKey({ key: matching[0], format: 'jwk' }); }
  catch { throw new Error('invalid signing key'); }
  if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('invalid signing key');
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), publicKey, decodePart(parts[2], 1024))) throw new Error('invalid signature');
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) ||
      claims.exp <= seconds || claims.iat > seconds + 60 || claims.iat < seconds - MAX_SESSION_SECONDS - 60 ||
      claims.exp <= claims.iat || claims.exp - claims.iat > MAX_SESSION_SECONDS + 60 ||
      claims.aud !== audience || (claims.azp !== undefined && claims.azp !== audience) ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
      typeof claims.sub !== 'string' || !/^[0-9]{1,128}$/.test(claims.sub)) throw new Error('invalid claims');
  if (nonce !== undefined) {
    if (typeof nonce !== 'string' || typeof claims.nonce !== 'string') throw new Error('invalid nonce');
    const a = Buffer.from(nonce), b = Buffer.from(claims.nonce);
    if (a.length !== b.length || a.length !== 43 || !timingSafeEqual(a, b)) throw new Error('invalid nonce');
  }
  // Do not expose the JWT, picture URL or unverified email to the browser.
  const name = typeof claims.name === 'string' ? claims.name.slice(0, 120) : '';
  const email = claims.email_verified === true && typeof claims.email === 'string' ? claims.email.slice(0, 254) : '';
  return { sub: claims.sub, name, email, expiresAt: claims.exp };
}

async function googleKeys(force = false) {
  const now = Date.now();
  if (cachedKeys && cachedUntil > now && (!force || now - lastForcedRefresh < 10_000)) return cachedKeys;
  if (force) lastForcedRefresh = now;
  const response = await fetch(GOOGLE_KEYS_URL, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Google keys unavailable');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 128 * 1024) throw new Error('Google keys too large');
  // Google's JWKS is small. Limit bytes before decoding even if the header was
  // absent or misleading; never fetch a key URL supplied by a JWT header.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Google keys unavailable');
  let total = 0; const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 128 * 1024) throw new Error('Google keys too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 20) throw new Error('Google keys unavailable');
  cachedKeys = body.keys;
  // A short cache supports rotation and bounds the lifetime of a stale key.
  cachedUntil = now + 5 * 60 * 1000;
  return cachedKeys;
}

function cookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string' || raw.length > 16384) return '';
  const values = raw.split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`)).map(x => x.slice(name.length + 1));
  return values.length === 1 ? values[0] : '';
}
const makeCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

function configuredOrigin(req, origin = PRODUCTION_ORIGIN) {
  // Restrict identity to the app's dedicated origin, never a shared Pages or
  // unrelated Vercel domain. An Origin header must agree, if present.
  const expected = new URL(origin);
  const host = req.headers.host;
  const requestOrigin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  return host === expected.host && (!requestOrigin || requestOrigin === origin) &&
    (!fetchSite || ['same-origin', 'none'].includes(fetchSite)) &&
    (!req.headers['x-forwarded-proto'] || req.headers['x-forwarded-proto'] === expected.protocol.slice(0, -1));
}

function sameOriginMutation(req, origin) {
  return configuredOrigin(req, origin) && req.headers.origin === origin && req.headers['x-bouncer-auth'] === '1';
}

async function readJson(req) {
  let input = req.body;
  if (input === undefined) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new Error('body too large');
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (Buffer.byteLength(input) > BODY_LIMIT) throw new Error('body too large');
    input = JSON.parse(input.toString());
  } else if (Buffer.byteLength(JSON.stringify(input) || '') > BODY_LIMIT) throw new Error('body too large');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid body');
  return input;
}

function json(res, status, body, cookies = []) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(JSON.stringify(body));
}

/** Dependency injection is for isolated tests; the deployed default does not
 * accept an audience, origin, keys, or clock from the browser. */
export function createGoogleSessionHandler({ audience = process.env.BOUNCER_GOOGLE_CLIENT_ID || '',
  origin = PRODUCTION_ORIGIN, keys = googleKeys, now = Date.now } = {}) {
  async function verifyToken(token, nonce) {
    let availableKeys = await keys(false);
    try { return verifyGoogleIdToken(token, { audience, keys: availableKeys, now: now(), nonce }); }
    catch (error) {
      if (error.message !== 'unknown signing key') throw error;
      availableKeys = await keys(true);
      return verifyGoogleIdToken(token, { audience, keys: availableKeys, now: now(), nonce });
    }
  }
  return async (req, res) => {
    if (!configuredOrigin(req, origin)) return json(res, 403, { error: 'Sign-in is available only on the dedicated Bouncer site.' });
    if (!CLIENT_ID_RE.test(audience)) return json(res, 503, { error: 'Google sign-in is not configured.' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.searchParams.get('challenge') === '1') {
      // The custom header is not sent by cross-origin form or image requests.
      if (req.headers['x-bouncer-auth'] !== '1') return json(res, 403, { error: 'Request not allowed.' });
      const nonce = randomBytes(32).toString('base64url');
      return json(res, 200, { clientId: audience, nonce }, [makeCookie(NONCE_COOKIE, nonce, 300)]);
    }
    if (req.method === 'GET') {
      const token = cookie(req, SESSION_COOKIE);
      if (!token) return json(res, 200, { authenticated: false });
      try {
        const identity = await verifyToken(token);
        return json(res, 200, { authenticated: true, user: identity });
      } catch {
        return json(res, 200, { authenticated: false }, [makeCookie(SESSION_COOKIE, '', 0)]);
      }
    }
    if (req.method === 'POST') {
      if (!sameOriginMutation(req, origin) || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'Request not allowed.' });
      try {
        const body = await readJson(req);
        if (Object.keys(body).length !== 1 || typeof body.credential !== 'string') throw new Error('invalid body');
        const nonce = cookie(req, NONCE_COOKIE);
        if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('missing nonce');
        const identity = await verifyToken(body.credential, nonce);
        const lifetime = Math.min(MAX_SESSION_SECONDS, identity.expiresAt - Math.floor(now() / 1000));
        if (lifetime < 1) throw new Error('expired');
        return json(res, 200, { authenticated: true, user: identity }, [makeCookie(NONCE_COOKIE, '', 0), makeCookie(SESSION_COOKIE, body.credential, lifetime)]);
      } catch {
        return json(res, 401, { authenticated: false, error: 'Google identity could not be verified.' }, [makeCookie(NONCE_COOKIE, '', 0)]);
      }
    }
    if (req.method === 'DELETE') {
      if (!sameOriginMutation(req, origin)) return json(res, 403, { error: 'Request not allowed.' });
      return json(res, 200, { authenticated: false }, [makeCookie(SESSION_COOKIE, '', 0), makeCookie(NONCE_COOKIE, '', 0)]);
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return json(res, 405, { error: 'Method not allowed.' });
  };
}

export default createGoogleSessionHandler();
