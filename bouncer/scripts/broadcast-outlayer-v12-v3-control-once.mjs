#!/usr/bin/env node
/** CI-only distinct zero-yocto control for the original registration. No key
 * enters CI. Do not retry either original hash if any result is uncertain. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {ExperimentalSvalinSetupRpc} from '../agent/svalin-setup-rpc.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {readBoundedJson} from '../shared/bounded-json.mjs';
import {verifySignedOutlayerRegistrationControl} from '../agent/outlayer-v12-registration-control.mjs';
import {broadcastOutlayerRegistrationControlOnce} from '../agent/outlayer-v12-registration-control-runner.mjs';
const PARENT='c436db6317e667c0776f81748a8a76fd1b725403';
const ownerPlan=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json',import.meta.url),'utf8'));
const plan=JSON.parse(fs.readFileSync(new URL('../config/testnet-outlayer-burn-v3-plan.json',import.meta.url),'utf8'));
const original=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v3/outlayer-v12-register-original.json',import.meta.url),'utf8'));
const file=new URL('../evidence/testnet-owner-v3/outlayer-v12-register-control-original.json',import.meta.url),stat=fs.lstatSync(file);
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
 !event.head_commit?.message?.includes('[outlayer-v12-v3-control-once]'))throw new Error('unexpected parent push; no broadcast');
async function verifyPreviousFence(){
 const response=await fetch('https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/13233629935',{
  headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','user-agent':'bouncer-v3-control'},
  redirect:'error',signal:AbortSignal.timeout(10_000)});
 try{
  if(!response.ok)return false;
  const a=await readBoundedJson(response,{maxBytes:65536,label:'original registration fence'}),run=a?.workflow_run;
  return a?.id===13233629935&&a.expired===false&&a.size_in_bytes>0&&a.size_in_bytes<32768&&
   a.name==='outlayer-v12-v3-register-fence-41644157538-7720fdbdbbc20f269e188a13a4b3b9810c90a9651915c83d0bf916de1a60ac1e'&&
   run?.id===41644157538&&run.head_sha==='c9584ee16cbc2e7e2619ba3feca5ca6dc2bd4a69'&&
   run.head_branch==='arena/25a7aaf6-near-hub'&&original.tx_hash==='9tsgJgUUqJsV9X8hpRABqPwcC7SZJ9uV64xc3bFoamPe';
 }finally{await response.body?.cancel().catch(()=>{})}
}
async function persistAttempt(r){
 if(r.control_tx_hash!==control.tx_hash||r.original_tx_hash!==original.tx_hash||r.owner!==plan.owner||r.vault!==plan.vault||!await verifyPreviousFence())return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-v12-v3-control-fence'});
}
const provider=new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com',{readTimeoutMs:10000});
try{
 const result=await broadcastOutlayerRegistrationControlOnce({plan,ownerPlan,original,control,provider,persistAttempt});
 console.log(JSON.stringify({...result,control_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch{
 console.error(`Original registration control ${control.tx_hash} not safely confirmed; reconcile both originals, never resend.`);process.exitCode=1;
}
