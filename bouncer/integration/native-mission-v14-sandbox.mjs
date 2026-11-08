#!/usr/bin/env node
/** Completely isolated nearcore mission with a FABRICATED provider contract.
 * The provider does not run code or contact an API. All accounts, keys, RPC,
 * storage, registry, outputs and transfers are disposable and loopback-only.
 * This is not a live OutLayer fulfillment or independent-provider evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import nearApi from 'near-api-js';
import { validateKnownFirstPartyActionRequest, MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH } from '@meteorwallet/connect-shared/internal';
import { syntheticV14MeteorRequest } from './v14-synthetic-meteor.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { runNativeMission } from '../agent/native-mission.mjs';
import { createAuthenticatedNativeMissionService } from '../agent/authenticated-native-mission-service.mjs';
import { createNativeMissionSite } from '../agent/native-mission-site.mjs';
import { nativeMissionApprovalMessage } from '../web-src/native-mission-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { buildV14PhoneResearchPlan, verifyV14PhoneResearchPlan, v14PhoneBatchCommitment } from '../agent/native-v14-phone-plan.mjs';
import { prepareV14PhoneAttempt, inspectV14PhoneAttempt } from '../agent/native-v14-phone-receipts.mjs';
import { inspectV14PhoneSetupCompletion } from '../agent/native-v14-phone-completion.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const {transactions:tx}=nearApi, N=10n**24n, T=10n**12n;
const OWNER='mission-buyer.testnet', VAULT=`native.${OWNER}`, PROVIDER='outlayer.testnet';
const INTRUDER='loader-intruder.testnet', HOLD=`hold.${OWNER}`, FAILED=`failed.${OWNER}`, LOW=`low.${OWNER}`;
const pair=()=>nearApi.KeyPair.fromRandom('ed25519'), pub=k=>String(k.getPublicKey());
const account=(id,provider,key)=>new nearApi.Account(id,provider,new nearApi.KeyPairSigner(key));
const call=(method,args={},deposit=0n,gas=30n*T)=>tx.functionCall(method,args,gas,deposit);
const program={url:'https://example.test/not-real.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',
  max_instructions:10_000_000,max_memory_mb:128,max_execution_seconds:60};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest();
const createLoader=(loader,funding=20n*N)=>[tx.createAccount(),tx.transfer(funding),tx.deployContract(loader),call('loader_init',{},1n,20n*T)];
const deployCompressed=(compressed,deposit=1n)=>call('loader_deploy',compressed,deposit,240n*T);
function failed(result,label) { assert.equal(result?.final_execution_status,'FINAL',`${label}: not FINAL`); assert.ok(result?.status?.Failure,`${label}: expected failure`); }
async function absent(provider,id) {
  let error; try { await provider.viewAccount(id,{finality:'final'}); } catch (caught) { error=caught; }
  assert.ok(error,`${id} should be absent`);
  assert.match(`${error.message ?? ''} ${JSON.stringify(error)}`,/UNKNOWN_ACCOUNT|does not exist|doesn't exist|unknown account/i);
}
// Test-only in-memory consent fence. Production uses PostgreSQL; this verifies
// the synthetic owner's actual NEP-413 signature and rejects a replay.
function syntheticConsent(ownerKey,origin) {
  let saved;
  return {
    async issue(action) {
      const issued=Date.now(),expires=issued+120_000,nonce=crypto.randomBytes(32);
      const challenge={challenge_id:crypto.randomBytes(16).toString('hex'),nonce_base64:nonce.toString('base64'),recipient:new URL(origin).host,
        message:nativeMissionApprovalMessage(action,sha(JSON.stringify(action)).toString('hex'),origin,issued,expires),expires_at_ms:expires};
      saved={action,challenge,nonce,used:false};return challenge;
    },
    async authenticate({action,evidence}) {
      if(!saved||saved.used||JSON.stringify(action)!==JSON.stringify(saved.action)||evidence?.challenge_id!==saved.challenge.challenge_id||
          evidence?.accountId!==OWNER||evidence?.publicKey!==pub(ownerKey))return false;
      const payload=nep413Payload({message:saved.challenge.message,nonce:new Uint8Array(saved.nonce),recipient:saved.challenge.recipient});
      if(!ownerKey.getPublicKey().verify(sha(payload),Buffer.from(evidence.signature??'','base64')))return false;
      saved.used=true;return true;
    },
  };
}
function siteRequest(server,{route='/',input}={}) {
  const data=input===undefined?null:JSON.stringify(input),origin='https://bouncer.example';
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:data?'POST':'GET',
      headers:{host:'bouncer.example',origin,'x-bouncer-native-mission':'v1',...(data?{'content-type':'application/json'}:{})}},res=>{
      const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(data);
  });
}
function makeMission(codeHash,priceRoute,storageRoute,suffix='') {
  return {version:1,id:`sandbox-mission${suffix}`,contract_id:VAULT,owner_account_id:OWNER,
    max_native_amount:String(3n*N/10n),required_resources:['compute','api','storage'],goals:[
      {kind:'random',goal:{id:`compute${suffix}`,contract_id:VAULT,owner_account_id:OWNER,policy_id:'compute',amount:String(N/10n),input:{min:1,max:100},program}},
      {kind:'oracle',goal:{id:`price${suffix}`,contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:String(N/10n),route:priceRoute,max_age_seconds:300}},
      {kind:'storage',goal:{id:`store${suffix}`,contract_id:VAULT,contract_code_hash:codeHash,owner_account_id:OWNER,policy_id:'store',amount:String(N/10n),
        object_id:`mission-results${suffix}`,value:{from_goal_ids:[`compute${suffix}`,`price${suffix}`]},route:storageRoute}},
    ]};
}
async function main() {
  const binary=process.env.BOUNCER_SANDBOX_BIN, vaultWasm=fs.readFileSync(process.env.BOUNCER_V14_WASM_PATH),
    providerWasm=fs.readFileSync(process.env.BOUNCER_FAKE_OUTLAYER_WASM_PATH);
  const loader=process.env.BOUNCER_V14_RESEARCH_LOADER ? fs.readFileSync(process.env.BOUNCER_V14_RESEARCH_LOADER) : null;
  readVerifiedFile(binary,SANDBOX_SHA256);
  for(const wasm of [vaultWasm,providerWasm,...(loader?[loader]:[])]) assert.ok(wasm.length>8 && wasm.length<2_000_000 && wasm.subarray(0,4).equals(Buffer.from([0,97,115,109])));
  let compressed=null, meteorBytes=null;
  if (loader) {
    compressed=zlib.deflateRawSync(vaultWasm,{level:9}); assert.ok(compressed.length<=200_000);
    assert.deepEqual(zlib.inflateRawSync(compressed),vaultWasm);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v14-mission-'));
  const rootSeed=pair(),ownerKey=pair(),fakeKey=pair(),intruderKey=pair(),keys={compute:pair(),price:pair(),store:pair()};
  const expectedCodeHash=nearApi.utils.serialize.base_encode(sha(vaultWasm));
  const expectedPrice={project:ORACLE_TESTNET_PROJECT,route_revision:1,policy_revision:1,payee_revision:1,active:true};
  const expectedStorage={prefix:'mission-',max_value_bytes:4096,route_revision:1,policy_revision:1,payee_revision:1,active:true};
  let phonePlan=null,phonePlanAnchors=null;
  if (loader) {
    const inputs={mission:makeMission(expectedCodeHash,expectedPrice,expectedStorage),ownerPublicKey:pub(ownerKey),
      agentPublicKeys:Object.fromEntries(Object.entries(keys).map(([id,k])=>[id,pub(k)])),
      gasAllowances:Object.fromEntries(Object.keys(keys).map(id=>[id,String(N/2n)])),
      dailyCaps:Object.fromEntries(Object.keys(keys).map(id=>[id,String(N)])),
      vaultStorageFundingYocto:String(20n*N),nativeDepositYocto:String(2n*N),vaultWasm,loaderWasm:loader,compressed,
      trustedArtifacts:{vault_sha256:sha(vaultWasm).toString('hex'),loader_sha256:sha(loader).toString('hex')}};
    phonePlan=buildV14PhoneResearchPlan(inputs);
    phonePlanAnchors={...inputs,review:phonePlan.review,trustedReviewSha256:phonePlan.review.review_sha256};
    verifyV14PhoneResearchPlan(phonePlanAnchors);
    const request=syntheticV14MeteorRequest(phonePlan.batches[0]); meteorBytes=Buffer.byteLength(JSON.stringify(request));
    const valid=validateKnownFirstPartyActionRequest(request);
    assert.equal(MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH,400_000); assert.equal(valid.ok,true,valid.reason);
    assert.ok(meteorBytes<380_000,`synthetic Meteor action request too large: ${meteorBytes}`);
  }
  let sandbox,journal;
  try {
    sandbox=await startSandbox(binary,dir,pub(rootSeed)); const {provider,rpcUrl}=sandbox;
    const report=await withSandboxOnlyFetch(rpcUrl,async()=>{
      assertSandboxStatus(await provider.status());
      const root=account('testnet',provider,sandbox.rootKey), owner=account(OWNER,provider,ownerKey);
      const send=(signer,receiverId,actions)=>signer.signAndSendTransaction({receiverId,actions,waitUntil:'FINAL',throwOnFailure:false});
      const must=async(signer,receiver,actions,label)=>{const r=await send(signer,receiver,actions);requireFinalSuccess(r,label);return r;};
      const setupProofs=[],setupPrior=[];
      const inspectSetup=async(index,sent)=>{
        const stage=phonePlan.batches[index],trustedOriginalHash=sent.transaction_outcome.id;
        const attempt=prepareV14PhoneAttempt({...phonePlanAnchors,stageId:stage.id,trustedOriginalHash});
        const result=await provider.txStatusReceipts(trustedOriginalHash,OWNER,'FINAL');
        const proof=inspectV14PhoneAttempt({...phonePlanAnchors,trustedOriginalHash,attempt,result});
        const expected=index===0?['FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH']:index===5?
          ['FINAL_LOCAL_ADD_KEYS_OUTCOME_MATCH','FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH']:['FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH'];
        assert.ok(expected.includes(proof.status),`unexpected ${stage.id} proof: ${proof.status}`);
        assert.equal(proof.do_not_resend,true);setupProofs.push(proof.status);setupPrior.push({attempt,trustedOriginalHash,result});
      };
      for(const [id,k] of [[OWNER,ownerKey],[PROVIDER,fakeKey],...(loader?[[INTRUDER,intruderKey]]:[])])
        await must(root,id,[tx.createAccount(),tx.transfer(100n*N),tx.addKey(k.getPublicKey(),tx.fullAccessKey())],`create disposable ${id}`);
      await must(account(PROVIDER,provider,fakeKey),PROVIDER,[tx.deployContract(providerWasm),call('new')],'deploy fake provider locally');
      if (!loader) {
        await must(owner,VAULT,[tx.createAccount(),tx.transfer(20n*N),tx.deployContract(vaultWasm),call('new',{owner:OWNER})],'deploy local V14 vault');
      } else {
        // RESEARCH ONLY: all transactions here are fenced to disposable nearcore.
        const bad=Buffer.from(compressed.subarray(0,compressed.length-100)),intruder=account(INTRUDER,provider,intruderKey);
        failed(await send(owner,FAILED,[...createLoader(loader),deployCompressed(bad)]),'bad compressed code');
        await absent(provider,FAILED);
        await must(owner,HOLD,createLoader(loader),'create research loader for access checks');
        const changedWasm=Buffer.from(vaultWasm); changedWasm[changedWasm.length-1]^=1;
        const changedCompressed=zlib.deflateRawSync(changedWasm,{level:9});
        assert.deepEqual(zlib.inflateRawSync(changedCompressed),changedWasm);
        failed(await send(owner,HOLD,[deployCompressed(changedCompressed)]),'valid compressed wrong-hash code');
        failed(await send(owner,HOLD,[call('loader_init',{},1n,20n*T)]),'loader reinitialization');
        failed(await send(intruder,HOLD,[deployCompressed(compressed)]),'non-owner deployment');
        failed(await send(intruder,HOLD,[call('loader_refund',{},1n,60n*T)]),'non-owner refund');
        failed(await send(owner,HOLD,[deployCompressed(compressed,0n)]),'zero-yocto deployment');
        failed(await send(owner,HOLD,[call('loader_refund',{},0n,60n*T)]),'zero-yocto refund');
        await must(owner,HOLD,[call('loader_refund',{},1n,60n*T)],'owner explicitly refunds research loader'); await absent(provider,HOLD);
        const lowResult=await send(owner,LOW,[...createLoader(loader,N),deployCompressed(compressed)]);
        failed(lowResult,'insufficient-storage upgrade');
        assert.match(JSON.stringify(lowResult.status.Failure),/LackBalance|Storage|storage|ActionError/i);
        assert.equal((await provider.viewAccount(LOW,{finality:'final'})).code_hash,nearApi.utils.serialize.base_encode(sha(loader)));
        assert.deepEqual((await provider.viewAccessKeyList(LOW,{finality:'final'})).keys,[]);
        failed(await send(owner,LOW,[deployCompressed(compressed)]),'pending loader cannot redeploy');
        const beforeRefund=BigInt((await provider.viewAccount(OWNER,{finality:'final'})).amount);
        await must(owner,LOW,[call('loader_refund',{},1n,60n*T)],'owner explicitly refunds failed upgrade'); await absent(provider,LOW);
        const afterRefund=BigInt((await provider.viewAccount(OWNER,{finality:'final'})).amount);
        assert.ok(afterRefund>beforeRefund+N/2n,'failed-upgrade loader funding did not return to sandbox owner');
        assert.equal(v14PhoneBatchCommitment(phonePlan.batches[0]),phonePlan.review.stages[0].action_commitment_sha256);
        const sent=await must(owner,VAULT,phonePlan.batches[0].actions,'compressed V14 research self-deploy');
        await inspectSetup(0,sent);
        const receipt=await provider.txStatusReceipts(sent.transaction_outcome.id,OWNER,'FINAL');
        const selfDeploy=receipt.receipts.filter(r=>r.predecessor_id===VAULT && r.receiver_id===VAULT &&
          r.receipt?.Action?.actions?.some(a=>a.DeployContract?.code===sha(vaultWasm).toString('base64')));
        assert.equal(selfDeploy.length,1,'matching V14 self-deployment receipt missing or duplicated');
        const actions=selfDeploy[0].receipt.Action.actions; assert.equal(actions.length,2);
        assert.equal(actions[1]?.FunctionCall?.method_name,'new');
        assert.deepEqual(JSON.parse(Buffer.from(actions[1].FunctionCall.args,'base64').toString('utf8')),{owner:OWNER});
        assert.equal((await provider.viewAccount(VAULT,{finality:'final'})).code_hash,nearApi.utils.serialize.base_encode(sha(vaultWasm)));
        assert.deepEqual((await provider.viewAccessKeyList(VAULT,{finality:'final'})).keys,[]);
        assert.equal(await provider.callFunction(VAULT,'get_owner',{}, {finality:'final'}),OWNER);
      }
      const methods={compute:'execute_outlayer',price:'execute_outlayer_native_project',store:'execute_native_storage'};
      if (phonePlan) {
        // This executes the exact unsigned plan only on disposable nearcore;
        // it is not a phone prompt or public-chain setup.
        for (let i=1;i<phonePlan.batches.length;i++) {
          const stage=phonePlan.batches[i];
          assert.equal(v14PhoneBatchCommitment(stage),phonePlan.review.stages[i].action_commitment_sha256);
          const sent=await must(owner,stage.receiverId,stage.actions,stage.id);
          await inspectSetup(i,sent);
        }
      } else {
        for(const id of Object.keys(keys)) {
          await must(owner,VAULT,[call('set_policy',{policy_id:id,token:'native',per_tx_cap:String(N/10n),daily_cap:String(N)},1n)],`policy ${id}`);
          await must(owner,VAULT,[call('allow_payee',{policy_id:id,payee:id==='store'?VAULT:PROVIDER},1n)],`allow ${id}`);
          await must(owner,VAULT,[call('grant_agent_key',{policy_id:id,public_key:pub(keys[id])},1n)],`grant ${id}`);
          await must(owner,OWNER,[tx.addKey(keys[id].getPublicKey(),tx.functionCallAccessKey(VAULT,[methods[id]],N/2n))],`restrict ${id}`);
        }
        await must(owner,VAULT,[call('set_outlayer_program',{policy_id:'compute',program},1n)],'pin fake compute');
        await must(owner,VAULT,[call('set_outlayer_native_project',{policy_id:'price',project:ORACLE_TESTNET_PROJECT},1n)],'pin fake data route');
        await must(owner,VAULT,[call('set_native_storage_route',{policy_id:'store',prefix:'mission-',max_value_bytes:4096},1n)],'pin public storage route');
        await must(owner,VAULT,[call('deposit_native',{},2n*N)],'fund local vault');
      }
      const view=(method,args={})=>provider.callFunction(VAULT,method,args,{finality:'final'});
      const priceRoute=await view('get_outlayer_native_project',{policy_id:'price'}),storageRoute=await view('get_native_storage_route',{policy_id:'store'});
      const codeHash=(await provider.viewAccount(VAULT,{finality:'final'})).code_hash;
      assert.deepEqual((await provider.viewAccessKeyList(VAULT,{finality:'final'})).keys,[]);
      const rpc=new SandboxSetupRpc(rpcUrl), originalSend=rpc.sendTransactionOnce.bind(rpc);
      const idForMethod={'execute_outlayer':'compute','execute_outlayer_native_project':'price','execute_native_storage':'store'};
      let activeIds={compute:'compute',price:'price',store:'store'};
      rpc.sendTransactionOnce=(signed,wait)=>originalSend(signed,wait,{beforeSubmit:()=>{
        const hash=nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(tx.encodeTransaction(signed.transaction)).digest());
        assert.equal(signed.transaction.signerId,OWNER);assert.equal(signed.transaction.receiverId,VAULT);
        const method=signed.transaction.actions[0]?.functionCall?.methodName, id=activeIds[idForMethod[method]];
        assert.equal(journal.get(id)?.status,'pending');assert.equal(journal.get(id)?.tx_hash,hash);
      }});
      let completion=null;
      if (phonePlan) {
        assert.equal(codeHash,expectedCodeHash);
        assert.deepEqual(priceRoute,expectedPrice); assert.deepEqual(storageRoute,expectedStorage);
        completion=await inspectV14PhoneSetupCompletion({...phonePlanAnchors,prior:setupPrior,provider:new SandboxSetupRpc(rpcUrl)});
        assert.equal(completion.status,'ORIGINALS_AND_SETUP_SNAPSHOT_MATCH_NOT_AUTHORIZED',JSON.stringify(completion.blockers));
        assert.equal(completion.wallet_prompt_authorized,false);
      }
      const make=(suffix='')=>makeMission(codeHash,priceRoute,storageRoute,suffix);
      const signers=(suffix='')=>Object.fromEntries(Object.entries(keys).map(([id,k])=>[`${id}${suffix}`,{account:account(OWNER,rpc,k),publicKey:k.getPublicKey()}]));
      journal=new FileJournal(path.join(dir,'mission-originals.json'),VAULT,OWNER);
      const run=(mission,opts={})=>runNativeMission({mission,provider:rpc,journal,log:()=>{},...opts});
      const mission=make();
      assert.equal((await run(mission,{signers:signers()})).status,'READY');assert.equal(rpc.transportCalls,0);
      const completed=await run(mission,{signers:signers(),execute:true});
      assert.equal(completed.status,'FULFILLED');assert.equal(completed.new_payments,3);assert.equal(rpc.transportCalls,3);
      const saved=JSON.parse(completed.deliveries[2].delivery.result.value);
      assert.deepEqual(saved.resources.map(x=>x.goal_id),['compute','price']);
      assert.deepEqual(saved.resources.map(x=>x.tx_hash),completed.deliveries.slice(0,2).map(x=>x.delivery.tx_hash));
      for(const delivery of completed.deliveries.slice(0,2)) assert.equal(delivery.delivery.refunded_to_owner_yocto,String(N/100n));
      const recovered=await run(mission,{signers:{},recoverOnly:true});assert.equal(recovered.status,'RECOVERED');assert.equal(rpc.transportCalls,3);
      assert.deepEqual(recovered.deliveries.map(x=>x.delivery.tx_hash),completed.deliveries.map(x=>x.delivery.tx_hash));
      // Simulate losing the response AFTER the real first sandbox submission.
      const second=make('-second');activeIds={compute:'compute-second',price:'price-second',store:'store-second'};
      rpc.loseNextAcknowledgementForTest();
      await assert.rejects(run(second,{signers:signers('-second'),execute:true}),/unresolved/);
      const original=journal.get('compute-second').tx_hash;assert.equal(rpc.transportCalls,4);
      const partial=await run(second,{signers:{},recoverOnly:true});assert.equal(partial.status,'RECOVERED_PARTIAL');
      assert.equal(partial.deliveries[0].delivery.tx_hash,original);assert.equal(rpc.transportCalls,4);
      const resumed=await run(second,{signers:signers('-second'),execute:true});
      assert.equal(resumed.status,'FULFILLED');assert.equal(resumed.new_payments,2);assert.equal(rpc.transportCalls,6);
      assert.equal(journal.get('compute-second').tx_hash,original);

      // Wire the real same-origin HTTP service to the real three guarded
      // runners. Consent and provider are still synthetic, and everything is
      // isolated to this nearcore; no browser wallet or public chain is used.
      const third=make('-http');activeIds={compute:'compute-http',price:'price-http',store:'store-http'};
      const siteOrigin='https://bouncer.example',service=createAuthenticatedNativeMissionService({mission:third,provider:rpc,
        signers:signers('-http'),journal,auth:syntheticConsent(ownerKey,siteOrigin)});
      const site=createNativeMissionSite({siteOrigin,service});
      await new Promise((resolve,reject)=>site.listen(0,'127.0.0.1',resolve).once('error',reject));
      try {
        assert.equal((await siteRequest(site)).status,200);
        const config=JSON.parse((await siteRequest(site,{route:'/api/native-mission/config'})).body),reviewHash=config.review.mission_sha256;
        const preview=JSON.parse((await siteRequest(site,{route:'/api/native-mission/preview',input:{missionSha256:reviewHash}})).body);
        assert.equal(preview.preview.status,'READY');assert.equal(rpc.transportCalls,6);
        const challenge=JSON.parse((await siteRequest(site,{route:'/api/native-mission/challenge',input:{missionSha256:reviewHash,ownerPublicKey:pub(ownerKey)}})).body);
        const payload=nep413Payload({message:challenge.message,nonce:new Uint8Array(Buffer.from(challenge.nonce_base64,'base64')),recipient:challenge.recipient});
        const evidence={challenge_id:challenge.challenge_id,accountId:OWNER,publicKey:pub(ownerKey),
          signature:Buffer.from(ownerKey.sign(sha(payload)).signature).toString('base64')};
        const input={missionSha256:reviewHash,ownerPublicKey:pub(ownerKey),evidence};
        const response=await siteRequest(site,{route:'/api/native-mission/execute',input}),executed=JSON.parse(response.body);
        assert.equal(response.status,200);assert.equal(executed.status,'FULFILLED');assert.equal(executed.new_payments,3);assert.equal(rpc.transportCalls,9);
        const list=JSON.parse((await siteRequest(site,{route:'/api/native-mission/originals',input:{missionSha256:reviewHash}})).body);
        assert.deepEqual(list.originals.map(row=>row.original_hash),executed.deliveries.map(row=>row.delivery.tx_hash));
        const receiptOnly=JSON.parse((await siteRequest(site,{route:'/api/native-mission/recover',input:{missionSha256:reviewHash}})).body);
        assert.equal(receiptOnly.status,'RECOVERED');assert.equal(receiptOnly.new_payments,0);assert.equal(rpc.transportCalls,9);
        assert.equal((await siteRequest(site,{route:'/api/native-mission/execute',input})).status,409);assert.equal(rpc.transportCalls,9);
      } finally {await new Promise(resolve=>site.close(resolve))}
      return {scope:'isolated nearcore and fabricated provider; no public chain or real service',
        research_loader:loader?{synthetic_meteor_request_bytes:meteorBytes,loader_wasm_bytes:loader.length,
          compressed_v14_bytes:compressed.length,all_unsigned_plan_stages_executed_only_in_sandbox:true,
          sandbox_original_receipt_proofs:setupProofs,sandbox_completion_snapshot:completion?.status,
          failed_upgrade_owner_refund_tested:true,real_phone_tested:false}:null,
        three_guarded_legs_and_public_result_storage:true, sandbox_refunds_verified:true,
        original_hash_recovery_without_new_send:true, lost_response_recovered_and_remaining_legs_continued:true,
        fixed_site_http_synthetic_consent_three_real_runners:true,
        independent_delivery_verified:false, public_chain_transactions:false};
    });
    console.log(JSON.stringify(report,null,2));
    if (loader && process.env.GITHUB_ACTIONS==='true') console.log(`::notice title=V14 research phone loader::Synthetic Meteor request ${meteorBytes} bytes; loader ${loader.length} bytes; compressed V14 ${compressed.length} bytes. Isolated chain and fake provider only; not a real phone, wallet approval or live fulfillment.`);
  } finally {journal?.close();if(sandbox)await stopSandboxChild(sandbox.child);fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error('Isolated native mission FAILED:',error?.stack??String(error));process.exitCode=1;});
