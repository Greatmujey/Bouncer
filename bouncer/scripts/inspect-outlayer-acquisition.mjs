#!/usr/bin/env node
/** Read-only acquisition preflight bound to original finalized parent receipts. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {inspectOutlayerBurnStage} from '../agent/outlayer-v11-burn-preflight.mjs';
import {verifyOutlayerRegistrationControlReceipt} from '../agent/outlayer-registration-control-runner.mjs';
import {verifyOutlayerBurnRegistration} from '../agent/outlayer-burn-registration.mjs';
import {verifyOutlayerAcquisitionReceipt} from '../agent/outlayer-burn-acquisition.mjs';
import {verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
const stage=process.argv[2];if(process.argv.length!==3||!['wrap','swap-fake'].includes(stage))throw new Error('one known acquisition stage required');
const read=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v2-plan.json'),plan=read('../config/testnet-outlayer-burn-v2-plan.json');
const original=read('../evidence/testnet-owner-v2/outlayer-burn-register-original.json');
const control=read('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json');
const registration=read('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json');
const wrap=stage==='swap-fake'?read('../evidence/testnet-owner-v2/outlayer-burn-wrap-original.json'):undefined;
verifySignedOutlayerBurnStage(registration,plan,ownerPlan);
if(registration.stage!=='register-fake'||BigInt(registration.nonce)!==BigInt(control.nonce)+1n||
 (stage==='swap-fake'&&(!wrap||wrap.stage!=='wrap'||BigInt(wrap.nonce)!==BigInt(registration.nonce)+1n)))throw new Error('acquisition originals are not consecutive');
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000}),account=ownerPlan.account_id;
  const controlReceipt=verifyOutlayerRegistrationControlReceipt(await provider.txStatusReceipts(control.tx_hash,account,'FINAL'),control,original,plan,ownerPlan);
  const registrationReceipt=verifyOutlayerBurnRegistration(await provider.txStatusReceipts(registration.tx_hash,account,'FINAL'),registration,plan,ownerPlan);
  const wrapReceipt=wrap?verifyOutlayerAcquisitionReceipt(await provider.txStatusReceipts(wrap.tx_hash,account,'FINAL'),wrap,plan,ownerPlan):null;
  const state=await inspectOutlayerBurnStage({plan,ownerPlan,stage,provider});
  if(!state.eligible||state.signer_key_nonce!==(wrap??registration).nonce)throw Error();
  console.log(JSON.stringify({...state,prior:{control:controlReceipt,registration:registrationReceipt,...(wrapReceipt?{wrap:wrapReceipt}:{})},
   rpc:endpoint,scope:'read-only prior FINAL receipt checks and fresh stage state; no signature, send or provider payment'},null,2));process.exit(0);
 }catch{console.error(`Acquisition ${stage} originals or state unavailable at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`Acquisition ${stage} is unknown; no transaction was made.`);process.exitCode=1;
