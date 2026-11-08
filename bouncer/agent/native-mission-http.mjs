/** Explicitly mounted same-origin testnet mission endpoint. No endpoint is
 * mounted by the static site by default. This server may spend only through
 * the fixed authenticated mission service; it is NOT a read-only endpoint. */
import http from 'node:http';
const PREFIX = '/api/native-mission/', MAX_BODY = 8192;
const exact = (x, fields) => x && Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(value));
}
async function body(req) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > MAX_BODY)) throw Error();
  let count = 0; const chunks = [];
  for await (const chunk of req) { count += chunk.length; if (count > MAX_BODY) throw Error(); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks, count).toString('utf8'));
}
export function createNativeMissionHttpHandler({ service, siteOrigin, now = Date.now, bodyTimeoutMs = 10_000 } = {}) {
  let site; try { site = new URL(siteOrigin); } catch { throw new Error('fixed dedicated HTTPS site origin required'); }
  if (site.protocol !== 'https:' || site.origin !== siteOrigin || site.username || site.password || site.pathname !== '/' || site.search || site.hash ||
      site.hostname === 'github.io' || site.hostname.endsWith('.github.io') || site.hostname === 'madethis.website' ||
      site.hostname.endsWith('.madethis.website') || !service ||
      ['getReview','preview','issue','execute','originals','recover'].some(name => typeof service[name] !== 'function') ||
      typeof now !== 'function' || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 10_000) {
    throw new Error('fixed dedicated HTTPS site origin and configured testnet mission service required');
  }
  let pending = 0, count = 0, started = now();
  const specs = { preview: ['preview', ['missionSha256']], challenge: ['issue', ['missionSha256','ownerPublicKey']],
    execute: ['execute', ['missionSha256','ownerPublicKey','evidence']], originals: ['originals', ['missionSha256']],
    recover: ['recover', ['missionSha256']] };
  return async function handle(req, res, pathname) {
    if (req.headers['x-bouncer-native-mission'] !== 'v1' || (req.headers.origin && req.headers.origin !== siteOrigin)) return reply(res, 403, { error: 'unavailable' });
    if (pathname === `${PREFIX}config` && req.method === 'GET') return reply(res, 200, { enabled: true, network: 'testnet', review: service.getReview() });
    const match = /^\/api\/native-mission\/([a-z]+)$/.exec(pathname), spec = match && specs[match[1]];
    if (!spec || req.method !== 'POST') return reply(res, 404, { error: 'unavailable' });
    if (req.headers.origin !== siteOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(res, 403, { error: 'unavailable' });
    const clock = now();
    if (!Number.isSafeInteger(clock) || clock < started) return reply(res, 503, { error: 'unavailable', do_not_retry: true });
    if (clock - started >= 120_000) { started = clock; count = 0; }
    if (pending >= 4 || count >= 80) return reply(res, 429, { error: 'unavailable', do_not_retry: true });
    pending++; count++;
    try {
      const timer = setTimeout(() => req.destroy(), bodyTimeoutMs); timer.unref?.();
      let value; try { value = await body(req); } finally { clearTimeout(timer); }
      if (!exact(value, spec[1])) return reply(res, 400, { error: 'invalid request' });
      return reply(res, 200, await service[spec[0]](value));
    } catch {
      return reply(res, 409, { error: 'NATIVE_MISSION_UNAVAILABLE', do_not_retry: true,
        message: 'Stop and reconcile any original transaction before approving again.' });
    } finally { pending--; }
  };
}

/** Server builder only; caller chooses a private bind address and TLS proxy.
 * It starts nothing, provisions nothing, and never loads keys from requests. */
export function createNativeMissionHttpServer(options) {
  const handle = createNativeMissionHttpHandler(options);
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://internal.invalid'); } catch { return reply(res, 404, { error: 'unavailable' }); }
    if (url.search || url.hash) return reply(res, 404, { error: 'unavailable' });
    void handle(req, res, url.pathname).catch(() => {
      if (!res.headersSent) reply(res, 503, { error: 'unavailable', do_not_retry: true });
      else res.end();
    });
  });
}
