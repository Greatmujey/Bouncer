/** A limited phone-preview API: read-only funding indication and unsigned setup
 * review. It has no signing, spending, wallet-prompt or seller-order routes.
 * Deployment identity and callback origin are supplied by the operator. */
import crypto from 'node:crypto';
import http from 'node:http';

const idPattern = /^[a-f0-9]{32}$/;
function fixedOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('fixed HTTPS site origin required'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/') {
    throw new Error('fixed HTTPS site origin required');
  }
  return value;
}
function reply(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(text);
}
function bearer(req) {
  const text = req.headers.authorization;
  return typeof text === 'string' && /^Bearer [A-Za-z0-9._-]{100,32768}$/.test(text) ? text.slice(7) : '';
}
async function bytes(req, limit) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > limit)) throw Error();
  const chunks = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > limit) throw Error(); chunks.push(chunk); }
  return Buffer.concat(chunks, count);
}

/** No client-selected owner, vault, RPC URL, account data or transaction. */
export function createReadOnlyPreviewService({ bridge, siteOrigin, relayUrl, inspectReadiness, makeReview, now = Date.now } = {}) {
  const site = fixedOrigin(siteOrigin);
  if (relayUrl !== undefined && relayUrl !== 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read') {
    throw new Error('fixed experimental relay URL required');
  }
  if (!bridge || ['pending', 'take', 'submit', 'takeForBrowser', 'submitEncrypted'].some(k => typeof bridge[k] !== 'function') ||
      typeof inspectReadiness !== 'function' || typeof makeReview !== 'function' || typeof now !== 'function') {
    throw new Error('read-only preview dependencies required');
  }
  const tasks = new Map(); let active = false;
  function prune() {
    const current = now();
    for (const [id, task] of tasks) if (task.finished && current - task.finished > 120_000) tasks.delete(id);
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://preview.invalid'), pathname = url.pathname;
      if (url.search || url.hash) return reply(res, 404, { error: 'not found' });
      if (pathname === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok', scope: 'read-only preview' });
      let match = /^\/internal\/read-only-jobs\/([a-f0-9]{32})$/.exec(pathname);
      if (match && req.method === 'GET') {
        const job = bridge.take(match[1], bearer(req));
        return job ? reply(res, 200, job) : reply(res, 404, { error: 'unavailable' });
      }
      match = /^\/internal\/read-only-results\/([a-f0-9]{32})\/([a-f0-9]{64})$/.exec(pathname);
      if (match && req.method === 'POST' && /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        const raw = await bytes(req, 4_000_000);
        return bridge.submit(match[1], match[2], raw, bearer(req))
          ? reply(res, 200, { accepted: true }) : reply(res, 404, { error: 'unavailable' });
      }
      if (req.headers.origin && req.headers.origin !== site) return reply(res, 403, { error: 'origin rejected' });
      if (pathname.startsWith('/api/read-only/') && req.headers['x-bouncer-preview'] !== 'read-only') {
        return reply(res, 403, { error: 'origin rejected' });
      }
      if (pathname === '/api/read-only/config' && req.method === 'GET') {
        return relayUrl ? reply(res, 200, { relay_url: relayUrl }) : reply(res, 503, { error: 'relay not configured' });
      }
      if (pathname === '/api/read-only/pending' && req.method === 'GET') return reply(res, 200, { jobs: bridge.pending() });
      match = /^\/api\/read-only\/jobs\/([a-f0-9]{32})$/.exec(pathname);
      if (match && req.method === 'GET') {
        const work = bridge.takeForBrowser(match[1]);
        return work ? reply(res, 200, work) : reply(res, 404, { error: 'unavailable' });
      }
      if (pathname === '/api/read-only/results' && req.method === 'POST' && req.headers.origin === site &&
          /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        const raw = await bytes(req, 1_900_000); let envelope;
        try { envelope = JSON.parse(raw.toString('utf8')); } catch { return reply(res, 400, { error: 'invalid result' }); }
        return bridge.submitEncrypted(envelope) ? reply(res, 200, { accepted: true }) : reply(res, 404, { error: 'unavailable' });
      }
      if (pathname === '/api/read-only/review' && req.method === 'POST') {
        if (req.headers.origin !== site || req.headers['x-bouncer-preview'] !== 'read-only' || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) {
          return reply(res, 403, { error: 'origin rejected' });
        }
        prune();
        if (active || tasks.size >= 8) return reply(res, 429, { error: 'read-only check already in progress' });
        active = true;
        const id = crypto.randomBytes(16).toString('hex'), task = { state: 'checking', finished: 0 };
        tasks.set(id, task);
        void (async () => {
          try {
            const snapshot = await inspectReadiness();
            const review = await makeReview(snapshot);
            task.state = 'complete'; task.snapshot = snapshot; task.review = review;
          } catch { task.state = 'unavailable'; }
          finally { task.finished = now(); active = false; }
        })();
        return reply(res, 202, { task_id: id });
      }
      match = /^\/api\/read-only\/review\/([a-f0-9]{32})$/.exec(pathname);
      if (match && req.method === 'GET' && idPattern.test(match[1])) {
        prune(); const task = tasks.get(match[1]);
        if (!task) return reply(res, 404, { error: 'unavailable' });
        if (task.state === 'complete') return reply(res, 200, { state: task.state, snapshot: task.snapshot, review: task.review });
        return reply(res, 200, { state: task.state });
      }
      return reply(res, 404, { error: 'not found' });
    } catch { if (!res.headersSent) reply(res, 503, { error: 'read-only preview unavailable' }); else res.destroy(); }
  });
}
