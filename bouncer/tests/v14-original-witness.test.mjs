// Synthetic only: no wallet, actual network, provider, signing or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { buildV14PhoneResearchPlan } from '../agent/native-v14-phone-plan.mjs';
import { createV14OriginalWitness,deriveV14OriginalBinding,inspectV14OriginalSnapshot,V14_WITNESS_GENESIS } from '../agent/v14-original-witness.mjs';
import { createV14FileWitnessStore } from '../agent/v14-file-witness-store.mjs';
import { FileJournal } from '../agent/procurement.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const scope='3'.repeat(32),owner='owner.testnet',vault=`native.${owner}`;
function fixture() {
  const wasm=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from('bouncer-agent-v14-native-storage-testnet synthetic')]);
  const loader=Buffer.concat([Buffer.from([0,97,115,109,1,0,0,0]),Buffer.from('synthetic loader')]);
  const codeHash=nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest());
  const mission={version:1,id:'witness-test',contract_id:vault,owner_account_id:owner,max_native_amount:'300',
    required_resources:['compute','api','storage'],goals:[
      {kind:'random',goal:{id:'compute',contract_id:vault,owner_account_id:owner,policy_id:'compute',amount:'100',input:{min:1,max:100},
        program:{url:'https://example.test/random.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',max_instructions:10000000,max_memory_mb:128,max_execution_seconds:60}}},
      {kind:'oracle',goal:{id:'price',contract_id:vault,owner_account_id:owner,policy_id:'price',amount:'100',
        route:{project:{...ORACLE_TESTNET_PROJECT},route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300}},
      {kind:'storage',goal:{id:'store',contract_id:vault,owner_account_id:owner,contract_code_hash:codeHash,policy_id:'store',amount:'100',
        object_id:'mission-results',value:{from_goal_ids:['compute','price']},route:{prefix:'mission-',max_value_bytes:4096,
          route_revision:1,policy_revision:1,payee_revision:1,active:true}}},
    ]};
  const inputs={mission,ownerPublicKey:key(),agentPublicKeys:{compute:key(),price:key(),store:key()},
    gasAllowances:{compute:'500',price:'500',store:'500'},dailyCaps:{compute:'500',price:'500',store:'500'},
    vaultStorageFundingYocto:'600',nativeDepositYocto:'300',vaultWasm:wasm,loaderWasm:loader,compressed:zlib.deflateRawSync(wasm),
    trustedArtifacts:{vault_sha256:sha(wasm),loader_sha256:sha(loader)}};
  const review=buildV14PhoneResearchPlan(inputs).review;
  return {inputs,review,binding:deriveV14OriginalBinding({scopeId:scope,...inputs,review,trustedReviewSha256:review.review_sha256})};
}
function memoryStore() {
  let snapshot={revision:0,head_sha256:V14_WITNESS_GENESIS,events:[]},failAfterAppend=false;
  return {
    read:async()=>structuredClone(snapshot),
    append:async({expected_revision,expected_head_sha256,record})=>{
      if (snapshot.revision!==expected_revision || snapshot.head_sha256!==expected_head_sha256) throw new Error('CAS conflict');
      snapshot={revision:snapshot.revision+1,head_sha256:sha(record),events:[...snapshot.events,record]};
      if (failAfterAppend) { failAfterAppend=false; throw new Error('response lost after commit'); }
      return structuredClone(snapshot);
    },
    replace:value=>{snapshot=structuredClone(value)},failAfterNextAppend:()=>{failAfterAppend=true},
  };
}
function setup(options={}) {
  const {binding}=fixture(),local=memoryStore(),remote=memoryStore();
  const verifier=async({txHash})=>({tx_hash:txHash,final_block_hash:hash(250)});
  const witness=createV14OriginalWitness({binding,localStore:local,independentStore:remote,
    verifySetupReceipt:verifier,verifyMissionReceipt:verifier,...options});
  return {binding,local,remote,witness};
}
async function completeSetup({binding,witness}) {
  for(let i=0;i<binding.stages.length;i++) {
    const stageId=binding.stages[i].id;
    await witness.claimWalletStage(stageId);
    await witness.retainWalletOriginal({stageId,txHash:hash(i+1)});
    await witness.verifyWalletOriginal({stageId,proof:{synthetic:true}});
  }
}

