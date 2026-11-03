/** LOCAL-ONLY testnet resource-agent setup journal. Exact signed bytes are
 * durably fsynced BEFORE export. Existing or ambiguous originals are NEVER
 * replaced. No network access, seller contact or private-key export. */
import fs from 'node:fs';
import path from 'node:path';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan, readTestnetResourceAgentKeyring } from './testnet-resource-agent-keyring.mjs';
import { readTestnetOwnerKeyring } from './testnet-owner-local-keyring.mjs';
import { signTestnetResourceAgentSetup, verifySignedTestnetResourceAgentSetup,
 verifyGuardControlParent } from './testnet-resource-agent-setup.mjs';
import { readBoundedPrivate, syncWrite } from './circle-owner-offline-journal.mjs';
import { verifyTestnetResourceAgentFundingAnchor } from './testnet-resource-agent-funding-anchor.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
const stages=['guard-probe','guard-control','configure','install'];
function privateDir(dir){
 const s=fs.lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||
  (typeof process.getuid==='function'&&s.uid!==process.getuid()))throw new Error('resource-agent journal directory is not private');
}
function funding(owner,ownerDir){
 const j=readBoundedPrivate(path.join(ownerDir,'vault-circle-fund-journal.json'),100_000);
 if(j?.version!==1||j.status!=='ORIGINAL_FINAL_VERIFIED')throw new Error('original Circle vault funding is not verified');
 return verifyTestnetResourceAgentFundingAnchor({ownerPlan:owner,envelope:j.envelope,proof:j.final_verification}).circle_code_hash;
}

function validateFinal(j,r,stage,owner,agent,circleHash){
 const e=j?.envelope;
 verifySignedTestnetResourceAgentSetup(e,owner,agent);
 const expected=stage==='guard-probe'?'ONE_YOCTO_GUARD_REJECTED_AT_FINAL':
  stage==='guard-control'?'GUARD_CONTROL_REJECTED_AND_ORIGINAL_NONCE_SUPERSEDED_AT_FINAL':
  stage==='configure'?'RESOURCE_POLICY_CONFIGURED_AT_FINAL':'RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL';
 const nonce=pinnedAccessKeyNonce(r?.state?.owner_key_nonce);
 if(j?.version!==1||e.stage!==stage||r?.status!==expected||r.stage!==stage||r.network!=='testnet'||
  r.owner!==owner.account_id||r.vault!==agent.vault||r.agent_public_key!==agent.public_key||r.tx_hash!==e.tx_hash||
  r.receipt?.tx_hash!==e.tx_hash||!isTransactionHash(r.receipt?.root_receipt_id)||r.state?.circle_code_hash!==circleHash||
  r.state?.owner!==owner.account_id||r.state?.vault!==agent.vault||r.state?.vault_key_count!==0||nonce===null||nonce<BigInt(e.nonce)||
  r.state?.vault_actual_circle_atoms!=='6907'||r.state?.vault_tracked_circle_atoms!=='6907'||r.seller_contacted!==false||r.do_not_resend!==true||
  (stage==='guard-probe'&&!(r.receipt.guard_failure_verified===true&&r.state.guard_probe_eligible===true&&r.state.agent_granted===false))||
  (stage==='guard-control'&&!(r.receipt.guard_failure_verified===true&&r.state.guard_control_eligible===true&&
   r.state.guard_control_policy===null&&r.state.policy===null&&r.state.agent_granted===false&&
   r.superseded_original_probe_hash===e.supersedes_probe_hash&&r.original_probe_receipt_status==='UNKNOWN_UNLESS_SEPARATELY_VERIFIED'))||
  (stage==='configure'&&!(r.receipt.guard_failure_verified===false&&r.state.install_eligible===true&&r.state.agent_granted===true))||
  (stage==='install'&&!(r.receipt.guard_failure_verified===false&&r.state.status==='RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL'&&
   r.state.owner_key_count===2&&r.state.agent_granted===true&&r.state.daily_spent_atoms==='0'&&
   JSON.stringify(r.state.agent_methods)===JSON.stringify(agent.methods))))throw new Error(`original ${stage} has not been verified`);
 return true;
}
function previous(workDir,stage,owner,agent,circleHash){
 const j=readBoundedPrivate(path.join(workDir,`${stage}-journal.json`),100_000);
 if(j?.status!=='ORIGINAL_FINAL_VERIFIED')throw new Error(`original ${stage} has not been verified`);
 validateFinal(j,j.final_verification,stage,owner,agent,circleHash);
 return j;
}
function originalProbe(workDir,owner,agent){
 const j=readBoundedPrivate(path.join(workDir,'guard-probe-journal.json'),100_000);
 if(j?.version!==1||!['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(j.status)||
   j.envelope?.stage!=='guard-probe')throw new Error('original guard probe is not journaled');
 verifySignedTestnetResourceAgentSetup(j.envelope,owner,agent);
 return j;
}
// A distinct zero-yocto control can establish the guard while consuming a
// higher owner-key nonce. It does not assert that the earlier original failed
// or was absent. The earlier bearer and journal remain untouched forever.
function previousGuard(workDir,owner,agent,circleHash){
 const original=originalProbe(workDir,owner,agent);
 if(original.status==='ORIGINAL_FINAL_VERIFIED')return previous(workDir,'guard-probe',owner,agent,circleHash);
 const control=previous(workDir,'guard-control',owner,agent,circleHash);
 verifyGuardControlParent(control.envelope,original.envelope,owner,agent);
 return control;
}

function publish(e,owner,agent,evidenceDir){
 verifySignedTestnetResourceAgentSetup(e,owner,agent);
 const file=path.join(evidenceDir,`resource-agent-${e.stage}-original.json`),data=JSON.stringify(e,null,2)+'\n';
 try{syncWrite(file,data,'wx',0o644)}catch(error){
  if(error?.code!=='EEXIST')throw error;
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||fs.readFileSync(file,'utf8')!==data)throw error;
 }
 return {stage:e.stage,tx_hash:e.tx_hash,owner:e.owner,vault:e.vault,agent_public_key:e.agent_public_key,
  nonce:e.nonce,original_envelope_exported:true,signed_tx_is_public_bearer:true,private_key_exported:false,do_not_blindly_resend:true};
}
export async function signAndJournalTestnetResourceAgent({ownerPlan,agentPlan,ownerDir,agentDir,workDir,evidenceDir,stage,restore=false,nowMs=Date.now()}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),agent=validateTestnetResourceAgentPlan(agentPlan,owner);
 if(!stages.includes(stage)||typeof restore!=='boolean'||![ownerDir,agentDir,workDir,evidenceDir].every(x=>typeof x==='string'&&path.isAbsolute(x))||
  new Set([ownerDir,agentDir,workDir,evidenceDir].map(x=>path.resolve(x))).size!==4)throw new Error('distinct absolute resource-agent journal paths required');
 privateDir(ownerDir);privateDir(agentDir);privateDir(workDir);
 const journal=path.join(workDir,`${stage}-journal.json`),lock=path.join(workDir,`${stage}.lock`);
 fs.mkdirSync(lock,{mode:0o700});
 try{
  if(restore){
   const existing=readBoundedPrivate(journal,100_000);
   if(existing?.version!==1||!['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(existing.status)||existing.envelope?.stage!==stage){
    throw new Error('invalid original resource-agent journal');
   }
   return publish(existing.envelope,owner,agent,evidenceDir);
  }
  if(fs.existsSync(journal))throw new Error('resource-agent original already journaled; inspect it, never sign a replacement');
  const circleHash=funding(owner,ownerDir);
  let parent;
  if(stage==='guard-control'){
   const original=originalProbe(workDir,owner,agent);
   if(original.status!=='ORIGINAL_SIGNED_NOT_CONFIRMED')throw new Error('guard control is only for an unresolved original probe');
   parent=original.envelope;
  }
  if(stage==='configure'||stage==='install')previousGuard(workDir,owner,agent,circleHash);
  if(stage==='install')previous(workDir,'configure',owner,agent,circleHash);
  const agentKey=readTestnetResourceAgentKeyring({dir:agentDir,plan:agent,ownerPlan:owner});
  const ownerKey=readTestnetOwnerKeyring({dir:ownerDir,plan:owner});
  if(String(agentKey.getPublicKey())!==agent.public_key||String(ownerKey.getPublicKey())!==owner.public_key)throw new Error('local keys differ from reviewed setup');
  const snapshot=readBoundedPrivate(path.join(workDir,`${stage}-snapshot.json`));
  if(snapshot.circle_code_hash!==circleHash)throw new Error('fresh token code differs from verified funding');
  const envelope=await signTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,snapshot,stage,keyPair:ownerKey,
   ...(parent?{originalProbe:parent}:{}),nowMs});
  verifySignedTestnetResourceAgentSetup(envelope,owner,agent);
  if(parent)verifyGuardControlParent(envelope,parent,owner,agent);
  syncWrite(journal,JSON.stringify({version:1,status:'ORIGINAL_SIGNED_NOT_CONFIRMED',created_at:new Date().toISOString(),envelope},null,2)+'\n','wx',0o600);
  return publish(envelope,owner,agent,evidenceDir);
 }finally{fs.rmdirSync(lock)}
}

