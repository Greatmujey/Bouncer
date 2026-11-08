import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createAuthenticatedNativeOracleSetupService } from '../agent/authenticated-native-oracle-setup-service.mjs';
import { createNativeOracleSetupClient } from '../web-src/native-oracle-setup-client.mjs';
import { validateWitnessedNativeOracleTrial } from '../agent/native-oracle-phone-signer.mjs';
import { ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-outlayer.mjs';

const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url)),OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const key=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const reorder=x=>Array.isArray(x)?x.map(reorder):x && typeof x==='object' ? Object.fromEntries(Object.keys(x).reverse().map(k=>[k,reorder(x[k])])) : x;
function fixture({reorderedReview=false}={}){
  const ownerKey=key(),agentKey=key(),review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,
    policy_id:'price',agent_public_key:agentKey,per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:ownerKey,operation_id:crypto.randomBytes(16).toString('hex'),review_sha256:review.review_sha256,
    stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const plan={...identity,review,stages:identity.stages.map(s=>({...s,claimed:false,original_hash:null}))};
  let head='0'.repeat(40),count=0,text='';
  const store={async read(){return {head,text}},async append(input){if(input.expectedHead!==head || input.expectedText!==text)throw Error();
    text=input.text;head=(++count).toString(16).padStart(40,'0');return {confirmed:true,head}}};
  const witness=createNativeOraclePromptWitness({store});let peerState=null;
  const otherWitness={async inspect(){return {head,state:peerState}}};
  let state='absent',issued=[];
  const fence={async inspect({ownerPublicKey,evidence}={}){if(ownerPublicKey!==ownerKey || evidence==='bad')throw Error('synthetic authentication failed');
    if(state==='absent'){const e=new Error();e.code='OWNER_FENCED';throw e}
    const output=structuredClone(plan);if(state==='mismatched')output.stages[0].claimed=true;return output}};
  const coordinator=Object.fromEntries(['reserve','claim','recordOriginal','verifyCompletion'].map(x=>[x,async()=>({})]));
  const auth={async issue(action){issued.push(action);return {action}}};
  const receiptProvider={async viewNodeStatus(){return {chain_id:'testnet'}},async txStatusReceipts(){throw Error('not available')}};
  const service=createAuthenticatedNativeOracleSetupService({auth,fence,witness,otherWitness,coordinator,
    getRetainedReview:async (id,k)=>id===review.review_sha256 && k===agentKey?{review:reorderedReview?reorder(review):review}:null,
    wasmBytes:wasm,receiptProvider,owner:OWNER});
  return {review,identity,plan,witness,otherWitness,service,receiptProvider,ownerKey,issued,setState:v=>{state=v},setPeer:v=>{peerState=v}};
}

test('native service binds challenge to retained plan and never treats absent or disagreeing journals as permission',async()=>{
  const f=fixture();await assert.rejects(f.service.issueReservation({taskId:'f'.repeat(64),ownerPublicKey:f.ownerKey,agentPublicKey:f.review.agent_public_key}));
  await assert.rejects(f.service.issueReservation({taskId:f.review.review_sha256,ownerPublicKey:f.ownerKey,agentPublicKey:key()}));
  await assert.rejects(f.service.issueReservation({taskId:f.review.review_sha256,ownerPublicKey:f.ownerKey}));
  const reservation=await f.service.issueReservation({taskId:f.review.review_sha256,ownerPublicKey:f.ownerKey,agentPublicKey:f.review.agent_public_key});
  assert.equal(reservation.action.purpose,'reserve_native_setup');assert.equal(reservation.action.review_sha256,f.review.review_sha256);
  const none=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});assert.equal(none.status,'NO_LOCAL_RECORD');
  assert.match(none.scope,/not proof/);assert.equal(none.execution_authorized,false);
  await f.witness.reserve(f.identity);f.setState('mismatched');
  const mismatch=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(mismatch.status,'RECOVERY_REQUIRED');assert.equal(mismatch.database_stages[0].claimed,true);
  assert.equal(mismatch.witnessed_records[0].event,'reserve');
  await assert.rejects(f.service.previewOriginal({ownerPublicKey:f.ownerKey,stageId:f.review.stages[0].id,originalHash:hash(9),evidence:'synthetic'}));
  f.setState('present');assert.equal((await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'})).status,'WITNESSED');
  const challenge=await f.service.issueClaim({identity:f.identity,stageId:f.review.stages[0].id});
  assert.equal(challenge.action.purpose,'claim_native_setup_stage');assert.equal(challenge.action.operation_id,f.identity.operation_id);
  await assert.rejects(f.service.issueClaim({identity:{...f.identity,review_sha256:'f'.repeat(64)},stageId:f.review.stages[0].id}));
  await assert.rejects(f.service.issueCompletion({identity:f.identity}));
});

