#!/usr/bin/env node
/** Public read-only pinned preflight. No signing or submission. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { inspectTestnetResourceAgentSetup } from '../agent/testnet-resource-agent-setup.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
try{
 const {owner,agent,anchor}=publicResourceAgentInputs();
 const state=await inspectTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,provider:new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org')});
 if(state.circle_code_hash!==anchor.circle_code_hash)throw new Error('current Circle code differs from original funding');
 console.log(JSON.stringify(state,null,2));
}catch(error){console.error(`Resource-agent preflight stopped: ${error?.message??'unknown error'}`);process.exitCode=1}
