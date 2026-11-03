#!/usr/bin/env node
/** CI-only distinct registration after verifying the original nonce fence.
 * Never retry any original; no private testnet key enters GitHub. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ExperimentalSvalinSetupRpc} from '../agent/svalin-setup-rpc.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {broadcastPostControlRegistrationOnce} from '../agent/outlayer-registration-after-control.mjs';
const PARENT='6227d3e87b692a024e0e59182dcdb955443a81e5';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
const control=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json',import.meta.url),'utf8'));
verifySignedOutlayerRegistrationControl(control,original,plan,ownerPlan);
const file=new URL('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json',import.meta.url),stat=fs.lstatSync(file);
if(!stat.isFile()||stat.size<1||stat.size>16384)throw new Error('invalid new registration bearer');
const bytes=fs.readFileSync(file);if(bytes.length!==stat.size)throw new Error('new registration changed while reading');
const envelope=JSON.parse(bytes.toString('utf8'));verifySignedOutlayerBurnStage(envelope,plan,ownerPlan);
if(envelope.stage!=='register-fake'||envelope.nonce!==(BigInt(control.nonce)+1n).toString())throw new Error('new registration does not follow the old control');
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha,BOUNCER_FENCE_ARTIFACT_ID:artifact,GITHUB_TOKEN:token,GITHUB_EVENT_PATH:eventPath}=process.env;
if(!/^[1-9][0-9]{0,15}$/.test(run??'')||attempt!=='1'||!/^[a-f0-9]{40}$/.test(sha??'')||
 !/^[1-9][0-9]{0,15}$/.test(artifact??'')||typeof token!=='string'||token.length<20||
 process.env.GITHUB_REPOSITORY!=='Greatmujey/Bouncer'||process.env.GITHUB_REF!=='refs/heads/arena/25a7aaf6-near-hub'||
 process.env.GITHUB_EVENT_NAME!=='push'||typeof eventPath!=='string')throw new Error('unexpected new registration workflow identity');
const eventStat=fs.lstatSync(eventPath);if(!eventStat.isFile()||eventStat.size<1||eventStat.size>1000000)throw new Error('invalid push event');
const event=JSON.parse(fs.readFileSync(eventPath,'utf8'));
if(event.before!==PARENT||event.after!==sha||event.ref!==process.env.GITHUB_REF||
 !event.head_commit?.message?.includes('[outlayer-after-control-once]'))throw new Error('unexpected parent push; no broadcast');
async function persistAttempt(r){
 if(r.stage!=='register-fake'||r.tx_hash!==envelope.tx_hash||r.owner!==plan.owner||r.vault!==plan.vault)return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-burn-register-after-control-fence'});
}
const provider=new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com',{readTimeoutMs:10000});
try{
 const result=await broadcastPostControlRegistrationOnce({plan,ownerPlan,original,control,envelope,provider,persistAttempt});
 console.log(JSON.stringify({...result,original_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch{
 console.error(`New registration ${envelope.tx_hash} not safely confirmed; retain and reconcile all originals, never resend.`);process.exitCode=1;
}