test('binding is derived from the complete pinned public plan, not an arbitrary review hash',()=>{
  const {inputs,review,binding}=fixture();
  assert.equal(binding.owner,owner);assert.equal(binding.vault,vault);assert.equal(binding.review_sha256,review.review_sha256);
  assert.equal(binding.stages.length,6);assert.deepEqual(binding.goals.map(x=>x.id),['compute','price','store']);
  assert.deepEqual(binding.public_review,review); // a separately retained public review, not merely its digest
  assert.ok(!JSON.stringify(binding).includes('private_key'));
  const unsafe=structuredClone(binding);unsafe.public_review.agent_private_key='do-not-store';
  assert.throws(()=>createV14OriginalWitness({binding:unsafe,localStore:memoryStore(),independentStore:memoryStore()}),/secret-bearing/);
  const changed=structuredClone(review);changed.stages[0].actions[1].deposit_yocto='999';
  assert.throws(()=>deriveV14OriginalBinding({scopeId:scope,...inputs,review:changed,trustedReviewSha256:review.review_sha256}),/differs/);
  assert.throws(()=>deriveV14OriginalBinding({scopeId:scope,...inputs,review,trustedReviewSha256:'f'.repeat(64)}),/retained/);
  assert.throws(()=>deriveV14OriginalBinding({scopeId:'bad',...inputs,review,trustedReviewSha256:review.review_sha256}),/scope/);
  const query=structuredClone(inputs);
  query.mission.goals[0].goal.program.url='https://example.test/random.wasm?api_key=do-not-store';
  const unsafeReview=buildV14PhoneResearchPlan(query).review;
  assert.throws(()=>deriveV14OriginalBinding({scopeId:scope,...query,review:unsafeReview,trustedReviewSha256:unsafeReview.review_sha256}),/secret-bearing/);
});

test('independent and local copies retain six wallet claims/originals, then three mission originals in order',async()=>{
  const s=setup();await s.witness.reserve();await completeSetup(s);
  for(let i=0;i<s.binding.goals.length;i++) {
    const goal=s.binding.goals[i];
    await s.witness.retainMissionOriginal({goalId:goal.id,kind:goal.kind,txHash:hash(30+i),fingerprint:'a'.repeat(64)});
    await s.witness.verifyMissionOriginal({goalId:goal.id,proof:{synthetic:true}});
  }
  const state=await s.witness.inspect();
  assert.equal(state.revision,25);assert.equal(state.pending,null);assert.equal(state.next_setup_stage,null);assert.equal(state.next_mission_goal,null);
  assert.deepEqual(state.setup.map(x=>x.tx_hash),[1,2,3,4,5,6].map(hash));
  assert.deepEqual(state.mission.map(x=>x.tx_hash),[30,31,32].map(hash));
  assert.deepEqual(await s.local.read(),await s.remote.read());
  assert.ok(!(await s.remote.read()).events.join('').includes('private_key'));
});

test('a lost wallet response leaves a one-shot claim; neither another prompt nor a later stage is authorized',async()=>{
  const {binding,witness}=setup();await witness.reserve();const stageId=binding.stages[0].id;
  await witness.claimWalletStage(stageId);
  await assert.rejects(witness.claimWalletStage(stageId),/never prompt again/);
  await assert.rejects(witness.claimWalletStage(binding.stages[1].id),/never prompt again/);
  await assert.rejects(witness.retainMissionOriginal({goalId:'compute',kind:'random',txHash:hash(20),fingerprint:'a'.repeat(64)}),/never send a replacement/);
  assert.deepEqual((await witness.inspect()).pending,{type:'wallet',stage_id:stageId,tx_hash:null});
  // Only the original reported later is retained. Retaining it is not itself a receipt or fresh-state verification.
  await witness.retainWalletOriginal({stageId,txHash:hash(1)});
  await assert.rejects(witness.retainWalletOriginal({stageId,txHash:hash(2)}),/recover without another prompt/);
  assert.equal((await witness.inspect()).pending.tx_hash,hash(1));
});

test('missing or wrong receipt verifier never advances either setup or mission',async()=>{
  const s=setup({verifySetupReceipt:undefined});await s.witness.reserve();
  const stageId=s.binding.stages[0].id;await s.witness.claimWalletStage(stageId);await s.witness.retainWalletOriginal({stageId,txHash:hash(1)});
  await assert.rejects(s.witness.verifyWalletOriginal({stageId}),/verifier are required/);
  assert.equal((await s.witness.inspect()).revision,3);
  const other=createV14OriginalWitness({binding:s.binding,localStore:s.local,independentStore:s.remote,
    verifySetupReceipt:async()=>({tx_hash:hash(2),final_block_hash:hash(250)})});
  await assert.rejects(other.verifyWalletOriginal({stageId}),/was not verified/);
  assert.equal((await other.inspect()).next_setup_stage,stageId);
});

