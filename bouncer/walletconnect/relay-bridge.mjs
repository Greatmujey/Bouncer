// A narrowly scoped WalletConnect transport fallback. This is not a general
// proxy: it only connects to Reown's fixed .org relay for Bouncer's public
// project ID, and only accepts the dedicated site origin. Pairing URIs and
// symmetric keys remain in the browser; only the relay authentication token and
// encrypted relay messages pass through this process. Never log URL, payload,
// IP address, auth token, topic, or any WebSocket frame.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeJWT, verifyJWT } from '@walletconnect/relay-auth';

export const BRIDGE_PATH = '/api/wc-relay';
export const BRIDGE_ORIGIN = 'https://bouncer-near.vercel.app';
export const UPSTREAM_RELAY = 'wss://relay.walletconnect.org';
export const BRIDGE_READY = 'BOUNCER_RELAY_READY_V1';
export const BRIDGE_ERROR = 'BOUNCER_RELAY_ERROR_V1';

const AUTH_KEYS = new Set(['auth', 'projectId', 'ua', 'useOnCloseEvent', 'bundleId', 'packageName']);
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const isProjectId = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);

/** Validate without returning or logging anything except the fixed upstream URL. */
export async function validateRelayURL(value, projectId, now = Date.now()) {
  if (!isProjectId(projectId) || typeof value !== 'string' || value.length > 3_000) throw new Error('invalid');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid'); }
  if (url.protocol !== 'wss:' || url.hostname !== 'relay.walletconnect.org' || url.port || url.username || url.password || url.pathname !== '/' || url.hash) throw new Error('invalid');
  const entries = [...url.searchParams.entries()];
  if (entries.length < 3 || entries.length > AUTH_KEYS.size || entries.some(([key, item]) => !AUTH_KEYS.has(key) || item.length > 1_500) ||
      new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('invalid');
  if (url.searchParams.get('projectId') !== projectId || !url.searchParams.get('ua')) throw new Error('invalid');
  const auth = url.searchParams.get('auth') || '';
  if (auth.length > 1_500 || !JWT.test(auth)) throw new Error('invalid');
  try {
    const { payload } = decodeJWT(auth);
    const seconds = Math.floor(now / 1000);
    if (payload.aud !== UPSTREAM_RELAY || typeof payload.iss !== 'string' || !payload.iss.startsWith('did:key:') ||
        typeof payload.sub !== 'string' || payload.sub.length > 256 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
        payload.iat > seconds + 300 || payload.iat < seconds - 86_700 || payload.exp <= seconds - 60 || payload.exp - payload.iat > 86_700 ||
        !(await verifyJWT(auth))) throw new Error('invalid');
  } catch { throw new Error('invalid'); }
  return url.toString();
}

/**
 * Per-instance safeguards limit abuse but are not a globally shared rate
 * limiter. The endpoint is testnet-only infrastructure, not an open proxy.
 * `upstreamFactory` and limits are injectable for local tests only.
 */
export function createRelayBridge({
  projectId, allowedOrigin = BRIDGE_ORIGIN,
  upstreamFactory = (url, options) => new WebSocket(url, options),
  maxConnections = 16, maxPerIp = 2, maxPerMinute = 12,
  handshakeTimeoutMs = 7_000, upstreamTimeoutMs = 12_000, lifetimeMs = 240_000,
  maxPayload = 64 * 1024, maxMessages = 512, maxTotalBytes = 2 * 1024 * 1024,
  onDiagnostic,
} = {}) {
  // Optional tests may count fixed event names. The deployed entry passes no
  // callback and never logs connection, request or session data.
  const diagnostic = code => { try { onDiagnostic?.(code); } catch { /* test diagnostics must not affect transport */ } };
  const active = new Map(), recent = new Map();
  let totalActive = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end('WebSocket upgrade required');
  });
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload });
  const reject = (socket, status) => { try { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); } };
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (req, socket, head) => {
    // No query string: request/access logs must never contain the relay JWT.
    if (!isProjectId(projectId) || req.method !== 'GET' || req.url !== BRIDGE_PATH || req.headers.origin !== allowedOrigin) { diagnostic('UPGRADE_DENIED'); return reject(socket, 403); }
    const forwarded = String(req.headers['x-vercel-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!forwarded || forwarded.length > 100) return reject(socket, 403);
    const now = Date.now();
    for (const [key, value] of recent) if (now - value.start >= 60_000) recent.delete(key);
    if (recent.size > 2_000 || totalActive >= maxConnections || (active.get(forwarded) || 0) >= maxPerIp) return reject(socket, 429);
    const bucket = recent.get(forwarded) || { start: now, count: 0 };
    if (bucket.count >= maxPerMinute) return reject(socket, 429);
    bucket.count++; recent.set(forwarded, bucket);
    try {
      wss.handleUpgrade(req, socket, head, client => {
        active.set(forwarded, (active.get(forwarded) || 0) + 1); totalActive++;
        diagnostic('UPGRADE_ACCEPTED');
        wss.emit('connection', client, req, forwarded);
      });
    } catch { socket.destroy(); }
  });
  wss.on('connection', (client, _req, ip) => {
    let upstream, closed = false, established = false, messages = 0, bytes = 0;
    let handshakeTimer, upstreamTimer, lifetimeTimer;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer); clearTimeout(upstreamTimer); clearTimeout(lifetimeTimer);
      totalActive--;
      const next = (active.get(ip) || 1) - 1;
      if (next) active.set(ip, next); else active.delete(ip);
      try { if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close(); } catch { /* best effort */ }
      try { if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(); } catch { /* best effort */ }
    };
    const fail = code => {
      diagnostic(`FAIL_${code}`);
      if (!closed && client.readyState === WebSocket.OPEN) {
        try { client.send(`${BRIDGE_ERROR}:${code}`); } catch { /* best effort */ }
      }
      finish();
    };
    const forward = (destination, data, binary) => {
      if (closed || !established || binary || destination?.readyState !== WebSocket.OPEN || destination.bufferedAmount > 256 * 1024) { diagnostic(binary ? 'FORWARD_BINARY' : 'FORWARD_UNAVAILABLE'); return finish(); }
      const length = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      messages++; bytes += length;
      if (messages > maxMessages || bytes > maxTotalBytes || length > maxPayload) { diagnostic('FORWARD_LIMIT'); return finish(); }
      diagnostic('FORWARD_OK');
      try { destination.send(data, { binary: false }, error => { if (error) finish(); }); } catch { finish(); }
    };
    client.on('error', finish); client.on('close', finish);
    handshakeTimer = setTimeout(() => fail('TIMEOUT'), handshakeTimeoutMs);
    lifetimeTimer = setTimeout(finish, lifetimeMs);
    client.once('message', async (data, binary) => {
      clearTimeout(handshakeTimer);
      // The browser waits for READY before sending relay messages. Reject
      // extra frames during async JWT verification/upstream establishment.
      const unexpected = () => fail('INVALID');
      client.on('message', unexpected);
      if (binary || data.length > 4_096) return fail('INVALID');
      let request, url;
      try {
        request = JSON.parse(data.toString('utf8'));
        if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'type,url' || request.type !== 'connect') throw new Error('invalid');
        url = await validateRelayURL(request.url, projectId);
      } catch { return fail('INVALID'); }
      if (closed) return;
      try {
        diagnostic('UPSTREAM_DIAL');
        upstream = upstreamFactory(url, { origin: allowedOrigin, handshakeTimeout: upstreamTimeoutMs, perMessageDeflate: false, maxPayload });
        upstream.on('error', error => {
          const code = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code) ? error.code : 'OTHER';
          diagnostic(`UPSTREAM_ERROR_${code}`); fail('UNAVAILABLE');
        });
        upstream.on('unexpected-response', (request, response) => {
          const code = [401, 403].includes(response.statusCode) ? 'AUTH' : 'UNAVAILABLE';
          diagnostic(response.statusCode === 401 ? 'UPSTREAM_401' : response.statusCode === 403 ? 'UPSTREAM_403' : response.statusCode === 429 ? 'UPSTREAM_429' : 'UPSTREAM_HTTP_ERROR');
          response.resume(); request.destroy(); fail(code);
        });
        upstream.on('close', () => { diagnostic('UPSTREAM_CLOSE'); finish(); });
        upstream.on('message', (body, isBinary) => forward(client, body, isBinary));
        upstreamTimer = setTimeout(() => fail('TIMEOUT'), upstreamTimeoutMs);
        upstream.once('open', () => {
          if (closed) return;
          clearTimeout(upstreamTimer);
          diagnostic('UPSTREAM_OPEN');
          established = true;
          client.off('message', unexpected);
          client.on('message', (body, isBinary) => forward(upstream, body, isBinary));
          try { client.send(BRIDGE_READY); } catch { return finish(); }
        });
      } catch { fail('UNAVAILABLE'); }
    });
  });
  return server;
}
