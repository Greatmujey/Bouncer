#!/usr/bin/env node
/** CI-only exact public bearer, one testnet submission and original-hash
 * verification. No private key is available. The published signature may be
 * relayed by another party before preflight; never resend an ambiguous hash. */
import crypto from 'node:crypto';
import { publicResourceAgentInputs } from './resource-agent-v2-common.mjs';
import { githubOriginalFence } from '../agent/github-original-fence.mjs';
import { broadcastTestnetResourceAgentOnce } from '../agent/testnet-resource-agent-runner.mjs';
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
const stage=process.env.BOUNCER_RESOURCE_AGENT_STAGE;
if(!['guard-probe','guard-control','configure','install'].includes(stage))throw new Error('fixed testnet resource-agent stage required');
const {owner,agent,anchor,envelope,bytes}=publicResourceAgentInputs(stage),digest=crypto.createHash('sha256').update(bytes).digest('hex');
const originalProbe=stage==='guard-control'?publicResourceAgentInputs('guard-probe').envelope:undefined;
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT,sha=process.env.GITHUB_SHA,
 artifact=process.env.BOUNCER_FENCE_ARTIFACT_ID,token=process.env.GITHUB_TOKEN;
if(!/^[1-9][0-9]{0,19}$/.test(run??'')||attempt!=='1'||!/^[a-f0-9]{40}$/.test(sha??'')||
 !/^[1-9][0-9]{0,19}$/.test(artifact??'')||typeof token!=='string'||token.length<20||
 process.env.GITHUB_REPOSITORY!=='Greatmujey/Bouncer'||process.env.GITHUB_REF!=='refs/heads/arena/25a7aaf6-near-hub'){
 throw new Error('resource-agent setup requires the first attempt of the intended branch workflow');
}
async function persistAttempt(record){
 if(record.stage!==stage||record.tx_hash!==envelope.tx_hash||record.owner!==owner.account_id||record.vault!==agent.vault||
   record.agent_public_key!==agent.public_key)return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32_768,
  prefix:`resource-agent-v2-${stage}-fence`});
}
try{
 const result=await broadcastTestnetResourceAgentOnce({ownerPlan:owner,agentPlan:agent,envelope,originalProbe,expectedCircleCodeHash:anchor.circle_code_hash,
  provider:new ExperimentalSvalinSetupRpc('https://rpc.testnet.near.org',{readTimeoutMs:12_000}),persistAttempt});
 console.log(JSON.stringify({...result,signed_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch(error){console.error(`Original resource-agent ${stage} stopped: ${error?.message??'unknown error'}`);process.exitCode=1}
