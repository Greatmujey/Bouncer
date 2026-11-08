import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan } from '../agent/native-oracle-atomic-wallet.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWitnessedNativeOraclePhoneAccount } from '../agent/native-oracle-phone-signer.mjs';
import { createPresignedWitnessedNativeOracleAccount } from '../agent/presigned-witnessed-native-oracle-account.mjs';
import { prepareWitnessedNativeOracleTrial } from '../web-src/witnessed-native-oracle-trial.mjs';
import { submitWitnessedNativeOracleTrialOnce } from '../web-src/native-oracle-trial-submit.mjs';
import { inspectLocalNativeSubmission } from '../web-src/native-oracle-local-submission.mjs';
import { recoverWitnessedNativeOracle } from '../agent/recover-witnessed-native-oracle.mjs';
import { createAuthenticatedNativeOracleTrialClaim, createOwnerAuthorizedNativeTrialWitness } from '../agent/authenticated-native-oracle-trial-claim.mjs';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';
import { runOracleGoal,ORACLE_PROJECT_ID,ORACLE_PROJECT_UUID,ORACLE_TESTNET_PROGRAM } from '../agent/oracle-outlayer.mjs';

// All accounts, completion evidence, witnesses and receipts are synthetic.
const OWNER='alice.testnet',VAULT=`native.${OWNER}`,base=1_800_000_000_000;
const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
function store() {
  let revision=0,text='',loseAck=false;
  const head=()=>revision.toString(16).padStart(40,'0');
  return {async read(){return {head:head(),text}},
    async append(request){if(request.expectedHead!==head() || request.expectedText!==text)throw Error('CAS conflict');
      text=request.text;revision++;if(loseAck)throw Error('lost synthetic acknowledgement');return {confirmed:true,head:head()}},
    setLoseAck(value){loseAck=value},snapshot(){return {head:head(),text}}};
}
const journal=()=>{const rows=new Map();return {get:id=>rows.get(id),put:(id,v)=>rows.set(id,structuredClone(v)),rows}};
async function fixture({atomic=false}={}) {
  let clock=base;
  const indexedDB=new IDBFactory();
  const device=await openNativeOracleDeviceKey({indexedDB,storage:{persisted:async()=>true},crypto:webcrypto,
    origin:'https://bouncer.example',isTopLevel:true,now:()=>clock});
  const key=await device.create({owner:OWNER,vault:VAULT});
  const ownerKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const terms={owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:key.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE};
  const review=(atomic?buildAtomicNativeOracleWalletPlan({wasmBytes:wasm,terms,trustedOwnerPublicKey:ownerKey}):
    buildNativeOracleWalletPlan({wasmBytes:wasm,terms})).review;
  const identity={owner:OWNER,owner_public_key:ownerKey,operation_id:'a'.repeat(32),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const goal={id:'native-oracle-trial-1',contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:review.per_tx_cap_yocto,
    route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
  const remote=store(),witness=createNativeOraclePromptWitness({store:remote});
  await witness.reserve(identity);
  for(let i=0;i<identity.stages.length;i++){
    const stage=identity.stages[i].stage_id,claim=await witness.assertClaimable(identity,stage);
    await witness.claim(identity,stage,claim);await witness.recordOriginal(identity,stage,hash(i+1));
  }
  let completionReads=0,signatures=0,nonce='77';
  const getFreshCompletion=async()=>{completionReads++;const {head}=await witness.inspect(OWNER);return {
    version:1,network:'testnet',status:atomic?'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED':'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',stage_id:'verify_native_setup_completion',
    owner:OWNER,vault:VAULT,review_sha256:review.review_sha256,independently_witnessed:true,witness_head:head,
    execution_authorized:false,signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
    prior_original_hashes:identity.stages.map((_,i)=>hash(i+1)),checks:{...checks},blockers:[],observed_at:new Date(clock).toISOString(),
    block_hash:hash(9),block_height:100,block_timestamp_nanosec:(BigInt(clock)*1_000_000n).toString(),agent_key_nonce:nonce};};
  const requestPhoneSignature=async request=>{signatures++;return device.signNativeOracleTrial({review,identity,completion:request.completion,
    freshCompletion:request.freshCompletion,witness:request.witness,ownerConfirmed:true,expectedTransactionHash:request.transactionHash});};
  const makeAccount=(overrides={})=>createWitnessedNativeOraclePhoneAccount({goal,review,identity,wasmBytes:wasm,
    trustedReviewHash:review.review_sha256,trustedOwnerPublicKey:identity.owner_public_key,witness,getFreshCompletion,requestPhoneSignature,
    now:()=>clock,...overrides});
  let sends=0,statusReads=0;
  const source={WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}};
  const provider={async viewNodeStatus(){return {chain_id:'testnet'}},async viewAccessKey(){return {permission:{FunctionCall:{
      receiver_id:VAULT,method_names:['execute_outlayer_native_project']}}}},
    async callFunction(_account,method){
      if(method==='contract_version')return 'bouncer-agent-v9';if(method==='get_owner')return OWNER;
      if(method==='get_policy')return {token:'native',per_tx_cap:goal.amount,daily_cap:goal.amount};
      if(method==='get_outlayer_native_project')return structuredClone(goal.route);if(method==='is_agent_key_allowed')return true;
      if(method==='check')return [true,'ok'];if(method==='get_project')return {project_id:ORACLE_PROJECT_ID,uuid:ORACLE_PROJECT_UUID,owner:'zavodil2.testnet'};
      if(method==='get_version')return {wasm_hash:ORACLE_TESTNET_PROGRAM.sha256,source};if(method==='get_project_pricing')return null;
      throw Error('unexpected synthetic view');},
    async sendTransactionOnce(){sends++;throw Error('synthetic unknown send result')},
    async txStatusReceipts(){statusReads++;throw Error('synthetic original not yet found')},
  };
  const publicKey=nearApi.utils.PublicKey.from(review.agent_public_key);
  return {device,indexedDB,review,identity,goal,witness,remote,provider,publicKey,makeAccount,getFreshCompletion,requestPhoneSignature,
    counts:()=>({completionReads,signatures,sends,statusReads}),setNonce:value=>{nonce=value},setClock:value=>{clock=value}};
}
const run=(f,account,local)=>runOracleGoal({goal:f.goal,provider:f.provider,account,publicKey:f.publicKey,journal:local,execute:true,log:()=>{}});
const recover=(f,local)=>recoverWitnessedNativeOracle({goal:f.goal,review:f.review,identity:f.identity,wasmBytes:wasm,
  trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,witness:f.witness,
  provider:f.provider,journal:local,log:()=>{}});

test('original hash is witnessed before signing, checked before send, and recovered on a new device without another send',async()=>{
  const f=await fixture(),local=journal();try {
    const account=f.makeAccount();await assert.rejects(run(f,account,local),/unresolved.*do not resend/);
    const remote=await f.witness.inspect(OWNER),pending=local.get(f.goal.id);
    assert.equal(remote.state.phase,'trial_claimed');assert.equal(remote.state.trial.original_hash,pending.tx_hash);
    const phone=await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256});
    assert.equal(phone.record.tx_hash,pending.tx_hash);assert.deepEqual(f.counts(),{completionReads:2,signatures:1,sends:1,statusReads:0});
    const restored=journal();await assert.rejects(recover(f,restored),/synthetic original not yet found/);
    assert.equal(restored.get(f.goal.id).tx_hash,pending.tx_hash);assert.equal(restored.get(f.goal.id).recovered_from_witness,true);
    await assert.rejects(run(f,f.makeAccount(),journal()));
    assert.deepEqual(f.counts(),{completionReads:3,signatures:1,sends:1,statusReads:1});
  }finally{f.device.close()}
});

