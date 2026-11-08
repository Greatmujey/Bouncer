// Browser-test only: serve reviewed local public assets as intercepted responses
// for the exact Vercel origin. No socket, credentials, wallet or chain access.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_WEB_FILES} from './stage-public-web.mjs';
export const VERCEL_ORIGIN='https://bouncer-near.vercel.app';
const web=fileURLToPath(new URL('../web/',import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(web,'vercel.json'),'utf8'));
const globalHeaders=Object.fromEntries(config.headers.find(h=>h.source==='/(.*)').headers.map(h=>[h.key,h.value]));
const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.json':'application/json',
  '.txt':'text/plain; charset=utf-8','.zip':'application/zip'};
export async function serveStagedVercel(route) {
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==VERCEL_ORIGIN)throw Error('wrong test origin');
  if(url.pathname==='/api/google-session')return route.fulfill({status:503,contentType:'application/json',body:'{}'});
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(request.method()!=='GET'||!PUBLIC_WEB_FILES.includes(name))return route.fulfill({status:404,body:'not found'});
  return route.fulfill({status:200,headers:globalHeaders,contentType:mime[path.extname(name)]||'application/octet-stream',
    body:fs.readFileSync(path.join(web,name))});
}
