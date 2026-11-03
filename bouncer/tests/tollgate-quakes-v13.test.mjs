import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { TOLLGATE_CONTRACT,TOLLGATE_RESOURCE,TOLLGATE_SELLER } from '../agent/tollgate-v12-readiness.mjs';
import { GithubTollgateVoucherFence } from '../agent/tollgate-github-voucher-fence.mjs';
import { TollgateResponseStore } from '../agent/tollgate-response-store.mjs';
import { makeTollgateQuakesReview,validateTollgateQuakesReview,tollgateQuakesReviewHash,inspectTollgateQuakesChannel,
 purchaseTollgateQuakesOnce,TollgateVoucherFence,V13_VOUCHER_SHA256,V13_VOUCHER_CODE_HASH,TOLLGATE_CHANNEL_CODE_HASH,
 CHANNEL_BUDGET_YOCTO,QUAKES_PRICE_YOCTO } from '../agent/tollgate-quakes-v13.mjs';
const hash='1'.repeat(32),other='2'.repeat(32),MIN='10000000000000000000000';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),pub=k=>String(k.getPublicKey());
const encoded=x=>Buffer.from(JSON.stringify(x)).toString('base64');
const answer=x=>({block_hash:hash,result:[...Buffer.from(JSON.stringify(x))]});
function fixture(){
 const now=Date.now(),ownerKey=key(),agentKey=key(),voucherKey=key();
 const ownerPlan={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',
  account_id:'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',public_key:pub(ownerKey)};
 const review=makeTollgateQuakesReview({ownerPlan,intentId:'quakes-once-1',agentPublicKey:pub(agentKey),
  voucherPublicKey:pub(voucherKey),expiresAtMs:String(now+120_000)});
 const state={chain:'testnet',blockMs:now,owner:review.owner,version:'bouncer-agent-v13-tollgate-native-testnet',
  vaultCode:V13_VOUCHER_CODE_HASH,vaultKeys:[],channelCode:TOLLGATE_CHANNEL_CODE_HASH,channelKeys:[{access_key:{permission:'FullAccess'}}],mixed:false,
  authorized:true,policy:{token:'native',per_tx_cap:CHANNEL_BUDGET_YOCTO,daily_cap:CHANNEL_BUDGET_YOCTO},spent:CHANNEL_BUDGET_YOCTO,
  config:{voucher_domain:'tollgate:v1',min_dispute_window_sec:'15',max_expiry_sec:'2592000',min_channel_deposit:MIN},
  intent:{intent_id:review.intent_id,policy_id:'data',channel_contract:TOLLGATE_CONTRACT,seller:TOLLGATE_SELLER,amount:CHANNEL_BUDGET_YOCTO,
   agent_public_key:review.agent_public_key,voucher_public_key:review.voucher_public_key,review_hash:tollgateQuakesReviewHash(review),
   expires_at_ms:review.expires_at_ms,channel_lifetime_sec:'600',dispute_window_sec:'15',consumed:true,cancelled:false,
   callback_recorded:true,promise_failed:false,recovering:false,channel_verified:true,channel_id:'7',active:false},
  channel:{channel_id:'7',owner:review.vault,seller:TOLLGATE_SELLER,agent_pubkey:review.voucher_public_key,status:'Open',
   dispute_window_sec:'15',deposit:'18000000000000000000000',storage_fee:'2000000000000000000000',remaining:'18000000000000000000000',
   settled:'0',refunded:'0',last_nonce:'0',settlements:0,opened_at_ns:String(BigInt(now-60_000)*1_000_000n),
   expires_at_ns:String(BigInt(now-60_000+600_000)*1_000_000n)},rpcSends:0};
 const provider={async viewNodeStatus(){return {chain_id:state.chain}},async viewBlock(o){assert.deepEqual(o,{finality:'final'});
  return {header:{hash,timestamp_nanosec:String(BigInt(state.blockMs)*1_000_000n)}}},
  async query(q){assert.equal(q.block_id,hash);
   if(q.request_type==='view_account')return {block_hash:state.mixed?other:hash,code_hash:q.account_id===review.vault?state.vaultCode:state.channelCode};
   if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:q.account_id===review.vault?state.vaultKeys:state.channelKeys};
   throw Error('unexpected query');},
  async callFunctionRaw(id,method,args,ref){assert.equal(ref.blockId,hash);
   if(method==='get_owner')return answer(state.owner);if(method==='contract_version')return answer(state.version);
   if(method==='get_tollgate_intent'){assert.equal(args.intent_id,review.intent_id);return answer(state.intent)}
   if(method==='is_tollgate_voucher_authorized')return answer(state.authorized);
   if(method==='get_policy')return answer(state.policy);if(method==='daily_spent')return answer(state.spent);
   if(method==='get_config')return answer(state.config);if(method==='get_channel')return answer(state.channel);
   throw Error('unexpected view');},
  async sendTransactionOnce(){state.rpcSends++;throw Error('must never submit a transaction')}};
 const accept={scheme:'near-channel',network:'near-testnet',maxAmountRequired:QUAKES_PRICE_YOCTO,asset:'NEAR',payTo:TOLLGATE_SELLER,
  resource:TOLLGATE_RESOURCE,description:'Recent earthquakes',mimeType:'application/json',maxTimeoutSeconds:60,extra:{contract:TOLLGATE_CONTRACT,
   price:QUAKES_PRICE_YOCTO,voucher:'tollgate:v1:{contract}:{channel_id}:{cumulative_yocto}:{nonce}',header:'X-PAYMENT',minDisputeWindowSec:15,minRemainingSec:120,
   openChannel:{contract:TOLLGATE_CONTRACT,method:'open_channel',args:{seller:TOLLGATE_SELLER,agent_pubkey:'ed25519:<channel public key>',expires_in_sec:'86400',dispute_window_sec:'15'}}}};
 const http={free:0,paid:0,offer:{x402Version:1,error:'payment required',accepts:[accept]},mode:'success'};
 const fetchedAt=new Date(now).toISOString(),startTime=new Date(now-24*3_600_000).toISOString();
 const data={source:'USGS Earthquake Hazards Program, FDSN event API',
  source_url:`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=5&starttime=${encodeURIComponent(startTime)}&limit=10`,
  fetched_at:fetchedAt,cached:false,query:{min_magnitude:5,hours:24,limit:10},count:1,
  quakes:[{id:'us-test',magnitude:5.2,place:'Synthetic Ocean',time:fetchedAt}],
  paid:{channel_id:'7',nonce:'1',price_yocto:QUAKES_PRICE_YOCTO}};
 const ack={success:true,scheme:'near-channel',network:'near-testnet',contract:TOLLGATE_CONTRACT,channel_id:'7',
  cumulative:QUAKES_PRICE_YOCTO,nonce:'1',paid:QUAKES_PRICE_YOCTO,settlement:null};
 const fetchImpl=async(url,options)=>{
  assert.equal(url,TOLLGATE_RESOURCE);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  if(!options.headers['x-payment']){
   http.free++;return new Response(JSON.stringify(http.offer),{status:402,headers:{'content-type':'application/json',
    'x-tollgate-scheme':'near-channel','x-tollgate-network':'near-testnet','x-tollgate-contract':TOLLGATE_CONTRACT,
    'x-tollgate-seller':TOLLGATE_SELLER,'x-tollgate-price':QUAKES_PRICE_YOCTO}});
  }
  http.paid++;assert.equal(options.credentials,'omit');assert.ok(options.signal instanceof AbortSignal);
  const p=JSON.parse(Buffer.from(options.headers['x-payment'],'base64').toString('utf8'));
  assert.deepEqual({...p,payload:{...p.payload,signature:'<signature>'}},{scheme:'near-channel',network:'near-testnet',payload:{contract:TOLLGATE_CONTRACT,
   channel_id:'7',cumulative:QUAKES_PRICE_YOCTO,nonce:'1',signature:'<signature>'}});
  assert.equal(voucherKey.getPublicKey().verify(Buffer.from(`tollgate:v1:${TOLLGATE_CONTRACT}:7:${QUAKES_PRICE_YOCTO}:1`),
   Buffer.from(p.payload.signature,'base64')),true);
  if(http.mode==='lost')throw Error('network timeout, possibly accepted');
  if(http.mode==='no-ack')return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  if(http.mode==='reject')return new Response('{}',{status:402,headers:{'content-type':'application/json'}});
  if(http.mode==='bad-ack')return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json','x-payment-response':encoded({...ack,nonce:'2'})}});
  if(http.mode==='upstream-fail')return new Response('{"error":"upstream failed"}',{status:502,headers:{'content-type':'application/json','x-payment-response':encoded(ack)}});
  if(http.mode==='oversize')return new Response('x'.repeat(262_145),{status:200,headers:{'content-type':'application/json','x-payment-response':encoded(ack)}});
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json','x-payment-response':encoded(ack)}});
 };
 return {now,ownerPlan,ownerKey,agentKey,voucherKey,review,state,provider,http,fetchImpl,data,ack};
}
function privateFence(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-tollgate-test-'));fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,fence:new TollgateVoucherFence(dir)};
}
const args=(f,fence)=>({review:f.review,provider:f.provider,voucherKey:f.voucherKey,fence,fetchImpl:f.fetchImpl,now:()=>f.now,executionMode:'synthetic'});

