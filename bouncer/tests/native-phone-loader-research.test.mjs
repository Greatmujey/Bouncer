import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import nearApi from 'near-api-js';
import { NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildResearchPhonePlan, verifyResearchPhoneReview, researchPhoneBatchCommitment,
  assertResearchPhoneBatchMatchesReview, prepareResearchPhoneAttempt, inspectResearchPhoneAttempt,
  NATIVE_PHONE_LOADER_BYTES, NATIVE_PHONE_LOADER_SHA256 } from '../agent/native-phone-loader-research.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const loader = fs.readFileSync(new URL('../contracts/native-phone-loader/fixtures/native-phone-loader-research.wasm', import.meta.url));
const compressed = zlib.deflateRawSync(wasm, {level:9});
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const terms = { owner:'buyer.testnet', vault:'native.buyer.testnet', policy_id:'price', agent_public_key:agentKey,
  per_tx_cap_yocto:'100000000000000000000000', daily_cap_yocto:'100000000000000000000000',
  vault_deposit_yocto:'100000000000000000000000', agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE };
const inputs = {terms,wasmBytes:wasm,loaderBytes:loader,compressedBytes:compressed,trustedOwnerPublicKey:ownerKey};
const plan = () => buildResearchPhonePlan(inputs);
function rpcAction(action) {
  if (action.enum==='createAccount') return 'CreateAccount';
  if (action.enum==='transfer') return {Transfer:{deposit:action.transfer.deposit.toString()}};
  if (action.enum==='deployContract') return {DeployContract:{code:crypto.createHash('sha256').update(action.deployContract.code).digest('base64')}};
  if (action.enum==='functionCall') return {FunctionCall:{method_name:action.functionCall.methodName,
    args:Buffer.from(action.functionCall.args).toString('base64'),gas:Number(action.functionCall.gas),deposit:action.functionCall.deposit.toString()}};
  const key=action.addKey,p=key.accessKey.permission.functionCall;
  return {AddKey:{public_key:String(key.publicKey),access_key:{nonce:Number(key.accessKey.nonce),
    permission:{FunctionCall:{allowance:p.allowance.toString(),receiver_id:p.receiverId,method_names:[...p.methodNames]}}}}};
}
function fixture(index=0,omitLocal=false) {
  const p=plan(), {review}=p, batch=p.batches[index], root=hash(2), upgrade=hash(3), actions=batch.actions.map(rpcAction);
  const anchors={review,wasmBytes:wasm,loaderBytes:loader,compressedBytes:compressed,trustedReviewHash:review.review_sha256,
    trustedOriginalHash:hash(1),trustedOwnerPublicKey:ownerKey};
  const attempt=prepareResearchPhoneAttempt({...anchors,stageId:batch.id});
  const rootOutcome={executor_id:batch.receiverId,status:index===0?{SuccessReceiptId:upgrade}:{SuccessValue:''},
    receipt_ids:index===0?[upgrade]:[],logs:index===1?['BOUNCER native deposit received']:[]};
  const result={final_execution_status:'FINAL',status:{SuccessValue:''},
    transaction:{hash:hash(1),signer_id:batch.signerId,public_key:ownerKey,receiver_id:batch.receiverId,actions:structuredClone(actions)},
    transaction_outcome:{id:hash(1),outcome:{executor_id:batch.signerId,receipt_ids:[root],status:{SuccessReceiptId:root}}},
    receipts:omitLocal?[]:[{receipt_id:root,predecessor_id:batch.signerId,receiver_id:batch.receiverId,
      receipt:{Action:{signer_id:batch.signerId,signer_public_key:ownerKey,actions:structuredClone(actions),
        input_data_ids:[],output_data_receivers:[]}}}],
    receipts_outcome:[{id:root,outcome:rootOutcome}]};
  if(index===0){
    result.receipts.push({receipt_id:upgrade,predecessor_id:review.vault,receiver_id:review.vault,receipt:{Action:{
      signer_id:review.owner,signer_public_key:ownerKey,input_data_ids:[],output_data_receivers:[],actions:[
        {DeployContract:{code:crypto.createHash('sha256').update(wasm).digest('base64')}},
        {FunctionCall:{method_name:'new',args:Buffer.from(JSON.stringify({owner:review.owner})).toString('base64'),gas:30_000_000_000_000,deposit:'0'}},
      ]}}});
    result.receipts_outcome.push({id:upgrade,outcome:{executor_id:review.vault,status:{SuccessValue:''},receipt_ids:[],logs:[]}});
  }
  return {...anchors,attempt,result};
}
const inspect = f => inspectResearchPhoneAttempt(f);
function addRefund(f,parent=0,n=4){
  const id=hash(n),owner=f.attempt.signer_id;f.result.receipts_outcome[parent].outcome.receipt_ids.push(id);
  f.result.receipts.push({receipt_id:id,predecessor_id:'system',receiver_id:owner,receipt:{Action:{signer_id:owner,
    signer_public_key:ownerKey,gas_price:'0',input_data_ids:[],output_data_receivers:[],actions:[{Transfer:{deposit:'10'}}]}}});
  f.result.receipts_outcome.push({id,outcome:{executor_id:owner,status:{SuccessValue:''},receipt_ids:[]}});
}

