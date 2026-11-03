import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createTestnetOwnerKeyring, readTestnetOwnerKeyring } from '../agent/testnet-owner-local-keyring.mjs';
import { createOutlayerBurnKeyring } from '../agent/outlayer-v12-burn-keyring.mjs';
import { signVaultCircle } from '../agent/keyless-vault-v12-circle.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { signAndJournalOutlayerV12Registration, recordFinalOutlayerV12Registration } from '../agent/outlayer-v12-burn-register-journal.mjs';

const now = Date.parse('2026-11-03T13:00:00Z');
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const write = (file,value) => fs.writeFileSync(file, JSON.stringify(value), {mode:0o600});
async function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v12-ol-journal-'));fs.chmodSync(root,0o700);
 const paths=Object.fromEntries(['ownerKeyring','agentKeyring','circleFundJournal','snapshot','journal','evidence','lock'].map(n=>[n,path.join(root,n)]));
 const owner=createTestnetOwnerKeyring(paths.ownerKeyring).plan;
 const plan=createOutlayerBurnKeyring({dir:paths.agentKeyring,ownerPlan:owner}).plan;
 const keyPair=readTestnetOwnerKeyring({dir:paths.ownerKeyring,plan:owner});
 const common={block_hash:hash(3),block_timestamp_nanosec:String(BigInt(now)*1_000_000n)};
 const circleSnapshot={...common,version:1,network:'testnet',owner:owner.account_id,public_key:owner.public_key,vault:plan.vault,
  owner_key_nonce:'122',circle_token:CIRCLE,circle_code_hash:CIRCLE_TESTNET_CODE_HASH,circle_storage_min_yocto:'1250000000000000000000',
  vault_code_hash:plan.vault_code_hash,vault_key_count:0,vault_circle_registration:'REGISTERED_AT_VIEW',
  owner_circle_atoms:'6898',vault_actual_circle_atoms:'0',vault_tracked_circle_atoms:'0',fund_eligible:true,
  signed:false,sent:false,seller_contacted:false};
 const fund=await signVaultCircle({plan:owner,snapshot:circleSnapshot,kind:'fund',amountAtoms:'6898',keyPair,nowMs:now});
 const final={status:'VAULT_FUNDED_CIRCLE_TEST_USDC_AT_FINAL',kind:'fund',network:'testnet',owner:owner.account_id,vault:plan.vault,
  tx_hash:fund.tx_hash,receipt:{tx_hash:fund.tx_hash,trusted_rpc_not_consensus_proof:true,
   funding:{amount_atoms:'6898',transfer_event_verified:true,full_amount_accepted:true}},
  state:{owner_circle_atoms:'0',vault_actual_circle_atoms:'6898',vault_tracked_circle_atoms:'6898',vault_key_count:0,vault_code_hash:plan.vault_code_hash},
  circle_funding_verified:true,seller_contacted:false,do_not_resend:true};
 write(paths.circleFundJournal,{version:1,status:'ORIGINAL_FINAL_VERIFIED',envelope:fund,final_verification:final});
 const snapshot={...common,version:1,stage:'register-fake',network:'testnet',owner:owner.account_id,vault:plan.vault,
  signer_public_key:owner.public_key,signer_key_nonce:fund.nonce,eligible:true,blockers:[],signed:false,sent:false,
  seller_contacted:false,independent_fulfillment_verified:false};
 write(paths.snapshot,snapshot);
 return {root,paths,owner,plan,keyPair,fund,snapshot,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const sign=f=>signAndJournalOutlayerV12Registration({ownerPlan:f.owner,plan:f.plan,paths:f.paths,nowMs:now});
function resultFor(f){
 const e=JSON.parse(fs.readFileSync(f.paths.evidence)), bytes=fs.readFileSync(f.paths.evidence);
 return {status:'OUTLAYER_FAKE_TOKEN_REGISTRATIONS_FINAL',network:'testnet',tx_hash:e.tx_hash,
  receipt:{tx_hash:e.tx_hash,root_receipt_id:hash(4),linked_successful_outcomes:1,registered_accounts:[f.owner.account_id,f.plan.vault],
   asset:'usdc.fakes.testnet',trusted_rpc_not_consensus_proof:true},
  next_stage:{...f.snapshot,stage:'wrap',signer_key_nonce:e.nonce},reconciliation_only:false,sent:true,
  seller_contacted:false,provider_paid:false,independent_fulfillment_verified:false,do_not_resend:true,
  signed_envelope_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),run_id:'123',fence_artifact_id:'456',commit:'a'.repeat(40)};
}

