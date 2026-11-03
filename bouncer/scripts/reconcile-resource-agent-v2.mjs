#!/usr/bin/env node
/** Read-only lookup of exactly the original signed hash, never a resend. */
import crypto from 'node:crypto';
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { reconcileTestnetResourceAgent } from '../agent/testnet-resource-agent-runner.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
const stage=process.env.BOUNCER_RESOURCE_AGENT_STAGE;
if(!['guard-probe','guard-control','configure','install'].includes(stage))throw new Error('fixed resource-agent stage required');
try{
 const {owner,agent,anchor,envelope,bytes}=publicResourceAgentInputs(stage);
 const originalProbe=stage==='guard-control'?publicResourceAgentInputs('guard-probe').envelope:undefined;
 // Read-only fallback queries the SAME original hash. A failure or timeout is
 // never interpreted as absence, permission to resend, or success.
 const endpoints=['https://rpc.testnet.near.org','https://test.rpc.fastnear.com'];
 let result,used;const errors=[];
 for(const endpoint of endpoints){
  try{
   result=await reconcileTestnetResourceAgent({ownerPlan:owner,agentPlan:agent,envelope,originalProbe,expectedCircleCodeHash:anchor.circle_code_hash,
    provider:new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:12_000})});
   used=endpoint;break;
  }catch(error){errors.push(`${endpoint}: ${String(error?.message??'unknown').slice(0,160)}`)}
 }
 if(!result)throw new Error(`original hash remains unresolved on all read-only endpoints (${errors.join('; ')})`);
 console.log(JSON.stringify({...result,read_only_rpc:used,signed_envelope_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  reconciliation_run_id:process.env.GITHUB_RUN_ID??null,reconciliation_commit:process.env.GITHUB_SHA??null},null,2));
}catch(error){console.error(`Original resource-agent ${stage} reconciliation stopped; do not resend: ${error?.message??'unknown error'}`);process.exitCode=1}
