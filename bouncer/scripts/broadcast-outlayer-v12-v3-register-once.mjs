#!/usr/bin/env node
/** CI-only one-shot of the locally signed fake-token registration original.
 * Private testnet keys never enter GitHub. Never retry this original hash. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ExperimentalSvalinSetupRpc} from '../agent/svalin-setup-rpc.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {verifySignedOutlayerBurnStage} from '../agent/outlayer-v12-burn-signed.mjs';
import {broadcastOutlayerBurnRegistrationOnce} from '../agent/outlayer-v12-burn-registration.mjs';
const PARENT='1b83009b24acb514be1f1f41fd33056c3619ea38';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const file=new URL('../evidence/testnet-owner-v3/outlayer-v12-register-original.json',import.meta.url),stat=fs.lstatSync(file);
if(!stat.isFile()||stat.size<1||stat.size>16384)throw new Error('invalid original OutLayer registration bearer');
const bytes=fs.readFileSync(file);if(bytes.length!==stat.size)throw new Error('original registration changed while reading');
const envelope=JSON.parse(bytes.toString('utf8'));verifySignedOutlayerBurnStage(envelope,plan,ownerPlan);
if(envelope.stage!=='register-fake')throw new Error('unexpected OutLayer stage');
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha,BOUNCER_FENCE_ARTIFACT_ID:artifact,GITHUB_TOKEN:token,GITHUB_EVENT_PATH:eventPath}=process.env;
if(!/^[1-9][0-9]{0,15}$/.test(run??'')||attempt!=='1'||!/^[a-f0-9]{40}$/.test(sha??'')||
 !/^[1-9][0-9]{0,15}$/.test(artifact??'')||typeof token!=='string'||token.length<20||
 process.env.GITHUB_REPOSITORY!=='Greatmujey/Bouncer'||process.env.GITHUB_REF!=='refs/heads/arena/25a7aaf6-near-hub'||
 process.env.GITHUB_EVENT_NAME!=='push'||typeof eventPath!=='string')throw new Error('unexpected OutLayer registration workflow identity');
const eventStat=fs.lstatSync(eventPath);if(!eventStat.isFile()||eventStat.size<1||eventStat.size>1_000_000)throw new Error('invalid push event');
const event=JSON.parse(fs.readFileSync(eventPath,'utf8'));
if(event.before!==PARENT||event.after!==sha||event.ref!==process.env.GITHUB_REF||
 !event.head_commit?.message?.includes('[outlayer-v12-v3-register-once]'))throw new Error('unexpected parent push; no broadcast');
async function persistAttempt(record){
 if(record.stage!=='register-fake'||record.tx_hash!==envelope.tx_hash||record.owner!==plan.owner||record.vault!==plan.vault)return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-v12-v3-register-fence'});
}
const provider=new ExperimentalSvalinSetupRpc('https://rpc.testnet.near.org',{readTimeoutMs:10000});
try{
 const result=await broadcastOutlayerBurnRegistrationOnce({plan,ownerPlan,envelope,provider,persistAttempt});
 console.log(JSON.stringify({...result,signed_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch{
 console.error(`Original fake-token registration ${envelope.tx_hash} not safely confirmed; retain original and reconcile, never resend.`);
 process.exitCode=1;
}
