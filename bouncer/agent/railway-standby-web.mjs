/**
 * Temporary, testnet-only Railway website while the Vercel deployment limit
 * is in effect. This is the public static workspace, not a mission service.
 * It exposes an explicit allowlist and approves only this dedicated origin.
 * No journal, credential, signer or transaction handler is loaded here.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_WEB_FILES, validatePublicWeb} from '../scripts/stage-public-web.mjs';

export const RAILWAY_WEB_ORIGIN = 'https://bouncer-production-6df1.up.railway.app';
const SOURCE_ORIGIN = 'https://bouncer-near.vercel.app';
const DEFAULT_SOURCE = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = {'.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8', '.zip':'application/zip'};
const CSP = "script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https://accounts.google.com; object-src 'none'; base-uri 'none'";
const BANNER = '<aside class="railway-standby-banner" role="note"><strong>Temporary Railway testnet site.</strong> Vault deployment and Bouncer missions are not enabled here yet. Encrypted setup recovery is available when configured. A separately reviewed direct provider test, if available, bypasses Bouncer.</aside>';

export function createRailwayStandbyWeb({webSource=DEFAULT_SOURCE}={}) {
  validatePublicWeb(webSource);
  const files = new Map(PUBLIC_WEB_FILES.map(name=>[name,fs.readFileSync(path.join(webSource,name))]));
  const index = files.get('index.html').toString('utf8')
    .replace(`content="${SOURCE_ORIGIN}"`, `content="${RAILWAY_WEB_ORIGIN}"`)
    .replace('<main class="main" id="main-content">', `<main class="main" id="main-content">\n        ${BANNER}`);
  if (!index.includes(BANNER) || !index.includes(`content="${RAILWAY_WEB_ORIGIN}"`)) throw new Error('website staging failed');
  files.set('index.html', Buffer.from(index));

  // Return false for paths owned by the backend; no arbitrary files are served.
  return function handle(req,res) {
    let url;try { url=new URL(req.url,'http://internal.invalid'); } catch { return false; }
    const name=url.pathname==='/workspace'?'index.html':url.pathname.slice(1);
    const content=files.get(name);
    if (!content || url.hash) return false;
    if (req.headers.host!==new URL(RAILWAY_WEB_ORIGIN).host ||
        (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto']!=='https')) {
      res.writeHead(421,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('Unavailable');return true;
    }
    if (!['GET','HEAD'].includes(req.method)) {
      res.writeHead(405,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});res.end('Unavailable');return true;
    }
    res.writeHead(200,{'content-type':TYPES[path.extname(name)]||'application/octet-stream','content-length':content.length,
      'content-security-policy':CSP,'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin',
      'cross-origin-opener-policy':'same-origin-allow-popups','permissions-policy':'camera=(), microphone=(), geolocation=()',
      'cache-control':'no-store'});
    res.end(req.method==='HEAD'?undefined:content);return true;
  };
}
