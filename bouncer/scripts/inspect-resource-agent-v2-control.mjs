#!/usr/bin/env node
/** Public read-only pinned preflight for a distinct zero-yocto control probe. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { inspectTestnetResourceAgentGuardControl, verifySignedTestnetResourceAgentSetup } from '../agent/testnet-resource-agent-setup.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
try {
 const {owner,agent,anchor,envelope:original}=publicResourceAgentInputs('guard-probe');
 verifySignedTestnetResourceAgentSetup(original,owner,agent);
 const state=await inspectTestnetResourceAgentGuardControl({ownerPlan:owner,agentPlan:agent,
  provider:new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org')});
 if(state.circle_code_hash!==anchor.circle_code_hash||state.guard_control_eligible!==true||
    BigInt(state.owner_key_nonce)+1n!==BigInt(original.nonce))throw new Error('original probe or fresh control state differs');
 console.log(JSON.stringify(state,null,2));
}catch(error){console.error(`Resource-agent control preflight stopped; reconcile the original: ${error?.message??'unknown error'}`);process.exitCode=1}
