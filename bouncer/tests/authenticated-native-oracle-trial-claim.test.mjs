import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { validateWitnessedNativeOracleTrial } from '../agent/native-oracle-phone-signer.mjs';
import { createAuthenticatedNativeOracleTrialClaim } from '../agent/authenticated-native-oracle-trial-claim.mjs';

const OWNER='alice.testnet',VAULT=`native.${OWNER}`,NOW=1_800_000_000_000;
const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
function store() {
  let revision=0,text='',loseAck=false;
  const head=()=>revision.toString(16).padStart(40,'0');
  return {async read(){return {head:head(),text}},async append(request){
    if(request.expectedHead!==head() || request.expectedText!==text)throw Error('CAS conflict');
    text=request.text;revision++;if(loseAck)throw Error('lost synthetic acknowledgment');return {confirmed:true,head:head()};
  },setLoseAck(value){loseAck=value}};
}
function authenticator() {
  let counter=0;const records=new Map();
  return {async issue(action){const challenge_id=String(++counter).padStart(32,'0');records.set(challenge_id,{action,used:false});return {challenge_id}},
    async authenticate({action,evidence}){const record=records.get(evidence?.challenge_id);
      if(!record || record.used || evidence?.owner_signature!=='synthetic' || JSON.stringify(action)!==JSON.stringify(record.action))return false;
      record.used=true;return true}};
}
async function fixture() {
  const ownerKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),agentKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:agentKey,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:ownerKey,operation_id:'a'.repeat(32),review_sha256:review.review_sha256,
    stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const goal={id:'native-oracle-trial-1',contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:review.per_tx_cap_yocto,
    route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
  const checked=validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes:wasm,trustedReviewHash:review.review_sha256,trustedOwnerPublicKey:ownerKey});
  const trial={goal_id:goal.id,goal_sha256:checked.goalSha256,agent_public_key:agentKey,original_hash:hash(50)};
  const remote=store(),witness=createNativeOraclePromptWitness({store:remote});await witness.reserve(identity);
  for(let i=0;i<4;i++) {const stage=identity.stages[i].stage_id,prior=await witness.assertClaimable(identity,stage);
    await witness.claim(identity,stage,prior);await witness.recordOriginal(identity,stage,hash(i+1))}
  const head=(await witness.inspect(OWNER)).head,auth=authenticator();let peerState=null,peerHead=null,stale=false;
  const otherWitness={async inspect(){return {head:peerHead??(await witness.inspect(OWNER)).head,state:peerState}}};
  const getFreshCompletion=async()=>({version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',
    stage_id:'verify_native_setup_completion',owner:OWNER,vault:VAULT,review_sha256:review.review_sha256,
    independently_witnessed:true,witness_head:head,execution_authorized:false,signing_authorized:false,transaction_sent:false,
    owner_approval_obtained:false,wallet_prompt_authorized:false,prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],
    checks:{...checks},blockers:[],observed_at:new Date(NOW-(stale?10_000:0)).toISOString(),block_hash:hash(9),
    block_height:100,block_timestamp_nanosec:(BigInt(NOW)*1_000_000n).toString(),agent_key_nonce:'77'});
  const claim=createAuthenticatedNativeOracleTrialClaim({goal,review,identity,wasmBytes:wasm,trustedReviewHash:review.review_sha256,
    trustedOwnerPublicKey:ownerKey,auth,witness,otherWitness,getFreshCompletion,now:()=>NOW});
  return {claim,trial,head,witness,remote,setPeerState:value=>{peerState=value},setPeerHead:value=>{peerHead=value},setStale:value=>{stale=value}};
}
const evidence=challenge=>({...challenge,owner_signature:'synthetic'});

test('owner-authenticated trial claim binds exact goal, key, original and witness head; the challenge is single-use',async()=>{
  const f=await fixture(),challenge=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head});
  const saved=await f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)});
  assert.equal(saved.state.phase,'trial_claimed');assert.deepEqual(saved.state.trial,f.trial);
  await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)}));
  await assert.rejects(f.claim.issue({trial:f.trial,expectedWitnessHead:f.head}));
});

test('wrong owner evidence, changed original, wrong head or other-flow conflict cannot claim',async()=>{
  const f=await fixture(),challenge=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head});
  await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:{...challenge,owner_signature:'wrong'}}));
  await assert.rejects(f.claim.claim({trial:{...f.trial,original_hash:hash(51)},expectedWitnessHead:f.head,evidence:evidence(challenge)}));
  await assert.rejects(f.claim.issue({trial:{...f.trial,goal_sha256:'f'.repeat(64)},expectedWitnessHead:f.head}));
  await assert.rejects(f.claim.issue({trial:f.trial,expectedWitnessHead:'f'.repeat(40)}));
  f.setPeerState({identity:'other setup'});await assert.rejects(f.claim.issue({trial:f.trial,expectedWitnessHead:f.head}));
  assert.equal((await f.witness.inspect(OWNER)).state.phase,'complete');
});

test('a stale completion consumes authentication without appending or signing',async()=>{
  const f=await fixture(),challenge=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head});f.setStale(true);
  await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)}));
  f.setStale(false);await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)}));
  assert.equal((await f.witness.inspect(OWNER)).state.phase,'complete');
});

test('lost witness acknowledgement consumes both owner challenge and original claim',async()=>{
  const f=await fixture(),challenge=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head});f.remote.setLoseAck(true);
  await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)}));f.remote.setLoseAck(false);
  assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
  await assert.rejects(f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)}));
});

test('two owner-authorized competing claims yield at most one retained original',async()=>{
  const f=await fixture(),first=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head}),second=await f.claim.issue({trial:f.trial,expectedWitnessHead:f.head});
  const attempts=await Promise.allSettled([first,second].map(challenge=>f.claim.claim({trial:f.trial,expectedWitnessHead:f.head,evidence:evidence(challenge)})));
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
});
