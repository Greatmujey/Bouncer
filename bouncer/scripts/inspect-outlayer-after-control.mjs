#!/usr/bin/env node
/** Read-only: verify the old control receipt and a fresh new-registration
 * snapshot. No signature or send; the old original is never retried. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcileOutlayerRegistrationControl} from '../agent/outlayer-registration-control-runner.mjs';
import {inspectOutlayerBurnStage} from '../agent/outlayer-v11-burn-preflight.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
const control=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000});
  const controlProof=await reconcileOutlayerRegistrationControl({plan,ownerPlan,original,control,provider});
  if(controlProof.status!=='OUTLAYER_REGISTRATION_NONCE_FENCED_AT_FINAL'||controlProof.registration_state!=='REGISTRATIONS_ABSENT_AT_FINAL_VIEW')throw Error();
  const state=await inspectOutlayerBurnStage({plan,ownerPlan,stage:'register-fake',provider});
  if(!state.eligible||state.signer_key_nonce!==control.nonce)throw Error();
  console.log(JSON.stringify({...state,control_proof:controlProof,rpc:endpoint,
   scope:'read-only prior original control receipt and fresh registration state; no signature, send or provider payment'},null,2));process.exit(0);
 }catch{console.error(`Post-control original or state unavailable at ${new URL(endpoint).hostname}; no send`)}
}
console.error('Post-control registration state unknown; no transaction was made.');process.exitCode=1;