test('review pins the exact resource, bounded native channel, identities and tested code',()=>{
 const f=fixture(),r=f.review;
 assert.equal(r.resource,TOLLGATE_RESOURCE);assert.equal(r.channel_budget_yocto,CHANNEL_BUDGET_YOCTO);assert.equal(r.price_yocto,QUAKES_PRICE_YOCTO);
 assert.equal(nearApi.utils.serialize.base_encode(Buffer.from(V13_VOUCHER_SHA256,'hex')),V13_VOUCHER_CODE_HASH);
 assert.deepEqual(validateTollgateQuakesReview({...r}),r);
 assert.equal(tollgateQuakesReviewHash(Object.fromEntries(Object.entries(r).reverse())),tollgateQuakesReviewHash(r));
 for(const changed of [{resource:'https://attacker.invalid/'},{seller:'attacker.testnet'}, {channel_budget_yocto:'999'},
  {vault_code_hash:other},{extra:'ignored'}, {method:'POST'},{network:'mainnet'}]){
  assert.throws(()=>validateTollgateQuakesReview({...r,...changed}));
 }
 assert.throws(()=>makeTollgateQuakesReview({ownerPlan:f.ownerPlan,intentId:'a',agentPublicKey:pub(f.agentKey),voucherPublicKey:pub(f.agentKey),expiresAtMs:r.expires_at_ms}),/dedicated/);
 assert.throws(()=>makeTollgateQuakesReview({ownerPlan:f.ownerPlan,intentId:'bad/id',agentPublicKey:pub(f.agentKey),voucherPublicKey:pub(f.voucherKey),expiresAtMs:r.expires_at_ms}),/intent/);
});

