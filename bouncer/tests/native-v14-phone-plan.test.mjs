// Strictly synthetic unsigned reviews. No wallet, signer, chain or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { buildV14PhoneResearchPlan, verifyV14PhoneResearchPlan, v14PhoneBatchCommitment } from '../agent/native-v14-phone-plan.mjs';
import { prepareV14PhoneAttempt, inspectV14PhoneAttempt } from '../agent/native-v14-phone-receipts.mjs';
import { syntheticV14MeteorRequest } from '../integration/v14-synthetic-meteor.mjs';
import { validateKnownFirstPartyActionRequest } from '@meteorwallet/connect-shared/internal';
import { inspectV14PhoneSetupCompletion } from '../agent/native-v14-phone-completion.mjs';

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
  const request=syntheticV14MeteorRequest(batches[0]),validation=validateKnownFirstPartyActionRequest(request);
  assert.equal(validation.ok,true,validation.reason);
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

const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
function rpcAction(action) {
  if(action.enum==='createAccount')return 'CreateAccount';
  if(action.enum==='transfer')return {Transfer:{deposit:String(action.transfer.deposit)}};
  if(action.enum==='deployContract')return {DeployContract:{code:crypto.createHash('sha256').update(action.deployContract.code).digest('base64')}};
  if(action.enum==='functionCall')return {FunctionCall:{method_name:action.functionCall.methodName,args:Buffer.from(action.functionCall.args).toString('base64'),
    gas:Number(action.functionCall.gas),deposit:String(action.functionCall.deposit)}};
  const a=action.addKey,p=a.accessKey.permission.functionCall;
  return {AddKey:{public_key:String(a.publicKey),access_key:{nonce:Number(a.accessKey.nonce),permission:{FunctionCall:{
    allowance:String(p.allowance),receiver_id:p.receiverId,method_names:[...p.methodNames]}}}}};
}
function receiptFixture(index=0,omitLocal=false,inputs=fixture(),originalHash=hash(1)) {
  const plan=buildV14PhoneResearchPlan(inputs),{review}=plan,batch=plan.batches[index],root=hash(2),upgrade=hash(3);
  const anchored={...inputs,review,trustedReviewSha256:review.review_sha256,trustedOriginalHash:originalHash},
    attempt=prepareV14PhoneAttempt({...anchored,stageId:batch.id}),actions=batch.actions.map(rpcAction);
  const result={final_execution_status:'FINAL',status:{SuccessValue:''},
    transaction:{hash:originalHash,signer_id:batch.signerId,public_key:inputs.ownerPublicKey,receiver_id:batch.receiverId,actions:structuredClone(actions)},
    transaction_outcome:{id:originalHash,outcome:{executor_id:batch.signerId,receipt_ids:[root],status:{SuccessReceiptId:root}}},
    receipts:omitLocal?[]:[{receipt_id:root,predecessor_id:batch.signerId,receiver_id:batch.receiverId,
      receipt:{Action:{signer_id:batch.signerId,signer_public_key:inputs.ownerPublicKey,input_data_ids:[],output_data_receivers:[],actions:structuredClone(actions)}}}],
    receipts_outcome:[{id:root,outcome:{executor_id:batch.receiverId,status:index===0?{SuccessReceiptId:upgrade}:{SuccessValue:''},
      receipt_ids:index===0?[upgrade]:[],logs:index===4?['BOUNCER native deposit received']:[]}}]};
  if(index===0) {
    result.receipts.push({receipt_id:upgrade,predecessor_id:review.vault,receiver_id:review.vault,receipt:{Action:{
      signer_id:review.owner,signer_public_key:inputs.ownerPublicKey,input_data_ids:[],output_data_receivers:[],actions:[
        {DeployContract:{code:crypto.createHash('sha256').update(inputs.vaultWasm).digest('base64')}},
        {FunctionCall:{method_name:'new',args:Buffer.from(JSON.stringify({owner:review.owner})).toString('base64'),gas:30_000_000_000_000,deposit:'0'}}]}}});
    result.receipts_outcome.push({id:upgrade,outcome:{executor_id:review.vault,status:{SuccessValue:''},receipt_ids:[],logs:[]}});
  }
  return {...anchored,attempt,result};
}
function addRefund(f,parent=0,n=4) {
  const id=hash(n),signer=f.attempt.signer_id;f.result.receipts_outcome[parent].outcome.receipt_ids.push(id);
  f.result.receipts.push({receipt_id:id,predecessor_id:'system',receiver_id:signer,receipt:{Action:{signer_id:signer,
    signer_public_key:f.ownerPublicKey,gas_price:'0',input_data_ids:[],output_data_receivers:[],actions:[{Transfer:{deposit:'10'}}]}}});
  f.result.receipts_outcome.push({id,outcome:{executor_id:signer,status:{SuccessValue:''},receipt_ids:[]}});
}

