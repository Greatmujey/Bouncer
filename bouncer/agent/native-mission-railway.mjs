/** API-only ingress for a single persistent mission service behind Vercel.
 * The shared proxy secret is a network gate, not wallet authorization. The
 * guarded service still requires a fresh owner signature for each payment. */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createNativeMissionHttpHandler } from './native-mission-http.mjs';
import { validateNativeProxySiteOrigin, validateRailwayNativeBackend, validateNativeProxySecret } from './native-mission-proxy.mjs';

function reject(res, status) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
  res.end(JSON.stringify({error:'unavailable'}));
}
function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/** Binds no port, reads no agent keys, and sends no transactions. */
export function createRailwayNativeMissionBackend({siteOrigin, backendOrigin, proxySecret, service} = {}) {
  const origin = validateNativeProxySiteOrigin(siteOrigin);
  const host = new URL(validateRailwayNativeBackend(backendOrigin)).host;
  const secret = validateNativeProxySecret(proxySecret);
  const handle = createNativeMissionHttpHandler({service, siteOrigin:origin});
  const server = http.createServer((req,res) => {
    // Only the Vercel proxy knows this secret. Do not trust forwarded host or
    // origin headers by themselves: they can be forged by a direct client.
    if (req.headers.host !== host || req.headers['x-forwarded-proto'] !== 'https' ||
        !secretMatches(req.headers['x-bouncer-proxy-secret'], secret)) return reject(res, 403);
    let url; try { url = new URL(req.url, 'http://internal.invalid'); } catch { return reject(res, 404); }
    if (url.search || url.hash || !/^\/api\/native-mission\/(?:config|preview|challenge|execute|originals|recover)$/.test(url.pathname)) {
      return reject(res, 404);
    }
    void handle(req,res,url.pathname).catch(() => {
      if (!res.headersSent) reject(res,503); else res.destroy();
    });
  });
  server.on('clientError',(_error,socket) => socket.destroy());
  server.on('upgrade',(_req,socket) => socket.destroy());
  return server;
}
