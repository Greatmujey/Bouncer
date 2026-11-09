// Synthetic owner, browser, checkpoint and database. No chain or wallet send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {createV14BrowserOriginalCheckpointHandler} from '../infrastructure/v14-browser-original-checkpoint-edge.mjs';
import {createV14BrowserIndependentStore,V14_BROWSER_CHECKPOINT_ENDPOINT} from '../web-src/v14-browser-independent-store.mjs';
import {createV14BrowserWitnessStore} from '../web-src/v14-browser-witness-store.mjs';
import {createV14BrowserOriginalWitness} from '../web-src/v14-browser-original-witness.mjs';
import {fixture,scope,owner,vault} from './v14-witness-fixture.mjs';

const origin='https://bouncer-near.vercel.app',project='https://jiouaqwxkvlkmvyumzwc.supabase.co',capability='b'.repeat(64);
const serviceSecret='synthetic-database-key',zero='0'.repeat(64),sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const location={origin,host:'bouncer-near.vercel.app'};
const env=(enabled=true)=>name=>({BOUNCER_V14_BROWSER_CHECKPOINT_ENABLE:enabled?'1':'0',
  BOUNCER_V14_CHECKPOINT_ENABLE:'0',SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:serviceSecret})[name];
const req=(body,{requestOrigin=origin,method='POST',url=V14_BROWSER_CHECKPOINT_ENDPOINT,headers={}}={})=>new Request(url,
  {method,headers:{origin:requestOrigin,'content-type':'application/json',...headers},...(method==='POST'?{body:JSON.stringify(body)}:{})});
const initial=()=>({revision:0,head_sha256:zero,events:[]});
function fakeRpc() {
  let state=initial(),calls=0;
  return {fetch:async(url,options)=>{
    calls++;assert.equal(url,`${project}/rest/v1/rpc/bouncer_v14_original_checkpoint_v1`);
    const data=JSON.parse(options.body);assert.equal(data.p_capability_hash,sha(capability));
    assert.ok(!options.body.includes(capability));
    if(data.p_operation==='append') {
      if(data.p_expected_revision!==state.revision||data.p_expected_head_sha256!==state.head_sha256)return new Response(JSON.stringify({error:'unavailable'}));
      state={revision:state.revision+1,head_sha256:sha(data.p_record),events:[...state.events,data.p_record]};
    }
    return new Response(JSON.stringify(state));
  },calls:()=>calls,state:()=>structuredClone(state)};
}
function browserFetch(handler) {
  return (url,options)=>{
    assert.equal(url,V14_BROWSER_CHECKPOINT_ENDPOINT);assert.equal(options.credentials,'omit');
    assert.equal(options.redirect,'error');assert.equal(options.referrerPolicy,'no-referrer');
    const headers=new Headers(options.headers);headers.set('origin',origin);
    return handler(new Request(url,{...options,headers}));
  };
}

test('browser checkpoint bridge is default-off and strictly limits origins, methods and credential headers',async()=>{
  const rpc=fakeRpc(),off=createV14BrowserOriginalCheckpointHandler({getEnv:env(false),fetch:rpc.fetch,crypto:webcrypto});
  assert.equal((await off(req({scope_id:scope,capability,operation:'read'}))).status,503);assert.equal(rpc.calls(),0);
  const on=createV14BrowserOriginalCheckpointHandler({getEnv:env(),fetch:rpc.fetch,crypto:webcrypto});
  const preflight=await on(req(null,{method:'OPTIONS'}));assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  for(const options of [{requestOrigin:'https://evil.test'},{requestOrigin:'null'},
    {url:`${V14_BROWSER_CHECKPOINT_ENDPOINT}?secret=forbidden`},{headers:{cookie:'session=not-allowed'}},
    {headers:{authorization:'Bearer not-allowed'}},{headers:{apikey:'not-allowed'}}]) {
    const response=await on(req({scope_id:scope,capability,operation:'read'},options));
    assert.notEqual(response.status,200);
  }
  assert.equal((await on(req(null,{method:'GET'}))).status,405);assert.equal(rpc.calls(),0);
});

test('browser bridge hashes capability, communicates only with the fixed database and returns no credential',async()=>{
  const rpc=fakeRpc(),handler=createV14BrowserOriginalCheckpointHandler({getEnv:env(),fetch:rpc.fetch,crypto:webcrypto});
  const response=await handler(req({scope_id:scope,capability,operation:'read'}));
  assert.equal(response.status,200);const body=await response.text();assert.deepEqual(JSON.parse(body),initial());
  assert.ok(!body.includes(capability));assert.ok(!body.includes(serviceSecret));assert.equal(rpc.calls(),1);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('browser local and independent stores coordinate a one-shot claim through the real handler',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),rpc=fakeRpc();
  const handler=createV14BrowserOriginalCheckpointHandler({getEnv:env(),fetch:rpc.fetch,crypto:webcrypto});
  const remote=createV14BrowserIndependentStore({location,scopeId:scope,capability,crypto:webcrypto,fetch:browserFetch(handler)});
  const local=await createV14BrowserWitnessStore({indexedDB:db,crypto:webcrypto,owner,vault,scopeId:scope,
    journalKeyHex:'a'.repeat(64),initializeBrandNew:true});
  const witness=await createV14BrowserOriginalWitness({review,trustedReviewSha256:review.review_sha256,scopeId:scope,
    localStore:local,independentStore:remote,crypto:webcrypto});
  await witness.reserve();await witness.claimWalletStage(binding.stages[0].id);
  assert.equal((await witness.inspect()).pending.stage_id,binding.stages[0].id);
  assert.equal(rpc.state().revision,2);assert.equal((await local.read()).revision,2);
  await assert.rejects(witness.claimWalletStage(binding.stages[0].id),/never repeat/);
  local.close();
});

test('browser client never retries an uncertain response or accepts a substituted acknowledgement',async()=>{
  let calls=0;
  const lost=createV14BrowserIndependentStore({location,scopeId:scope,capability,crypto:webcrypto,fetch:async()=>{calls++;throw Error('lost')}});
  await assert.rejects(lost.append({expected_revision:0,expected_head_sha256:zero,record:'{}'}),/never repeat/);assert.equal(calls,1);
  const fake=createV14BrowserIndependentStore({location,scopeId:scope,capability,crypto:webcrypto,
    fetch:async()=>new Response(JSON.stringify({revision:1,head_sha256:'f'.repeat(64),events:['{}']}))});
  await assert.rejects(fake.append({expected_revision:0,expected_head_sha256:zero,record:'{}'}),/uncertain/);
  assert.throws(()=>createV14BrowserIndependentStore({location:{origin:'https://wrong.test',host:'wrong.test'},scopeId:scope,
    capability,crypto:webcrypto}),/unavailable/);
  let requested=false;
  const stale=createV14BrowserIndependentStore({location,scopeId:scope,capability,crypto:webcrypto,isCurrent:()=>false,
    fetch:async()=>{requested=true;return new Response('{}')}});
  await assert.rejects(stale.read(),/uncertain/);assert.equal(requested,false);
});