test('only bounded original receipt graphs match the six unsigned V14 research stages',()=>{
  for(let i=0;i<6;i++)for(const omitted of i===5?[false,true]:[false]){
    const f=receiptFixture(i,omitted),proof=inspectV14PhoneAttempt(f);
    assert.equal(proof.status,omitted?'FINAL_LOCAL_ADD_KEYS_OUTCOME_MATCH':i===0?'FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH':'FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH');
    assert.equal(proof.do_not_resend,true);assert.equal(proof.current_state_verified,false);
    assert.equal(proof.independent_prompt_fence_verified,false);assert.equal(proof.wallet_prompt_authorized,false);assert.equal(proof.owner_approval_verified,false);
    addRefund(f);if(i===0)addRefund(f,1,5);assert.equal(inspectV14PhoneAttempt(f).tx_hash,hash(1));
  }
});

test('V14 original inspection rejects forged, missing, unlinked or wrong-owner evidence',()=>{
  const changes=[
    r=>{r.final_execution_status='EXECUTED'},r=>{r.transaction.hash=hash(6)},r=>{r.transaction.public_key=key()},
    r=>{r.transaction.actions[2].DeployContract.code=Buffer.alloc(32).toString('base64')},r=>{r.transaction.actions[4].FunctionCall.args=''},
    r=>{r.transaction.actions[4].FunctionCall.deposit='0'},r=>{r.receipts[0].receipt.Action.input_data_ids=[hash(6)]},
    r=>{r.receipts[1].predecessor_id='evil.testnet'},r=>{r.receipts[1].receipt.Action.signer_public_key=key()},
    r=>{r.receipts[1].receipt.Action.actions[0].DeployContract.code=Buffer.alloc(32).toString('base64')},
    r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.args=Buffer.from('{"owner":"evil.testnet"}').toString('base64')},
    r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.gas=1},r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.deposit='1'},
    r=>{r.receipts_outcome[0].outcome.receipt_ids=[]},r=>{r.receipts_outcome[1].outcome.executor_id='evil.testnet'},
    r=>{r.receipts.push(structuredClone(r.receipts[0]))},r=>{r.receipts.pop()},r=>{r.transaction_outcome.outcome.receipt_ids.push(hash(7))},
  ];
  for(const change of changes){const f=receiptFixture();change(f.result);assert.throws(()=>inspectV14PhoneAttempt(f));}
  for(const patch of [{trustedReviewSha256:'0'.repeat(64)},{trustedOriginalHash:hash(6)},{trustedOriginalHash:null},
    {attempt:null},{attempt:{...receiptFixture().attempt,receiver_id:'evil.testnet'}}]){
    assert.throws(()=>inspectV14PhoneAttempt({...receiptFixture(),...patch}));
  }
  const missingLog=receiptFixture(4);missingLog.result.receipts_outcome[0].outcome.logs=[];assert.throws(()=>inspectV14PhoneAttempt(missingLog));
  const addKeys=receiptFixture(5,true);addKeys.result.transaction.actions[1].AddKey.access_key.permission='FullAccess';
  assert.throws(()=>inspectV14PhoneAttempt(addKeys));
  const extra=receiptFixture();addRefund(extra);extra.result.receipts.at(-1).receiver_id='evil.testnet';assert.throws(()=>inspectV14PhoneAttempt(extra));
});

test('a V14 FINAL failure is a state-review warning, never retry or refund authority',()=>{
  const f=receiptFixture();f.result.status={Failure:{ActionError:{index:4}}};f.result.receipts_outcome[0].outcome.status=structuredClone(f.result.status);
  const proof=inspectV14PhoneAttempt(f);assert.equal(proof.status,'FINAL_FAILURE_NEEDS_STATE_REVIEW');assert.equal(proof.do_not_resend,true);
  assert.equal(proof.wallet_prompt_authorized,false);assert.equal(proof.current_state_verified,false);
});

