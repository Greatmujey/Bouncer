import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash,webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';
import { createNativeOraclePhoneSigner, createNativeOraclePhoneAccount } from '../agent/native-oracle-phone-signer.mjs';
import { runOracleGoal, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-outlayer.mjs';

// Disposable keys, locally fabricated completion and no network or broadcast.
const wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const OWNER='alice.testnet',VAULT=`native.${OWNER}`,origin='https://bouncer.example',base=1_800_000_000_000;
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
async function fixture(changes={}) {
  let clock=base;
  const env={indexedDB:new IDBFactory(),storage:{persisted:async()=>true},crypto:webcrypto,origin,isTopLevel:true,
    now:()=>clock,...changes};
  const device=await openNativeOracleDeviceKey(env),made=await device.create({owner:OWNER,vault:VAULT});
  const review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner:OWNER,vault:VAULT,policy_id:'price',agent_public_key:made.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:OWNER,owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),operation_id:'a'.repeat(32),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const completion={version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',
    stage_id:'verify_native_setup_completion',owner:OWNER,vault:VAULT,review_sha256:review.review_sha256,
    independently_witnessed:true,witness_head:'c'.repeat(40),execution_authorized:false,signing_authorized:false,transaction_sent:false,
    owner_approval_obtained:false,wallet_prompt_authorized:false,
    prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],checks:{...checks},blockers:[],observed_at:new Date(base).toISOString(),
    block_hash:hash(9),block_height:100,block_timestamp_nanosec:(BigInt(base)*1_000_000n).toString(),agent_key_nonce:'77'};
  const args={policy_id:review.policy_id,amount:review.per_tx_cap_yocto,
    expected_route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
  const tx=nearApi.transactions.createTransaction(OWNER,nearApi.utils.PublicKey.from(review.agent_public_key),VAULT,78n,
    [nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)],Buffer.alloc(32,9));
  const expectedTransactionHash=nearApi.utils.serialize.base_encode(createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
  return {env,device,review,identity,completion,args:{review,identity,completion,ownerConfirmed:true,expectedTransactionHash},setClock:v=>{clock=v}};
}

test('a non-extractable phone key signs the exact NEAR transaction after recording its original hash',async()=>{
  const f=await fixture();try {
    const result=await f.device.signNativeOracleTrial(f.args);
    assert.equal(result.status,'SIGNED_NOT_BROADCAST');assert.equal(result.transaction_sent,false);
    assert.equal(result.broadcast_authorized,false);assert.equal(result.do_not_retry,true);assert.equal(result.local_original_retained,true);
    const tx=nearApi.transactions.SignedTransaction.decode(result.signed_transaction),unsigned=nearApi.transactions.encodeTransaction(tx.transaction);
    const digest=createHash('sha256').update(unsigned).digest();
    assert.equal(result.tx_hash,nearApi.utils.serialize.base_encode(digest));
    assert.equal(tx.transaction.signerId,OWNER);assert.equal(tx.transaction.receiverId,VAULT);
    assert.equal(`ed25519:${nearApi.utils.serialize.base_encode(Uint8Array.from(tx.transaction.publicKey.ed25519Key.data))}`,f.review.agent_public_key);
    assert.equal(tx.transaction.nonce,78n);
    assert.deepEqual([...tx.transaction.blockHash],[...Buffer.alloc(32,9)]);
    assert.equal(tx.transaction.actions.length,1);const action=tx.transaction.actions[0];
    assert.deepEqual(Object.keys(action),['functionCall']);assert.equal(action.functionCall.methodName,'execute_outlayer_native_project');
    assert.equal(action.functionCall.deposit,0n);assert.equal(action.functionCall.gas,300n*10n**12n);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(action.functionCall.args))),{policy_id:'price',amount:f.review.per_tx_cap_yocto,
      expected_route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}});
    assert.deepEqual(Object.keys(tx.signature),['ed25519Signature']);
    assert.equal(nearApi.utils.PublicKey.from(f.review.agent_public_key).verify(digest,Uint8Array.from(tx.signature.ed25519Signature.data)),true);
    const local=await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256});
    assert.equal(local.record.tx_hash,result.tx_hash);assert.equal(local.record.nonce,'78');assert.equal(local.record.block_hash,hash(9));
    assert.equal(Object.hasOwn(local.record,'signed_transaction'),false);assert.equal(Object.hasOwn(local.record,'private_key'),false);
    await assert.rejects(f.device.signNativeOracleTrial(f.args),/already recorded/);
  }finally{f.device.close()}
});