test('concurrent independent journals cannot both obtain a trial signature',async()=>{
  const f=await fixture();try {
    const results=await Promise.allSettled([run(f,f.makeAccount(),journal()),run(f,f.makeAccount(),journal())]);
    assert.equal(results.filter(x=>x.status==='rejected').length,2); // winner's synthetic send times out
    assert.equal(f.counts().signatures,1);assert.equal(f.counts().sends,1);
    assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
  }finally{f.device.close()}
});

test('an unknown witness acknowledgment consumes the hash before the phone is called',async()=>{
  const f=await fixture();try {
    f.remote.setLoseAck(true);await assert.rejects(run(f,f.makeAccount(),journal()));f.remote.setLoseAck(false);
    assert.equal(f.counts().signatures,0);assert.equal(f.counts().sends,0);
    assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
    await assert.rejects(run(f,f.makeAccount(),journal()));assert.equal(f.counts().signatures,0);
  }finally{f.device.close()}
});

test('a changed nonce or mismatched witness head after the claim stops before signing',async()=>{
  for(const mode of ['nonce','head']){
    const f=await fixture();try {
      let calls=0;const original=f.getFreshCompletion;
      const getFreshCompletion=async()=>{const snapshot=await original();calls++;
        if(calls===2){if(mode==='nonce')snapshot.agent_key_nonce='78';else snapshot.witness_head='e'.repeat(40)}return snapshot};
      await assert.rejects(run(f,f.makeAccount({getFreshCompletion}),journal()));
      assert.equal(f.counts().signatures,0);assert.equal(f.counts().sends,0);
      assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
    }finally{f.device.close()}
  }
});