test('read-only snapshot checks one FINAL block, reviewed channel and current authorization',async()=>{
 const f=fixture(),out=await inspectTollgateQuakesChannel({review:f.review,provider:f.provider,now:()=>f.now});
 assert.equal(out.channel_id,'7');assert.equal(out.review_hash,tollgateQuakesReviewHash(f.review));
 assert.equal(out.channel_full_access_keys,1);assert.equal(out.voucher_signed,false);assert.equal(out.payment_sent,false);
 assert.equal(f.state.rpcSends,0);assert.equal(f.http.free,0);assert.equal(f.http.paid,0);
});

test('wrong chain, keys, code, policy, revisions, intent and channel fail closed',async()=>{
 const mutations=[
  s=>s.chain='mainnet',s=>s.vaultCode=other,s=>s.vaultKeys=[{}],s=>s.owner='attacker.testnet',s=>s.version='old',
  s=>s.channelCode=other,s=>s.mixed=true,s=>s.authorized=false,s=>s.policy.daily_cap='0',s=>s.spent='0',
  s=>s.config.min_channel_deposit='1',s=>s.intent.review_hash='b'.repeat(64),s=>s.intent.voucher_public_key=pub(key()),
  s=>s.intent.consumed=false,s=>s.intent.callback_recorded=false,s=>s.intent.promise_failed=true,s=>s.intent.recovering=true,
  s=>s.intent.channel_verified=false,s=>s.intent.channel_id=null,s=>s.intent.cancelled=true,s=>s.intent.active=true,
  s=>s.channel.owner='attacker.testnet',s=>s.channel.seller='attacker.testnet',s=>s.channel.agent_pubkey=pub(key()),
  s=>s.channel.status='Closing',s=>s.channel.settled='1',s=>s.channel.last_nonce='1',s=>s.channel.refunded='1',
  s=>s.channel.deposit='1',s=>s.channel.remaining='1',s=>s.channel.dispute_window_sec='1',s=>s.channel.expires_at_ns=s.channel.opened_at_ns,
  s=>s.blockMs-=60_000];
 for(const mutate of mutations){
  const f=fixture();mutate(f.state);
  await assert.rejects(inspectTollgateQuakesChannel({review:f.review,provider:f.provider,now:()=>f.now}));
  assert.equal(f.state.rpcSends,0);
 }
});

