#!/usr/bin/env node
/** CI-only locally signed, original-hash-fenced fake-token swap. */
import fs from 'node:fs';import crypto from 'node:crypto';
import {ExperimentalSvalinSetupRpc} from '../agent/svalin-setup-rpc.mjs';
import {githubOriginalFence} from '../agent/github-original-fence.mjs';
import {verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {broadcastOutlayerAcquisitionOnce} from '../agent/outlayer-burn-acquisition.mjs';
const PARENT='82283b43a72c7026b1ad713b0d4c105a2b2125ee';
const read=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const ownerPlan=read('../config/testnet-owner-v2-plan.json'),plan=read('../config/testnet-outlayer-burn-v2-plan.json');
const original=read('../evidence/testnet-owner-v2/outlayer-burn-register-original.json');
const control=read('../evidence/testnet-owner-v2/outlayer-burn-register-control-original.json');
const registration=read('../evidence/testnet-owner-v2/outlayer-burn-register-after-control-original.json');
const wrap=read('../evidence/testnet-owner-v2/outlayer-burn-wrap-original.json');
const file=new URL('../evidence/testnet-owner-v2/outlayer-burn-swap-original.json',import.meta.url),stat=fs.lstatSync(file);
if(!stat.isFile()||stat.size<1||stat.size>16384)throw new Error('invalid swap bearer');
const bytes=fs.readFileSync(file);if(bytes.length!==stat.size)throw new Error('swap changed while reading');
const envelope=JSON.parse(bytes.toString('utf8'));verifySignedOutlayerBurnStage(envelope,plan,ownerPlan);
if(wrap.stage!=='wrap'||BigInt(wrap.nonce)!==BigInt(registration.nonce)+1n||envelope.stage!=='swap-fake'||
 envelope.nonce!==(BigInt(wrap.nonce)+1n).toString())throw new Error('swap is not consecutive');
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const {GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SHA:sha,BOUNCER_FENCE_ARTIFACT_ID:artifact,GITHUB_TOKEN:token,GITHUB_EVENT_PATH:eventPath}=process.env;
if(!/^[1-9][0-9]{0,15}$/.test(run??'')||attempt!=='1'||!/^[a-f0-9]{40}$/.test(sha??'')||
 !/^[1-9][0-9]{0,15}$/.test(artifact??'')||typeof token!=='string'||token.length<20||
 process.env.GITHUB_REPOSITORY!=='Greatmujey/Bouncer'||process.env.GITHUB_REF!=='refs/heads/arena/25a7aaf6-near-hub'||
 process.env.GITHUB_EVENT_NAME!=='push'||typeof eventPath!=='string')throw new Error('unexpected swap workflow identity');
const eventStat=fs.lstatSync(eventPath);if(!eventStat.isFile()||eventStat.size<1||eventStat.size>1000000)throw new Error('invalid push event');
const event=JSON.parse(fs.readFileSync(eventPath,'utf8'));
if(event.before!==PARENT||event.after!==sha||event.ref!==process.env.GITHUB_REF||!event.head_commit?.message?.includes('[outlayer-swap-once]')){
 throw new Error('unexpected parent push; no broadcast');
}
async function persistAttempt(r){
 if(r.stage!=='swap-fake'||r.tx_hash!==envelope.tx_hash||r.owner!==plan.owner||r.vault!==plan.vault)return false;
 return githubOriginalFence({artifactId:artifact,runId:run,headSha:sha,digest,token,maxArtifactBytes:32768,prefix:'outlayer-burn-swap-fence'});
}
const provider=new ExperimentalSvalinSetupRpc('https://test.rpc.fastnear.com',{readTimeoutMs:10000});
try{const result=await broadcastOutlayerAcquisitionOnce({plan,ownerPlan,original,control,registration,wrap,envelope,provider,persistAttempt});
 console.log(JSON.stringify({...result,original_envelope_sha256:digest,fence_artifact_id:artifact,run_id:run,commit:sha},null,2));
}catch{console.error(`Original swap ${envelope.tx_hash} is not safely confirmed; reconcile, never resend.`);process.exitCode=1}