test('a witness lost after signing prevents the runner from sending and preserves its journal',async()=>{
  const f=await fixture(),local=journal();try {
    let reads=0;const delegate=f.witness;
    const witness={claimTrial:(...a)=>delegate.claimTrial(...a),async inspect(...a){reads++;if(reads>=2)throw Error('synthetic witness outage');return delegate.inspect(...a)}};
    await assert.rejects(run(f,f.makeAccount({witness}),local));
    assert.equal(f.counts().signatures,1);assert.equal(f.counts().sends,0);assert.equal(local.get(f.goal.id).status,'pending');
    assert.equal((await delegate.inspect(OWNER)).state.trial.original_hash,local.get(f.goal.id).tx_hash);
  }finally{f.device.close()}
});

test('recovery rejects a changed goal, different identity, or a conflicting local original',async()=>{
  const f=await fixture();try {
    await assert.rejects(run(f,f.makeAccount(),journal()));
    const actual=(await f.witness.inspect(OWNER)).state.trial.original_hash;
    const bad=journal();bad.put(f.goal.id,{fingerprint:'0'.repeat(64),status:'pending',oracle_goal:f.goal,
      agent_public_key:f.review.agent_public_key,tx_hash:hash(99)});
    await assert.rejects(recover(f,bad));assert.equal(bad.get(f.goal.id).tx_hash,hash(99));
    await assert.rejects(recoverWitnessedNativeOracle({goal:{...f.goal,amount:'1'},review:f.review,identity:f.identity,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,witness:f.witness,provider:f.provider,journal:journal()}));
    assert.notEqual(actual,hash(99));assert.equal(f.counts().sends,1);
  }finally{f.device.close()}
});

test('a slow witness is followed by a fresh state check without changing the original signed block',async()=>{
  const f=await fixture(),local=journal();try {
    const delegate=f.witness,originalCompletion=f.getFreshCompletion;let calls=0;
    const slow={inspect:(...a)=>delegate.inspect(...a),async claimTrial(...a){const saved=await delegate.claimTrial(...a);
      f.setClock(base+30_000);return saved}};
    const getFreshCompletion=async()=>{const value=await originalCompletion();calls++;
      if(calls>1){value.block_height=101;value.block_hash=hash(70)}return value};
    await assert.rejects(run(f,f.makeAccount({witness:slow,getFreshCompletion}),local),/unresolved.*do not resend/);
    assert.equal(f.counts().signatures,1);assert.equal(f.counts().sends,1);assert.equal(calls,2);
    assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).record.block_hash,hash(9));
  }finally{f.device.close()}
});

test('the device rejects a changed witness receipt or pinned goal before signing',async()=>{
  for(const change of [w=>({...w,goal_sha256:'f'.repeat(64)}),w=>({...w,original_hash:hash(80)}),
    w=>({...w,witness_head:'f'.repeat(40)}),w=>({...w,agent_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey())})]){
    const f=await fixture();try {
      const requestPhoneSignature=request=>f.requestPhoneSignature({...request,witness:change(request.witness)});
      await assert.rejects(run(f,f.makeAccount({requestPhoneSignature}),journal()));
      assert.equal(f.counts().sends,0);
      assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'NO_LOCAL_ORIGINAL');
      assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
    }finally{f.device.close()}
  }
});

