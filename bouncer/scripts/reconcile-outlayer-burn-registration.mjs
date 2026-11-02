#!/usr/bin/env node
/** Original-hash fake-token registration recovery. No signing or broadcasting. */
import fs from 'node:fs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {reconcileOutlayerBurnRegistration} from '../agent/outlayer-burn-registration.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const envelope=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
for(const endpoint of ['https://rpc.testnet.near.org','https://test.rpc.fastnear.com']){
 try{
  const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:15_000});
  const result=await reconcileOutlayerBurnRegistration({plan,ownerPlan,envelope,provider});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`Original registration unavailable or mismatched at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`Original testnet registration ${envelope.tx_hash} remains unresolved; retain it and never resend.`);process.exitCode=1;
