#!/usr/bin/env node
/** Fixed public-state preflight for the V3 owner's real, uninstalled
 * OutLayer agent public keys. No private key, signature or order. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectOutlayerBurnStage } from '../agent/outlayer-v12-burn-preflight.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await inspectOutlayerBurnStage({ownerPlan,plan,stage:'register-fake',provider:new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:10_000})});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch(error){console.error(`Read-only V3 preflight unavailable: ${new URL(endpoint).hostname}: ${error?.message??'unknown'}`)}
}
console.error('No pinned V3 preflight available; do not sign.');process.exitCode=1;