test('a second device verifies fabricated FINAL delivery and refund using the independently retained hash',async()=>{
  const f=await fixture();try {
    await assert.rejects(run(f,f.makeAccount(),journal()),/unresolved.*do not resend/);
    const original=(await f.witness.inspect(OWNER)).state.trial.original_hash,goal=f.goal,project=goal.route.project;
    const blockHash=hash(90),bouncerReceipt=hash(91),requestReceipt=hash(92),completedReceipt=hash(93),refundReceipt=hash(94);
    const charged='10000000000000000000000',refunded='90000000000000000000000';
    const source={WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}};
    const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
    const event=(name,data)=>`EVENT_JSON:${JSON.stringify({standard:'near-outlayer',version:'1.0.0',event:name,data:[data]})}`;
    const data={success:true,token_id:'near',source:'custom',price_usd:2.75,timestamp:Math.floor(base/1000)};
    const request={sender_id:OWNER,predecessor_id:VAULT,payment:goal.amount,input_data:project.input_data,code_source:source,
      project_id:ORACLE_PROJECT_ID,project_uuid:ORACLE_PROJECT_UUID,attached_usd:'0'};
    const completion={success:true,sender_id:OWNER,code_source:source,payment_charged:charged,payment_refunded:refunded};
    const limits={max_instructions:project.max_instructions,max_memory_mb:project.max_memory_mb,max_execution_seconds:project.max_execution_seconds};
    const outlayerArgs={source:{Project:{project_id:ORACLE_PROJECT_ID,version_key:project.version_key}},resource_limits:limits,
      input_data:project.input_data,secrets_ref:null,response_format:'Json',payer_account_id:OWNER,params:null};
    const outcome=(id,executor_id,status,logs=[])=>({id,block_hash:blockHash,outcome:{executor_id,status,logs}});
    const receipt=(id,predecessor_id,receiver_id,actions)=>({receipt_id:id,predecessor_id,receiver_id,receipt:{Action:{actions}}});
    const chain={final_execution_status:'FINAL',status:{SuccessValue:encode(data)},transaction_outcome:{id:original},
      transaction:{hash:original,signer_id:OWNER,receiver_id:VAULT,public_key:String(f.publicKey),
        actions:[{FunctionCall:{method_name:'execute_outlayer_native_project',deposit:'0',args:encode({policy_id:goal.policy_id,amount:goal.amount,expected_route:goal.route})}}]},
      receipts_outcome:[outcome(bouncerReceipt,VAULT,{SuccessReceiptId:requestReceipt},['BOUNCER independent native project initiated; full maximum reserved']),
        outcome(requestReceipt,'outlayer.testnet',{SuccessReceiptId:completedReceipt},[event('execution_requested',{request_data:JSON.stringify(request)})]),
        outcome(completedReceipt,'outlayer.testnet',{SuccessValue:encode(data)},[event('execution_completed',completion)]),
        outcome(refundReceipt,OWNER,{SuccessValue:''})],
      receipts:[receipt(requestReceipt,VAULT,'outlayer.testnet',[{FunctionCall:{method_name:'request_execution',deposit:goal.amount,args:encode(outlayerArgs)}}]),
        receipt(refundReceipt,'outlayer.testnet',OWNER,[{Transfer:{deposit:refunded}}])]};
    f.provider.txStatusReceipts=async(tx,owner,wait)=>{assert.equal(tx,original);assert.equal(owner,OWNER);assert.equal(wait,'FINAL');return structuredClone(chain)};
    f.provider.block=async({blockId})=>{assert.equal(blockId,blockHash);return {header:{hash:blockHash,timestamp_nanosec:(BigInt(base)*1_000_000n).toString()}}};
    const recovered=journal(),result=await recover(f,recovered);
    assert.equal(result.status,'REUSED');assert.equal(result.delivery.tx_hash,original);assert.equal(result.delivery.charged_yocto,charged);
    assert.equal(result.delivery.refunded_to_owner_yocto,refunded);assert.equal(recovered.get(goal.id).status,'completed');
    assert.equal(f.counts().sends,1);assert.equal(f.counts().signatures,1);
  }finally{f.device.close()}
});

