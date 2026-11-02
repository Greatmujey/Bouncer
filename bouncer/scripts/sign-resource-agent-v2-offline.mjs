#!/usr/bin/env node
/** LOCAL ONLY. Fsyncs one original before exporting its public bearer.
 * No RPC, broadcast, seller or private key to GitHub. */
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { signAndJournalTestnetResourceAgent } from '../agent/testnet-resource-agent-journal.mjs';
const [stage,option,...rest]=process.argv.slice(2);
if(!['guard-probe','configure','install'].includes(stage)||(option&&option!=='--restore-original')||rest.length)throw new Error('usage: sign-resource-agent-v2-offline.mjs guard-probe|configure|install [--restore-original]');
try{
 const {owner,agent}=publicResourceAgentInputs();
 const base='/home/user/near_hub/.bouncer-private/replacement-owner';
 const result=await signAndJournalTestnetResourceAgent({ownerPlan:owner,agentPlan:agent,ownerDir:base,
  agentDir:'/home/user/near_hub/.bouncer-private/replacement-resource-agent-v2',workDir:`${base}/resource-agent`,
  evidenceDir:'/home/user/near_hub/bouncer/evidence/testnet-owner-v2',stage,restore:option==='--restore-original'});
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(`Resource-agent original signing stopped: ${error?.message??'unknown error'}`);process.exitCode=1}
