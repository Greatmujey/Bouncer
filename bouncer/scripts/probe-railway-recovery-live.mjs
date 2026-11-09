// One read-only check of the live Railway recovery route. It sends only GET
// and OPTIONS: no wallet, owner signature, checkpoint data, initialization,
// bearer capability, key, record, or NEAR transaction is used.
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const site='https://bouncer-production-6df1.up.railway.app';
const anchor=`${site}/api/v14-bootstrap-anchor`;
const origins=[site,'https://bouncer-near.vercel.app'];
const deniedOrigin='https://untrusted.invalid';
// Public non-secret baseline from the initial live volume diagnostic.
const fingerprint='ddedbee9176926e6a7adcb3e4d10376663920a77eff8338b02f675432bce7b81';
const fail=()=>Error('Railway recovery route check failed; do not initialize or retry an uncertain setup');

export async function probeRailwayRecovery({fetch:fetchImpl=globalThis.fetch}={}) {
  if(typeof fetchImpl!=='function')throw fail();
  async function request(url,options={}) {
    return fetchImpl(url,{...options,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
  }
  for(const origin of origins) {
    const r=await request(anchor,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST',
      'access-control-request-headers':'content-type'}});
    if(r.status!==204||r.headers.get('access-control-allow-origin')!==origin||
      !/\bPOST\b/i.test(r.headers.get('access-control-allow-methods')||'')||
      !/\bcontent-type\b/i.test(r.headers.get('access-control-allow-headers')||'')||r.headers.has('set-cookie'))throw fail();
  }
  const denied=await request(anchor,{method:'OPTIONS',headers:{origin:deniedOrigin,'access-control-request-method':'POST'}});
  if(denied.status!==403||denied.headers.has('access-control-allow-origin'))throw fail();
  const response=await request(`${site}/readiness?volume-probe=6`,{method:'GET'});
  if(response.status!==200)throw fail();
  const content=await response.text();if(content.length>8192)throw fail();
  let state;try{state=JSON.parse(content)}catch{throw fail()}
  if(state.service!=='bouncer-testnet-native-backend'||state.status!=='STANDBY'||
    state.mission_enabled!==false||state.transactions_enabled!==false||state.recovery_anchor_enabled!==true||
    state.checks?.volume!=='DECLARED_MOUNT_PRESENT'||state.recovery_volume_probe?.phase!=='after-redeploy'||
    state.recovery_volume_probe?.status!=='OBSERVED'||state.recovery_volume_probe?.fingerprint!==fingerprint||
    state.recovery_volume_probe?.transaction_authorized!==false)throw fail();
  return Object.freeze({recovery_route_reachable:true,railway_origin_allowed:true,vercel_origin_allowed:true,
    untrusted_origin_denied:true,volume_mount_observed:true,transactions_enabled:false,mission_enabled:false,
    encrypted_backup_checked:false,independent_restore_verified:false,latest_head_verified:false});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    const report=await probeRailwayRecovery();
    console.log(`::notice title=Live Railway recovery-only route::${JSON.stringify(report)}`);
  }catch(error){console.error(`::error title=Live Railway recovery-only route::${error.message}`);process.exitCode=1}
}
