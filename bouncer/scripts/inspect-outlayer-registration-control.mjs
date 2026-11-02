#!/usr/bin/env node
/** Pinned read-only state for a distinct nonce-fencing guard control. */
import fs from 'node:fs';
import {ReadOnlyNearRpcProvider} from '../agent/read-only-near-rpc.mjs';
import {inspectOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
verifySignedOutlayerBurnStage(original,plan,ownerPlan);
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const provider=new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:10000});
  const result=await inspectOutlayerRegistrationControl({plan,ownerPlan,provider});
  const eligible=result.control_eligible&&BigInt(result.signer_key_nonce)+1n===BigInt(original.nonce);
  console.log(JSON.stringify({...result,control_eligible:eligible,original_tx_hash:original.tx_hash,original_nonce:original.nonce,
   rpc:endpoint,scope:'read-only control preflight; original receipt remains unknown and its public bearer can still be relayed'},null,2));process.exit(0);
 }catch{console.error(`Control state unavailable at ${new URL(endpoint).hostname}; no send`)}
}
console.error('Control state unknown; no transaction was made.');process.exitCode=1;