function completionFixture() {
  const inputs=fixture(),plan=buildV14PhoneResearchPlan(inputs),{review}=plan,blockHash=hash(9),time=1_800_000_000_000;
  const prior=plan.batches.map((_,i)=>{const {attempt,trustedOriginalHash,result}=receiptFixture(i,i===5,inputs,hash(10+i));
    return {attempt,trustedOriginalHash,result};});
  const state={owner:{block_hash:blockHash,code_hash:hash(0)},vault:{block_hash:blockHash,code_hash:review.artifacts.vault_code_hash,amount:'10000',storage_usage:100},
    ownerKeys:{block_hash:blockHash,keys:[{public_key:inputs.ownerPublicKey,access_key:{nonce:0,permission:'FullAccess'}},
      ...review.mission.goals.map(({kind,goal})=>({public_key:inputs.agentPublicKeys[goal.id],access_key:{nonce:0,permission:{FunctionCall:{
        receiver_id:vault,allowance:inputs.gasAllowances[goal.id],method_names:[kind==='random'?'execute_outlayer':
          kind==='oracle'?'execute_outlayer_native_project':'execute_native_storage']}}}}))]},
    vaultKeys:{block_hash:blockHash,keys:[]},ledger:inputs.nativeDepositYocto};
  const provider={async viewNodeStatus(){return {chain_id:'testnet'}},async viewBlock(){return {header:{hash:blockHash,height:42,timestamp_nanosec:`${time}000000`}}},
    async experimental_protocolConfig({blockId}){assert.equal(blockId,blockHash);return {chain_id:'testnet',runtime_config:{storage_amount_per_byte:'1'}}},
    async query({request_type,account_id,block_id}){assert.equal(block_id,blockHash);
      return request_type==='view_account'?(account_id===owner?state.owner:state.vault):(account_id===owner?state.ownerKeys:state.vaultKeys);},
    async callFunctionRaw(contract,method,args,{blockId}){assert.equal(contract,vault);assert.equal(blockId,blockHash);
      const entry=review.mission.goals.find(x=>x.goal.policy_id===args.policy_id),g=entry?.goal;
      const values={contract_version:'bouncer-agent-v14-native-storage-testnet',get_owner:owner,vault_balance:state.ledger,
        get_policy:g?{token:'native',per_tx_cap:g.amount,daily_cap:review.rolling_caps_yocto[g.id]}:null,
        get_outlayer_program:g?.program,get_outlayer_native_project:g?.route,get_native_storage_route:g?.route,
        is_agent_key_allowed:true,check:[true,'ok']};
      return {block_hash:blockHash,result:[...Buffer.from(JSON.stringify(values[method]))]};}};
  return {inputs,review,prior,provider,state,now:()=>time,trustedReviewSha256:review.review_sha256};
}

test('read-only V14 completion requires all distinct originals and one fresh pinned state snapshot',async()=>{
  const f=completionFixture(),options={...f.inputs,review:f.review,prior:f.prior,provider:f.provider,now:f.now,trustedReviewSha256:f.trustedReviewSha256};
  const proof=await inspectV14PhoneSetupCompletion(options);
  assert.equal(proof.status,'ORIGINALS_AND_SETUP_SNAPSHOT_MATCH_NOT_AUTHORIZED');assert.deepEqual(proof.blockers,[]);
  assert.equal(proof.prior_original_hashes.length,6);assert.equal(proof.wallet_prompt_authorized,false);assert.equal(proof.local_key_custody_verified,false);
  assert.equal(proof.independent_delivery_verified,false);assert.equal(proof.no_inflight_request_proven,false);
  await assert.rejects(inspectV14PhoneSetupCompletion({...options,prior:f.prior.slice(0,5)}),/every earlier/);
  const repeated=structuredClone(f.prior);repeated[1].trustedOriginalHash=repeated[0].trustedOriginalHash;
  await assert.rejects(inspectV14PhoneSetupCompletion({...options,prior:repeated}),/repeated/);
  const reversed=[...f.prior].reverse();await assert.rejects(inspectV14PhoneSetupCompletion({...options,prior:reversed}),/order/);
  f.state.vault.code_hash=hash(8);assert.ok((await inspectV14PhoneSetupCompletion(options)).blockers.includes('exact_keyless_vault'));
  f.state.vault.code_hash=f.review.artifacts.vault_code_hash;f.state.vaultKeys.keys.push({public_key:key()});
  assert.ok((await inspectV14PhoneSetupCompletion(options)).blockers.includes('exact_keyless_vault'));
  f.state.vaultKeys.keys=[];f.state.ledger='0';assert.ok((await inspectV14PhoneSetupCompletion(options)).blockers.includes('deposited_and_storage_backed'));
  f.state.ledger=f.inputs.nativeDepositYocto;f.state.ownerKeys.keys[1].access_key.permission='FullAccess';
  assert.ok((await inspectV14PhoneSetupCompletion(options)).blockers.includes('compute_agent_key'));
  f.state.owner.block_hash=hash(8);await assert.rejects(inspectV14PhoneSetupCompletion(options),/mixed-block/);
  await assert.rejects(inspectV14PhoneSetupCompletion({...options,now:()=>f.now()+300_000}),/stale/);
});
