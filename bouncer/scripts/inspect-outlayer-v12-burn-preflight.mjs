#!/usr/bin/env node
/** Public-state experiment only. These are byte-pattern placeholders with no
 * private key and MUST NEVER be installed or funded. This script cannot sign,
 * create an executable plan, persist a key, call a seller, or broadcast. */
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { createOutlayerBurnPlan } from '../agent/outlayer-v12-burn-plan.mjs';
import { inspectOutlayerBurnStage } from '../agent/outlayer-v12-burn-preflight.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const placeholder=n=>`ed25519:${nearApi.utils.serialize.base_encode(Buffer.alloc(32,n))}`;
const plan=createOutlayerBurnPlan({ownerPlan,
 fundingPublicKey:placeholder(1),projectPublicKey:placeholder(2)});
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const result=await inspectOutlayerBurnStage({ownerPlan,plan,stage:'register-fake',provider:new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:8000})});
  const {eligible,...publicResult}=result;
  console.log(JSON.stringify({...publicResult,rpc:endpoint,necessary_state_checks_passed:eligible,
    placeholder_keys_only:true,transaction_authorized:false,
    scope:'read-only preliminary state checks; placeholder keys have no private keys and must never be installed or funded; no executable coordinator, proof of previous receipts, authorization or fulfillment'},null,2));
  process.exit(0);
 }catch(error){console.error(`Read-only preflight failed: ${new URL(endpoint).hostname}: ${error?.message??'unknown'}`)}
}
console.error('No endpoint returned a usable pinned preflight; all data remain unknown.');process.exitCode=1;
