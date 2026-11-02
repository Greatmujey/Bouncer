#!/usr/bin/env node
/** Fixed public views only. No key, signature, seller request or transaction. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectOutlayerV11Readiness } from '../agent/outlayer-v11-readiness.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await inspectOutlayerV11Readiness({ownerPlan,provider:new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:8000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch(error){console.error(`Read-only endpoint failed: ${new URL(endpoint).hostname}: ${error?.message??'unknown'}`)}
}
console.error('No endpoint returned a usable pinned snapshot; all data remain unknown.');process.exitCode=1;
