#!/usr/bin/env node
/** TEST ONLY: disposable loopback nearcore, pinned published channel WASM and
 * pinned seller SDK. The seller handler returns synthetic quakes; no live
 * provider, USGS, public-chain transaction, Circle token or audit is involved. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import nearApi from 'near-api-js';
import {startSandbox,stopSandboxChild} from './v11-nearcore-sandbox.mjs';
import {readVerifiedFile,SANDBOX_SHA256,assertSandboxStatus,requireFinalSuccess} from './v11-sandbox-support.mjs';
import {loopbackSandboxUrl,withSandboxOnlyFetch} from './v11-sandbox-setup-rpc.mjs';
import {PUBLISHED_CHANNEL_SHA256} from './v13-sandbox-tollgate.mjs';
import {makeTollgateQuakesReview,tollgateQuakesReviewHash,purchaseTollgateQuakesOnce,TollgateVoucherFence,
 V13_VOUCHER_SHA256,CHANNEL_BUDGET_YOCTO,QUAKES_PRICE_YOCTO} from '../agent/tollgate-quakes-v13.mjs';
import {TOLLGATE_RESOURCE} from '../agent/tollgate-v12-readiness.mjs';
import {TollgateResponseStore} from '../agent/tollgate-response-store.mjs';
import {corroborateTollgateQuakes} from '../agent/tollgate-quakes-corroboration.mjs';
import {inspectTollgateSettlement} from '../agent/tollgate-settlement-verification.mjs';

const fixture=process.env.BOUNCER_TOLLGATE_SELLER_FIXTURES;
if(!fixture||!path.isAbsolute(fixture))throw Error('absolute pinned seller fixture path required');
for(const [name,digest] of [['src/core/voucher.mjs','51739a45a9a7e3a83fe411d2cf2f2e0d5ff3518fc4f0717225247181689f97b3'],
 ['src/seller/tollgate.mjs','c83c65bced260297bbd2188877e91f45f7ae70b936860dcd29c75e76dc60dd77'],
 ['src/seller/store.mjs','8b3264f9cc0250126bd3a0cdec665ba1fc29b7907bf6802b9782534ea2a34bfe']]){
 const bytes=fs.readFileSync(path.join(fixture,name));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('pinned seller fixture differs');
}
const {createTollgate}=await import(pathToFileURL(path.join(fixture,'src/seller/tollgate.mjs')).href);
readVerifiedFile(process.env.BOUNCER_SANDBOX_BIN,SANDBOX_SHA256);
const wasm=readVerifiedFile(process.env.BOUNCER_V13_WASM_PATH,V13_VOUCHER_SHA256,{maxBytes:2*1024*1024});
const channelWasm=readVerifiedFile(process.env.BOUNCER_TOLLGATE_WASM_PATH,PUBLISHED_CHANNEL_SHA256,{maxBytes:4*1024*1024});
const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v13-http-sandbox-'));fs.chmodSync(rootDir,0o700);
const genesis=nearApi.KeyPair.fromRandom('ed25519');let sandbox,server;
try{
 sandbox=await startSandbox(process.env.BOUNCER_SANDBOX_BIN,rootDir,String(genesis.getPublicKey()));
 const endpoint=loopbackSandboxUrl(sandbox.rpcUrl);
 await withSandboxOnlyFetch(endpoint,async()=>{
  const p=sandbox.provider;assertSandboxStatus(await p.status());
  const ROOT='testnet',OWNER='bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',VAULT=`data.${OWNER}`,
   PARENT='tollgate-busel.testnet',CHANNEL=`channels.${PARENT}`,SELLER=`seller.${PARENT}`;
  const {transactions:tx,KeyPair,Account,KeyPairSigner}=nearApi,TGAS=10n**12n,NEAR=10n**24n;
  const key=()=>KeyPair.fromRandom('ed25519'),pub=k=>String(k.getPublicKey());
  const ownerKey=key(),agentKey=key(),voucherKey=key(),parentKey=key(),sellerKey=key();
  const account=(id,k)=>new Account(id,p,new KeyPairSigner(k));
  const root=new Account(ROOT,p,new KeyPairSigner(sandbox.rootKey)),owner=account(OWNER,ownerKey),agent=account(OWNER,agentKey),
   parent=account(PARENT,parentKey),seller=account(SELLER,sellerKey);
  const fn=(method,args={},deposit=0n,gas=100n*TGAS)=>tx.functionCall(method,args,gas,deposit);
  const batch=async(signer,id,actions,label)=>{const r=await signer.signAndSendTransaction({receiverId:id,actions,waitUntil:'FINAL',throwOnFailure:false});
   requireFinalSuccess(r,label);return r};
  const call=(signer,id,method,args={},deposit=0n,gas=100n*TGAS)=>batch(signer,id,[fn(method,args,deposit,gas)],method);
  const view=(id,method,args={})=>p.callFunction(id,method,args,{finality:'final'});
  await batch(root,OWNER,[tx.createAccount(),tx.transfer(20n*NEAR),tx.addKey(ownerKey.getPublicKey(),tx.fullAccessKey())],'local owner');
  await batch(owner,VAULT,[tx.createAccount(),tx.transfer(8n*NEAR),tx.deployContract(wasm),fn('new',{owner:OWNER})],'local keyless V13');
  await batch(root,PARENT,[tx.createAccount(),tx.transfer(20n*NEAR),tx.addKey(parentKey.getPublicKey(),tx.fullAccessKey())],'local provider parent');
  await batch(parent,CHANNEL,[tx.createAccount(),tx.transfer(6n*NEAR),tx.deployContract(channelWasm),fn('new',{min_dispute_window_sec:'15',max_expiry_sec:'2592000'})],'local published channel');
  await batch(parent,SELLER,[tx.createAccount(),tx.transfer(4n*NEAR),tx.addKey(sellerKey.getPublicKey(),tx.fullAccessKey())],'local seller');
  const amount=BigInt(CHANNEL_BUDGET_YOCTO);
  await call(owner,VAULT,'deposit_native',{},amount);
  await call(owner,VAULT,'set_policy',{policy_id:'data',token:'native',per_tx_cap:CHANNEL_BUDGET_YOCTO,daily_cap:CHANNEL_BUDGET_YOCTO},1n);
  await call(owner,VAULT,'allow_payee',{policy_id:'data',payee:CHANNEL},1n);
  await call(owner,VAULT,'allow_payee',{policy_id:'data',payee:SELLER},1n);
  await call(owner,VAULT,'grant_agent_key',{policy_id:'data',public_key:pub(agentKey)},1n);
  const block=await p.viewBlock({finality:'final'}),expiry=(BigInt(block.header.timestamp_nanosec)/1_000_000n+120_000n).toString();
  const ownerPlan={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:OWNER,public_key:pub(ownerKey)};
  const review=makeTollgateQuakesReview({ownerPlan,intentId:'local-quakes-http',agentPublicKey:pub(agentKey),voucherPublicKey:pub(voucherKey),expiresAtMs:expiry});
  await call(owner,VAULT,'set_tollgate_intent',{intent_id:review.intent_id,policy_id:review.policy_id,amount:CHANNEL_BUDGET_YOCTO,
   agent_public_key:review.agent_public_key,voucher_public_key:review.voucher_public_key,review_hash:tollgateQuakesReviewHash(review),
   expires_at_ms:review.expires_at_ms,channel_lifetime_sec:'600',dispute_window_sec:'15'},1n);
  await batch(owner,OWNER,[tx.addKey(agentKey.getPublicKey(),tx.functionCallAccessKey(VAULT,['execute_tollgate_intent'],NEAR/2n))],'local restricted agent');
  await call(agent,VAULT,'execute_tollgate_intent',{intent_id:review.intent_id},0n,150n*TGAS);
  const opened=await view(VAULT,'get_tollgate_intent',{intent_id:review.intent_id});assert.equal(opened.channel_id,'0');
  await call(owner,VAULT,'verify_tollgate_channel',{intent_id:review.intent_id,candidate_id:opened.channel_id},1n);
  assert.equal(await view(VAULT,'is_tollgate_voucher_authorized',{intent_id:review.intent_id}),true);
  // A narrow identity adapter aliases ONLY the named disposable sandbox chain
  // ID for the production testnet checks; every view remains local nearcore.
  const provider={async viewNodeStatus(){assertSandboxStatus(await p.status());return {chain_id:'testnet'}},
   viewBlock:(...a)=>p.viewBlock(...a),query:(...a)=>p.query(...a),callFunctionRaw:(...a)=>p.callFunctionRaw(...a)};
  const gate=createTollgate({contract:CHANNEL,seller:SELLER,network:'near-testnet',
   channelSource:id=>view(CHANNEL,'get_channel',{channel_id:id}),
   settle:async v=>{const r=await call(seller,CHANNEL,'settle',{channel_id:v.channelId,cumulative_amount:v.cumulative,nonce:v.nonce,signature:v.signature});
    return {ok:true,hash:r.transaction_outcome.id}}});
  const handler=gate.protect({price:'0.001',description:'Synthetic local quakes'},async(req,res,receipt)=>{
   const now=Date.now(),start=new Date(now-24*3_600_000).toISOString();
   const body={source:'USGS Earthquake Hazards Program, FDSN event API',
    source_url:`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&minmagnitude=5&starttime=${encodeURIComponent(start)}&limit=10`,
    fetched_at:new Date(now).toISOString(),cached:false,query:{min_magnitude:5,hours:24,limit:10},count:1,
    quakes:[{id:'sandbox-synthetic-event',magnitude:5.1,place:'Synthetic Ocean',time:new Date(now).toISOString()}],
    paid:{channel_id:receipt.channel_id,nonce:receipt.nonce,price_yocto:receipt.price}};
   res.statusCode=200;res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
  });
  server=http.createServer((req,res)=>handler(req,res).catch(()=>{res.statusCode=500;res.end('{}')}));
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const port=server.address().port;let httpRequests=0;
  // This adapter maps only the exact reviewed URL to the local SDK server. It
  // does not use fetch or DNS and can never contact the real public seller.
  const localFetch=async(url,options)=>{
   assert.equal(url,TOLLGATE_RESOURCE);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');httpRequests++;
   const target=new URL(url),headers={...options.headers,'x-forwarded-host':target.host,'x-forwarded-proto':'https'};
   return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:target.pathname+target.search,method:'GET',headers},res=>{
     const chunks=[];let total=0;res.on('data',chunk=>{total+=chunk.length;if(total>300_000)req.destroy(Error('fixture response too large'));else chunks.push(chunk)});
     res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',reject);
    });req.on('error',reject);req.setTimeout(15_000,()=>req.destroy(Error('fixture timeout')));req.end();
   });
  };
  const fenceDir=path.join(rootDir,'voucher-fence');fs.mkdirSync(fenceDir,{mode:0o700});
  const evidenceDir=path.join(rootDir,'response-evidence');fs.mkdirSync(evidenceDir,{mode:0o700});
  const fence=new TollgateVoucherFence(fenceDir),responseStore=new TollgateResponseStore(evidenceDir);
  const result=await purchaseTollgateQuakesOnce({review,provider,voucherKey,fence,responseStore,fetchImpl:localFetch,executionMode:'synthetic'});
  assert.equal(result.status,'PROVIDER_RETURNED_DATA');assert.equal(result.settlement_verified,false);
  assert.equal(result.response_locally_retained,true);
  assert.equal(result.data.quakes[0].id,'sandbox-synthetic-event');assert.equal(httpRequests,2);
  // This is a synthetic comparison transport, not real USGS or live delivery.
  const q=result.data.quakes[0],fakeSource=async(url,options)=>{
   assert.equal(new URL(url).hostname,'earthquake.usgs.gov');assert.equal(options.method,'GET');
   return Response.json({type:'FeatureCollection',features:[{type:'Feature',id:q.id,
    properties:{mag:q.magnitude,place:q.place,time:Date.parse(q.time)}}]});
  };
  const comparison=await corroborateTollgateQuakes({review,purchase:result,responseStore,fetchImpl:fakeSource});
  assert.equal(comparison.status,'UPSTREAM_DATA_CORROBORATED');assert.equal(comparison.settlement_verified,false);
  assert.equal((await view(CHANNEL,'get_channel',{channel_id:opened.channel_id})).settled,'0');
  await assert.rejects(purchaseTollgateQuakesOnce({review,provider,voucherKey,fence,fetchImpl:localFetch,executionMode:'synthetic'}),/EEXIST/);
  assert.equal(httpRequests,3); // second call discovers only; paid request is never repeated
  const settlement=await gate.settleChannel(opened.channel_id);assert.equal(settlement.ok,true);
  const proofProvider={...provider,txStatusReceipts:(...a)=>p.txStatusReceipts(...a)};
  let settlementProof;
  try{settlementProof=await inspectTollgateSettlement({review,purchase:result,txHash:settlement.hash,provider:proofProvider})}
  catch(error){
   // Diagnostic structure only. Never print voucher signatures or call args.
   const r=await p.txStatusReceipts(settlement.hash,SELLER,'FINAL');
   const shape={final:r.final_execution_status,txStatus:Object.keys(r.transaction_outcome?.outcome?.status??{}),
    txChildren:r.transaction_outcome?.outcome?.receipt_ids,txActionKeys:r.transaction?.actions?.map(a=>Object.keys(a)),
    receipts:r.receipts?.map(x=>({id:x.receipt_id,from:x.predecessor_id,to:x.receiver_id,
     actions:x.receipt?.Action?.actions?.map(a=>Object.keys(a)),methods:x.receipt?.Action?.actions?.map(a=>a.FunctionCall?.method_name??null)})),
    outcomes:r.receipts_outcome?.map(x=>({id:x.id,executor:x.outcome?.executor_id,status:Object.keys(x.outcome?.status??{}),
     children:x.outcome?.receipt_ids,logCount:x.outcome?.logs?.length,block:!!x.block_hash}))};
   console.log('SANITIZED_SYNTHETIC_RECEIPT_SHAPE '+JSON.stringify(shape));throw error;
  }
  assert.equal(settlementProof.settlement_verified,true);
  let channel=await view(CHANNEL,'get_channel',{channel_id:opened.channel_id});assert.equal(channel.settled,QUAKES_PRICE_YOCTO);
  await call(owner,VAULT,'start_tollgate_close',{intent_id:review.intent_id},1n);
  channel=await view(CHANNEL,'get_channel',{channel_id:opened.channel_id});let ready=false;
  for(let i=0;i<40;i++){const b=await p.viewBlock({finality:'final'});if(BigInt(b.header.timestamp_nanosec)>=BigInt(channel.settle_deadline_ns)){ready=true;break}await delay(1000)}
  assert.equal(ready,true);const before=await p.viewAccount(VAULT,{finality:'final'});
  await call(owner,VAULT,'finalize_tollgate_close',{intent_id:review.intent_id},1n);
  channel=await view(CHANNEL,'get_channel',{channel_id:opened.channel_id});
  const after=await p.viewAccount(VAULT,{finality:'final'});
  assert.equal(channel.status,'Closed');assert.equal(BigInt(channel.refunded),BigInt(channel.deposit)-BigInt(QUAKES_PRICE_YOCTO));
  assert.ok(BigInt(after.amount)>=BigInt(before.amount)+BigInt(channel.refunded));
  assert.equal(await view(VAULT,'daily_spent',{policy_id:'data'}),CHANNEL_BUDGET_YOCTO);
  console.log(JSON.stringify({scope:'disposable local nearcore, pinned published seller SDK and synthetic response only',
   live_provider_contacted:false,public_chain_transaction:false,independent_data_verified:false,circle_payment:false,
   owner_review_hash_pinned:true,one_yocto_owner_policy:true,restricted_agent:true,channel_verified:true,
   one_fenced_http_voucher:true,replay_refused:true,local_seller_acknowledged:true,local_data_returned:true,
   exact_response_retained:true,synthetic_upstream_comparison_passed:true,
   no_false_settlement_claim_before_chain:true,local_seller_settled:true,final_receipt_graph_and_detached_payout_verified:true,
   owner_close_and_detached_refund:true,
   rolling_budget_conservative:true,v13_sha256:V13_VOUCHER_SHA256,channel_sha256:PUBLISHED_CHANNEL_SHA256},null,2));
 });
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 if(sandbox)await stopSandboxChild(sandbox.child);
 fs.rmSync(rootDir,{recursive:true,force:true});
}
