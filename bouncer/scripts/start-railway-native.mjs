#!/usr/bin/env node
/** Railway container entry. Without explicit enablement it serves only a
 * public, non-spending standby status; it creates no state and never imports
 * the mission runtime. A configured mission still starts recovery-first. */
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
/** No input is trusted or reflected. No wallet, journal, RPC, keys or backend
 * connection is loaded in standby. This endpoint is not mission readiness. */
export function createRailwayNativeStandby() {
  const server=http.createServer((req,res)=>{
    const status=(req.method==='GET'||req.method==='HEAD') && (req.url==='/'||req.url==='/healthz');
    req.resume();
    res.writeHead(status?200:404,headers);
    res.end(req.method==='HEAD' ? undefined : JSON.stringify(status?STANDBY_STATUS:{error:'unavailable'}));
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
  const port=railwayNativePort(),server=createRailwayNativeStandby();
  await new Promise((resolve,reject)=>server.listen(port,'0.0.0.0',resolve).once('error',reject));
  console.log(`Bouncer testnet backend in STANDBY on port ${port}; no mission, wallet or transactions are enabled.`);
  let stopping=false;
  const shutdown=()=>{if(stopping)return;stopping=true;server.close(error=>{if(error)process.exitCode=1});server.closeIdleConnections?.()};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  main().catch(error=>{console.error(`Bouncer Railway service did not start (${classifyStartupError(error)}). Preserve any original journal; no startup transaction was sent.`);process.exitCode=1});
}