test('changed review, absent consent, stale or mismatched completion fail before any local original is recorded',async()=>{
  const f=await fixture();try {
    const bad=[
      {...f.args,ownerConfirmed:false},
      {...f.args,expectedTransactionHash:hash(8)},
      {...f.args,review:{...f.review,payee:'evil.testnet'}},
      {...f.args,identity:{...f.identity,owner_public_key:f.review.agent_public_key}},
      {...f.args,completion:{...f.completion,blockers:['policy']}},
      {...f.args,completion:{...f.completion,checks:{...checks,exact_agent_key:false}}},
      {...f.args,completion:{...f.completion,prior_original_hashes:[hash(1),hash(1),hash(3),hash(4)]}},
      {...f.args,completion:{...f.completion,independently_witnessed:false}},
      {...f.args,completion:{...f.completion,agent_key_nonce:'18446744073709551615'}},
      {...f.args,completion:{...f.completion,agent_key_nonce:String(Number.MAX_SAFE_INTEGER)}},
      {...f.args,completion:{...f.completion,block_timestamp_nanosec:(BigInt(base-120_001)*1_000_000n).toString()}},
      {...f.args,completion:{...f.completion,block_hash:'bad'}},
    ];
    for(const item of bad)await assert.rejects(f.device.signNativeOracleTrial(item));
    f.setClock(base+5001);await assert.rejects(f.device.signNativeOracleTrial(f.args));
    assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'NO_LOCAL_ORIGINAL');
  }finally{f.device.close()}
});

