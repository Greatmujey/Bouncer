import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createTestnetOwnerKeyring, readTestnetOwnerKeyring } from '../agent/testnet-owner-local-keyring.mjs';
import { createOutlayerBurnPlan } from '../agent/outlayer-v12-burn-plan.mjs';
import { signOutlayerBurnStage } from '../agent/outlayer-v12-burn-signed.mjs';
import { signAndJournalV12RegistrationControl } from '../agent/outlayer-v12-registration-control-journal.mjs';
const now = Date.parse('2026-11-03T14:00:00Z'), hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const write = (file,value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v12-control-')); fs.chmodSync(root,0o700);
  const paths = Object.fromEntries(['ownerKeyring','originalJournal','snapshot','journal','evidence','lock'].map(n => [n,path.join(root,n)]));
  const owner = createTestnetOwnerKeyring(paths.ownerKeyring).plan, keyPair = readTestnetOwnerKeyring({ dir:paths.ownerKeyring, plan:owner });
  const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const plan = createOutlayerBurnPlan({ ownerPlan:owner, fundingPublicKey:key(), projectPublicKey:key() });
  const snapshot = { version:1,stage:'register-fake',network:'testnet',owner:owner.account_id,vault:plan.vault,
    block_hash:hash(3),block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:owner.public_key,
    signer_key_nonce:'123',eligible:true,blockers:[],control_policy:null,control_eligible:true,signed:false,sent:false,
    seller_contacted:false,independent_fulfillment_verified:false };
  const original = await signOutlayerBurnStage({ ownerPlan:owner,plan,stage:'register-fake',snapshot,keyPair,nowMs:now });
  write(paths.originalJournal,{version:1,status:'ORIGINAL_SIGNED_NOT_CONFIRMED',envelope:original});write(paths.snapshot,snapshot);
  return {root,paths,owner,plan,original,snapshot,keyPair,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const sign = f => signAndJournalV12RegistrationControl({ownerPlan:f.owner,plan:f.plan,original:f.original,paths:f.paths,nowMs:now});
test('a distinct control is journaled before export and cannot be replaced', async () => {
 const f=await fixture();try{
  const result=await sign(f),journal=JSON.parse(fs.readFileSync(f.paths.journal)),out=JSON.parse(fs.readFileSync(f.paths.evidence));
  assert.equal(result.original_tx_hash,f.original.tx_hash);assert.equal(result.control_tx_hash,out.tx_hash);
  assert.equal(result.original_history_proven,false);assert.equal(result.do_not_resend_original,true);
  assert.equal(out.nonce,'125');assert.equal(out.original_nonce,'124');assert.deepEqual(out,journal.envelope);
  assert.equal(fs.statSync(f.paths.journal).mode&0o777,0o600);assert.ok(!JSON.stringify(out).includes(f.keyPair.toString()));
  await assert.rejects(sign(f),/already journaled/);fs.unlinkSync(f.paths.evidence);
  const restored=await signAndJournalV12RegistrationControl({ownerPlan:f.owner,plan:f.plan,original:f.original,paths:f.paths,restore:true});
  assert.equal(restored.control_tx_hash,result.control_tx_hash);assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)),out);
 }finally{f.cleanup()}
});
test('changed original, stale snapshot or exposed owner material prevent signing', async () => {
 for(const mutate of [
  f=>write(f.paths.originalJournal,{version:1,status:'ORIGINAL_FINAL_VERIFIED',envelope:f.original}),
  f=>write(f.paths.originalJournal,{version:1,status:'ORIGINAL_SIGNED_NOT_CONFIRMED',envelope:{...f.original,nonce:'1'}}),
  f=>write(f.paths.snapshot,{...f.snapshot,signer_key_nonce:'124'}),
  f=>fs.chmodSync(path.join(f.paths.ownerKeyring,'master.key'),0o644),
 ]){const f=await fixture();try{mutate(f);await assert.rejects(sign(f));assert.equal(fs.existsSync(f.paths.journal),false);assert.equal(fs.existsSync(f.paths.evidence),false)}finally{f.cleanup()}}
 const f=await fixture();try{await assert.rejects(signAndJournalV12RegistrationControl({ownerPlan:f.owner,plan:f.plan,original:f.original,paths:f.paths,nowMs:now+180000}));assert.equal(fs.existsSync(f.paths.journal),false)}finally{f.cleanup()}
});
