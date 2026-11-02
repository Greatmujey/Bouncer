#!/usr/bin/env node
/** Read-only, single-FINAL-block stage inspection using the published real
 * public-key plan. No keys, signer, order or transaction are used. */
import fs from 'node:fs';
import {ReadOnlyNearRpcProvider} from '../agent/read-only-near-rpc.mjs';
import {inspectOutlayerBurnStage} from '../agent/outlayer-v11-burn-preflight.mjs';
import {OUTLAYER_BURN_STAGES} from '../agent/outlayer-v11-burn-signed.mjs';
const stage=process.argv[2];
if(process.argv.length!==3||!OUTLAYER_BURN_STAGES.includes(stage))throw new Error('exactly one known diagnostic stage required');
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
 try{
  const provider=new ReadOnlyNearRpcProvider(endpoint,{timeoutMs:10_000});
  const result=await inspectOutlayerBurnStage({ownerPlan,plan,stage,provider});
  console.log(JSON.stringify({...result,rpc:endpoint},null,2));process.exit(0);
 }catch{console.error(`OutLayer ${stage} public state unavailable at ${new URL(endpoint).hostname}; no send`)}
}
console.error(`OutLayer ${stage} state unknown; no transaction or seller request was made.`);process.exitCode=1;
