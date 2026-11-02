#!/usr/bin/env node
/** Read-only reconciliation of one fixed acquisition original and parents. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcileOutlayerAcquisition} from '../agent/outlayer-burn-acquisition.mjs';
const stage=process.argv[2];if(process.argv.length!==3||!['wrap','swap-fake'].includes(stage))throw new Error('one known acquisition stage required');
const read=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v2-plan.json'),plan=read('../config/testnet-outlayer-burn-v2-plan.json');
const original=read('../evidence/testnet-owner-v2/outlayer-burn-register-original.json');
const control=read('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json');
const registration=read('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json');
const wrap=stage==='swap-fake'?read('../evidence/testnet-owner-v2/outlayer-burn-wrap-original.json'):undefined;
const envelope=read(`../evidence/testnet-owner-v2/outlayer-burn-${stage}-original.json`);
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{const result=await reconcileOutlayerAcquisition({plan,ownerPlan,original,control,registration,wrap,envelope,
  provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`Original ${stage} unavailable or mismatched at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`Original ${stage} ${envelope.tx_hash} remains unresolved; retain and never resend.`);process.exitCode=1;
