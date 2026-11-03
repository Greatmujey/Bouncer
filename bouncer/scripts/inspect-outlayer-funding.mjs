#!/usr/bin/env node
/** Read-only fake-token vault funding preflight bound to original receipts. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {inspectOutlayerFundingBefore} from '../agent/outlayer-burn-funding.mjs';
const read=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v2-plan.json'),plan=read('../config/testnet-outlayer-burn-v2-plan.json');
const original=read('../evidence/testnet-owner-v2/outlayer-burn-register-original.json');
const control=read('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json');
const registration=read('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json');
const wrap=read('../evidence/testnet-owner-v2/outlayer-burn-wrap-original.json');
const swap=read('../evidence/testnet-owner-v2/outlayer-burn-swap-original.json');
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await inspectOutlayerFundingBefore({plan,ownerPlan,original,control,registration,wrap,swap,
   provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch(error){
  const detail=typeof error?.message==='string'?error.message.replace(/[\r\n]/g,' ').slice(0,300):'unknown error';
  console.error(`Funding preflight unavailable or mismatched at ${new URL(endpoint).hostname}: ${detail}; no send`);
 }
}
console.error('Original-bound fake-token funding preflight is unknown; no transaction was made.');process.exitCode=1;