test('owner-authenticated witness composes with the phone signer and the one-send runner',async()=>{
  const f=await fixture();try {
    let issued,consumed=false,prompts=0;
    const auth={async issue(action){issued=structuredClone(action);return {challenge_id:'a'.repeat(32)}},
      async authenticate({action,evidence}){if(consumed || evidence?.owner_signature!=='synthetic' || JSON.stringify(action)!==JSON.stringify(issued))return false;
        consumed=true;return true}};
    const otherWitness={async inspect(){return {head:(await f.witness.inspect(OWNER)).head,state:null}}};
    const claimService=createAuthenticatedNativeOracleTrialClaim({goal:f.goal,review:f.review,identity:f.identity,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,auth,witness:f.witness,otherWitness,
      getFreshCompletion:f.getFreshCompletion,now:()=>base});
    const authorizedWitness=createOwnerAuthorizedNativeTrialWitness({claimService,identity:f.identity,
      requestOwnerEvidence:async({trial,challenge})=>{prompts++;assert.equal(trial.goal_id,f.goal.id);
        return {...challenge,owner_signature:'synthetic'}}});
    const local=journal();await assert.rejects(run(f,f.makeAccount({witness:authorizedWitness}),local),/unresolved.*do not resend/);
    assert.equal(prompts,1);assert.equal(consumed,true);assert.equal(f.counts().signatures,1);assert.equal(f.counts().sends,1);
    assert.equal((await f.witness.inspect(OWNER)).state.trial.original_hash,local.get(f.goal.id).tx_hash);
  }finally{f.device.close()}
});

test('owner authentication failure stops before the trial claim, phone signing or send',async()=>{
  const f=await fixture();try {
    const auth={async issue(){return {challenge_id:'a'.repeat(32)}},async authenticate(){return false}};
    const otherWitness={async inspect(){return {head:(await f.witness.inspect(OWNER)).head,state:null}}};
    const claimService=createAuthenticatedNativeOracleTrialClaim({goal:f.goal,review:f.review,identity:f.identity,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,auth,witness:f.witness,otherWitness,
      getFreshCompletion:f.getFreshCompletion,now:()=>base});
    const authorizedWitness=createOwnerAuthorizedNativeTrialWitness({claimService,identity:f.identity,
      requestOwnerEvidence:async()=>({owner_signature:'invalid'})});
    await assert.rejects(run(f,f.makeAccount({witness:authorizedWitness}),journal()));
    assert.equal(f.counts().signatures,0);assert.equal(f.counts().sends,0);assert.equal((await f.witness.inspect(OWNER)).state.phase,'complete');
  }finally{f.device.close()}
});

// Exercise the actual phone-side witness/sign composition, then hand its
// signed bytes to the guarded runner. The wallet, peer, RPC and send are all
// synthetic and no signed bytes are logged or sent to a network.
async function signedPhoneTrial(f) {
  const client={verifyCompletion:f.getFreshCompletion,async claimTrial({identity,trial,expectedWitnessHead}){
    const saved=await f.witness.claimTrial(identity,trial,expectedWitnessHead);
    return {status:'TRIAL_ORIGINAL_WITNESSED',owner:identity.owner,operation_id:identity.operation_id,review_sha256:identity.review_sha256,
      ...trial,witness_head:saved.head,independently_witnessed:true,do_not_retry:true,execution_authorized:false,transaction_sent:false};
  }};
  const prepared=await prepareWitnessedNativeOracleTrial({client,deviceStore:f.device,identity:f.identity,review:f.review,
    goalId:f.goal.id,origin:'https://bouncer.example',isTopLevel:true,crypto:webcrypto,isCurrent:()=>true,now:()=>base});
  return prepared.sign({ownerConfirmed:true});
}
function presignedAccount(f,signedResult,overrides={}) {
  const otherWitness={async inspect(){return {head:(await f.witness.inspect(OWNER)).head,state:null}}};
  return createPresignedWitnessedNativeOracleAccount({goal:f.goal,review:f.review,identity:f.identity,wasmBytes:wasm,
    trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,
    signedResult,witness:f.witness,otherWitness,getFreshCompletion:f.getFreshCompletion,now:()=>base,...overrides});
}