test('a single fenced request signs only the reviewed voucher and returns synthetic seller data',async t=>{
 const f=fixture(),{dir,fence}=privateFence(t),out=await purchaseTollgateQuakesOnce(args(f,fence));
 assert.equal(f.http.free,1);assert.equal(f.http.paid,1);assert.equal(f.state.rpcSends,0);
 assert.equal(out.status,'PROVIDER_RETURNED_DATA');assert.equal(out.fence_scope,'LOCAL_ONLY');assert.equal(out.seller_claimed_acceptance,true);assert.equal(out.settlement_verified,false);
 assert.equal(out.upstream_provenance_verified,false);assert.equal(out.voucher_resource_bound,false);assert.equal(out.data.quakes[0].id,'us-test');
 const files=fs.readdirSync(dir);assert.equal(files.length,1);const j=JSON.parse(fs.readFileSync(path.join(dir,files[0]),'utf8'));
 assert.equal(j.status,'DO_NOT_RETRY_AFTER_FENCE');assert.equal(j.review_hash,tollgateQuakesReviewHash(f.review));
 assert.equal(JSON.stringify(j).includes('signature'),false);assert.equal(JSON.stringify(j).includes('secret'),false);
 assert.equal(fs.statSync(path.join(dir,files[0])).mode&0o777,0o600);
 await assert.rejects(purchaseTollgateQuakesOnce(args(f,fence)),/EEXIST/);assert.equal(f.http.paid,1);
});

test('a changed offer or unauthorized snapshot sends no voucher and does not claim the fence',async t=>{
 for(const mutation of [f=>f.http.offer.accepts[0].resource='https://attacker.invalid',f=>f.state.authorized=false,
  f=>f.state.channelCode=other,f=>f.state.channel.settled='1']){
  const f=fixture(),{dir,fence}=privateFence(t);mutation(f);
  await assert.rejects(purchaseTollgateQuakesOnce(args(f,fence)));assert.equal(f.http.paid,0);assert.deepEqual(fs.readdirSync(dir),[]);
 }
});

