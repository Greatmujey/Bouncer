import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWitnessedNativeOraclePhoneAccount } from '../agent/native-oracle-phone-signer.mjs';
import { recoverWitnessedNativeOracle } from '../agent/recover-witnessed-native-oracle.mjs';
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
async function fixture() {
  let clock=base;
  const device=await openNativeOracleDeviceKey({indexedDB:new IDBFactory(),storage:{persisted:async()=>true},crypto:webcrypto,
    origin:'https://bouncer.example',isTopLevel:true,now:()=>clock});
  const key=await device.create({owner:OWNER,vault:VAULT});
  const review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:key.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),operation_id:'a'.repeat(32),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const goal={id:'native-oracle-trial-1',contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:review.per_tx_cap_yocto,
    route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
  const remote=store(),witness=createNativeOraclePromptWitness({store:remote});
  await witness.reserve(identity);
  for(let i=0;i<4;i++){
    const stage=identity.stages[i].stage_id,claim=await witness.assertClaimable(identity,stage);
    await witness.claim(identity,stage,claim);await witness.recordOriginal(identity,stage,hash(i+1));
  }
  let completionReads=0,signatures=0,nonce='77';
  const getFreshCompletion=async()=>{completionReads++;const {head}=await witness.inspect(OWNER);return {
    version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',stage_id:'verify_native_setup_completion',
    owner:OWNER,vault:VAULT,review_sha256:review.review_sha256,independently_witnessed:true,witness_head:head,
    execution_authorized:false,signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
    prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],checks:{...checks},blockers:[],observed_at:new Date(clock).toISOString(),
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
  return {device,review,identity,goal,witness,remote,provider,publicKey,makeAccount,getFreshCompletion,requestPhoneSignature,
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
