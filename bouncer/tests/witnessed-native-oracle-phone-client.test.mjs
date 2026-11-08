import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { IDBFactory } from 'fake-indexeddb';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';
import { prepareWitnessedNativeOracleTrial } from '../web-src/witnessed-native-oracle-trial.mjs';

// Fabricated identities, setup receipts and witness. No RPC, wallet, send or
// provider is involved. The DB/HTTP integration uses a separate test.
const OWNER='phone.testnet',VAULT=`native.${OWNER}`,ORIGIN='https://bouncer.example',NOW=1_800_000_000_000;
const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
function memoryStore(){let rev=0,text='';const head=()=>rev.toString(16).padStart(40,'0');return {
  async read(){return {head:head(),text}},async append(input){if(input.expectedHead!==head() || input.expectedText!==text)throw Error('synthetic CAS conflict');
    text=input.text;rev++;return {confirmed:true,head:head()}}}}
async function fixture({dropClaim=false,changeNonce=false,alterProof=false}={}){
  const device=await openNativeOracleDeviceKey({indexedDB:new IDBFactory(),storage:{persisted:async()=>true},crypto:crypto.webcrypto,
    origin:ORIGIN,isTopLevel:true,now:()=>NOW});
  const made=await device.create({owner:OWNER,vault:VAULT});
  const review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:made.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',vault_deposit_yocto:'100000000000000000000000',
    agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),operation_id:'a'.repeat(32),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const witness=createNativeOraclePromptWitness({store:memoryStore()});await witness.reserve(identity);
  for(let i=0;i<4;i++){const stage=identity.stages[i].stage_id,prior=await witness.assertClaimable(identity,stage);
    await witness.claim(identity,stage,prior);await witness.recordOriginal(identity,stage,hash(i+1))}
  const events=[];let nonce='77',current=true;
  const client={async verifyCompletion(){events.push('completion');return {version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',
    stage_id:'verify_native_setup_completion',owner:OWNER,vault:VAULT,review_sha256:review.review_sha256,independently_witnessed:true,
    witness_head:(await witness.inspect(OWNER)).head,execution_authorized:false,signing_authorized:false,transaction_sent:false,
    owner_approval_obtained:false,wallet_prompt_authorized:false,prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],checks:{...checks},
    blockers:[],observed_at:new Date(NOW).toISOString(),block_hash:hash(9),block_height:100,
    block_timestamp_nanosec:(BigInt(NOW)*1_000_000n).toString(),agent_key_nonce:nonce}},
    async claimTrial({identity:provided,goal,trial,expectedWitnessHead}){
      events.push('claim');assert.deepEqual(provided,identity);assert.equal(crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex'),trial.goal_sha256);
      const saved=await witness.claimTrial(identity,trial,expectedWitnessHead);
      if(dropClaim)throw Error('lost synthetic witness response');if(changeNonce)nonce='78';
      return {status:'TRIAL_ORIGINAL_WITNESSED',owner:OWNER,operation_id:identity.operation_id,review_sha256:review.review_sha256,
        ...trial,...(alterProof?{original_hash:hash(80)}:{}),witness_head:saved.head,independently_witnessed:true,
        do_not_retry:true,execution_authorized:false,transaction_sent:false};
    }};
  const prepare=()=>prepareWitnessedNativeOracleTrial({client,deviceStore:device,identity,review,goalId:'native-oracle-trial-1',
    origin:ORIGIN,isTopLevel:true,crypto:crypto.webcrypto,isCurrent:()=>current,now:()=>NOW});
  return {device,identity,review,witness,events,prepare,setCurrent:v=>{current=v}};
}

test('phone prepares visible terms, witnesses the original, refreshes state and signs only once',async()=>{
  const f=await fixture();try{
    const p=await f.prepare();assert.equal(p.terms.maximum_native_yocto,f.review.per_tx_cap_yocto);assert.equal(p.terms.transaction_sent,false);
    assert.equal(p.terms.refund_destination,OWNER);assert.equal(p.terms.rolling_day_cap_yocto,f.review.daily_cap_yocto);
    assert.equal(p.terms.agent_gas_allowance_yocto,f.review.agent_gas_allowance_yocto);
    assert.equal(p.terms.gas_limit,'300000000000000');assert.equal(p.terms.method,'execute_outlayer_native_project');
    assert.deepEqual(p.terms.project,f.review.project);assert.equal(Object.isFrozen(p.terms.project),true);
    assert.ok(p.terms.limitations.some(text=>text.includes('Gas')));
    assert.ok(p.terms.limitations.some(text=>text.includes('full maximum')));
    await assert.rejects(p.sign({ownerConfirmed:false}));assert.deepEqual(f.events,[]);
    const result=await p.sign({ownerConfirmed:true});assert.equal(result.status,'SIGNED_NOT_BROADCAST');assert.equal(result.transaction_sent,false);
    assert.deepEqual(f.events,['completion','claim','completion']);assert.equal((await f.witness.inspect(OWNER)).state.trial.original_hash,result.tx_hash);
    const tx=nearApi.transactions.SignedTransaction.decode(result.signed_transaction),digest=crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx.transaction)).digest();
    assert.equal(nearApi.utils.serialize.base_encode(digest),result.tx_hash);
    assert.equal(nearApi.utils.PublicKey.from(f.review.agent_public_key).verify(digest,Uint8Array.from(tx.signature.ed25519Signature.data)),true);
    await assert.rejects(p.sign({ownerConfirmed:true}));assert.deepEqual(f.events,['completion','claim','completion']);
  }finally{f.device.close()}
});

test('a lost original-claim response is recoverable from the witness and never signs',async()=>{
  const f=await fixture({dropClaim:true});try{
    const p=await f.prepare();await assert.rejects(p.sign({ownerConfirmed:true}),/lost synthetic witness response/);
    assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
    assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'NO_LOCAL_ORIGINAL');
    await assert.rejects(p.sign({ownerConfirmed:true}));
    const again=await f.prepare();await assert.rejects(again.sign({ownerConfirmed:true}));
    assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'NO_LOCAL_ORIGINAL');
  }finally{f.device.close()}
});

test('changed nonce, altered proof, or changed owner session stops before a local signature',async()=>{
  for(const options of [{changeNonce:true},{alterProof:true}]){
    const f=await fixture(options);try{const p=await f.prepare();await assert.rejects(p.sign({ownerConfirmed:true}));
      assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
      assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'NO_LOCAL_ORIGINAL');
    }finally{f.device.close()}}
  const f=await fixture();try{const p=await f.prepare();f.setCurrent(false);await assert.rejects(p.sign({ownerConfirmed:true}));assert.deepEqual(f.events,[])}finally{f.device.close()}
});

test('two prepared phone requests sharing a witness cannot both sign',async()=>{
  const f=await fixture();try{const [a,b]=await Promise.all([f.prepare(),f.prepare()]);
    const outcomes=await Promise.allSettled([a.sign({ownerConfirmed:true}),b.sign({ownerConfirmed:true})]);
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
    assert.equal((await f.witness.inspect(OWNER)).state.trial.original_hash,outcomes.find(o=>o.status==='fulfilled').value.tx_hash);
  }finally{f.device.close()}
});
