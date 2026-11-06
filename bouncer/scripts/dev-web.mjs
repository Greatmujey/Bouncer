// Small development preview of the reviewed website and its serverless API.
// It serves no repository files outside the public allowlist, signs nothing,
// and binds to all interfaces for the Arena preview proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from '../web/api/google-session.mjs';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const files = new Set(PUBLIC_WEB_FILES);
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const port = Number(process.env.PORT || 4173);
const walletConnectProjectId = process.env.BOUNCER_WALLETCONNECT_PROJECT_ID || '';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (walletConnectProjectId && !/^[a-f0-9]{32}$/i.test(walletConnectProjectId)) throw new Error('Invalid WalletConnect project ID');
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://preview.invalid').pathname;
  if (pathname === '/api/google-session') return void session(req, res);
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