test('phone-witnessed signed bytes reach the guarded runner once and a lost send recovers the same original',async()=>{
  const f=await fixture(),local=journal();try {
    const signed=await signedPhoneTrial(f),account=presignedAccount(f,signed);
    await assert.rejects(run(f,account,local),/unresolved.*do not resend/);
    assert.equal(local.get(f.goal.id).tx_hash,signed.tx_hash);assert.equal(f.counts().sends,1);
    assert.equal((await f.witness.inspect(OWNER)).state.trial.original_hash,signed.tx_hash);
    const recovered=journal();await assert.rejects(recover(f,recovered),/synthetic original not yet found/);
    assert.equal(recovered.get(f.goal.id).tx_hash,signed.tx_hash);
    await assert.rejects(run(f,presignedAccount(f,signed),local),/synthetic original not yet found/);
    assert.equal(f.counts().sends,1);
  }finally{f.device.close()}
});

test('tampered signature, hash, reviewed goal or phone-result flags are refused before a send',async()=>{
  const f=await fixture();try {
    const signed=await signedPhoneTrial(f),corrupt=Uint8Array.from(signed.signed_transaction);corrupt[corrupt.length-1]^=1;
    assert.throws(()=>presignedAccount(f,{...signed,signed_transaction:corrupt}));
    assert.throws(()=>presignedAccount(f,{...signed,tx_hash:hash(80)}));
    assert.throws(()=>presignedAccount(f,{...signed,witnessed_original_matched:false}));
    assert.throws(()=>presignedAccount(f,signed,{goal:{...f.goal,amount:'1'}}));
    assert.equal(f.counts().sends,0);
  }finally{f.device.close()}
});

test('changed nonce or witness peer stops the presigned handoff before journaling or sending',async()=>{
  for(const mode of ['nonce','peer']){
    const f=await fixture(),local=journal();try {
      const signed=await signedPhoneTrial(f);
      if(mode==='nonce')f.setNonce('78');
      const otherWitness=mode==='peer'?{async inspect(){return {head:'f'.repeat(40),state:null}}}:undefined;
      const account=presignedAccount(f,signed,otherWitness?{otherWitness}:{});
      await assert.rejects(run(f,account,local));
      assert.equal(local.get(f.goal.id),undefined);assert.equal(f.counts().sends,0);
    }finally{f.device.close()}
  }
});

test('a lost witness after journal commit blocks the send and preserves the original',async()=>{
  const f=await fixture(),local=journal();try {
    const signed=await signedPhoneTrial(f);let reads=0;
    const otherWitness={async inspect(){reads++;if(reads>=3)throw Error('synthetic witness outage');
      return {head:(await f.witness.inspect(OWNER)).head,state:null}}};
    await assert.rejects(run(f,presignedAccount(f,signed,{otherWitness}),local));
    assert.equal(local.get(f.goal.id).status,'pending');assert.equal(local.get(f.goal.id).tx_hash,signed.tx_hash);
    assert.equal(f.counts().sends,0);
  }finally{f.device.close()}
});

test('two presigned handoffs sharing one journal cannot send twice',async()=>{
  const f=await fixture(),local=journal();try {
    const signed=await signedPhoneTrial(f),first=presignedAccount(f,signed),second=presignedAccount(f,signed);
    const outcomes=await Promise.allSettled([run(f,first,local),run(f,second,local)]);
    assert.equal(outcomes.filter(result=>result.status==='rejected').length,2);
    assert.ok(outcomes.some(result=>/another payment operation/.test(result.reason?.message ?? '')));
    assert.equal(local.get(f.goal.id).tx_hash,signed.tx_hash);assert.equal(f.counts().sends,1);assert.equal(f.counts().statusReads,0);
  }finally{f.device.close()}
});

test('the handoff copies caller bytes and cannot be used to sign an arbitrary action',async()=>{
  const f=await fixture(),local=journal();try {
    const signed=await signedPhoneTrial(f),account=presignedAccount(f,signed);
    await assert.rejects(account.signer.signTransaction({}));
    signed.signed_transaction.fill(0); // only the adapter's earlier verified copy may be used
    await assert.rejects(run(f,account,local),/unresolved.*do not resend/);
    assert.equal(f.counts().sends,1);assert.equal(local.get(f.goal.id).tx_hash,signed.tx_hash);
    await assert.rejects(account.signer.signTransaction({}));
  }finally{f.device.close()}
});

