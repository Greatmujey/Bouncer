#!/usr/bin/env node
/** Railway container entry. Without explicit enablement it serves a public,
 * non-spending standby; it creates no state and never imports the mission
 * runtime. Optional, fixed public read-only checks run once on startup. A
 * configured mission still starts recovery-first. */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const headers=Object.freeze({'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
export const STANDBY_STATUS=Object.freeze({service:'bouncer-testnet-native-backend',status:'STANDBY',
  mission_enabled:false,transactions_enabled:false});

export function railwayNativeStartMode(env=process.env) {
  const enabled=env.BOUNCER_NATIVE_MISSION_ENABLED;
  if(enabled===undefined||enabled===''||enabled==='0')return 'standby';
  if(enabled==='1' && env.BOUNCER_NATIVE_MISSION_INGRESS==='railway-proxy' && env.BOUNCER_NATIVE_MISSION_BIND==='0.0.0.0')return 'configured';
  throw new Error('invalid Railway mission configuration');
}
export function railwayNativePort(env=process.env) {
  if(env.PORT && env.BOUNCER_NATIVE_MISSION_PORT && env.PORT!==env.BOUNCER_NATIVE_MISSION_PORT)throw new Error('port mismatch');
  const raw=env.PORT||env.BOUNCER_NATIVE_MISSION_PORT||'8080';
  if(typeof raw!=='string'||!/^\d{1,5}$/.test(raw)||Number(raw)<1||Number(raw)>65535)throw new Error('invalid port');
  return Number(raw);
}
/** No input is trusted or reflected. No wallet, journal, agent keys or mission
 * runtime is loaded in standby. Optional diagnostics are public reads only,
 * never invoked by a request, and do not establish mission readiness. */
export function createRailwayNativeStandby({readiness,setupHandler,webHandler}={}) {
  if(readiness!==undefined && typeof readiness?.snapshot!=='function')throw new Error('invalid standby diagnostics');
  if(setupHandler!==undefined && typeof setupHandler!=='function')throw new Error('invalid read-only setup handler');
  if(webHandler!==undefined && typeof webHandler!=='function')throw new Error('invalid public website handler');
  const server=http.createServer((req,res)=>{
    if(webHandler && webHandler(req,res))return;
    if(setupHandler && (req.url==='/api/native-mission/v14-preflight'||req.url==='/api/native-mission/v14-receipt'||
        req.url==='/api/native-mission/v14-completed-history')) {
      void setupHandler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,headers);res.end(JSON.stringify({error:'unavailable'}))});
      return;
    }
    const get=req.method==='GET'||req.method==='HEAD';
    const status=get && (req.url==='/'||req.url==='/healthz');
    const diagnostic=get && req.url==='/readiness' && readiness!==undefined;
    req.resume();
    res.writeHead(status||diagnostic?200:404,headers);
    res.end(req.method==='HEAD' ? undefined : JSON.stringify(status?STANDBY_STATUS:diagnostic?readiness.snapshot():{error:'unavailable'}));
  });
  server.requestTimeout=10_000;server.headersTimeout=12_000;server.keepAliveTimeout=5_000;
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('upgrade',(_req,socket)=>socket.destroy());
  return server;
}
let classifyStartupError=()=> 'CONFIGURATION_OR_RUNTIME';
async function main() {
  if(process.argv.length!==2)throw new Error('invalid arguments');
  if(railwayNativeStartMode()==='configured') {
    const {startNativeMissionSite,classifyNativeMissionStartupError}=await import('./start-native-mission-site.mjs');
    classifyStartupError=classifyNativeMissionStartupError;
    await startNativeMissionSite();return;
  }
  const check=process.env.BOUNCER_STANDBY_READINESS;
  if(check!==undefined && check!=='' && check!=='0' && check!=='1')throw new Error('invalid standby diagnostics configuration');
  let readiness,setupHandler;
  if(check==='1') {
    const {createStandbyReadiness}=await import('../agent/railway-standby-readiness.mjs');
    readiness=createStandbyReadiness();
  }
  const setup=process.env.BOUNCER_V14_SETUP_READONLY;
  if(setup!==undefined&&setup!==''&&setup!=='0'&&setup!=='1')throw new Error('invalid read-only setup configuration');
  if(setup==='1') {
    const [{ReadOnlyNearReceiptProvider},{createV14SetupReadService},{createV14SetupReadHttpHandler},{V14_SETUP_TESTNET_RPC}]=await Promise.all([
      import('../agent/read-only-near-receipts.mjs'),import('../agent/v14-setup-read-service.mjs'),
      import('../agent/v14-setup-read-http.mjs'),import('../agent/v14-setup-rpc-verifier.mjs')]);
    const provider=new ReadOnlyNearReceiptProvider(V14_SETUP_TESTNET_RPC,{timeoutMs:15_000});
    const service=createV14SetupReadService({provider});
    setupHandler=createV14SetupReadHttpHandler({service,siteOrigin:process.env.BOUNCER_WALLET_ORIGIN,
      backendOrigin:process.env.BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN,proxySecret:process.env.BOUNCER_NATIVE_MISSION_PROXY_SECRET});
  }
  // The existing Railway service is a temporary static testnet website as
  // well as a standby backend. The exact hosted origin is fixed in the
  // handler; this does not enable any backend transaction or mission route.
  const {createRailwayStandbyWeb}=await import('../agent/railway-standby-web.mjs');
  const webHandler=createRailwayStandbyWeb();
  const port=railwayNativePort(),server=createRailwayNativeStandby({readiness,setupHandler,webHandler});
  await new Promise((resolve,reject)=>server.listen(port,'0.0.0.0',resolve).once('error',reject));
  console.log(`Bouncer testnet backend in STANDBY on port ${port}; static workspace available, no backend transactions or missions enabled.${setupHandler?' Read-only setup verification is enabled.':''}`);
  if(readiness)void readiness.start().catch(()=>{});
  let stopping=false;
  const shutdown=()=>{if(stopping)return;stopping=true;server.close(error=>{if(error)process.exitCode=1});server.closeIdleConnections?.()};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(error=>{console.error(`Bouncer Railway service did not start (${classifyStartupError(error)}). Preserve any original journal; no startup transaction was sent.`);process.exitCode=1});
}
