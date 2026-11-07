import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWalletPromptWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWitnessedWalletSetup } from '../agent/witnessed-wallet-setup.mjs';
import { createWitnessedNativeOracleSetup } from '../agent/witnessed-native-oracle-wallet-setup.mjs';

const branch = 'arena/0e4386ea-near-hub';
const git = (cwd, args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const nativeStages = ['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent'];
const ftStages = ['create_keyless_vault','register_vault_circle','fund_vault_circle'];
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const identity = (owner, stages) => ({ owner, owner_public_key: key(), operation_id: crypto.randomBytes(16).toString('hex'),
  review_sha256: 'b'.repeat(64), stages: stages.map((stage_id,i) => ({ stage_id, action_commitment_sha256: String(i+1).repeat(64) })) });
const review = id => ({ owner:id.owner, review_sha256:id.review_sha256,
  stages:id.stages.map(s=>({id:s.stage_id,action_commitment_sha256:s.action_commitment_sha256})) });
function fences(n, f, barrier = async () => {}) {
  const counts = {native:0,ft:0,nativeClaims:0,ftClaims:0};
  const claim = (id,stageId) => ({ owner:id.owner,operation_id:id.operation_id,review_sha256:id.review_sha256,stage_id:stageId,
    action_commitment_sha256:id.stages.find(s=>s.stage_id===stageId).action_commitment_sha256,status:'PROMPT_CLAIMED_NO_HASH',
    do_not_retry:true,execution_authorized:false,preflight_checked_at:new Date().toISOString() });
  const native = { async reserve() { counts.native++; await barrier(); return { ...n,review:review(n),status:'RESERVED_NOT_CLAIMED',
    execution_authorized:false,stages:n.stages.map(s=>({...s,claimed:false,original_hash:null})) }; },
    async inspect() {}, async claim({stageId}) { counts.nativeClaims++; return claim(n,stageId); },
    async recordOriginal() {}, async verifyCompletion() {} };
  const ft = { async reserve() { counts.ft++; await barrier(); return {...f,review:review(f),stage_id:ftStages[0],setup_snapshot:{}}; },
    async claimPrompt({stageId}) { counts.ftClaims++; return claim(f,stageId); }, async claimSetupStage() {},
    async recordOriginalHash() {}, async recordSetupStageOriginal() {} };
  return { native,ft,counts };
}
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-cross-flow-witness-'));
  const bare=path.join(root,'remote.git'),work=path.join(root,'work');
  try {
    fs.mkdirSync(work); git(root,['init','--bare','--initial-branch',branch,bare]);
    git(work,['init','--initial-branch',branch]); git(work,['config','user.email','synthetic@example.test']);
    git(work,['config','user.name','Synthetic test']); git(work,['remote','add','origin',bare]);
    fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');git(work,['add','README.md']);
    git(work,['commit','-m','Initial synthetic commit']);git(work,['push','origin',branch]);
    const initialHead=git(work,['rev-parse','HEAD']),setup={repo:work,branch,initialHead};
    const ft=createWalletPromptWitness({store:createGitBranchWitnessStore(setup)});
    const native=createNativeOraclePromptWitness({store:createGitNativeOraclePromptWitnessStore(setup)});
    const owner='shared-owner.testnet',n=identity(owner,nativeStages),f=identity(owner,ftStages);
    await run({native,ft,n,f,initialHead});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

test('either setup witness blocks the other flow before a restored or forked database is asked to reserve',async()=>fixture(async({native,ft,n,f})=>{
  const db=fences(n,f);
  const nc=createWitnessedNativeOracleSetup({fence:db.native,witness:native,otherWitness:ft});
  const fc=createWitnessedWalletSetup({fence:db.ft,witness:ft,otherWitness:native});
  const first=await nc.reserve({review:review(n)}); assert.equal(first.status,'RESERVED_NOT_CLAIMED');
  await assert.rejects(fc.reserve({review:review(f)}),e=>e.code==='CROSS_FLOW_WITNESSED');
  assert.equal(db.counts.ft,0);
  const claim=await nc.claim({identity:first.identity,stageId:nativeStages[0]});
  assert.equal(claim.independently_witnessed,true); assert.equal(db.counts.nativeClaims,1);
  // A newly created fake FT database cannot erase the independently retained witness.
  const restored=fences(n,f),again=createWitnessedWalletSetup({fence:restored.ft,witness:ft,otherWitness:native});
  await assert.rejects(again.reserve({review:review(f)}),e=>e.code==='CROSS_FLOW_WITNESSED');
  assert.equal(restored.counts.ft,0);
}));

test('an FT setup witness also blocks a native reservation before it reaches the database',async()=>fixture(async({native,ft,n,f})=>{
  const db=fences(n,f),nc=createWitnessedNativeOracleSetup({fence:db.native,witness:native,otherWitness:ft});
  const fc=createWitnessedWalletSetup({fence:db.ft,witness:ft,otherWitness:native});
  await fc.reserve({review:review(f)});
  await assert.rejects(nc.reserve({review:review(n)}),e=>e.code==='CROSS_FLOW_WITNESSED');
  assert.equal(db.counts.native,0);
}));

test('racing separate databases cannot both append an initially empty same-owner witness',async()=>fixture(async({native,ft,n,f})=>{
  let arrived=0,release;const barrier=()=>new Promise(resolve=>{if(++arrived===1)release=resolve;else{release();resolve();}});
  const db=fences(n,f,barrier), nc=createWitnessedNativeOracleSetup({fence:db.native,witness:native,otherWitness:ft});
  const fc=createWitnessedWalletSetup({fence:db.ft,witness:ft,otherWitness:native});
  const outcomes=await Promise.allSettled([nc.reserve({review:review(n)}),fc.reserve({review:review(f)})]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.equal(db.counts.native,1); assert.equal(db.counts.ft,1);
  const observed=[await native.inspect(n.owner),await ft.inspect(f.owner)];
  assert.equal(observed.filter(x=>x.state!==null).length,1);
}));

test('an intervening other-flow witness blocks the claim before its database call',async()=>fixture(async({native,ft,n,f})=>{
  const db=fences(n,f),nc=createWitnessedNativeOracleSetup({fence:db.native,witness:native,otherWitness:ft});
  const reserved=await nc.reserve({review:review(n)});
  // Simulate an old bypassing client writing the other namespace directly.
  await ft.reserve(f);
  await assert.rejects(nc.claim({identity:reserved.identity,stageId:nativeStages[0]}),e=>e.code==='CROSS_FLOW_WITNESSED');
  assert.equal(db.counts.nativeClaims,0);
}));

test('head mismatch, a missing peer, or a changed owner cannot yield a reservation',async()=>fixture(async({native,ft,n,f})=>{
  const db=fences(n,f);
  assert.throws(()=>createWitnessedNativeOracleSetup({fence:db.native,witness:native}));
  assert.throws(()=>createWitnessedWalletSetup({fence:db.ft,witness:ft,otherWitness:ft}));
  const different={async inspect(){return {head:'wrong-head',state:null}}};
  const nc=createWitnessedNativeOracleSetup({fence:db.native,witness:native,otherWitness:different});
  await assert.rejects(nc.reserve({review:review(n)}),e=>e.code==='WITNESS_HEAD_CHANGED');
  assert.equal(db.counts.native,0);
  const other=identity('another-owner.testnet',nativeStages),changed=fences(other,f);
  const mismatch=createWitnessedNativeOracleSetup({fence:changed.native,witness:native,otherWitness:ft});
  await assert.rejects(mismatch.reserve({review:review(n)}),e=>e.code==='WITNESS_MISMATCH');
  assert.equal((await native.inspect(other.owner)).state,null);
}));
