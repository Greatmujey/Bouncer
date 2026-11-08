import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHash} from 'node:crypto';
import {createDirectOneShotHandler} from '../infrastructure/direct-test-one-shot-edge.mjs';

const origin='https://8svrp7.csb.app',capability='A'.repeat(43),project='https://itzqbvbpmbnimvpyaige.supabase.co';
const env={SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-real-key'};
const response={scope:'direct',state:'ready',original_hash:null,claim_acquired:false,expired:false};
function request(body={capability,operation:'read'},options={}){
  return new Request('https://example.invalid/',{method:options.method || 'POST',headers:{origin:options.origin||origin,'content-type':options.type||'application/json'},
    ...(options.method==='OPTIONS'?{}:{body:JSON.stringify(body)})});
}
function handler(overrides={}){
  const calls=[];
  const value=createDirectOneShotHandler({getEnv:key=>env[key],crypto:webcrypto,fetch:async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});
    return new Response(JSON.stringify(overrides.result??response),{status:overrides.status??200});
  },...overrides});return {value,calls};
}

test('test endpoint allows isolated CSB hosts and the exact public Bouncer origin only',async()=>{
  const {value,calls}=handler();
  const preflight=await value(request(undefined,{method:'OPTIONS'}));assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(calls.length,0);
  const vercel='https://bouncer-near.vercel.app';
  const allowed=await value(request(undefined,{method:'OPTIONS',origin:vercel}));
  assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-origin'),vercel);
  for(const bad of ['https://evil.example','http://8svrp7.csb.app','https://8svrp7.csb.app.evil.example',
    'https://other.vercel.app','https://bouncer-near.vercel.app.evil.example','http://bouncer-near.vercel.app','null']){
    assert.equal((await value(request(undefined,{origin:bad}))).status,403);
  }
  for(const payload of [{capability,operation:'send'}, {capability,operation:'claim',original_hash:'x'},
    {capability,operation:'read',wallet:'secret'}, {capability:'short',operation:'read'}, {capability,operation:'retain',original_hash:'not-valid'}]) {
    assert.equal((await value(request(payload))).status,503);
  }
  assert.equal(calls.length,0);
});

test('the service key stays server-side; only a token hash goes to the database',async()=>{
  const {value,calls}=handler();const result=await value(request());
  assert.equal(result.status,200);assert.deepEqual(await result.json(),response);assert.equal(calls.length,1);
  assert.equal(calls[0].url,`${project}/rest/v1/rpc/bouncer_direct_test_v1`);
  assert.equal(calls[0].body.p_capability_hash,createHash('sha256').update(capability).digest('hex'));
  assert.equal(calls[0].body.p_origin,origin);assert.equal(calls[0].body.p_operation,'read');
  assert.ok(!JSON.stringify(calls[0].body).includes(capability));
  assert.ok(!JSON.stringify(await (await value(request())).json()).includes(env.SUPABASE_SERVICE_ROLE_KEY));
});

test('invalid or failed database results fail closed without leaking details',async()=>{
  for(const overrides of [{status:500},{result:{error:'bad'}},{result:{...response,scope:'other'}},
    {result:{...response,claim_acquired:'true'}},{result:{...response,original_hash:'bad'}}]) {
    const {value}=handler(overrides);const result=await value(request());assert.equal(result.status,503);
    assert.deepEqual(await result.json(),{error:'unavailable'});
  }
});
