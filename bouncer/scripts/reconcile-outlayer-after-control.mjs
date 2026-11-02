#!/usr/bin/env node
/** Read-only lookup of the new registration and prior control originals. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcilePostControlRegistration} from '../agent/outlayer-registration-after-control.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
const control=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json',import.meta.url),'utf8'));
const envelope=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{const result=await reconcilePostControlRegistration({plan,ownerPlan,original,control,envelope,
  provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`New registration or prior control unavailable at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`New registration ${envelope.tx_hash} remains unresolved; retain all originals and never resend.`);process.exitCode=1;
