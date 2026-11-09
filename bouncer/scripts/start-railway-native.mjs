#!/usr/bin/env node
/** Railway container entry. Without explicit enablement it serves a public,
 * non-spending standby and never imports the mission runtime. A narrowly
 * targeted persistence diagnostic may write one non-secret marker, never a
 * recovery record. An independently configured anchor never initializes on
 * startup and has no transaction route. A configured mission starts recovery-first. */
import http from 'node:http';
import fs from 'node:fs';
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
/** No input is trusted or reflected. Default standby loads no wallet, journal,
 * agent keys or mission runtime. The optional recovery anchor stores no key
 * or transaction handler. Requests only read cached diagnostics; an optional
 * isolated startup marker does not establish mission or recovery readiness. */
export function createRailwayNativeStandby({readiness,setupHandler,webHandler,bootstrapAnchorHandler}={}) {
  if(readiness!==undefined && typeof readiness?.snapshot!=='function')throw new Error('invalid standby diagnostics');
  if(setupHandler!==undefined && typeof setupHandler!=='function')throw new Error('invalid read-only setup handler');
  if(webHandler!==undefined && typeof webHandler!=='function')throw new Error('invalid public website handler');
  if(bootstrapAnchorHandler!==undefined && typeof bootstrapAnchorHandler!=='function')throw new Error('invalid recovery anchor handler');
  const server=http.createServer((req,res)=>{
    if(bootstrapAnchorHandler && req.url==='/api/v14-bootstrap-anchor'){
      void bootstrapAnchorHandler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,headers);res.end(JSON.stringify({error:'unavailable'}))});
      return;
    }
    if(webHandler && webHandler(req,res))return;
    if(setupHandler && (req.url==='/api/native-mission/v14-preflight'||req.url==='/api/native-mission/v14-receipt'||
        req.url==='/api/native-mission/v14-completed-history')) {
      void setupHandler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,headers);res.end(JSON.stringify({error:'unavailable'}))});
      return;
    }
    const get=req.method==='GET'||req.method==='HEAD';
    const status=get && (req.url==='/'||req.url==='/healthz');
    // Bounded numeric cache-busters let the same non-secret snapshot be read
    // across deploys. No supplied query is used or reflected in the response.
    const diagnostic=get && (req.url==='/readiness'||/^\/readiness\?volume-probe=\d{1,6}$/.test(req.url)) && readiness!==undefined;
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
  const anchorFlag=process.env.BOUNCER_V14_BOOTSTRAP_RAILWAY_ANCHOR;
  if(anchorFlag!==undefined&&anchorFlag!==''&&anchorFlag!=='0'&&anchorFlag!=='1')throw new Error('invalid recovery anchor configuration');
  let readiness,setupHandler;
  if(check==='1') {
    const [{createStandbyReadiness,inspectStandbyMount},{isRailwayRecoveryProbeTarget,runRailwayRecoveryVolumeProbe}]=await Promise.all([
      import('../agent/railway-standby-readiness.mjs'),import('../agent/railway-recovery-volume-probe.mjs')]);
    let recoveryVolumeProbe;
    if(isRailwayRecoveryProbeTarget()) {
      // This is a non-secret diagnostic, not the real checkpoint. Only this
      // exact Railway service and mounted /data are eligible. After the first
      // deployment, this phase can observe but NEVER recreate a missing marker.
      recoveryVolumeProbe=inspectStandbyMount()==='DECLARED_MOUNT_PRESENT'
        ? runRailwayRecoveryVolumeProbe({root:'/data',phase:'after-redeploy',mode:'observe-only'})
        : {phase:'after-redeploy',status:'MOUNT_NOT_CONFIRMED',fingerprint:null,transaction_authorized:false};
    }
    readiness=createStandbyReadiness({recoveryVolumeProbe,recoveryAnchorEnabled:anchorFlag==='1'});
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
  let bootstrapAnchorHandler;
  if(anchorFlag==='1') {
    // Require both the declared path and an actual writable mount. This still
    // does not prove persistence, independence, rollback resistance or freshness.
    const {inspectStandbyMount}=await import('../agent/railway-standby-readiness.mjs');
    if(process.env.RAILWAY_VOLUME_MOUNT_PATH!=='/data'||inspectStandbyMount()!=='DECLARED_MOUNT_PRESENT')
      throw new Error('declared Railway recovery volume required');
    const [{createV14BootstrapRailwayAnchor},{createV14BootstrapRailwayAnchorHttp}]=await Promise.all([
      import('../agent/v14-bootstrap-railway-anchor.mjs'),import('../agent/v14-bootstrap-railway-anchor-http.mjs')]);
    const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
    const anchor=createV14BootstrapRailwayAnchor({volumePath:'/data',compressedV14});
    bootstrapAnchorHandler=createV14BootstrapRailwayAnchorHttp({anchor});
  }
  const port=railwayNativePort(),server=createRailwayNativeStandby({readiness,setupHandler,webHandler,bootstrapAnchorHandler});
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
