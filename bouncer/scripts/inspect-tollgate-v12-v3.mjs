#!/usr/bin/env node
/** Fixed unpaid GET plus FINAL testnet views. No voucher, key or transaction. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectTollgateV12Readiness } from '../agent/tollgate-v12-readiness.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await inspectTollgateV12Readiness({ownerPlan,provider:new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:10_000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`Unpaid Tollgate or pinned testnet views unavailable at ${new URL(endpoint).hostname}; no payment`)}
}
console.error('Read-only independent-data discovery unavailable; no transaction or voucher.');process.exitCode=1;