test('research review pins loader, compressed V9 and three constrained owner stages',()=>{
  const p=plan(),{review}=p;
  assert.equal(loader.length,NATIVE_PHONE_LOADER_BYTES);assert.equal(crypto.createHash('sha256').update(loader).digest('hex'),NATIVE_PHONE_LOADER_SHA256);
  assert.deepEqual(p.batches.map(b=>b.id),['create_compressed_native_vault','configure_fund_native_oracle','install_native_oracle_agent']);
  assert.deepEqual(p.batches.map(b=>b.actions.length),[5,5,1]);
  assert.equal(review.compressed.sha256,crypto.createHash('sha256').update(compressed).digest('hex'));
  assert.equal(review.loader.sha256,NATIVE_PHONE_LOADER_SHA256);assert.equal(review.signing_authorized,false);
  assert.equal(review.transaction_sent,false);assert.equal(review.independent_delivery_verified,false);
  assert.equal(verifyResearchPhoneReview({...inputs,review,trustedReviewHash:review.review_sha256}).wallet_prompt_authorized,false);
  p.batches.forEach((b,i)=>assert.equal(assertResearchPhoneBatchMatchesReview(b,review.stages[i]),true));
  const changed=plan().batches[0];changed.actions[4].functionCall.deposit=0n;
  assert.notEqual(researchPhoneBatchCommitment(changed),review.stages[0].action_commitment_sha256);
  assert.throws(()=>assertResearchPhoneBatchMatchesReview(changed,review.stages[0]));
});

test('rejects corrupt, substituted, overlong or trailing artifact data and invalid authority',()=>{
  const wrongLoader=Buffer.from(loader);wrongLoader[10]^=1;
  const wrongV9=Buffer.from(wasm);wrongV9[10]^=1;
  for(const patch of [{loaderBytes:wrongLoader},{wasmBytes:wrongV9},{compressedBytes:compressed.subarray(0,compressed.length-1)},
    {compressedBytes:Buffer.concat([compressed,Buffer.from([1,2,3])])},{compressedBytes:Buffer.alloc(200_001)},
    {trustedOwnerPublicKey:agentKey},{trustedOwnerPublicKey:null}]) assert.throws(()=>buildResearchPhonePlan({...inputs,...patch}));
  const alternate=zlib.deflateRawSync(wasm,{level:8});
  assert.equal(buildResearchPhonePlan({...inputs,compressedBytes:alternate}).review.compressed.sha256,crypto.createHash('sha256').update(alternate).digest('hex'));
});

test('recognizes all three originals and complete linked self-upgrade without granting authority',()=>{
  for(let i=0;i<3;i++)for(const omit of i===2?[false,true]:[false]){
    const f=fixture(i,omit),proof=inspect(f);
    assert.equal(proof.status,omit?'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH':i===0?'FINAL_RESEARCH_LOADER_AND_UPGRADE_MATCH':'FINAL_RESEARCH_NATIVE_SETUP_RECEIPT_MATCH');
    assert.equal(proof.do_not_resend,true);assert.equal(proof.current_state_verified,false);
    assert.equal(proof.independent_prompt_fence_verified,false);assert.equal(proof.wallet_prompt_authorized,false);
    assert.equal(proof.owner_approval_verified,false);assert.equal(proof.independent_delivery_verified,false);
    addRefund(f,0,4);if(i===0)addRefund(f,1,5);assert.equal(inspect(f).tx_hash,hash(1));
  }
});

