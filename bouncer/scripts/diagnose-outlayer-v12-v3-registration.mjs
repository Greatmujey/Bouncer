#!/usr/bin/env node
/** Public read-only diagnosis of one original hash. No signing or broadcast.
 * UNKNOWN_TRANSACTION, timeouts and current storage views are NOT proof that
 * an earlier transaction never happened. The original fence remains final. */
import fs from 'node:fs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { inspectOutlayerBurnStage } from '../agent/outlayer-v12-burn-preflight.mjs';
import { verifyOutlayerBurnRegistration } from '../agent/outlayer-v12-burn-registration.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { observeOriginalReference } from '../agent/observe-original-reference.mjs';
const owner=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const envelope=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v3/outlayer-v12-register-original.json',import.meta.url),'utf8'));
const safeName=x=>typeof x==='string'&&/^[A-Z_]{1,80}$/.test(x)?x:null;
const results=[];
for(const endpoint of ['https://rpc.testnet.near.org','https://test.rpc.fastnear.com']){
 const result={rpc:new URL(endpoint).hostname,hash_status:'UNAVAILABLE',receipt_verified:false,stage_views:{}};
 try{
  const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-diagnosis',method:'EXPERIMENTAL_tx_status',params:{tx_hash:envelope.tx_hash,sender_account_id:owner.account_id,wait_until:'FINAL'}}),signal:AbortSignal.timeout(15_000)});
  try{
   if(response.ok){const body=await readBoundedJson(response,{maxBytes:4_000_000,label:'original status'});
    if(body?.jsonrpc==='2.0'&&body.id==='bouncer-diagnosis'&&body.error){result.hash_status='RPC_ERROR';result.error_cause=safeName(body.error.cause?.name);result.error_code=Number.isSafeInteger(body.error.code)?body.error.code:null;}
    else if(body?.jsonrpc==='2.0'&&body.id==='bouncer-diagnosis'&&body.result){result.hash_status='RESULT';
     result.final_execution_status=safeName(body.result.final_execution_status);
     result.exact_hash=body.result.transaction?.hash===envelope.tx_hash;
     try{verifyOutlayerBurnRegistration(body.result,envelope,plan,owner);result.receipt_verified=true}catch{/* exact original receipt not verified */}
    }else result.hash_status='INVALID_RESPONSE';
   }else result.hash_status='HTTP_ERROR';
  }finally{await response.body?.cancel().catch(()=>{})}
 }catch{/* timeout, network or invalid response remains unknown */}
 try{
  const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:10_000});
  try{result.reference_age=await observeOriginalReference({provider,referenceHash:envelope.block_hash})}
  catch{result.reference_age={status:'UNAVAILABLE',historical_execution_known:false,do_not_resend_original:true}}
  for(const stage of ['register-fake','wrap']){
   try{const s=await inspectOutlayerBurnStage({ownerPlan:owner,plan,stage,provider});
    result.stage_views[stage]={block_hash:s.block_hash,eligible:s.eligible,blockers:s.blockers,signer_key_nonce:s.signer_key_nonce};
   }catch{result.stage_views[stage]={status:'UNAVAILABLE'}}
  }
 }catch{/* unknown */}
 results.push(result);
}
console.log(JSON.stringify({network:'testnet',original_hash:envelope.tx_hash,results,original_outcome:'UNKNOWN_UNLESS_RECONCILED',
 read_only:true,signed:false,sent:false,do_not_resend:true,scope:'trusted RPC observations only; unavailable/not found is not proof of absence'},null,2));