test('two tabs cannot sign two transactions for the same locally retained trial',async()=>{
  const f=await fixture(),other=await openNativeOracleDeviceKey(f.env);try {
    const results=await Promise.allSettled([f.device.signNativeOracleTrial(f.args),other.signNativeOracleTrial(f.args)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
    assert.equal((await other.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'LOCAL_ORIGINAL_RETAINED');
    other.close();const reopened=await openNativeOracleDeviceKey(f.env);
    try{await assert.rejects(reopened.signNativeOracleTrial(f.args),/already recorded/)}finally{reopened.close()}
  }finally{f.device.close();other.close()}
});

test('a failure after the local original commits cannot generate a replacement transaction',async()=>{
  let failTransactionSign=false;
  const custom={getRandomValues:bytes=>webcrypto.getRandomValues(bytes),subtle:{
    generateKey:(...a)=>webcrypto.subtle.generateKey(...a),exportKey:(...a)=>webcrypto.subtle.exportKey(...a),
    digest:(...a)=>webcrypto.subtle.digest(...a),verify:(...a)=>webcrypto.subtle.verify(...a),
    sign:(algorithm,key,input)=>{if(failTransactionSign && input.byteLength===32)throw Error('synthetic signing failure');
      return webcrypto.subtle.sign(algorithm,key,input)},
  }};
  const f=await fixture({crypto:custom});try {
    failTransactionSign=true;await assert.rejects(f.device.signNativeOracleTrial(f.args));
    const original=await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256});
    assert.equal(original.status,'LOCAL_ORIGINAL_RETAINED');assert.match(original.record.tx_hash,/^[1-9A-HJ-NP-Za-km-z]+$/);
    failTransactionSign=false;await assert.rejects(f.device.signNativeOracleTrial(f.args),/already recorded/);
  }finally{f.device.close()}
});

test('the existing native OutLayer runner accepts the phone signature and journals its hash before a single synthetic send',async()=>{
  const f=await fixture();try {
    const goal={id:'native-oracle-trial-1',contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:f.review.per_tx_cap_yocto,
      route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
    const rows=new Map(),journal={get:id=>rows.get(id),put:(id,row)=>rows.set(id,structuredClone(row))};let sends=0,requests=0,preflightDone=false,completionReads=0;
    // PostgreSQL JSONB may return the same review with every object reordered.
    const reverse=x=>Array.isArray(x)?x.map(reverse):x && typeof x==='object'?
      Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,reverse(v)])):x;
    const account=createNativeOraclePhoneAccount({review:reverse(f.review),wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,now:()=>base,
      getFreshCompletion:async()=>{completionReads++;assert.equal(preflightDone,true);return f.completion},
      requestPhoneSignature:async request=>{
        requests++;assert.deepEqual(request.completion,f.completion);
        return f.device.signNativeOracleTrial({...f.args,completion:request.completion,expectedTransactionHash:request.transactionHash});
      }});
    const key=nearApi.utils.PublicKey.from(f.review.agent_public_key);
    const source={WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}};
    const provider={async viewNodeStatus(){return {chain_id:'testnet'}},async viewAccessKey(){return {permission:{FunctionCall:{
      receiver_id:VAULT,method_names:['execute_outlayer_native_project']}}}},
      async callFunction(_account,method){
        if(method==='contract_version')return 'bouncer-agent-v9';if(method==='get_owner')return OWNER;
        if(method==='get_policy')return {token:'native',per_tx_cap:goal.amount,daily_cap:goal.amount};
        if(method==='get_outlayer_native_project')return structuredClone(goal.route);if(method==='is_agent_key_allowed')return true;
        if(method==='check')return [true,'ok'];if(method==='get_project')return {project_id:ORACLE_PROJECT_ID,uuid:ORACLE_PROJECT_UUID,owner:'zavodil2.testnet'};
        if(method==='get_version')return {wasm_hash:ORACLE_TESTNET_PROGRAM.sha256,source};
        if(method==='get_project_pricing'){preflightDone=true;return null}
        throw Error('unexpected synthetic view');},
      async sendTransactionOnce(signed,wait){
        sends++;assert.equal(wait,'FINAL');const pending=journal.get(goal.id);assert.equal(pending.status,'pending');
        const digest=createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest();
        assert.equal(pending.tx_hash,nearApi.utils.serialize.base_encode(digest));assert.equal(key.verify(digest,signed.signature.data),true);
        assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).record.tx_hash,pending.tx_hash);
        throw Error('synthetic lost send response'); // never a network call
      },
      async txStatusReceipts(){throw Error('synthetic receipt unknown')},
    };
    const run=()=>runOracleGoal({goal,provider,account,publicKey:key,journal,execute:true,log:()=>{}});
    await assert.rejects(run(),/unresolved.*do not resend/);
    assert.equal(completionReads,1);assert.equal(requests,1);assert.equal(sends,1);assert.equal(journal.get(goal.id).status,'pending');
    await assert.rejects(run(),/synthetic receipt unknown/);
    assert.equal(requests,1);assert.equal(sends,1,'recovery checks the same original and never broadcasts again');
  }finally{f.device.close()}
});

