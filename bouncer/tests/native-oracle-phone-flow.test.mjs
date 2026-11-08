import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan } from '../agent/native-oracle-atomic-wallet.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';
import { createNativeOracleOwnerFlow } from '../web-src/native-oracle-owner-flow.mjs';

// Entirely fabricated wallet/setup/RPC/receipts. No actual user wallet or
// public transaction is used. The real phone key, witness and UI state machine
// are composed together to test the one-shot path and its recovery behavior.
const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`,ORIGIN='https://phone.example',NOW=1_800_000_000_000;
const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));

async function fixture({enabled=true,unknownSend=false,wrongNetwork=false,atomic=false}={}) {
  const indexedDB=new IDBFactory();
  const device=await openNativeOracleDeviceKey({indexedDB,storage:{persisted:async()=>true},crypto:webcrypto,
    origin:ORIGIN,isTopLevel:true,now:()=>NOW});
  const key=await device.create({owner:OWNER,vault:VAULT});
  const ownerKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const terms={owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:key.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE};
  const review=(atomic?buildAtomicNativeOracleWalletPlan({wasmBytes:wasm,terms,trustedOwnerPublicKey:ownerKey}):
    buildNativeOracleWalletPlan({wasmBytes:wasm,terms})).review;
  const identity={owner:OWNER,owner_public_key:ownerKey,operation_id:'1'.repeat(32),review_sha256:review.review_sha256,
    stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  let revision=0,text='';const head=()=>revision.toString(16).padStart(40,'0');
  const witness=createNativeOraclePromptWitness({store:{async read(){return {head:head(),text}},async append(input){
    if(input.expectedHead!==head() || input.expectedText!==text)throw Error('synthetic CAS');text=input.text;revision++;
    return {head:head(),confirmed:true}}}});
  await witness.reserve(identity);
  for(let i=0;i<identity.stages.length;i++){
    const stage=identity.stages[i].stage_id,claim=await witness.assertClaimable(identity,stage);
    await witness.claim(identity,stage,claim);await witness.recordOriginal(identity,stage,hash(i+1));
  }
  const rows=identity.stages.map((s,i)=>({...s,claimed:true,original_hash:hash(i+1)}));
  let sends=0,claims=0,receiptAvailable=true;
  const client={
    async inspect(){const remote=await witness.inspect(OWNER);return {status:'WITNESSED',identity,review,database_stages:rows,
      witnessed_records:remote.state.records,execution_authorized:false}},
    async previewOriginal({stageId,originalHash}){return {status:'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH',stage_id:stageId,
      tx_hash:originalHash,original_recorded:true,execution_authorized:false}},
    async trialSubmissionEnabled(){return enabled},
    async verifyCompletion(){const snapshot=await witness.inspect(OWNER);return {version:1,network:'testnet',
      status:atomic?'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED':'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',stage_id:'verify_native_setup_completion',owner:OWNER,vault:VAULT,
      review_sha256:review.review_sha256,independently_witnessed:true,witness_head:snapshot.head,execution_authorized:false,
      signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
      prior_original_hashes:rows.map(r=>r.original_hash),checks,blockers:[],observed_at:new Date(NOW).toISOString(),
      block_hash:hash(9),block_height:100,block_timestamp_nanosec:String(BigInt(NOW)*1_000_000n),agent_key_nonce:'77'}},
    async claimTrial({identity:raw,trial,expectedWitnessHead}){claims++;const saved=await witness.claimTrial(raw,trial,expectedWitnessHead);
      return {status:'TRIAL_ORIGINAL_WITNESSED',owner:raw.owner,operation_id:raw.operation_id,review_sha256:raw.review_sha256,
        ...trial,witness_head:saved.head,independently_witnessed:true,do_not_retry:true,execution_authorized:false,transaction_sent:false}},
    async previewTrial(){if(!receiptAvailable)throw Error('synthetic receipt unavailable');const remote=await witness.inspect(OWNER),tx=remote.state.trial.original_hash;
      return {status:'FINAL_NATIVE_ORACLE_DELIVERY_MATCH',owner:OWNER,original_hash:tx,do_not_retry:true,execution_authorized:false,
        provider_delivery_verified:true,delivery:{tx_hash:tx,provider:review.payee,asset:'NEAR',maximum_yocto:review.per_tx_cap_yocto,
          charged_yocto:'10000000000000000000000',refunded_to_owner_yocto:'90000000000000000000000',result:{price_usd:2.75}}}},
  };
  const fetch=async (_url,options)=>{const request=JSON.parse(options.body);
    if(request.method==='status')return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{chain_id:wrongNetwork?'mainnet':'testnet'}}));
    sends++;if(unknownSend)throw Error('synthetic lost RPC response');
    const original=(await witness.inspect(OWNER)).state.trial.original_hash;
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{transaction:{hash:original},transaction_outcome:{id:original}}}))};
  const makeFlow=(deviceStore=device)=>createNativeOracleOwnerFlow({client,deviceStore,ownerPublicKey:ownerKey,origin:ORIGIN,crypto:webcrypto,
    indexedDB,isTopLevel:true,fetch,now:()=>NOW,isCurrent:()=>true,interact:work=>work()});
  return {device,client,witness,makeFlow,review,counts:()=>({sends,claims}),setEnabled:value=>{enabled=value},
    setReceiptAvailable:value=>{receiptAvailable=value}};
}
async function ready(f,flow){
  await flow.check();assert.equal(flow.getState().phase,'await_receipt');await flow.checkReceipt();
  assert.equal(flow.getState().phase,'verify_setup');await flow.verifySetup();assert.equal(flow.getState().phase,'setup_verified');
}

test('known Meteor size limit stops before a reservation and preserves read-only recovery',async()=>{
  const f=await fixture();try{
    let reserves=0;
    f.client.inspect=async()=>({status:'NO_LOCAL_RECORD',execution_authorized:false});
    f.client.createReview=async({agentPublicKey})=>{
      assert.equal(agentPublicKey,f.review.agent_public_key);
      return {task_id:f.review.review_sha256,review:f.review,signing_authorized:false,transaction_sent:false};
    };
    f.client.assertWalletDeployAvailable=()=>{throw Object.assign(new Error('NATIVE_METEOR_DEPLOY_TOO_LARGE'),{code:'NATIVE_METEOR_DEPLOY_TOO_LARGE'})};
    f.client.reserve=async()=>{reserves++;throw Error('unexpected reservation')};
    const flow=f.makeFlow();await flow.check();assert.equal(flow.getState().phase,'review');
    await assert.rejects(flow.reserve({ownerConfirmed:true}),error=>error.code==='NATIVE_METEOR_DEPLOY_TOO_LARGE');
    assert.equal(flow.getState().phase,'blocked');assert.match(flow.getState().message,/No transaction was requested/);
    assert.equal(reserves,0);assert.deepEqual(f.counts(),{sends:0,claims:0});
    // A read-only check is still permitted and does not treat a deterministic
    // local compatibility stop as an uncertain reservation.
    await flow.check();assert.equal(flow.getState().phase,'review');assert.equal(reserves,0);
  }finally{f.device.close()}
});

test('owner reviews, explicitly authorizes one phone trial and verifies its synthetic receipt',async()=>{
  const f=await fixture();try{
    const flow=f.makeFlow();await ready(f,flow);assert.equal(flow.getState().trialAvailable,true);
    await flow.reviewTrial();assert.equal(flow.getState().phase,'trial_review');
    assert.equal(flow.getState().trialTerms.maximum_native_yocto,f.review.per_tx_cap_yocto);
    assert.deepEqual(f.counts(),{sends:0,claims:0});await assert.rejects(flow.runTrial(),e=>e.code==='NATIVE_OWNER_CONFIRMATION_REQUIRED');
    await flow.runTrial({ownerConfirmed:true});assert.equal(flow.getState().phase,'trial_retained');
    const original=flow.getState().originalHash;assert.equal((await f.witness.inspect(OWNER)).state.trial.original_hash,original);
    assert.deepEqual(f.counts(),{sends:1,claims:1});assert.match(flow.getState().message,/Check its receipts/);
    await assert.rejects(flow.runTrial({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
    await flow.checkTrial();assert.equal(flow.getState().phase,'trial_verified');
    assert.deepEqual(flow.getState().delivery,{priceUsd:2.75,chargedNear:'0.01',refundNear:'0.09'});
    assert.match(flow.getState().message,/Single source/);assert.deepEqual(f.counts(),{sends:1,claims:1});
  }finally{f.device.close()}
});

test('a lost send remains recoverable by the witnessed original without another signature or send',async()=>{
  const f=await fixture({unknownSend:true});try{
    const flow=f.makeFlow();await ready(f,flow);await flow.reviewTrial();await flow.runTrial({ownerConfirmed:true});
    assert.match(flow.getState().message,/unknown/);const original=flow.getState().originalHash;f.setReceiptAvailable(false);
    await flow.checkTrial();assert.equal(flow.getState().phase,'trial_retained');assert.equal(flow.getState().originalHash,original);
    const reopened=f.makeFlow();await reopened.check();assert.equal(reopened.getState().phase,'trial_retained');
    assert.equal(reopened.getState().originalHash,original);f.setReceiptAvailable(true);await reopened.checkTrial();
    assert.equal(reopened.getState().phase,'trial_verified');assert.deepEqual(f.counts(),{sends:1,claims:1});
  }finally{f.device.close()}
});

test('setup alone does not enable trial signing or sending',async()=>{
  const f=await fixture({enabled:false});try{
    const flow=f.makeFlow();await ready(f,flow);assert.equal(flow.getState().trialAvailable,false);
    await assert.rejects(flow.reviewTrial(),e=>e.code==='NATIVE_TRIAL_UNAVAILABLE');assert.deepEqual(f.counts(),{sends:0,claims:0});
  }finally{f.device.close()}
});

test('receipt output and refund must match the original before reporting delivery',async()=>{
  const f=await fixture();try{
    const flow=f.makeFlow();await ready(f,flow);await flow.reviewTrial();await flow.runTrial({ownerConfirmed:true});
    const preview=f.client.previewTrial;f.client.previewTrial=async()=>{const result=await preview();result.delivery.refunded_to_owner_yocto='1';return result};
    await flow.checkTrial();assert.equal(flow.getState().phase,'trial_retained');assert.match(flow.getState().message,/did not match/);
    assert.deepEqual(f.counts(),{sends:1,claims:1});
  }finally{f.device.close()}
});

test('wrong-network or unreachable browser RPC stops before the original is claimed or signed',async()=>{
  const f=await fixture({wrongNetwork:true});try{
    const flow=f.makeFlow();await ready(f,flow);await flow.reviewTrial();await flow.runTrial({ownerConfirmed:true});
    assert.equal(flow.getState().phase,'trial_review');assert.match(flow.getState().message,/No trial was claimed or signed/);
    assert.equal((await f.witness.inspect(OWNER)).state.phase,'complete');assert.deepEqual(f.counts(),{sends:0,claims:0});
  }finally{f.device.close()}
});

test('a second device without the agent key can verify only the witnessed original and refund',async()=>{
  const f=await fixture({unknownSend:true});try{
    const first=f.makeFlow();await ready(f,first);await first.reviewTrial();await first.runTrial({ownerConfirmed:true});
    const original=first.getState().originalHash;
    for(const deviceStore of [
      {async inspect(){return {status:'NO_LOCAL_DEVICE_KEY'}}},
      {async inspect(){throw Error('synthetic storage unavailable')}},
    ]){
      const recovery=f.makeFlow(deviceStore);await recovery.check();
      assert.equal(recovery.getState().phase,'trial_retained');assert.equal(recovery.getState().originalHash,original);
      assert.match(recovery.getState().message,/phone key is unavailable/i);
      await assert.rejects(recovery.reviewTrial(),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
      await assert.rejects(recovery.runTrial({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
      await recovery.checkTrial();assert.equal(recovery.getState().phase,'trial_verified');
      assert.deepEqual(recovery.getState().delivery,{priceUsd:2.75,chargedNear:'0.01',refundNear:'0.09'});
      assert.deepEqual(f.counts(),{sends:1,claims:1});
    }
    const originalInspect=f.client.inspect;
    f.client.inspect=async()=>{const remote=structuredClone(await originalInspect());remote.review.per_tx_cap_yocto='1';return remote};
    const tampered=f.makeFlow({async inspect(){return {status:'NO_LOCAL_DEVICE_KEY'}}});
    await assert.rejects(tampered.check());assert.equal(tampered.getState().phase,'stopped');
    assert.deepEqual(f.counts(),{sends:1,claims:1});
  }finally{f.device.close()}
});

test('without a local key an unfinished setup remains blocked and cannot request another transaction',async()=>{
  const f=await fixture();try{
    const recovery=f.makeFlow({async inspect(){return {status:'NO_LOCAL_DEVICE_KEY'}}});await recovery.check();
    assert.equal(recovery.getState().phase,'blocked');
    await assert.rejects(recovery.approveStage({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
    assert.deepEqual(f.counts(),{sends:0,claims:0});
  }finally{f.device.close()}
});

test('two-stage trial is recovered on a second device without the agent key or another send',async()=>{
  const f=await fixture({atomic:true,unknownSend:true});try {
    const first=f.makeFlow();await ready(f,first);
    assert.equal(first.getState().terms.setupStages,2);
    await first.reviewTrial();await first.runTrial({ownerConfirmed:true});
    const original=first.getState().originalHash;assert.equal(first.getState().phase,'trial_retained');
    const recovery=f.makeFlow({async inspect(){return {status:'NO_LOCAL_DEVICE_KEY'}}});
    await recovery.check();assert.equal(recovery.getState().phase,'trial_retained');
    assert.equal(recovery.getState().originalHash,original);
    await assert.rejects(recovery.runTrial({ownerConfirmed:true}),e=>e.code==='NATIVE_FLOW_ACTION_NOT_AVAILABLE');
    await recovery.checkTrial();assert.equal(recovery.getState().phase,'trial_verified');
    assert.deepEqual(recovery.getState().delivery,{priceUsd:2.75,chargedNear:'0.01',refundNear:'0.09'});
    assert.deepEqual(f.counts(),{sends:1,claims:1});
  }finally{f.device.close()}
});