test('lost responses, 402, missing or incorrect acknowledgements are unknown, never retried',async t=>{
 for(const mode of ['lost','reject','no-ack','bad-ack','oversize']){
  const f=fixture(),{fence}=privateFence(t);f.http.mode=mode;
  const out=await purchaseTollgateQuakesOnce(args(f,fence));assert.equal(out.status,'PAYMENT_AND_DELIVERY_UNKNOWN');
  assert.equal(out.do_not_retry,true);assert.equal(out.settlement_verified,false);
  await assert.rejects(purchaseTollgateQuakesOnce(args(f,fence)),/EEXIST/);assert.equal(f.http.paid,1);
 }
});

test('seller acknowledgement plus upstream failure is not fulfillment or settlement proof',async t=>{
 const f=fixture(),{fence}=privateFence(t);f.http.mode='upstream-fail';
 const out=await purchaseTollgateQuakesOnce(args(f,fence));assert.equal(out.status,'SELLER_CLAIMS_ACCEPTANCE_DELIVERY_UNCONFIRMED');
 assert.equal(out.seller_claimed_acceptance,true);assert.equal(out.settlement_verified,false);assert.equal(out.data,undefined);assert.equal(f.http.paid,1);
});

test('wrong content and wrong paid receipt never become successful data',async t=>{
 for(const mutation of [f=>f.data.paid.nonce='2',f=>f.data.query.min_magnitude=4.5,f=>f.data.source_url='https://attacker.invalid/',
  f=>f.data.fetched_at=new Date(f.now-900_000).toISOString(),f=>f.data.count=2]){
  const f=fixture(),{fence}=privateFence(t);mutation(f);const out=await purchaseTollgateQuakesOnce(args(f,fence));
  assert.equal(out.status,'SELLER_CLAIMS_ACCEPTANCE_DELIVERY_UNCONFIRMED');assert.equal(out.data,undefined);assert.equal(f.http.paid,1);
 }
});

