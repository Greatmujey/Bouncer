#!/usr/bin/env node
/** Read-only original-hash fake-token vault funding reconciliation. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcileOutlayerFunding} from '../agent/outlayer-burn-funding.mjs';
const read=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v2-plan.json'),plan=read('../config/testnet-outlayer-burn-v2-plan.json');
const original=read('../evidence/testnet-owner-v2/outlayer-burn-register-original.json');
const control=read('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json');
const registration=read('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json');
const wrap=read('../evidence/testnet-owner-v2/outlayer-burn-wrap-original.json');
const swap=read('../evidence/testnet-owner-v2/outlayer-burn-swap-original.json');
const envelope=read('../evidence/testnet-owner-v2/outlayer-burn-vault-fund-original.json');
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await reconcileOutlayerFunding({plan,ownerPlan,original,control,registration,wrap,swap,envelope,
   provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch(error){
  const detail=typeof error?.message==='string'?error.message.replace(/[\r\n]/g,' ').slice(0,300):'unknown error';
  console.error(`Original fake-token funding unavailable or mismatched at ${new URL(endpoint).hostname}: ${detail}; no send`);
 }
}
console.error(`Original fund-vault ${envelope.tx_hash} remains unresolved; retain and never resend.`);process.exitCode=1;
