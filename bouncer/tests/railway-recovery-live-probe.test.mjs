// All responses are synthetic; this test cannot reach a live service.
import test from 'node:test';import assert from 'node:assert/strict';
import {probeRailwayRecovery} from '../scripts/probe-railway-recovery-live.mjs';

const site='https://bouncer-production-6df1.up.railway.app';
const state={service:'bouncer-testnet-native-backend',status:'STANDBY',mission_enabled:false,transactions_enabled:false,
  recovery_anchor_enabled:true,recovery_anchor_writes_enabled:false,checks:{volume:'DECLARED_MOUNT_PRESENT'},recovery_volume_probe:{phase:'after-redeploy',status:'OBSERVED',
    fingerprint:'ddedbee9176926e6a7adcb3e4d10376663920a77eff8338b02f675432bce7b81',transaction_authorized:false}};
function mock({changed={},allowDenied=false,allowedStatus=204}={}) {
  const calls=[];
  const fetch=async(url,options)=>{
    calls.push({url,method:options.method,headers:options.headers});
    assert.ok(['GET','OPTIONS'].includes(options.method));assert.equal(options.body,undefined);
    if(options.method==='GET')return Response.json({...state,...changed});
    const origin=options.headers.origin;
    if(origin==='https://untrusted.invalid'&&!allowDenied)return new Response(null,{status:403});
    return new Response(null,{status:allowedStatus,headers:{'access-control-allow-origin':origin,
      'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}});
  };
  return {fetch,calls};
}

test('live probe can use only read-only methods and reports no backup verification',async()=>{
  const {fetch,calls}=mock(),result=await probeRailwayRecovery({fetch});
  assert.equal(result.recovery_route_reachable,true);assert.equal(result.untrusted_origin_denied,true);
  assert.equal(result.encrypted_backup_checked,false);assert.equal(result.independent_restore_verified,false);
  assert.equal(result.recovery_writes_enabled,false);assert.equal(result.transactions_enabled,false);assert.deepEqual(calls.map(x=>x.method),['OPTIONS','OPTIONS','OPTIONS','GET']);
  assert.equal(calls[0].url,`${site}/api/v14-bootstrap-anchor`);
});

test('disabled route, untrusted CORS, wrong volume or transaction enablement fails closed',async()=>{
  for(const options of [{allowDenied:true},{allowedStatus:403},{changed:{recovery_anchor_enabled:false}},
    {changed:{recovery_anchor_writes_enabled:true}},{changed:{transactions_enabled:true}},{changed:{mission_enabled:true}},{changed:{checks:{volume:'NOT_CONFIRMED'}}},
    {changed:{recovery_volume_probe:{...state.recovery_volume_probe,fingerprint:'0'.repeat(64)}}}])
    await assert.rejects(probeRailwayRecovery({fetch:mock(options).fetch}));
});