test('concurrent calls using the same voucher key can send at most one request',async t=>{
 const f=fixture(),{fence}=privateFence(t),results=await Promise.allSettled([purchaseTollgateQuakesOnce(args(f,fence)),purchaseTollgateQuakesOnce(args(f,fence))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(f.http.paid,1);
});

test('fence rejects non-private directories and pre-existing symbolic-link targets',async t=>{
 const f=fixture(),{dir,fence}=privateFence(t);fs.chmodSync(dir,0o755);assert.throws(()=>new TollgateVoucherFence(dir),/private/);
 fs.chmodSync(dir,0o700);
 const name='tollgate-voucher-'+crypto.createHash('sha256').update(f.review.voucher_public_key).digest('hex')+'.fence.json';
 fs.symlinkSync(path.join(dir,'target'),path.join(dir,name));
 await assert.rejects(purchaseTollgateQuakesOnce(args(f,fence)),/EEXIST/);assert.equal(f.http.paid,0);
});

test('paid request waits for a cross-environment GitHub fence, and failure sends nothing',async t=>{
 const f=fixture(),{dir}=privateFence(t);
 let start,release,label;const started=new Promise(r=>{start=r}),gate=new Promise(r=>{release=r});
 const remote=async(_url,options)=>{
  if(options.method==='POST'){
   label={...JSON.parse(options.body),id:701};start();await gate;return Response.json(label,{status:201});
  }
  return Response.json(label);
 };
 const fence=new GithubTollgateVoucherFence(dir,{token:'x'.repeat(30),fetchImpl:remote});
 const operation=purchaseTollgateQuakesOnce(args(f,fence));
 await started;assert.equal(f.http.paid,0);assert.equal(fs.readdirSync(dir).length,1);
 release();const result=await operation;
 assert.equal(result.status,'PROVIDER_RETURNED_DATA');assert.equal(result.fence_scope,'GITHUB_LABEL_AND_LOCAL');assert.equal(f.http.paid,1);
 const rejected=fixture(),second=privateFence(t);
 const denied=new GithubTollgateVoucherFence(second.dir,{token:'x'.repeat(30),fetchImpl:async()=>new Response('',{status:403})});
 await assert.rejects(purchaseTollgateQuakesOnce(args(rejected,denied)));
 assert.equal(rejected.http.paid,0);assert.equal(fs.readdirSync(second.dir).length,1);
 await assert.rejects(purchaseTollgateQuakesOnce(args(rejected,denied)),/EEXIST/);
 assert.equal(rejected.http.paid,0);
});

test('live mode fails closed without both remote fence and response store before contacting the seller',async t=>{
 const f=fixture(),{dir,fence}=privateFence(t),live={...args(f,fence),executionMode:'live'};
 await assert.rejects(purchaseTollgateQuakesOnce(live),/cross-environment fence/);
 assert.equal(f.http.free,0);assert.equal(f.http.paid,0);assert.deepEqual(fs.readdirSync(dir),[]);
 const remote=new GithubTollgateVoucherFence(dir,{token:'x'.repeat(30),fetchImpl:async()=>{throw Error('not reached')}});
 await assert.rejects(purchaseTollgateQuakesOnce({...live,fence:remote}),/response store/);
 assert.equal(f.http.free,0);assert.equal(f.http.paid,0);assert.deepEqual(fs.readdirSync(dir),[]);
 await assert.rejects(purchaseTollgateQuakesOnce({...args(f,fence),fetchImpl:globalThis.fetch}),/injected test transport/);
 assert.equal(f.http.free,0);assert.deepEqual(fs.readdirSync(dir),[]);
});

test('retains the exact seller response and stops without retry if evidence cannot be written',async t=>{
 const f=fixture(),{fence}=privateFence(t),{dir}=privateFence(t),store=new TollgateResponseStore(dir);
 const out=await purchaseTollgateQuakesOnce({...args(f,fence),responseStore:store});
 assert.equal(out.status,'PROVIDER_RETURNED_DATA');assert.equal(out.response_locally_retained,true);
 const saved=store.load({reviewHash:out.review_hash,channelId:out.channel_id});
 assert.equal(saved.record.response_sha256,out.response_sha256);
 assert.deepEqual(JSON.parse(saved.rawBytes.toString('utf8')),out.data);
 assert(!saved.rawBytes.toString('utf8').includes('signature'));
 const g=fixture(),second=privateFence(t),third=privateFence(t),blocked=new TollgateResponseStore(third.dir);
 blocked.save({reviewHash:tollgateQuakesReviewHash(g.review),channelId:'7',observedAtMs:g.now,rawBytes:Buffer.from('preexisting')});
 const failed=await purchaseTollgateQuakesOnce({...args(g,second.fence),responseStore:blocked});
 assert.equal(failed.status,'DATA_RECEIVED_EVIDENCE_WRITE_FAILED');assert.equal(failed.do_not_retry,true);
 assert.equal(g.http.paid,1);assert.equal(failed.response_locally_retained,false);
 await assert.rejects(purchaseTollgateQuakesOnce({...args(g,second.fence),responseStore:blocked}),/EEXIST/);
 assert.equal(g.http.paid,1);
});

test('a seller response that echoes the voucher is withheld and is never retried',async t=>{
 for(const kind of ['header','signature']){
  const f=fixture(),{fence}=privateFence(t),{dir}=privateFence(t),responseStore=new TollgateResponseStore(dir);
  const transport=async(url,options)=>{
   if(options?.headers?.['x-payment']){
    const h=options.headers['x-payment'],envelope=JSON.parse(Buffer.from(h,'base64').toString('utf8'));
    f.data.reflected=kind==='header'?h:envelope.payload.signature;
   }
   return f.fetchImpl(url,options);
  };
  const out=await purchaseTollgateQuakesOnce({...args(f,fence),responseStore,fetchImpl:transport});
  assert.equal(out.status,'SELLER_RESPONSE_CONTAINED_VOUCHER');assert.equal(out.do_not_retry,true);
  assert.equal(out.response_locally_retained,false);assert.equal(out.data,undefined);
  assert.deepEqual(fs.readdirSync(dir),[]);assert.equal(f.http.paid,1);
 }
});
