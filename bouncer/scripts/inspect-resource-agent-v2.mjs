#!/usr/bin/env node
/** Public read-only pinned preflight. No signing or submission. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { inspectTestnetResourceAgentSetup } from '../agent/testnet-resource-agent-setup.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
try{
 const {owner,agent,anchor}=publicResourceAgentInputs();
 let state,used;const errors=[];
 for(const endpoint of ['https://rpc.testnet.near.org','https://test.rpc.fastnear.com']){
  try{
   const s=await inspectTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,provider:new ReadOnlyNearRpcProvider(endpoint)});
   if(s.circle_code_hash!==anchor.circle_code_hash)throw new Error('current Circle code differs from original funding');
   state=s;used=endpoint;break;
  }catch(error){errors.push(`${endpoint}: ${String(error?.message??'unknown').slice(0,160)}`)}
 }
 if(!state)throw new Error(`all read-only endpoints unavailable (${errors.join('; ')})`);
 console.log(JSON.stringify({...state,read_only_rpc:used},null,2));
}catch(error){console.error(`Resource-agent preflight stopped: ${error?.message??'unknown error'}`);process.exitCode=1}