test('phone signer refuses a changed action before requesting a signature and never retries an unknown phone result',async()=>{
  const f=await fixture();try {
    let requests=0;const signer=createNativeOraclePhoneSigner({review:f.review,wasmBytes:wasm,trustedReviewHash:f.review.review_sha256,
      trustedOwnerPublicKey:f.identity.owner_public_key,requestPhoneSignature:async()=>{requests++;throw Error('synthetic transport lost')}});
    const key=nearApi.utils.PublicKey.from(f.review.agent_public_key);
    const route={project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true};
    const args={policy_id:'price',amount:f.review.per_tx_cap_yocto,expected_route:route};
    const build=deposit=>nearApi.transactions.createTransaction(OWNER,key,VAULT,78n,
      [nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,deposit)],Buffer.alloc(32,9));
    await assert.rejects(signer.signTransaction(build(1n)));assert.equal(requests,0);
    await assert.rejects(signer.signTransaction(build(0n)));assert.equal(requests,1);
    await assert.rejects(signer.signTransaction(build(0n)));assert.equal(requests,1);
  }finally{f.device.close()}
});

test('the phone account uses the completion nonce/block and stops on stale snapshots or changed receiver',async()=>{
  const f=await fixture();try {
    let clock=base,requests=0;
    const makeAccount=()=>createNativeOraclePhoneAccount({review:f.review,completion:f.completion,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,now:()=>clock,
      requestPhoneSignature:async()=>{requests++;throw Error('not expected')}});
    const account=makeAccount(),staleAccount=makeAccount();
    const key=await account.signer.getPublicKey(),args={policy_id:'price',amount:f.review.per_tx_cap_yocto,
      expected_route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
    const actions=[nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)];
    const tx=await account.createTransaction(VAULT,actions,key);assert.equal(tx.nonce,78n);
    assert.deepEqual([...tx.blockHash],[...Buffer.alloc(32,9)]);
    await assert.rejects(account.createTransaction('evil.testnet',actions,key));
    clock=base+5001;await assert.rejects(staleAccount.createTransaction(VAULT,actions,key));assert.equal(requests,0);
  }finally{f.device.close()}
});

test('the runner-side adapter rejects a corrupted phone signature and preserves the local original',async()=>{
  const f=await fixture();try {
    const key=nearApi.utils.PublicKey.from(f.review.agent_public_key);
    const signer=createNativeOraclePhoneSigner({review:f.review,wasmBytes:wasm,trustedReviewHash:f.review.review_sha256,
      trustedOwnerPublicKey:f.identity.owner_public_key,requestPhoneSignature:async request=>{
        const out=await f.device.signNativeOracleTrial({...f.args,expectedTransactionHash:request.transactionHash});
        out.signed_transaction[out.signed_transaction.length-1]^=1;return out;
      }});
    const args={policy_id:'price',amount:f.review.per_tx_cap_yocto,
      expected_route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
    const tx=nearApi.transactions.createTransaction(OWNER,key,VAULT,78n,
      [nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)],Buffer.alloc(32,9));
    await assert.rejects(signer.signTransaction(tx));
    assert.equal((await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256})).status,'LOCAL_ORIGINAL_RETAINED');
    await assert.rejects(signer.signTransaction(tx));
  }finally{f.device.close()}
});

test('completion expiring immediately after the local write leaves the original fenced',async()=>{
  let calls=0,enabled=false;
  const f=await fixture({now:()=>{if(!enabled)return base;calls++;return calls>=3?base+5001:base}});try {
    enabled=true;await assert.rejects(f.device.signNativeOracleTrial(f.args));
    const local=await f.device.inspectNativeOracleOriginal({reviewSha256:f.review.review_sha256});
    assert.equal(local.status,'LOCAL_ORIGINAL_RETAINED');assert.equal(local.record.tx_hash,f.args.expectedTransactionHash);
    enabled=false;await assert.rejects(f.device.signNativeOracleTrial(f.args),/already recorded/);
  }finally{f.device.close()}
});