test('a JSONB-reordered retained review remains valid, but an existing peer witness requires recovery',async()=>{
  const f=fixture({reorderedReview:true});
  assert.equal((await f.service.issueReservation({taskId:f.review.review_sha256,ownerPublicKey:f.ownerKey,agentPublicKey:f.review.agent_public_key})).action.review_sha256,f.review.review_sha256);
  f.setPeer({phase:'claimed'});
  const status=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(status.status,'RECOVERY_REQUIRED');assert.match(status.scope,/different setup flow/);
  await assert.rejects(f.service.issueReservation({taskId:f.review.review_sha256,ownerPublicKey:f.ownerKey,agentPublicKey:f.review.agent_public_key}));
});

test('a device-key mismatch or changed review blocks before any wallet transaction or server claim',async()=>{
  const f=fixture(),site={origin:'https://bouncer.example',host:'bouncer.example'},calls=[];let walletCalls=0,validDevice=false;
  const device={async inspect(){return validDevice?{status:'LOCAL_DEVICE_KEY_AVAILABLE',origin:site.origin,owner:OWNER,vault:VAULT,
    public_key:f.review.agent_public_key,expected_public_key_matched:true,private_key_exportable:false,local_storage_only:true,signing_authorized:false}
    :{status:'NO_LOCAL_DEVICE_KEY'}}};
  const wallet={manifest:{features:{signAndSendTransaction:true}},async signMessage(){walletCalls++;throw Error('unexpected')},
    async signAndSendTransaction(){walletCalls++;throw Error('unexpected')}};
  const fetchImpl=async(address)=>{calls.push(address);if(address.endsWith('/artifact'))return new Response(wasm);
    throw Error('server claim should not be called')};
  const client=createNativeOracleSetupClient({wallet,accountId:OWNER,ownerPublicKey:f.ownerKey,deviceStore:device,location:site,
    crypto:crypto.webcrypto,fetch:fetchImpl,isCurrent:()=>true,isTopLevel:true,relay:({work})=>work()});
  await assert.rejects(client.reserve({taskId:f.review.review_sha256,review:f.review}),e=>e.code==='NATIVE_DEVICE_KEY_UNAVAILABLE');
  assert.deepEqual(calls,[]);
  validDevice=true;const changed=structuredClone(f.review);changed.payee='evil.testnet';
  await assert.rejects(client.approveStage({identity:f.identity,review:changed,stageId:changed.stages[0].id}));
  assert.deepEqual(calls,['/api/native-oracle-setup/artifact']);assert.equal(walletCalls,0);
  const switched=createNativeOracleSetupClient({wallet,accountId:OWNER,ownerPublicKey:f.ownerKey,deviceStore:device,location:site,
    crypto:crypto.webcrypto,fetch:fetchImpl,isCurrent:()=>false,isTopLevel:true,relay:({work})=>work()});
  await assert.rejects(switched.reserve({taskId:f.review.review_sha256,review:f.review}),e=>e.code==='NATIVE_SETUP_SESSION_CHANGED');
});

