#!/usr/bin/env node
/** LOCAL ONLY. Persist an independently inspected CI result to the private
 * original journal; never queries an RPC, signs, sends or accepts a new hash. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { readBoundedPrivate } from '../agent/circle-owner-offline-journal.mjs';
import { recordFinalTestnetResourceAgentResult } from '../agent/testnet-resource-agent-journal.mjs';
const [stage,...rest]=process.argv.slice(2);
if(!['guard-probe','guard-control','configure','install'].includes(stage)||rest.length)throw new Error('a fixed resource-agent stage is required');
try{
 const {owner,agent,envelope}=publicResourceAgentInputs(stage),base='/home/user/near_hub/.bouncer-private/replacement-owner';
 const result=readBoundedPrivate(`${base}/resource-agent/${stage}-final.json`,100_000);
 if(result.tx_hash!==envelope.tx_hash)throw new Error('final result does not match the published original hash');
 const saved=recordFinalTestnetResourceAgentResult({ownerPlan:owner,agentPlan:agent,ownerDir:base,workDir:`${base}/resource-agent`,stage,result});
 console.log(JSON.stringify(saved,null,2));
}catch(error){console.error(`Resource-agent result recording stopped: ${error?.message??'unknown error'}`);process.exitCode=1}
