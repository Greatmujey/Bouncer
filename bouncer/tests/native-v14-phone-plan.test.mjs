// Strictly synthetic unsigned reviews. No wallet, signer, chain or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { buildV14PhoneResearchPlan, verifyV14PhoneResearchPlan, v14PhoneBatchCommitment } from '../agent/native-v14-phone-plan.mjs';

const owner='owner.testnet',vault=`native.${owner}`,sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash=bytes=>nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const magic=Buffer.from([0,97,115,109,1,0,0,0]);
function fixture() {
  // These aren't real WASM modules; the builder checks fingerprints/transport,
  // not audit/provenance. Only the isolated nearcore scenario executes code.
  const vaultWasm=Buffer.concat([magic,Buffer.from('bouncer-agent-v14-native-storage-testnet synthetic')]);
  const loaderWasm=Buffer.concat([magic,Buffer.from('synthetic loader')]),compressed=zlib.deflateRawSync(vaultWasm);
  const keys={compute:key(),price:key(),store:key()};
  const mission={version:1,id:'v14-plan',contract_id:vault,owner_account_id:owner,max_native_amount:'300',
    required_resources:['compute','api','storage'],goals:[
      {kind:'random',goal:{id:'compute',contract_id:vault,owner_account_id:owner,policy_id:'compute',amount:'100',input:{min:1,max:100},
        program:{url:'https://example.test/random.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',
          max_instructions:10000000,max_memory_mb:128,max_execution_seconds:60}}},
      {kind:'oracle',goal:{id:'price',contract_id:vault,owner_account_id:owner,policy_id:'price',amount:'100',
        route:{project:{...ORACLE_TESTNET_PROJECT},route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300}},
      {kind:'storage',goal:{id:'store',contract_id:vault,owner_account_id:owner,contract_code_hash:codeHash(vaultWasm),
        policy_id:'store',amount:'100',object_id:'mission-results',value:{from_goal_ids:['compute','price']},
        route:{prefix:'mission-',max_value_bytes:4096,route_revision:1,policy_revision:1,payee_revision:1,active:true}}},
    ]};
  return {mission,ownerPublicKey:key(),agentPublicKeys:keys,gasAllowances:{compute:'500',price:'500',store:'500'},
    dailyCaps:{compute:'500',price:'500',store:'500'},
    vaultStorageFundingYocto:'600',nativeDepositYocto:'300',vaultWasm,loaderWasm,compressed,
    trustedArtifacts:{vault_sha256:sha(vaultWasm),loader_sha256:sha(loaderWasm)}};
}

test('fresh V14 plan binds public terms, caps, one-yocto configuration and three narrowly scoped keys', () => {
  const f=fixture(),plan=buildV14PhoneResearchPlan(f),{review,batches}=plan;
  assert.equal(review.status,'UNSIGNED_OFFLINE_PLAN_ONLY'); assert.equal(review.signing_authorized,false); assert.equal(review.transaction_sent,false);
  assert.equal(review.vault_storage_funding_yocto,'600'); assert.equal(review.native_deposit_yocto,'300'); assert.equal(review.stages.length,6);
  assert.deepEqual(batches.map(x=>x.id),['create_v14_research_vault','configure_compute','configure_api','configure_storage','fund_native_vault','install_restricted_agents']);
  assert.deepEqual(review.stages[0].actions.map(x=>x.type),['create_account','transfer','deploy_contract','function_call','function_call']);
  assert.equal(review.stages[0].actions[4].method,'loader_deploy');
  for (let i=1;i<=3;i++) {
    const actions=review.stages[i].actions;
    assert.deepEqual(actions.map(x=>x.deposit_yocto),['1','1','1','1']);
    assert.equal(actions[0].args.token,'native'); assert.equal(actions[0].args.per_tx_cap,'100'); assert.equal(actions[0].args.daily_cap,'500');
    assert.equal(actions[1].args.payee,i===3?vault:'outlayer.testnet');
  }
  assert.equal(review.stages[4].actions[0].deposit_yocto,'300');
  assert.deepEqual(review.stages[5].actions.map(x=>x.method_names),[['execute_outlayer'],['execute_outlayer_native_project'],['execute_native_storage']]);
  assert.ok(review.stages[5].actions.every(x=>x.receiver_id===vault && x.allowance_yocto==='500'));
  for(let i=0;i<batches.length;i++) assert.equal(v14PhoneBatchCommitment(batches[i]),review.stages[i].action_commitment_sha256);
  assert.deepEqual(verifyV14PhoneResearchPlan({...f,review,trustedReviewSha256:review.review_sha256}).review,review);
  const altered=structuredClone(review); altered.stages[1].actions[0].args.daily_cap='999';
  assert.throws(()=>verifyV14PhoneResearchPlan({...f,review:altered,trustedReviewSha256:review.review_sha256}),/differs/);
  const changed={...batches[0],actions:[...batches[0].actions]}; changed.actions[1]=nearApi.transactions.transfer(601n);
  assert.notEqual(v14PhoneBatchCommitment(changed),review.stages[0].action_commitment_sha256);
});

test('rejects changed pins, streams, owner/agent keys, scope, insufficient funds and old route revisions', () => {
  const mutate=[
    f=>{f.trustedArtifacts.vault_sha256='0'.repeat(64);}, f=>{f.trustedArtifacts.loader_sha256='0'.repeat(64);},
    f=>{f.compressed=Buffer.concat([f.compressed,Buffer.from([0])]);}, f=>{f.nativeDepositYocto='299';},
    f=>{f.dailyCaps.compute='99';}, f=>{f.dailyCaps.price='0';},
    f=>{f.mission.goals[1].goal.route.route_revision=2;}, f=>{f.mission.goals[2].goal.route.payee_revision=2;},
    f=>{f.mission.goals[1].goal.policy_id='compute';}, f=>{f.mission.goals[2].goal.value={from_goal_ids:['compute']};},
    f=>{f.mission.required_resources=['compute','api'];}, f=>{f.agentPublicKeys.price=f.agentPublicKeys.compute;},
    f=>{f.ownerPublicKey=f.agentPublicKeys.compute;}, f=>{f.gasAllowances.store='0';},
    f=>{f.gasAllowances.store='1000000000000000000000001';}, f=>{f.agentPublicKeys.extra=key();},
    f=>{f.mission.goals[2].goal.contract_code_hash=codeHash(Buffer.from('different'));},
    f=>{f.mission.contract_id='elsewhere.testnet'; f.mission.goals.forEach(x=>x.goal.contract_id='elsewhere.testnet');},
  ];
  for(const change of mutate) { const f=fixture(); change(f); assert.throws(()=>buildV14PhoneResearchPlan(f)); }
  const f=fixture(),review=buildV14PhoneResearchPlan(f).review;
  assert.throws(()=>verifyV14PhoneResearchPlan({...f,review,trustedReviewSha256:'f'.repeat(64)}),/retained/);
});