test('the presigned account rejects a different call before the runner can journal it',async()=>{
  const f=await fixture();try {
    const signed=await signedPhoneTrial(f),account=presignedAccount(f,signed);
    const bad=nearApi.transactions.functionCall('execute_outlayer_native_project',
      {policy_id:f.goal.policy_id,amount:'1',expected_route:f.goal.route},300n*10n**12n,0n);
    await assert.rejects(account.createTransaction(VAULT,[bad],f.publicKey));
    await assert.rejects(account.createTransaction(VAULT,[bad],f.publicKey));
    assert.equal(f.counts().sends,0);
  }finally{f.device.close()}
});

test('a nonce change after pending-journal retention blocks the single send',async()=>{
  const f=await fixture(),local=journal();try {
    const signed=await signedPhoneTrial(f);let reads=0;
    const getFreshCompletion=async()=>{const value=await f.getFreshCompletion();if(++reads===2)value.agent_key_nonce='78';return value};
    await assert.rejects(run(f,presignedAccount(f,signed,{getFreshCompletion}),local));
    assert.equal(reads,2);assert.equal(local.get(f.goal.id).tx_hash,signed.tx_hash);assert.equal(local.get(f.goal.id).status,'pending');
    assert.equal(f.counts().sends,0);
  }finally{f.device.close()}
});

test('stale or inconsistent completion evidence cannot release the presigned transaction',async()=>{
  for(const mode of ['stale','originals','head']){
    const f=await fixture(),local=journal();try {
      const signed=await signedPhoneTrial(f);
      const getFreshCompletion=async()=>{const value=await f.getFreshCompletion();
        if(mode==='originals')value.prior_original_hashes[2]=hash(80);
        if(mode==='head')value.witness_head='f'.repeat(40);
        return value};
      const account=presignedAccount(f,signed,{getFreshCompletion,...(mode==='stale'?{now:()=>base+6000}:{})});
      await assert.rejects(run(f,account,local));
      assert.equal(local.get(f.goal.id),undefined);assert.equal(f.counts().sends,0);
    }finally{f.device.close()}
  }
});

// Browser submission tests below use a fabricated witness, phone key and RPC.
// No signed testnet transaction leaves this process.
async function submitArgs(f,signed,extra={}) {
  return {signedResult:signed,review:f.review,identity:f.identity,completion:await f.getFreshCompletion(),
    deviceStore:f.device,indexedDB:f.indexedDB,origin:'https://bouncer.example',isTopLevel:true,crypto:webcrypto,
    isCurrent:()=>true,now:()=>base,...extra};
}
test('phone submission records the witnessed original before exactly one testnet RPC call',async()=>{
  const f=await fixture();try {
    const signed=await signedPhoneTrial(f),original=signed.tx_hash;let calls=0,fetchError;
    const fetch=async (url,options)=>{ try {
      calls++;assert.equal(url,'https://rpc.testnet.near.org');assert.equal(options.redirect,'error');
      assert.equal(options.credentials,'omit');assert.equal(options.method,'POST');
      const request=JSON.parse(options.body);assert.equal(request.method,'send_tx');assert.equal(request.params.wait_until,'FINAL');
      const tx=nearApi.transactions.SignedTransaction.decode(Buffer.from(request.params.signed_tx_base64,'base64'));
      assert.deepEqual(Buffer.from(tx.transaction.publicKey.ed25519Key.data),Buffer.from(nearApi.utils.PublicKey.from(f.review.agent_public_key).ed25519Key.data));
      const local=await inspectLocalNativeSubmission(f.indexedDB,f.review.review_sha256);
      assert.equal(local.original_hash,original);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{transaction:{hash:original},transaction_outcome:{id:original}}}),
        {status:200,headers:{'content-type':'application/json'}});
      } catch (error) { fetchError=error; throw error; }
    };
    const args=await submitArgs(f,signed,{fetch});
    const result=await submitWitnessedNativeOracleTrialOnce(args);
    if(fetchError)throw fetchError;
    assert.deepEqual(result,{status:'ORIGINAL_RPC_ACKNOWLEDGED',original_hash:original,do_not_retry:true,provider_delivery_verified:false});
    assert.equal(calls,1);assert.equal(signed.signed_transaction.every(byte=>byte===0),true);
    await assert.rejects(submitWitnessedNativeOracleTrialOnce(args));assert.equal(calls,1);
  }finally{f.device.close()}
});