test('completion can be freshly authenticated after the original trial hash is witnessed',async()=>{
  const f=fixture();await f.witness.reserve(f.identity);
  for(let i=0;i<f.identity.stages.length;i++){
    const stage=f.identity.stages[i].stage_id,prior=await f.witness.assertClaimable(f.identity,stage);
    await f.witness.claim(f.identity,stage,prior);await f.witness.recordOriginal(f.identity,stage,hash(i+1));
    f.plan.stages[i].claimed=true;f.plan.stages[i].original_hash=hash(i+1);
  }
  f.setState('present');
  const prior=await f.witness.inspect(OWNER),trial={goal_id:'native-oracle-trial-1',goal_sha256:'d'.repeat(64),
    agent_public_key:f.review.agent_public_key,original_hash:hash(40)};
  const claimed=await f.witness.claimTrial(f.identity,trial,prior.head);
  assert.equal(claimed.state.phase,'trial_claimed');
  assert.equal((await f.service.issueCompletion({identity:f.identity})).action.purpose,'verify_native_setup_completion');
  assert.deepEqual(await f.service.verifyCompletion({identity:f.identity,evidence:'synthetic'}),{});
  const recovered=await f.service.inspect({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(recovered.status,'WITNESSED');assert.equal(recovered.witnessed_records.at(-1).original_hash,trial.original_hash);
  await assert.rejects(f.service.issueCompletion({identity:{...f.identity,operation_id:'f'.repeat(32)}}));
});

async function syntheticTrialReceiptFixture(){
  const f=fixture();await f.witness.reserve(f.identity);
  for(let i=0;i<f.identity.stages.length;i++){
    const stage=f.identity.stages[i].stage_id,prior=await f.witness.assertClaimable(f.identity,stage);
    await f.witness.claim(f.identity,stage,prior);await f.witness.recordOriginal(f.identity,stage,hash(i+1));
    f.plan.stages[i].claimed=true;f.plan.stages[i].original_hash=hash(i+1);
  }
  f.setState('present');
  const goal={id:'native-oracle-trial-1',contract_id:f.review.vault,owner_account_id:f.review.owner,policy_id:f.review.policy_id,
    amount:f.review.per_tx_cap_yocto,route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
  const checked=validateWitnessedNativeOracleTrial({goal,review:f.review,identity:f.identity,wasmBytes:wasm,
    trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.ownerKey});
  const original=hash(40),prior=await f.witness.inspect(OWNER);
  await f.witness.claimTrial(f.identity,{goal_id:goal.id,goal_sha256:checked.goalSha256,
    agent_public_key:f.review.agent_public_key,original_hash:original},prior.head);
  const blockHash=hash(90),bouncerReceipt=hash(91),requestReceipt=hash(92),completedReceipt=hash(93),refundReceipt=hash(94);
  const charged='10000000000000000000000',refunded='90000000000000000000000',stamp=1_800_000_000;
  const source={WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}};
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
  const event=(name,data)=>`EVENT_JSON:${JSON.stringify({standard:'near-outlayer',version:'1.0.0',event:name,data:[data]})}`;
  const project=goal.route.project,data={success:true,token_id:'near',source:'custom',price_usd:2.75,timestamp:stamp};
  const request={sender_id:OWNER,predecessor_id:VAULT,payment:goal.amount,input_data:project.input_data,code_source:source,
    project_id:ORACLE_PROJECT_ID,project_uuid:ORACLE_PROJECT_UUID,attached_usd:'0'};
  const completion={success:true,sender_id:OWNER,code_source:source,payment_charged:charged,payment_refunded:refunded};
  const limits={max_instructions:project.max_instructions,max_memory_mb:project.max_memory_mb,max_execution_seconds:project.max_execution_seconds};
  const outlayerArgs={source:{Project:{project_id:ORACLE_PROJECT_ID,version_key:project.version_key}},resource_limits:limits,
    input_data:project.input_data,secrets_ref:null,response_format:'Json',payer_account_id:OWNER,params:null};
  const outcome=(id,executor_id,status,logs=[])=>({id,block_hash:blockHash,outcome:{executor_id,status,logs}});
  const receipt=(id,predecessor_id,receiver_id,actions)=>({receipt_id:id,predecessor_id,receiver_id,receipt:{Action:{actions}}});
  const chain={final_execution_status:'FINAL',status:{SuccessValue:encode(data)},transaction_outcome:{id:original},
    transaction:{hash:original,signer_id:OWNER,receiver_id:VAULT,public_key:f.review.agent_public_key,
      actions:[{FunctionCall:{method_name:'execute_outlayer_native_project',deposit:'0',args:encode({policy_id:goal.policy_id,amount:goal.amount,expected_route:goal.route})}}]},
    receipts_outcome:[outcome(bouncerReceipt,VAULT,{SuccessReceiptId:requestReceipt},['BOUNCER independent native project initiated; full maximum reserved']),
      outcome(requestReceipt,'outlayer.testnet',{SuccessReceiptId:completedReceipt},[event('execution_requested',{request_data:JSON.stringify(request)})]),
      outcome(completedReceipt,'outlayer.testnet',{SuccessValue:encode(data)},[event('execution_completed',completion)]),
      outcome(refundReceipt,OWNER,{SuccessValue:''})],
    receipts:[receipt(requestReceipt,VAULT,'outlayer.testnet',[{FunctionCall:{method_name:'request_execution',deposit:goal.amount,args:encode(outlayerArgs)}}]),
      receipt(refundReceipt,'outlayer.testnet',OWNER,[{Transfer:{deposit:refunded}}])]};
  let reads=0;
  f.receiptProvider.txStatusReceipts=async(tx,account,wait)=>{reads++;assert.equal(tx,original);assert.equal(account,OWNER);assert.equal(wait,'FINAL');return structuredClone(chain)};
  f.receiptProvider.block=async({blockId})=>{assert.equal(blockId,blockHash);return {header:{hash:blockHash,timestamp_nanosec:`${stamp}000000000`}}};
  return {...f,goal,chain,original,charged,refunded,reads:()=>reads};
}

test('authenticated trial preview verifies the witnessed original, delivery and owner refund without a send',async()=>{
  const f=await syntheticTrialReceiptFixture();
  const result=await f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'synthetic'});
  assert.equal(result.status,'FINAL_NATIVE_ORACLE_DELIVERY_MATCH');assert.equal(result.original_hash,f.original);
  assert.equal(result.delivery.charged_yocto,f.charged);assert.equal(result.delivery.refunded_to_owner_yocto,f.refunded);
  assert.equal(result.delivery.result.price_usd,2.75);assert.equal(result.provider_delivery_verified,true);
  assert.equal(result.execution_authorized,false);assert.equal(result.do_not_retry,true);assert.equal(f.reads(),1);
  assert.equal((await f.witness.inspect(OWNER)).state.phase,'trial_claimed');
});

test('trial preview refuses wrong identity, unavailable receipts, failed output or a mismatched refund',async()=>{
  const f=await syntheticTrialReceiptFixture();
  await assert.rejects(f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'bad'}));assert.equal(f.reads(),0);
  f.setPeer({phase:'other'});await assert.rejects(f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'synthetic'}));
  f.setPeer(null);f.chain.final_execution_status='EXECUTED';
  await assert.rejects(f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'synthetic'}),e=>e.code==='RECEIPT_UNKNOWN');
  f.chain.final_execution_status='FINAL';f.chain.receipts[1].receiver_id='attacker.testnet';
  await assert.rejects(f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'synthetic'}),e=>e.code==='RECEIPT_UNKNOWN');
  f.receiptProvider.txStatusReceipts=async()=>{throw Error('not found is not proof of absence')};
  await assert.rejects(f.service.previewTrial({ownerPublicKey:f.ownerKey,evidence:'synthetic'}),e=>e.code==='RECEIPT_UNKNOWN');
});
