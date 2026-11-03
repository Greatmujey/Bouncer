#!/usr/bin/env node
/** Read-only original control and registration reconciliation; never sends. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcileOutlayerRegistrationControl} from '../agent/outlayer-v12-registration-control-runner.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v3/outlayer-v12-register-original.json',import.meta.url),'utf8'));
const control=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v3/outlayer-v12-register-control-original.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{const result=await reconcileOutlayerRegistrationControl({plan,ownerPlan,original,control,
  provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`Original control unavailable or mismatched at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`Original control ${control.tx_hash} remains unresolved; retain both originals and never resend.`);process.exitCode=1;
