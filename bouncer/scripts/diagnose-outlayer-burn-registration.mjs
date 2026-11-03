#!/usr/bin/env node
/** READ-ONLY diagnosis of the original fake-token registration. The injected
 * send method ONLY throws; even if every check passes, this cannot transmit. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {inspectOutlayerBurnStage} from '../agent/outlayer-v11-burn-preflight.mjs';
import {broadcastOutlayerBurnRegistrationOnce} from '../agent/outlayer-burn-registration.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const bytes=fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url));
const envelope=JSON.parse(bytes.toString('utf8')),digest=crypto.createHash('sha256').update(bytes).digest('hex');
const artifactId='13185743452',runId='41542420534',headSha='016a85096e991e5be171b686c9b3e7cd119adafe';
const token=process.env.GITHUB_TOKEN;
if(typeof token!=='string'||token.length<20)throw new Error('read-only artifact metadata access required');
let fence=false;try{fence=await githubOriginalFence({artifactId,runId,headSha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-burn-register-fence'})}catch{}
const results=[];
for(const endpoint of ['https://rpc.testnet.near.org','https://test.rpc.fastnear.com']){
 const source=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:12000});let reached=false,attemptedFence=false,reason='UNKNOWN',preflight=null,lookup='UNAVAILABLE';
 const provider=new Proxy(source,{get(target,prop){
  if(prop==='enforcesSetupBeforeSubmitGuard')return true;
  if(prop==='sendTransactionOnce')return async()=>{reached=true;throw new Error('READ_ONLY_NO_SEND')};
  const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
 }});
 try{const s=await inspectOutlayerBurnStage({ownerPlan,plan,stage:'register-fake',provider:source});
  preflight={eligible:s.eligible,blockers:s.blockers,signer_key_nonce:s.signer_key_nonce,block_hash:s.block_hash};}catch{}
 try{const r=await source.txStatusReceipts(envelope.tx_hash,ownerPlan.account_id,'FINAL');lookup=r?.transaction_outcome?.id===envelope.tx_hash?'RETURNED_ORIGINAL':'MISMATCHED_RESPONSE'}catch{}
 try{
  await broadcastOutlayerBurnRegistrationOnce({plan,ownerPlan,envelope,provider,persistAttempt:async()=>{attemptedFence=true;return fence}});
 }catch(error){
  const message=String(error?.message??'');
  const categories=[['STATE_NOT_ELIGIBLE',/fresh registration state is not eligible/],['NONCE_CHANGED',/owner nonce changed/],
   ['REFERENCE_OLD_OR_UNKNOWN',/reference block is too old or unknown/],['REFERENCE_NOT_CANONICAL',/reference is not canonical/],
   ['FENCE_UNAVAILABLE',/original registration fence was not established/],['READ_ONLY_SEND_GUARD_REACHED',/original fake-token registration .* is unconfirmed/]];
  reason=categories.find(([,pattern])=>pattern.test(message))?.[0]??'RPC_OR_OTHER_CHECK_UNKNOWN';
 }
 results.push({rpc:new URL(endpoint).hostname,preflight,original_lookup:lookup,old_fence_checked:fence,
  fence_check_reached:attemptedFence,read_only_send_guard_reached:reached,diagnostic_reason:reason});
}
console.log(JSON.stringify({network:'testnet',original_tx_hash:envelope.tx_hash,results,sent:false,do_not_resend:true,
 scope:'read-only diagnosis using current state; unavailable original is not proof it never executed and the public bearer may still be relayed'},null,2));
