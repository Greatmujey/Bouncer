// Small development preview of the reviewed website and its serverless API.
// It serves no repository files outside the public allowlist, signs nothing,
// and binds to all interfaces for the Arena preview proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from '../web/api/google-session.mjs';
import railwayConnection from '../web/api/railway-connection.mjs';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const files = new Set(PUBLIC_WEB_FILES);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const port = Number(process.env.PORT || 4173);
// Only this local preview may opt in to the read-only testnet service. The
// browser uses same-origin /api paths; loopback never appears in browser code.
const readOnlyBackend = process.env.BOUNCER_READONLY_PREVIEW === '1';
const backendPort = Number(process.env.BOUNCER_READONLY_PREVIEW_PORT || 8787);
// Separately opt in to the spending-capable testnet mission backend. The
// browser only sees same-origin paths; the backend is never started here.
const missionBackend = process.env.BOUNCER_NATIVE_MISSION_PREVIEW === '1';
const missionPort = Number(process.env.BOUNCER_NATIVE_MISSION_PORT || 8788);
const walletConnectProjectId = process.env.BOUNCER_WALLETCONNECT_PROJECT_ID || '';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535 ||
    !Number.isInteger(missionPort) || missionPort < 1 || missionPort > 65535) throw new Error('Invalid preview port');
if (walletConnectProjectId && !/^[a-f0-9]{32}$/i.test(walletConnectProjectId)) throw new Error('Invalid WalletConnect project ID');
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://preview.invalid').pathname;
  if (pathname === '/api/google-session') return void session(req, res);
  if (pathname === '/api/railway-connection') return void railwayConnection(req, res);
  if (missionBackend && pathname.startsWith('/api/native-mission/')) {
    if (!['GET', 'POST'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: missionPort, path: req.url, method: req.method,
      headers: { origin: req.headers.origin || '', 'x-bouncer-native-mission': req.headers['x-bouncer-native-mission'] || '',
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
        ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) } }, incoming => {
      res.writeHead(incoming.statusCode || 503, incoming.headers); incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"mission backend unavailable","do_not_retry":true}'); });
    req.pipe(upstream); return;
  }
  if (readOnlyBackend && (pathname.startsWith('/api/read-only/') || pathname.startsWith('/api/wallet-setup/') ||
      pathname.startsWith('/api/native-oracle-setup/'))) {
    if (!['GET', 'POST'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
      headers: { origin: req.headers.origin || '', 'x-bouncer-preview': req.headers['x-bouncer-preview'] || '',
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
        ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}),
        ...(req.headers['transfer-encoding'] ? { 'transfer-encoding': req.headers['transfer-encoding'] } : {}) } }, incoming => {
      res.writeHead(incoming.statusCode || 503, incoming.headers); incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"read-only preview unavailable"}'); });
    req.pipe(upstream); return;
  }
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['GET', 'HEAD'].includes(req.method) || !files.has(filename)) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(filename)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  if (req.method === 'HEAD') return void res.end();
  if (filename === 'walletconnect-config.json' && walletConnectProjectId) {
    return void res.end(`${JSON.stringify({ projectId: walletConnectProjectId })}\n`);
  }
  fs.createReadStream(path.join(web, filename)).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Bouncer website preview listening on port ${port}. Google sign-in is limited to the configured dedicated origin.`));
