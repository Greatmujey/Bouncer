/**
 * Optional same-origin Vercel -> persistent Node mission proxy.
 * Disabled unless explicitly configured. It accepts no wallet keys, does not
 * sign or send transactions, and never retries an upstream request. An
 * uncertain execute response is recovery-only, even if the proxy timed out.
 */
import { isIP } from 'node:net';
import { readBoundedBytes } from '../shared/bounded-json.mjs';

export const NATIVE_PROXY_ACTIONS = Object.freeze(['config','preview','challenge','execute','originals','recover','v14-preflight','v14-receipt']);
export const DEFAULT_WALLET_ORIGIN = 'https://bouncer-near.vercel.app';
const MAX_BODY = 8192, MAX_SETUP_BODY = 24_000, MAX_RESPONSE = 131072;
const setupAction = action => action==='v14-preflight'||action==='v14-receipt';
const noStore = { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
  'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' };
const exactRoute = action => `/api/native-mission/${action}`;
function reply(res, status, body) { res.writeHead(status, noStore); res.end(JSON.stringify(body)); }

export function validateNativeProxySiteOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('dedicated HTTPS wallet origin required'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port ||
      isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local') ||
      url.hostname === 'github.io' || url.hostname.endsWith('.github.io') ||
      url.hostname === 'madethis.website' || url.hostname.endsWith('.madethis.website') ||
      url.hostname.length > 253 || !url.hostname.includes('.') ||
      url.hostname.split('.').some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('dedicated HTTPS wallet origin required');
  }
  return url.origin;
}

/** Railway's public domain must be fixed by the operator, never the browser.
 * Reject paths, credentials, query strings, ports, redirects and local hosts. */
export function validateRailwayNativeBackend(value) {
  let url; try { url = new URL(value); } catch { throw new Error('fixed Railway HTTPS origin required'); }
  const host = url.hostname, suffix = '.up.railway.app', label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port ||
      !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
    throw new Error('fixed Railway HTTPS origin required');
  }
  return url.origin;
}

export function validateNativeProxySecret(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('a 32-byte random proxy secret in lower-case hex is required');
  return value;
}

async function requestBody(req, limit=MAX_BODY) {
  const length = req.headers['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || BigInt(length) > BigInt(limit))) throw Error();
  let bytes;
  // Vercel may already have parsed application/json before invoking a Node
  // handler. Otherwise consume the raw stream with the same size limit.
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') bytes = Buffer.from(req.body);
    else if (req.body && typeof req.body === 'object') bytes = Buffer.from(JSON.stringify(req.body));
    else throw Error();
    if (bytes.length > limit) throw Error();
  } else {
    const chunks = []; let total = 0;
    const timer = setTimeout(() => req.destroy(), 10_000); timer.unref?.();
    try {
      for await (const chunk of req) {
        total += chunk.length; if (total > limit) throw Error(); chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, total);
    } finally { clearTimeout(timer); }
  }
  if (!bytes.length) throw Error();
  JSON.parse(bytes.toString('utf8')); // backend independently validates exact fields
  return bytes;
}

/** One fixed action per deployed function. Test injection is not an HTTP API. */
export function createVercelNativeMissionProxy({ action, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!NATIVE_PROXY_ACTIONS.includes(action) || !env || typeof fetchImpl !== 'function') throw new Error('invalid mission proxy');
  return async function proxy(req, res) {
    // Do not expose an active-looking endpoint until the operator explicitly
    // configures it. This makes the existing static-only deployment fail shut.
    if (setupAction(action) ? env.BOUNCER_V14_SETUP_PROXY_ENABLED !== '1' : env.BOUNCER_NATIVE_MISSION_PROXY_ENABLED !== '1') {
      return reply(res, 404, {error:'unavailable'});
    }
    let siteOrigin, backendOrigin, secret, url;
    try {
      siteOrigin = validateNativeProxySiteOrigin(env.BOUNCER_WALLET_ORIGIN || DEFAULT_WALLET_ORIGIN);
      backendOrigin = validateRailwayNativeBackend(env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN);
      secret = validateNativeProxySecret(env.BOUNCER_NATIVE_MISSION_PROXY_SECRET);
      url = new URL(req.url, siteOrigin);
    } catch { return reply(res, 503, {error:'unavailable',do_not_retry:true}); }
    if (url.pathname !== exactRoute(action) || url.search || url.hash ||
        req.headers.host !== new URL(siteOrigin).host ||
        (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') ||
        req.headers['x-bouncer-native-mission'] !== 'v1' ||
        (req.headers.origin && req.headers.origin !== siteOrigin)) return reply(res, 403, {error:'unavailable'});
    const config = action === 'config';
    if (req.method !== (config ? 'GET' : 'POST')) return reply(res, 404, {error:'unavailable'});
    if (!config && (req.headers.origin !== siteOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))) {
      return reply(res, 403, {error:'unavailable'});
    }
    let bytes;
    try { if (!config) bytes = await requestBody(req,setupAction(action)?MAX_SETUP_BODY:MAX_BODY); }
    catch { return reply(res, 400, {error:'unavailable',do_not_retry:true}); }
    try {
      // Neither cookies nor arbitrary client headers are forwarded. TLS and a
      // separate origin secret protect the service, while the owner signature
      // and one-use database challenge remain the spending authority.
      const upstream = await fetchImpl(`${backendOrigin}${exactRoute(action)}`, {
        method:config ? 'GET' : 'POST', redirect:'error', cache:'no-store',
        signal:AbortSignal.timeout(action === 'execute' ? 150_000 : action === 'recover' || setupAction(action) ? 110_000 : 25_000),
        headers:{ origin:siteOrigin, 'x-bouncer-native-mission':'v1', 'x-bouncer-proxy-secret':secret,
          ...(config ? {} : {'content-type':'application/json'}) },
        ...(config ? {} : {body:bytes}),
      });
      if (!upstream || ![200,400,403,404,409,429,503].includes(upstream.status) ||
          !/^application\/json(?:\s*;|$)/i.test(upstream.headers?.get('content-type') ?? '')) throw Error();
      const data = await readBoundedBytes(upstream, {maxBytes:MAX_RESPONSE,label:'mission backend'});
      const text = data.toString('utf8');
      if (text.includes(secret)) throw Error();
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      return reply(res, upstream.status, value);
    } catch {
      // There is never an automatic re-send. The Railway process may still be
      // running after this proxy/request times out; check original hashes.
      return reply(res, 503, {error:'NATIVE_MISSION_UNAVAILABLE',do_not_retry:true,
        message:'The result may be uncertain. Check the original before approving again.'});
    }
  };
}