test('original is fsynced before export, cannot be replaced, and restores only identical bytes',async()=>{
 const f=await fixture();try{
  const x=await sign(f),e=JSON.parse(fs.readFileSync(f.paths.evidence)),j=JSON.parse(fs.readFileSync(f.paths.journal));
  assert.equal(x.tx_hash,j.envelope.tx_hash);assert.deepEqual(e,j.envelope);assert.equal(x.seller_contacted,false);
  assert.equal(fs.statSync(f.paths.journal).mode&0o777,0o600);assert.ok(!JSON.stringify(e).includes(f.keyPair.toString()));
  await assert.rejects(sign(f),/already journaled/);fs.unlinkSync(f.paths.evidence);
  const restored=await signAndJournalOutlayerV12Registration({ownerPlan:f.owner,plan:f.plan,paths:f.paths,restore:true});
  assert.equal(restored.tx_hash,e.tx_hash);assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)),e);
 }finally{f.cleanup()}
});

test('missing Circle funding, changed nonce or exposed keyring refuses any signature',async()=>{
 for(const mutate of [
  f=>write(f.paths.circleFundJournal,{}),
  f=>{const j=JSON.parse(fs.readFileSync(f.paths.circleFundJournal));j.final_verification.receipt.funding.full_amount_accepted=false;write(f.paths.circleFundJournal,j)},
  f=>{const s={...f.snapshot,signer_key_nonce:'124'};write(f.paths.snapshot,s)},
  f=>fs.chmodSync(path.join(f.paths.agentKeyring,'master.key'),0o644),
  f=>fs.chmodSync(path.join(f.paths.ownerKeyring,'master.key'),0o644),
 ]){const f=await fixture();try{mutate(f);await assert.rejects(sign(f));assert.equal(fs.existsSync(f.paths.journal),false);assert.equal(fs.existsSync(f.paths.evidence),false)}finally{f.cleanup()}}
 const stale=await fixture();try{await assert.rejects(signAndJournalOutlayerV12Registration({ownerPlan:stale.owner,plan:stale.plan,paths:stale.paths,nowMs:now+180_000}));assert.equal(fs.existsSync(stale.paths.journal),false)}finally{stale.cleanup()}
});

test('only matching FINAL result and fence references can be recorded, once',async()=>{
 const f=await fixture();try{
  await sign(f);const result=resultFor(f),args={ownerPlan:f.owner,plan:f.plan,paths:f.paths};
  for(const mutate of [
   r=>{r.receipt.asset=CIRCLE},r=>{r.receipt.registered_accounts.reverse()},r=>{r.receipt.trusted_rpc_not_consensus_proof=false},
   r=>{r.next_stage.signer_key_nonce='125'},r=>{r.next_stage.eligible=false},r=>{r.seller_contacted=true},
   r=>{r.provider_paid=true},r=>{r.do_not_resend=false},r=>{r.signed_envelope_sha256='0'.repeat(64)},
   r=>{r.fence_artifact_id=''},r=>{r.commit='not-a-sha'}
  ]){const changed=structuredClone(result);mutate(changed);assert.throws(()=>recordFinalOutlayerV12Registration({...args,result:changed}))}
  assert.equal(recordFinalOutlayerV12Registration({...args,result}).journal_status,'ORIGINAL_FINAL_VERIFIED');
  assert.equal(recordFinalOutlayerV12Registration({...args,result}).already_recorded,true);
  assert.throws(()=>recordFinalOutlayerV12Registration({...args,result:{...result,commit:'b'.repeat(40)}}));
 }finally{f.cleanup()}
});