test('lost independent-store acknowledgement and local rollback fail closed across restart',async()=>{
  const s=setup();await s.witness.reserve();const old=await s.local.read();s.remote.failAfterNextAppend();
  await assert.rejects(s.witness.claimWalletStage(s.binding.stages[0].id),/uncertain/);
  assert.equal((await s.remote.read()).revision,2);assert.equal((await s.local.read()).revision,1);
  await assert.rejects(s.witness.inspect(),/uncertain/);
  const restarted=createV14OriginalWitness({binding:s.binding,localStore:s.local,independentStore:s.remote});
  await assert.rejects(restarted.inspect(),/uncertain/);
  s.local.replace(old); // still cannot make a rolled-back local copy match the newer independent copy
  const again=createV14OriginalWitness({binding:s.binding,localStore:s.local,independentStore:s.remote});
  await assert.rejects(again.claimWalletStage(s.binding.stages[0].id),/uncertain/);
});

test('concurrent claimants cannot both reserve the same wallet prompt',async()=>{
  const s=setup();await s.witness.reserve();
  const make=()=>createV14OriginalWitness({binding:s.binding,localStore:s.local,independentStore:s.remote});
  const results=await Promise.allSettled([make().claimWalletStage(s.binding.stages[0].id),make().claimWalletStage(s.binding.stages[0].id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.deepEqual(await s.local.read(),await s.remote.read());
  assert.equal((await s.remote.read()).revision,2);
});

test('malformed, reordered, truncated and substituted histories fail even if both copies match',async()=>{
  const s=setup();await s.witness.reserve();await s.witness.claimWalletStage(s.binding.stages[0].id);
  const good=await s.local.read();
  const changed=structuredClone(good);changed.events[1]=changed.events[1].replace('wallet_claim','wallet_verified');changed.head_sha256=sha(changed.events[1]);
  assert.throws(()=>inspectV14OriginalSnapshot(changed,s.binding),/uncertain/);
  assert.throws(()=>inspectV14OriginalSnapshot({...good,events:[good.events[1],good.events[0]],head_sha256:sha(good.events[0])},s.binding),/uncertain/);
  assert.throws(()=>inspectV14OriginalSnapshot({...good,revision:1,events:good.events.slice(0,1)},s.binding),/uncertain/);
  assert.throws(()=>inspectV14OriginalSnapshot(good,{...s.binding,review_sha256:'f'.repeat(64)}),/invalid|uncertain/);
});

test('dedicated encrypted FileJournal stores the local copy, reopens it, and refuses implicit replacement',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v14-witness-'));
  const file=path.join(dir,'witness.enc'),encryptionKey=crypto.randomBytes(32),{binding}=fixture();
  try {
    let journal=new FileJournal(file,vault,owner,{encryptionKey});
    assert.throws(()=>createV14FileWitnessStore({journal,owner,vault,scopeId:scope}),/missing or uncertain/);
    const local=createV14FileWitnessStore({journal,owner,vault,scopeId:scope,initializeBrandNew:true}),remote=memoryStore();
    const witness=createV14OriginalWitness({binding,localStore:local,independentStore:remote});await witness.reserve();
    assert.throws(()=>createV14FileWitnessStore({journal,owner,vault,scopeId:scope,initializeBrandNew:true}),/missing or uncertain/);
    assert.ok(!fs.readFileSync(file,'utf8').includes(binding.review_sha256));journal.close();
    journal=new FileJournal(file,vault,owner,{encryptionKey,requireExisting:true});
    const reopened=createV14FileWitnessStore({journal,owner,vault,scopeId:scope});
    assert.deepEqual(await reopened.read(),await remote.read());
    assert.throws(()=>createV14FileWitnessStore({journal,owner,vault,scopeId:'4'.repeat(32)}),/missing or uncertain/);
    journal.close();
    assert.throws(()=>new FileJournal(path.join(dir,'missing'),vault,owner,{encryptionKey,requireExisting:true}),/original journal not found/);
  } finally {encryptionKey.fill(0);fs.rmSync(dir,{recursive:true,force:true});}
});