test('lost RPC acknowledgement remains unknown and never resends',async()=>{
  const f=await fixture();try {
    const signed=await signedPhoneTrial(f),original=signed.tx_hash;let calls=0;
    const args=await submitArgs(f,signed,{fetch:async()=>{calls++;throw Error('synthetic network timeout')}});
    const result=await submitWitnessedNativeOracleTrialOnce(args);
    assert.equal(result.status,'ORIGINAL_SUBMISSION_UNKNOWN');assert.equal(result.original_hash,original);assert.equal(result.do_not_retry,true);
    assert.equal((await inspectLocalNativeSubmission(f.indexedDB,f.review.review_sha256)).original_hash,original);
    await assert.rejects(submitWitnessedNativeOracleTrialOnce(args));assert.equal(calls,1);
  }finally{f.device.close()}
});

test('concurrent cooperating tabs cannot submit the same witnessed original twice',async()=>{
  const f=await fixture();try {
    const signed=await signedPhoneTrial(f);let calls=0;
    const fetch=async()=>{calls++;throw Error('synthetic unknown response')};
    const args=await submitArgs(f,signed,{fetch});
    const result=await Promise.allSettled([submitWitnessedNativeOracleTrialOnce(args),submitWitnessedNativeOracleTrialOnce(args)]);
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.filter(x=>x.status==='rejected').length,1);
    assert.equal(result.find(x=>x.status==='fulfilled').value.status,'ORIGINAL_SUBMISSION_UNKNOWN');assert.equal(calls,1);
  }finally{f.device.close()}
});

test('tampered bytes, stale or changed state and changed owner session stop before local submission or network',async()=>{
  for(const mode of ['signature','transaction','head','nonce','originals','stale','session']){
    const f=await fixture();try {
      const signed=await signedPhoneTrial(f);let calls=0;
      const args=await submitArgs(f,signed,{fetch:async()=>{calls++;throw Error('must not be reached')}});
      if(mode==='signature')signed.signed_transaction[signed.signed_transaction.length-1]^=1;
      if(mode==='transaction')signed.signed_transaction[5]^=1;
      if(mode==='head')args.completion.witness_head='f'.repeat(40);
      if(mode==='nonce')args.completion.agent_key_nonce='78';
      if(mode==='originals')args.completion.prior_original_hashes[2]=hash(80);
      if(mode==='stale')args.now=()=>base+6_000;
      if(mode==='session')args.isCurrent=()=>false;
      await assert.rejects(submitWitnessedNativeOracleTrialOnce(args));
      assert.equal(calls,0,mode);assert.equal(await inspectLocalNativeSubmission(f.indexedDB,f.review.review_sha256),null,mode);
    }finally{f.device.close()}
  }
});

test('two-stage setup signs and submits only its witnessed synthetic trial original once',async()=>{
  const f=await fixture({atomic:true});try {
    const signed=await signedPhoneTrial(f),original=signed.tx_hash;let calls=0;
    assert.deepEqual(signed.setup_original_hashes,[hash(1),hash(2)]);
    const args=await submitArgs(f,signed,{fetch:async (_url,options)=>{
      calls++;const request=JSON.parse(options.body);
      const local=await inspectLocalNativeSubmission(f.indexedDB,f.review.review_sha256);
      assert.equal(local.original_hash,original);
      return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{transaction:{hash:original},transaction_outcome:{id:original}}}));
    }});
    const wrong=structuredClone(args.completion);wrong.prior_original_hashes=[hash(1),hash(3)];
    await assert.rejects(submitWitnessedNativeOracleTrialOnce({...args,completion:wrong}));assert.equal(calls,0);
    const result=await submitWitnessedNativeOracleTrialOnce(args);
    assert.equal(result.status,'ORIGINAL_RPC_ACKNOWLEDGED');assert.equal(result.provider_delivery_verified,false);
    assert.equal(result.original_hash,original);assert.equal(calls,1);
    await assert.rejects(submitWitnessedNativeOracleTrialOnce(args));assert.equal(calls,1);
    const restored=journal();await assert.rejects(recover(f,restored),/synthetic original not yet found/);
    assert.equal(restored.get(f.goal.id).tx_hash,original);assert.equal(f.counts().sends,0);
  }finally{f.device.close()}
});
