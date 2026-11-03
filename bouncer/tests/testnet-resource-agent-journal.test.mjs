import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {createTestnetOwnerKeyring,readTestnetOwnerKeyring} from '../agent/testnet-owner-local-keyring.mjs';
import {createTestnetResourceAgentKeyring} from '../agent/testnet-resource-agent-keyring.mjs';
import {signVaultCircle} from '../agent/keyless-vault-circle.mjs';
import {V11_NEAR_CODE_HASH} from '../agent/keyless-vault-bootstrap.mjs';
import {signAndJournalTestnetResourceAgent,recordFinalTestnetResourceAgentResult} from '../agent/testnet-resource-agent-journal.mjs';
const hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,8));
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
async function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-resource-journal-'));fs.chmodSync(root,0o700);
 const ownerDir=path.join(root,'owner'),agentDir=path.join(root,'agent'),workDir=path.join(root,'work'),evidenceDir=path.join(root,'public');
 fs.mkdirSync(workDir,{mode:0o700});fs.mkdirSync(evidenceDir,{mode:0o700});
 const owner=createTestnetOwnerKeyring(ownerDir).plan,agent=createTestnetResourceAgentKeyring({dir:agentDir,ownerPlan:owner}).plan;
 const key=readTestnetOwnerKeyring({dir:ownerDir,plan:owner}),now=Date.now();
 const snap={version:1,network:'testnet',owner:owner.account_id,public_key:owner.public_key,vault:agent.vault,
  circle_token:agent.token,circle_code_hash:hash,circle_storage_min_yocto:'1250000000000000000000',vault_code_hash:V11_NEAR_CODE_HASH,
  vault_key_count:0,owner_key_nonce:'42',block_hash:hash,block_timestamp_nanosec:(BigInt(now)*1000000n).toString(),
  owner_circle_atoms:'6907',vault_actual_circle_atoms:'0',vault_tracked_circle_atoms:'0',vault_circle_registration:'REGISTERED_AT_VIEW',
  signed:false,sent:false,seller_contacted:false,register_eligible:false,fund_eligible:true};
 const e=await signVaultCircle({plan:owner,snapshot:snap,kind:'fund',amountAtoms:'6907',keyPair:key,nowMs:now});
 const proof={status:'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL',owner:owner.account_id,vault:agent.vault,tx_hash:e.tx_hash,
  receipt:{tx_hash:e.tx_hash,root_receipt_id:hash,funding:{amount_atoms:'6907',vault_hook_receipt:hash,token_resolver_receipt:hash,
   transfer_event_verified:true,full_amount_accepted:true}},state:{owner:owner.account_id,vault:agent.vault,circle_token:agent.token,
  owner_circle_atoms:'0',vault_code_hash:V11_NEAR_CODE_HASH,vault_key_count:0,vault_actual_circle_atoms:'6907',
  vault_tracked_circle_atoms:'6907',circle_code_hash:hash},
  circle_funding_verified:true,do_not_resend:true};
 save(path.join(ownerDir,'vault-circle-fund-journal.json'),{version:1,status:'ORIGINAL_FINAL_VERIFIED',envelope:e,final_verification:proof});
 const ready={...snap,agent_public_key:agent.public_key,owner_circle_atoms:'0',vault_actual_circle_atoms:'6907',vault_tracked_circle_atoms:'6907',
  policy:null,agent_granted:false,guard_probe_eligible:true,configure_eligible:true,install_eligible:false};
 const args=stage=>({ownerPlan:owner,agentPlan:agent,ownerDir,agentDir,workDir,evidenceDir,stage,nowMs:now});
 return {root,owner,agent,ownerDir,agentDir,workDir,evidenceDir,ready,args,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function markFinal(f,stage){
 const file=path.join(f.workDir,`${stage}-journal.json`),j=JSON.parse(fs.readFileSync(file));
 const result={stage,network:'testnet',owner:f.owner.account_id,vault:f.agent.vault,agent_public_key:f.agent.public_key,tx_hash:j.envelope.tx_hash,
  status:stage==='guard-probe'?'ONE_YOCTO_GUARD_REJECTED_AT_FINAL':stage==='guard-control'?
   'GUARD_CONTROL_REJECTED_AND_ORIGINAL_NONCE_SUPERSEDED_AT_FINAL':'RESOURCE_POLICY_CONFIGURED_AT_FINAL',
  receipt:{tx_hash:j.envelope.tx_hash,root_receipt_id:hash,guard_failure_verified:['guard-probe','guard-control'].includes(stage)},
  state:{owner:f.owner.account_id,vault:f.agent.vault,owner_key_nonce:j.envelope.nonce,vault_key_count:0,
   vault_actual_circle_atoms:'6907',vault_tracked_circle_atoms:'6907',circle_code_hash:hash,policy:null,
   guard_probe_eligible:stage==='guard-probe',guard_control_eligible:stage==='guard-control',guard_control_policy:null,
   install_eligible:stage==='configure',agent_granted:stage==='configure'},
  ...(stage==='guard-control'?{superseded_original_probe_hash:j.envelope.supersedes_probe_hash,
   original_probe_receipt_status:'UNKNOWN_UNLESS_SEPARATELY_VERIFIED'}:{}),seller_contacted:false,do_not_resend:true};
 const args={ownerPlan:f.owner,agentPlan:f.agent,ownerDir:f.ownerDir,workDir:f.workDir,stage,result};
 assert.equal(recordFinalTestnetResourceAgentResult(args).journal_status,'ORIGINAL_FINAL_VERIFIED');
 assert.equal(recordFinalTestnetResourceAgentResult(args).idempotent,true);
 assert.throws(()=>recordFinalTestnetResourceAgentResult({...args,result:{...result,tx_hash:hash}}));
 return JSON.parse(fs.readFileSync(file));
}

test('journals exact original before export, forbids re-signing and requires each verified predecessor',async()=>{
 const f=await fixture();try{
  save(path.join(f.workDir,'guard-probe-snapshot.json'),f.ready);
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('configure')));
  const guard=await signAndJournalTestnetResourceAgent(f.args('guard-probe'));
  const journal=path.join(f.workDir,'guard-probe-journal.json'),published=path.join(f.evidenceDir,'resource-agent-guard-probe-original.json');
  const j=JSON.parse(fs.readFileSync(journal));assert.equal(j.envelope.tx_hash,guard.tx_hash);
  assert.equal(j.status,'ORIGINAL_SIGNED_NOT_CONFIRMED');assert.equal(fs.statSync(journal).mode&0o777,0o600);
  assert.ok(fs.existsSync(published));assert.ok(!fs.readFileSync(published,'utf8').includes('private_key'));
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('guard-probe')),/never sign a replacement/);
  const contents=fs.readFileSync(published,'utf8');fs.unlinkSync(published);
  assert.equal((await signAndJournalTestnetResourceAgent({...f.args('guard-probe'),restore:true})).tx_hash,guard.tx_hash);
  assert.equal(fs.readFileSync(published,'utf8'),contents);
  markFinal(f,'guard-probe');
  save(path.join(f.workDir,'configure-snapshot.json'),{...f.ready,owner_key_nonce:'43'});
  const policy=await signAndJournalTestnetResourceAgent(f.args('configure'));assert.equal(policy.nonce,'44');
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('install')));
  markFinal(f,'configure');
  save(path.join(f.workDir,'install-snapshot.json'),{...f.ready,owner_key_nonce:'44',
   policy:{token:f.agent.token,per_tx_cap:'3000',daily_cap:'6907'},agent_granted:true,install_eligible:true});
  const installed=await signAndJournalTestnetResourceAgent(f.args('install'));assert.equal(installed.nonce,'45');
  assert.equal(installed.private_key_exported,false);assert.equal(installed.do_not_blindly_resend,true);
 }finally{f.cleanup()}
});

