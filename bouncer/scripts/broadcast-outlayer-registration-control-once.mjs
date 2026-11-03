#!/usr/bin/env node
/** CI-only distinct zero-yocto control for the original registration. No key
 * enters CI. Do not retry either original hash if any result is uncertain. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ExperimentalSvalinSetupRpc} from '../agent/svalin-setup-rpc.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {broadcastOutlayerRegistrationControlOnce} from '../agent/outlayer-registration-control-runner.mjs';
const PARENT='196cac5fa8ba12b55279ba131ea5a99091fed701';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v2-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-burn-register-original.json',import.meta.url),'utf8'));
const file=new URL('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json',import.meta.url),stat=fs.lstatSync(file);
if(!stat.isFile()||stat.size<1||stat.size>16384)throw new Error('invalid registration control bearer');
const bytes=fs.readFileSync(file);if(bytes.length!==stat.size)throw new Error('control changed while reading');
const control=JSON.parse(bytes.toString('utf8'));verifySignedOutlayerRegistrationControl(control,original,plan,ownerPlan);
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha,BOUNCER_FENCE_ARTIFACT_ID:artifact,GITHUB_TOKEN:token,GITHUB_EVENT_PATH:eventPath}=process.env;
if(!/^[1-9][0-9]{0,15}$/.test(run??'')||attempt!=='1'||!/^[a-f0-9]{40}$/.test(sha??'')||
 !/^[1-9][0-9]{0,15}$/.test(artifact??'')||typeof token!=='string'||token.length<20||
 process.env.GITHUB_REPOSITORY!=='Greatmujey/Bouncer'||process.env.GITHUB_REF!=='refs/heads/arena/25a7aaf6-near-hub'||
 process.env.GITHUB_EVENT_NAME!=='push'||typeof eventPath!=='string')throw new Error('unexpected control workflow identity');
const eventStat=fs.lstatSync(eventPath);if(!eventStat.isFile()||eventStat.size<1||eventStat.size>1000000)throw new Error('invalid push event');
const event=JSON.parse(fs.readFileSync(eventPath,'utf8'));
if(event.before!==PARENT||event.after!==sha||event.ref!==process.env.GITHUB_REF||
 !event.head_commit?.message?.includes('[outlayer-registration-control-once]'))throw new Error('unexpected parent push; no broadcast');
async function persistAttempt(r){
 if(r.control_tx_hash!==control.tx_hash||r.original_tx_hash!==original.tx_hash||r.owner!==plan.owner||r.vault!==plan.vault)return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-burn-control-fence'});
}
const provider=new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com',{readTimeoutMs:10000});
try{
 const result=await broadcastOutlayerRegistrationControlOnce({plan,ownerPlan,original,control,provider,persistAttempt});
 console.log(JSON.stringify({...result,control_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch{
 console.error(`Original registration control ${control.tx_hash} not safely confirmed; reconcile both originals, never resend.`);process.exitCode=1;
}
