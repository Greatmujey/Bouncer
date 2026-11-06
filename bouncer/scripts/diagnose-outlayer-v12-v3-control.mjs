#!/usr/bin/env node
/** Read-only diagnosis of BOTH public originals and pinned owner state. It
 * cannot submit, sign, or conclude historical absence from an RPC error. */
import fs from 'node:fs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { inspectOutlayerRegistrationControl } from '../agent/outlayer-v12-registration-control.mjs';
import { verifyOutlayerRegistrationControlReceipt } from '../agent/outlayer-v12-registration-control-runner.mjs';
import { verifyOutlayerBurnRegistration } from '../agent/outlayer-v12-burn-registration.mjs';
import { observeOriginalReference } from '../agent/observe-original-reference.mjs';
const read = p => JSON.parse(fs.readFileSync(new URL(p,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v3-plan.json'),plan=read('../config/testnet-outlayer-burn-v3-plan.json');
const original=read('../evidence/testnet-owner-v3/outlayer-v12-register-original.json');
const control=read('../evidence/testnet-owner-v3/outlayer-v12-register-control-original.json');
const observations=[];
// Older reference blocks may be pruned by ordinary RPCs. The public NEAR
// archival endpoint is severely rate-limited, so make only these targeted,
// read-only observations; an unavailable response remains UNKNOWN.
for (const endpoint of ['https://archival-rpc.testnet.near.org','https://test.rpc.fastnear.com','https://rpc.testnet.near.org']) {
 const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:10000});
 const o={rpc:new URL(endpoint).hostname,original:{tx_hash:original.tx_hash,status:'UNAVAILABLE',receipt_verified:false},
  control:{tx_hash:control.tx_hash,status:'UNAVAILABLE',receipt_verified:false},state:{status:'UNAVAILABLE'}};
 for (const [kind,envelope] of [['original',original],['control',control]]) {
  try {
   const receipt=await provider.txStatusReceipts(envelope.tx_hash,ownerPlan.account_id,'FINAL');
   o[kind].status='RESULT';o[kind].exact_hash=receipt?.transaction?.hash===envelope.tx_hash;
   o[kind].final_execution_status=receipt?.final_execution_status??null;
   try {
    const proof=kind==='original'?verifyOutlayerBurnRegistration(receipt,original,plan,ownerPlan):
     verifyOutlayerRegistrationControlReceipt(receipt,control,original,plan,ownerPlan);
    o[kind].receipt_verified=true;o[kind].proof=proof;
   }catch{/* unverified receipt */}
  }catch{/* absent/error is not proof */}
  try{o[kind].reference=await observeOriginalReference({provider,referenceHash:envelope.block_hash})}
  catch{o[kind].reference={status:'UNAVAILABLE',historical_execution_known:false,do_not_resend_original:true}}
 }
 try {const s=await inspectOutlayerRegistrationControl({plan,ownerPlan,provider});
  o.state={block_hash:s.block_hash,signer_key_nonce:s.signer_key_nonce,registration_stage_eligible:s.eligible,
   empty_control_policy:s.control_policy===null,control_eligible:s.control_eligible};
 }catch{/* state unknown */}
 observations.push(o);
}
console.log(JSON.stringify({network:'testnet',observations,read_only:true,signed:false,sent:false,
 do_not_resend_original:true,do_not_resend_control:true,original_history_unknown_unless_receipt_verified:true,
 scope:'trusted RPC observations; errors or unchanged current state do not prove historical non-execution'},null,2));