/** Persist a verified original result atomically. Call only with the trusted
 * read-only reconciliation or the matching one-shot result; this routine
 * does not query the chain and cannot establish RPC honesty by itself. */
export function recordFinalTestnetResourceAgentResult({ownerPlan,agentPlan,ownerDir,workDir,stage,result}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),agent=validateTestnetResourceAgentPlan(agentPlan,owner);
 if(!stages.includes(stage)||![ownerDir,workDir].every(x=>typeof x==='string'&&path.isAbsolute(x))||path.resolve(ownerDir)===path.resolve(workDir)){
  throw new Error('distinct private result paths required');
 }
 privateDir(ownerDir);privateDir(workDir);
 const lock=path.join(workDir,`${stage}.lock`),file=path.join(workDir,`${stage}-journal.json`);
 fs.mkdirSync(lock,{mode:0o700});
 try{
  const j=readBoundedPrivate(file,100_000),circleHash=funding(owner,ownerDir);
  if(!['ORIGINAL_SIGNED_NOT_CONFIRMED','ORIGINAL_FINAL_VERIFIED'].includes(j?.status))throw new Error('invalid original resource-agent journal');
  if(stage==='guard-control')verifyGuardControlParent(j.envelope,originalProbe(workDir,owner,agent).envelope,owner,agent);
  validateFinal(j,result,stage,owner,agent,circleHash);
  if(j.status==='ORIGINAL_FINAL_VERIFIED'){
   if(JSON.stringify(j.final_verification)!==JSON.stringify(result))throw new Error('existing final verification differs');
   return {stage,tx_hash:j.envelope.tx_hash,journal_status:j.status,idempotent:true,do_not_resend:true};
  }
  const next={...j,status:'ORIGINAL_FINAL_VERIFIED',final_verification:result},temp=file+'.new';
  syncWrite(temp,JSON.stringify(next,null,2)+'\n','wx',0o600);fs.renameSync(temp,file);
  const fd=fs.openSync(workDir,fs.constants.O_RDONLY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)};
  return {stage,tx_hash:j.envelope.tx_hash,journal_status:next.status,idempotent:false,do_not_resend:true};
 }finally{fs.rmdirSync(lock)}
}