test('requires separately retained review, original hash, exact owner key and all artifact bytes',()=>{
  const f=fixture();
  for(const patch of [{trustedReviewHash:'0'.repeat(64)},{trustedOriginalHash:hash(6)},{trustedOriginalHash:null},
    {trustedOwnerPublicKey:agentKey},{attempt:null},{attempt:{...f.attempt,receiver_id:'evil.testnet'}},
    {attempt:{...f.attempt,extra:true}},{compressedBytes:Buffer.alloc(0)}])assert.throws(()=>inspect({...f,...patch}));
  const review=structuredClone(f.review);review.stages[0].actions[4].self_deployment.args.owner='evil.testnet';
  assert.throws(()=>inspect({...f,review}),/review differs/);
  assert.throws(()=>prepareResearchPhoneAttempt({...f,stageId:'unknown'}));
});

test('rejects altered original actions, self-upgrade and unlinked receipt graphs',()=>{
  const changes=[
    r=>{r.final_execution_status='EXECUTED'},r=>{r.transaction.hash=hash(6)},r=>{r.transaction.public_key=agentKey},
    r=>{r.transaction.actions[2].DeployContract.code=Buffer.alloc(32).toString('base64')},
    r=>{r.transaction.actions[4].FunctionCall.deposit='0'},r=>{r.transaction.actions[4].FunctionCall.args=''},
    r=>{r.receipts[0].receipt.Action.input_data_ids=[hash(6)]},r=>{r.receipts[0].receipt.Action.actions.pop()},
    r=>{r.receipts[1].predecessor_id='evil.testnet'},r=>{r.receipts[1].receiver_id='evil.testnet'},
    r=>{r.receipts[1].receipt.Action.signer_public_key=agentKey},r=>{r.receipts[1].receipt.Action.input_data_ids=[hash(6)]},
    r=>{r.receipts[1].receipt.Action.output_data_receivers=[{receiver_id:'evil.testnet',data_id:hash(6)}]},
    r=>{r.receipts[1].receipt.Action.actions[0].DeployContract.code=Buffer.alloc(32).toString('base64')},
    r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.args=Buffer.from('{"owner":"evil.testnet"}').toString('base64')},
    r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.gas=1},
    r=>{r.receipts[1].receipt.Action.actions[1].FunctionCall.deposit='1'},
    r=>{r.receipts_outcome[0].outcome.status={SuccessReceiptId:hash(7)}},
    r=>{r.receipts_outcome[0].outcome.receipt_ids=[]},r=>{r.receipts_outcome[1].outcome.executor_id='evil.testnet'},
    r=>{r.receipts_outcome[1].outcome.receipt_ids=[hash(7)]},r=>{r.receipts.push(structuredClone(r.receipts[0]))},
    r=>{r.receipts_outcome.push(structuredClone(r.receipts_outcome[0]))},r=>{r.receipts.pop()},
    r=>{r.transaction_outcome.outcome.receipt_ids.push(hash(7))},
  ];
  for(const change of changes){const f=fixture();change(f.result);assert.throws(()=>inspect(f));}
  const f=fixture();addRefund(f);f.result.receipts.at(-1).receiver_id='evil.testnet';assert.throws(()=>inspect(f));
  const second=fixture(1);second.result.receipts_outcome[0].outcome.logs=[];assert.throws(()=>inspect(second));
  const key=fixture(2,true);key.result.transaction.actions[0].AddKey.access_key.permission='FullAccess';assert.throws(()=>inspect(key));
});

test('FINAL failure is only a state-review warning, never a retry or refund authorization',()=>{
  const f=fixture();f.result.status={Failure:{ActionError:{index:4}}};f.result.receipts_outcome[0].outcome.status=structuredClone(f.result.status);
  const proof=inspect(f);assert.equal(proof.status,'FINAL_FAILURE_NEEDS_STATE_REVIEW');assert.equal(proof.do_not_resend,true);
  assert.equal(proof.current_state_verified,false);assert.equal(proof.wallet_prompt_authorized,false);
});
