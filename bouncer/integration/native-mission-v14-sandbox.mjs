#!/usr/bin/env node
/** Completely isolated nearcore mission with a FABRICATED provider contract.
 * The provider does not run code or contact an API. All accounts, keys, RPC,
 * storage, registry, outputs and transfers are disposable and loopback-only.
 * This is not a live OutLayer fulfillment or independent-provider evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { runNativeMission } from '../agent/native-mission.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const {transactions:tx}=nearApi, N=10n**24n, T=10n**12n;
const OWNER='mission-buyer.testnet', VAULT=`native.${OWNER}`, PROVIDER='outlayer.testnet';
const pair=()=>nearApi.KeyPair.fromRandom('ed25519'), pub=k=>String(k.getPublicKey());
const account=(id,provider,key)=>new nearApi.Account(id,provider,new nearApi.KeyPairSigner(key));
const call=(method,args={},deposit=0n,gas=30n*T)=>tx.functionCall(method,args,gas,deposit);
const program={url:'https://example.test/not-real.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',
  max_instructions:10_000_000,max_memory_mb:128,max_execution_seconds:60};
async function main() {
  const binary=process.env.BOUNCER_SANDBOX_BIN, vaultWasm=fs.readFileSync(process.env.BOUNCER_V14_WASM_PATH),
    providerWasm=fs.readFileSync(process.env.BOUNCER_FAKE_OUTLAYER_WASM_PATH);
  readVerifiedFile(binary,SANDBOX_SHA256);
  for(const wasm of [vaultWasm,providerWasm]) assert.ok(wasm.length>8 && wasm.length<2_000_000 && wasm.subarray(0,4).equals(Buffer.from([0,97,115,109])));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v14-mission-'));
  const rootSeed=pair(),ownerKey=pair(),fakeKey=pair(),keys={compute:pair(),price:pair(),store:pair()};
  let sandbox,journal;
  try {
    sandbox=await startSandbox(binary,dir,pub(rootSeed)); const {provider,rpcUrl}=sandbox;
    const report=await withSandboxOnlyFetch(rpcUrl,async()=>{
      assertSandboxStatus(await provider.status());
      const root=account('testnet',provider,sandbox.rootKey), owner=account(OWNER,provider,ownerKey);
      const send=(signer,receiverId,actions)=>signer.signAndSendTransaction({receiverId,actions,waitUntil:'FINAL',throwOnFailure:false});
      const must=async(signer,receiver,actions,label)=>{const r=await send(signer,receiver,actions);requireFinalSuccess(r,label);return r;};
      for(const [id,k] of [[OWNER,ownerKey],[PROVIDER,fakeKey]])
        await must(root,id,[tx.createAccount(),tx.transfer(100n*N),tx.addKey(k.getPublicKey(),tx.fullAccessKey())],`create disposable ${id}`);
      await must(account(PROVIDER,provider,fakeKey),PROVIDER,[tx.deployContract(providerWasm),call('new')],'deploy fake provider locally');
      await must(owner,VAULT,[tx.createAccount(),tx.transfer(20n*N),tx.deployContract(vaultWasm),call('new',{owner:OWNER})],'deploy local V14 vault');
      const methods={compute:'execute_outlayer',price:'execute_outlayer_native_project',store:'execute_native_storage'};
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
      const make=(suffix='')=>({version:1,id:`sandbox-mission${suffix}`,contract_id:VAULT,owner_account_id:OWNER,
        max_native_amount:String(3n*N/10n),required_resources:['compute','api','storage'],goals:[
          {kind:'random',goal:{id:`compute${suffix}`,contract_id:VAULT,owner_account_id:OWNER,policy_id:'compute',amount:String(N/10n),input:{min:1,max:100},program}},
          {kind:'oracle',goal:{id:`price${suffix}`,contract_id:VAULT,owner_account_id:OWNER,policy_id:'price',amount:String(N/10n),route:priceRoute,max_age_seconds:300}},
          {kind:'storage',goal:{id:`store${suffix}`,contract_id:VAULT,contract_code_hash:codeHash,owner_account_id:OWNER,policy_id:'store',amount:String(N/10n),
            object_id:`mission-results${suffix}`,value:{from_goal_ids:[`compute${suffix}`,`price${suffix}`]},route:storageRoute}},
        ]});
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
      return {scope:'isolated nearcore and fabricated provider; no public chain or real service',
        three_guarded_legs_and_public_result_storage:true, sandbox_refunds_verified:true,
        original_hash_recovery_without_new_send:true, lost_response_recovered_and_remaining_legs_continued:true,
        independent_delivery_verified:false, public_chain_transactions:false};
    });
    console.log(JSON.stringify(report,null,2));
  } finally {journal?.close();if(sandbox)await stopSandboxChild(sandbox.child);fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error('Isolated native mission FAILED:',error?.stack??String(error));process.exitCode=1;});