test('a distinct verified nonce-fence control preserves the unresolved original before configuration',async()=>{
 const f=await fixture();try{
  save(path.join(f.workDir,'guard-probe-snapshot.json'),f.ready);
  const original=await signAndJournalTestnetResourceAgent(f.args('guard-probe'));
  const originalFile=path.join(f.workDir,'guard-probe-journal.json'),originalBytes=fs.readFileSync(originalFile,'utf8');
  save(path.join(f.workDir,'guard-control-snapshot.json'),{...f.ready,guard_control_policy:null,guard_control_eligible:true});
  const control=await signAndJournalTestnetResourceAgent(f.args('guard-control'));
  assert.equal(BigInt(control.nonce),BigInt(original.nonce)+1n);
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('configure')));
  markFinal(f,'guard-control');
  assert.equal(fs.readFileSync(originalFile,'utf8'),originalBytes,'the earlier original must remain unchanged');
  save(path.join(f.workDir,'configure-snapshot.json'),{...f.ready,owner_key_nonce:control.nonce});
  const configured=await signAndJournalTestnetResourceAgent(f.args('configure'));
  assert.equal(BigInt(configured.nonce),BigInt(control.nonce)+1n);
  assert.equal(JSON.parse(originalBytes).status,'ORIGINAL_SIGNED_NOT_CONFIRMED');
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('guard-control')),/never sign a replacement/);
 }finally{f.cleanup()}
});

test('rejects tampered funding, missing copies, exposed directory and unverified predecessor',async()=>{
 const f=await fixture();try{
  save(path.join(f.workDir,'guard-probe-snapshot.json'),f.ready);
  const file=path.join(f.ownerDir,'vault-circle-fund-journal.json'),fund=JSON.parse(fs.readFileSync(file));
  const altered=structuredClone(fund);altered.final_verification.state.vault_tracked_circle_atoms='1';save(file,altered);
  await assert.rejects(signAndJournalTestnetResourceAgent(f.args('guard-probe')),/funding is not verified/);save(file,fund);
  fs.chmodSync(f.workDir,0o755);await assert.rejects(signAndJournalTestnetResourceAgent(f.args('guard-probe')),/not private/);fs.chmodSync(f.workDir,0o700);
  fs.unlinkSync(path.join(f.agentDir,'backup.enc.json'));await assert.rejects(signAndJournalTestnetResourceAgent(f.args('guard-probe')));
  assert.equal(fs.existsSync(path.join(f.workDir,'guard-probe-journal.json')),false);
 }finally{f.cleanup()}
});