test('synthetic phone-signed oracle delivery and refund verify once, then recover without another signature',async()=>{
  const f=await fixture();try {
    const goal={id:'synthetic-phone-oracle',contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:f.review.per_tx_cap_yocto,
      route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
    const entries=new Map(),journal={get:id=>entries.get(id),put:(id,row)=>entries.set(id,structuredClone(row))};let requests=0,sends=0,chain;
    const account=createNativeOraclePhoneAccount({review:f.review,completion:f.completion,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,now:()=>base,
      requestPhoneSignature:request=>{requests++;return f.device.signNativeOracleTrial({...f.args,expectedTransactionHash:request.transactionHash})}});
    const key=nearApi.utils.PublicKey.from(f.review.agent_public_key);
    const source={WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}};
    const encoded=x=>Buffer.from(JSON.stringify(x)).toString('base64');
    const event=(name,data)=>`EVENT_JSON:${JSON.stringify({standard:'near-outlayer',version:'1.0.0',event:name,data:[data]})}`;
    const blockHash=hash(8),bouncerReceipt=hash(10),requestReceipt=hash(11),completedReceipt=hash(12),refundReceipt=hash(13);
    const stamp=Math.floor(base/1000),charged='10000000000000000000000',refunded='90000000000000000000000';
    const provider={async viewNodeStatus(){return {chain_id:'testnet'}},async viewAccessKey(){return {permission:{FunctionCall:{
      receiver_id:VAULT,method_names:['execute_outlayer_native_project']}}}},
      async callFunction(_account,method){
        if(method==='contract_version')return 'bouncer-agent-v9';if(method==='get_owner')return OWNER;
        if(method==='get_policy')return {token:'native',per_tx_cap:goal.amount,daily_cap:goal.amount};
        if(method==='get_outlayer_native_project')return structuredClone(goal.route);if(method==='is_agent_key_allowed')return true;
        if(method==='check')return [true,'ok'];if(method==='get_project')return {project_id:ORACLE_PROJECT_ID,uuid:ORACLE_PROJECT_UUID,owner:'zavodil2.testnet'};
        if(method==='get_version')return {wasm_hash:ORACLE_TESTNET_PROGRAM.sha256,source};if(method==='get_project_pricing')return null;
        throw Error('unexpected synthetic view');},
      async block(query){assert.equal(query.blockId,blockHash);return {header:{hash:blockHash,timestamp_nanosec:(BigInt(base)*1_000_000n).toString()}}},
      async sendTransactionOnce(signed,wait){
        sends++;assert.equal(wait,'FINAL');const pending=journal.get(goal.id);assert.equal(pending.status,'pending');
        const digest=createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest();
        assert.equal(nearApi.utils.serialize.base_encode(digest),pending.tx_hash);assert.equal(key.verify(digest,signed.signature.data),true);
        const project=goal.route.project,input=project.input_data;
        const limits={max_instructions:project.max_instructions,max_memory_mb:project.max_memory_mb,max_execution_seconds:project.max_execution_seconds};
        const signedArgs={policy_id:goal.policy_id,amount:goal.amount,expected_route:goal.route};
        const data={success:true,token_id:'near',source:'custom',price_usd:2.75,timestamp:stamp};
        const request={sender_id:OWNER,predecessor_id:VAULT,payment:goal.amount,input_data:input,code_source:source,
          project_id:ORACLE_PROJECT_ID,project_uuid:ORACLE_PROJECT_UUID,attached_usd:'0'};
        const completion={success:true,sender_id:OWNER,code_source:source,payment_charged:charged,payment_refunded:refunded};
        const outlayerArgs={source:{Project:{project_id:ORACLE_PROJECT_ID,version_key:project.version_key}},resource_limits:limits,
          input_data:input,secrets_ref:null,response_format:'Json',payer_account_id:OWNER,params:null};
        const outcome=(id,executor_id,status,logs=[])=>({id,block_hash:blockHash,outcome:{executor_id,status,logs}});
        const receipt=(id,predecessor_id,receiver_id,actions)=>({receipt_id:id,predecessor_id,receiver_id,receipt:{Action:{actions}}});
        chain={final_execution_status:'FINAL',status:{SuccessValue:encoded(data)},transaction_outcome:{id:pending.tx_hash},
          transaction:{hash:pending.tx_hash,signer_id:OWNER,receiver_id:VAULT,public_key:String(key),
            actions:[{FunctionCall:{method_name:'execute_outlayer_native_project',deposit:'0',args:encoded(signedArgs)}}]},
          receipts_outcome:[outcome(bouncerReceipt,VAULT,{SuccessReceiptId:requestReceipt},['BOUNCER independent native project initiated; full maximum reserved']),
            outcome(requestReceipt,'outlayer.testnet',{SuccessReceiptId:completedReceipt},[event('execution_requested',{request_data:JSON.stringify(request)})]),
            outcome(completedReceipt,'outlayer.testnet',{SuccessValue:encoded(data)},[event('execution_completed',completion)]),
            outcome(refundReceipt,OWNER,{SuccessValue:''})],
          receipts:[receipt(requestReceipt,VAULT,'outlayer.testnet',[{FunctionCall:{method_name:'request_execution',deposit:goal.amount,args:encoded(outlayerArgs)}}]),
            receipt(refundReceipt,'outlayer.testnet',OWNER,[{Transfer:{deposit:refunded}}])]};
        return {transaction_outcome:{id:pending.tx_hash}}; // fabricated, no RPC
      },
      async txStatusReceipts(hashValue,owner,wait){assert.equal(hashValue,journal.get(goal.id).tx_hash);assert.equal(owner,OWNER);assert.equal(wait,'FINAL');
        return structuredClone(chain)},
    };
    const run=()=>runOracleGoal({goal,provider,account,publicKey:key,journal,execute:true,log:()=>{}});
    const first=await run();assert.equal(first.status,'FULFILLED');assert.equal(first.delivery.charged_yocto,charged);
    assert.equal(first.delivery.refunded_to_owner_yocto,refunded);assert.equal(first.delivery.result.price_usd,2.75);
    assert.equal(journal.get(goal.id).status,'completed');assert.equal((await run()).status,'REUSED');
    assert.equal(requests,1);assert.equal(sends,1);
  }finally{f.device.close()}
});

