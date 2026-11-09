// Synthetic transport/Edge tests; no database, wallet or NEAR transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,webcrypto } from 'node:crypto';
import { createSupabaseV14OriginalStore,V14_ORIGINAL_CHECKPOINT_ENDPOINT } from '../agent/supabase-v14-original-store.mjs';
import { createV14OriginalCheckpointHandler } from '../infrastructure/v14-original-checkpoint-edge.mjs';
import { V14_WITNESS_GENESIS } from '../agent/v14-original-witness.mjs';

const scope='a'.repeat(32),cap='b'.repeat(64),secret='synthetic-service-role-do-not-use',project='https://jiouaqwxkvlkmvyumzwc.supabase.co';
const sha=value=>createHash('sha256').update(value).digest('hex');
const env=(enabled=true)=>key=>({BOUNCER_V14_CHECKPOINT_ENABLE:enabled?'1':'0',SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:secret})[key];
const init={revision:0,head_sha256:V14_WITNESS_GENESIS,events:[]};
const req=(body,extra={})=>new Request(V14_ORIGINAL_CHECKPOINT_ENDPOINT,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});

test('edge is default-off and never accepts browser-origin traffic',async()=>{
  let calls=0;const fetch=async()=>{calls++;return new Response('{}')};
  const off=createV14OriginalCheckpointHandler({getEnv:env(false),fetch,crypto:webcrypto});
  const res=await off(req({scope_id:scope,capability:cap,operation:'read'}));
  assert.equal(res.status,503);assert.deepEqual(await res.json(),{error:'unavailable'});assert.equal(calls,0);
  const on=createV14OriginalCheckpointHandler({getEnv:env(),fetch,crypto:webcrypto});
  const rejected=await on(req({scope_id:scope,capability:cap,operation:'read'},{origin:'https://bouncer-near.vercel.app'}));
  assert.equal(rejected.status,403);assert.equal(rejected.headers.get('access-control-allow-origin'),null);assert.equal(calls,0);
});

test('edge passes only a capability hash to its fixed database, never returns either secret',async()=>{
  const calls=[];
  const handler=createV14OriginalCheckpointHandler({getEnv:env(),crypto:webcrypto,fetch:async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});return new Response(JSON.stringify(init),{status:200});
  }});
  const response=await handler(req({scope_id:scope,capability:cap,operation:'read'}));
  assert.equal(response.status,200);const body=await response.text();assert.deepEqual(JSON.parse(body),init);
  assert.equal(calls.length,1);assert.equal(calls[0].url,`${project}/rest/v1/rpc/bouncer_v14_original_checkpoint_v1`);
  assert.equal(calls[0].body.p_capability_hash,sha(cap));assert.equal(calls[0].body.p_scope_id,scope);
  assert.equal(calls[0].options.redirect,'error');assert.ok(!JSON.stringify(calls[0].body).includes(cap));
  assert.ok(!body.includes(cap));assert.ok(!body.includes(secret));
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('malformed or oversized edge inputs and untrusted upstream results fail closed',async()=>{
  let calls=0;const handler=createV14OriginalCheckpointHandler({getEnv:env(),crypto:webcrypto,fetch:async()=>{calls++;return new Response(JSON.stringify({error:'unavailable'}));}});
  for (const body of [
    {scope_id:scope,capability:'bad',operation:'read'},
    {scope_id:scope,capability:cap,operation:'read',unexpected:1},
    {scope_id:scope,capability:cap,operation:'append',expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record:'x'.repeat(24577)},
    {scope_id:scope,capability:cap,operation:'append',expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record:'a\nb'},
  ]) assert.equal((await handler(req(body))).status,503);
  assert.equal(calls,0);
  assert.equal((await handler(req({scope_id:scope,capability:cap,operation:'read'}))).status,503);
  assert.equal(calls,1);
  const wrongProject=createV14OriginalCheckpointHandler({getEnv:key=>key==='BOUNCER_V14_CHECKPOINT_ENABLE'?'1':'wrong',crypto:webcrypto,fetch:async()=>{throw Error('must not fetch')}});
  assert.equal((await wrongProject(req({scope_id:scope,capability:cap,operation:'read'}))).status,503);
});

test('server client and synthetic edge do atomic compare-and-append without sending capability to SQL',async()=>{
  let state=structuredClone(init),calls=0;
  const rpc=async(url,options)=>{
    calls++;const data=JSON.parse(options.body);
    assert.equal(data.p_capability_hash,sha(cap));assert.ok(!options.body.includes(cap));
    if (data.p_operation==='append') {
      if (data.p_expected_revision!==state.revision || data.p_expected_head_sha256!==state.head_sha256) return new Response(JSON.stringify({error:'unavailable'}));
      state={revision:state.revision+1,head_sha256:sha(data.p_record),events:[...state.events,data.p_record]};
    }
    return new Response(JSON.stringify(state));
  };
  const handler=createV14OriginalCheckpointHandler({getEnv:env(),crypto:webcrypto,fetch:rpc});
  const throughEdge=(url,options)=>handler(new Request(url,options));
  const store=createSupabaseV14OriginalStore({scopeId:scope,capability:cap,fetch:throughEdge});
  assert.deepEqual(await store.read(),init);
  const record='{"synthetic":"record"}';
  const updated=await store.append({expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record});
  assert.equal(updated.revision,1);assert.equal(updated.head_sha256,sha(record));
  await assert.rejects(store.append({expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record}),/uncertain/);
  assert.deepEqual(await store.read(),updated);assert.equal(calls,4);
});

test('client never automatically retries an ambiguous network error or accepts a substituted acknowledgement',async()=>{
  let calls=0;
  const store=createSupabaseV14OriginalStore({scopeId:scope,capability:cap,fetch:async()=>{calls++;throw new Error('response lost')}});
  await assert.rejects(store.append({expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record:'{}'}),/never retry/);
  assert.equal(calls,1);
  const dishonest=createSupabaseV14OriginalStore({scopeId:scope,capability:cap,fetch:async()=>new Response(JSON.stringify({...init,revision:1,events:['{}'],head_sha256:'f'.repeat(64)}))});
  await assert.rejects(dishonest.append({expected_revision:0,expected_head_sha256:V14_WITNESS_GENESIS,record:'{}'}),/uncertain/);
  assert.throws(()=>createSupabaseV14OriginalStore({scopeId:scope,capability:'secret'}),/unavailable/);
});
