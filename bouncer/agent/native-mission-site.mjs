/**
 * One fixed-origin testnet website + guarded-mission HTTP server. This factory
 * binds no port, generates no keys and sends no transactions on construction.
 * A separately configured service supplies all mission authority. Deploy only
 * behind a dedicated HTTPS reverse proxy that preserves the Host header.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeMissionHttpHandler } from './native-mission-http.mjs';
import { createGoogleSessionHandler } from '../web/api/google-session.mjs';
import { PUBLIC_WEB_FILES, stagePublicWeb } from '../scripts/stage-public-web.mjs';
import { createRelayBridge, BRIDGE_PATH } from '../walletconnect/relay-bridge.mjs';

const DEFAULT_SOURCE=fileURLToPath(new URL('../web/',import.meta.url));
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml',
  '.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.zip':'application/zip'};
const CSP="script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https://accounts.google.com; object-src 'none'; base-uri 'none'";
function security(res) {
  res.setHeader('content-security-policy',CSP);
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','strict-origin-when-cross-origin');
  res.setHeader('cross-origin-opener-policy','same-origin-allow-popups');
  res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('cache-control','no-store');
}
function reject(res,status=404) {res.writeHead(status,{'content-type':'text/plain; charset=utf-8'});res.end('Unavailable');}

/** Exposes only the reviewed static files and exact same-origin API paths. */
export function createNativeMissionSite({siteOrigin,service,walletConnectProjectId='',googleClientId='',webSource=DEFAULT_SOURCE}={}) {
  const handle=createNativeMissionHttpHandler({service,siteOrigin});
  const expectedHost=new URL(siteOrigin).host;
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-site-'));let files;
  try {
    const dest=path.join(tmp,'public');
    stagePublicWeb(dest,webSource,{walletOrigin:siteOrigin,walletConnectProjectId});
    files=new Map(PUBLIC_WEB_FILES.map(name=>[name,fs.readFileSync(path.join(dest,name))]));
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
  const google=createGoogleSessionHandler({origin:siteOrigin,audience:googleClientId});
  const relay=walletConnectProjectId?createRelayBridge({projectId:walletConnectProjectId,allowedOrigin:siteOrigin}):null;
  const hostAllowed=req=>req.headers.host===expectedHost && (!req.headers['x-forwarded-proto'] || req.headers['x-forwarded-proto']==='https');
  const server=http.createServer((req,res)=>{
    security(res);
    if(!hostAllowed(req))return reject(res,421);
    let url;try {url=new URL(req.url,'http://bouncer-internal.invalid');}catch{return reject(res,400)}
    if(url.hash)return reject(res,400);
    if(url.pathname.startsWith('/api/native-mission/')) {
      if(url.search)return reject(res,404);
      return void handle(req,res,url.pathname).catch(()=>{if(!res.headersSent)reject(res,503);else res.destroy()});
    }
    if(url.pathname==='/api/google-session')return void google(req,res).catch(()=>{if(!res.headersSent)reject(res,503);else res.destroy()});
    if(url.pathname===BRIDGE_PATH) {res.writeHead(relay?426:503,{'content-type':'text/plain; charset=utf-8'});return res.end('WalletConnect relay unavailable');}
    if(!['GET','HEAD'].includes(req.method))return reject(res,405);
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1),content=files.get(name);
    if(!content)return reject(res);
    res.writeHead(200,{'content-type':TYPES[path.extname(name)]||'application/octet-stream','content-length':content.length});
    res.end(req.method==='HEAD'?undefined:content);
  });
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('upgrade',(req,socket,head)=>{
    if(!relay || !hostAllowed(req) || req.url!==BRIDGE_PATH) {socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    relay.emit('upgrade',req,socket,head);
  });
  return server;
}