test('an uncertain just-in-time completion is not retried and never reaches the phone',async()=>{
  const f=await fixture();try {
    let reads=0,requests=0;
    const account=createNativeOraclePhoneAccount({review:f.review,wasmBytes:wasm,trustedReviewHash:f.review.review_sha256,
      trustedOwnerPublicKey:f.identity.owner_public_key,now:()=>base,getFreshCompletion:async()=>{reads++;throw Error('synthetic timeout')},
      requestPhoneSignature:async()=>{requests++;throw Error('unexpected')}});
    const key=await account.signer.getPublicKey(),args={policy_id:'price',amount:f.review.per_tx_cap_yocto,
      expected_route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
    const actions=[nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)];
    await assert.rejects(account.createTransaction(VAULT,actions,key));await assert.rejects(account.createTransaction(VAULT,actions,key));
    assert.equal(reads,1);assert.equal(requests,0);
  }finally{f.device.close()}
});

test('a transaction changed after its completion snapshot never reaches the phone',async()=>{
  const f=await fixture();try {
    let requests=0;const account=createNativeOraclePhoneAccount({review:f.review,completion:f.completion,wasmBytes:wasm,
      trustedReviewHash:f.review.review_sha256,trustedOwnerPublicKey:f.identity.owner_public_key,now:()=>base,
      requestPhoneSignature:async()=>{requests++;throw Error('unexpected')}});
    const key=await account.signer.getPublicKey(),args={policy_id:'price',amount:f.review.per_tx_cap_yocto,
      expected_route:{project:f.review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
    const tx=await account.createTransaction(VAULT,[nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)],key);
    tx.blockHash[0]^=1;await assert.rejects(account.signer.signTransaction(tx));assert.equal(requests,0);
  }finally{f.device.close()}
});
