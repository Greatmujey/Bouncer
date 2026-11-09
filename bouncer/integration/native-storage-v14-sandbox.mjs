#!/usr/bin/env node
/** Disposable loopback nearcore only: no public-chain wallet or transaction.
 * Exercises the built V14 WASM AND the real JS storage runner and verifier.
 * The test adapter aliases the sandbox's checked identity to testnet solely
 * for the runner; the network fence rejects every non-loopback fetch. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { runNativeStorageGoal, recoverNativeStorageGoal } from '../agent/native-storage.mjs';
import { SandboxSetupRpc, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';
import { syntheticV14MeteorRequest } from './v14-synthetic-meteor.mjs';
import { buildV14TemporaryBootstrapPlan, signV14TemporaryBootstrapDeployment } from '../web-src/v14-bootstrap-plan.mjs';
import { createV14BootstrapCreateVerifier, V14_BOOTSTRAP_READ_RPC } from '../web-src/v14-bootstrap-create-verifier.mjs';
import { createV14BootstrapDeploymentVerifier } from '../web-src/v14-bootstrap-deployment-verifier.mjs';
import { createBootstrapTwoCopyWitness } from '../web-src/v14-bootstrap-originals.mjs';
import { createBootstrapOriginalRetainer } from '../web-src/v14-bootstrap-original-retainer.mjs';
import { bootstrapSha256 } from '../shared/v14-bootstrap-protocol.mjs';
import { sealV14BootstrapRecoveryKit, openV14BootstrapRecoveryKit } from '../web-src/v14-bootstrap-recovery-kit.mjs';
import { validateKnownFirstPartyActionRequest, MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH } from '@meteorwallet/connect-shared/internal';

const { transactions: tx } = nearApi, N = 10n ** 24n, T = 10n ** 12n;
const OWNER = 'buyer.testnet', VAULT = `store.${OWNER}`;
const pub = pair => String(pair.getPublicKey());
const call = (method, args = {}, deposit = 0n, gas = 30n * T) => tx.functionCall(method, args, gas, deposit);
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
function failed(result, pattern) {
  assert.equal(result?.final_execution_status, 'FINAL');
  assert.ok(result?.status?.Failure);
  assert.match(JSON.stringify(result.status.Failure), pattern);
}
async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN, wasmFile = process.env.BOUNCER_V14_WASM_PATH;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const wasm = fs.readFileSync(wasmFile);
  assert.ok(wasm.length > 100_000 && wasm.length < 2_000_000 && wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v14-storage-'));
  const rootSeed = nearApi.KeyPair.fromRandom('ed25519'), ownerKey = nearApi.KeyPair.fromRandom('ed25519'), agentKey = nearApi.KeyPair.fromRandom('ed25519');
  const temporaryBootstrap = process.env.BOUNCER_SANDBOX_TEMP_BOOTSTRAP === '1';
  // Disposable sandbox key only. This branch does not authorize or create a
  // key on testnet, and contains no browser custody or independent recovery.
  const bootstrapKey = temporaryBootstrap ? nearApi.KeyPair.fromRandom('ed25519') : null;
  let sandbox, journal;
  try {
    sandbox = await startSandbox(binary, dir, pub(rootSeed));
    const { provider, rpcUrl } = sandbox;
    const output = await withSandboxOnlyFetch(rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const root = account('testnet', provider, sandbox.rootKey), owner = account(OWNER, provider, ownerKey);
      const send = (signer, receiverId, actions) => signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
      const must = async (signer, receiver, actions, label) => { const result = await send(signer, receiver, actions); requireFinalSuccess(result, label); return result; };
      await must(root, OWNER, [tx.createAccount(), tx.transfer(100n * N), tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())], 'create local owner');
      if (temporaryBootstrap) {
        // Exercise the actual browser-safe plan, not a separately handwritten
        // batch. All keys, passphrases and witnesses here are disposable. The
        // serialized kit is a simulated independent copy, NOT a real cloud
        // backup, phone restore, live wallet, or authorization for testnet.
        const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
        const plan=await buildV14TemporaryBootstrapPlan({owner:OWNER,ownerPublicKey:pub(ownerKey),vault:VAULT,
          temporaryPublicKey:pub(bootstrapKey),vaultFundingYocto:String(6n*N),compressedV14:compressed,crypto:crypto.webcrypto});
        assert.deepEqual(Buffer.from(plan.deploymentActions[0].deployContract.code),wasm);
        const scopeId=crypto.randomBytes(16).toString('hex'),capability=crypto.randomBytes(32).toString('hex');
        const passphrase='disposable sandbox recovery only';
        const sealed=await sealV14BootstrapRecoveryKit({review:plan.review,temporaryKey:bootstrapKey,scopeId,
          checkpointCapability:capability,passphrase,crypto:crypto.webcrypto});
        const recovered=await openV14BootstrapRecoveryKit({kit:JSON.parse(JSON.stringify(sealed)),passphrase,crypto:crypto.webcrypto,
          expected:{owner:OWNER,vault:VAULT,ownerPublicKey:pub(ownerKey),temporaryPublicKey:pub(bootstrapKey),
            reviewSha256:plan.review.review_sha256,scopeId}});
        const mobileRequest=syntheticV14MeteorRequest({signerId:OWNER,receiverId:VAULT,actions:plan.createActions});
        const valid=validateKnownFirstPartyActionRequest(mobileRequest);
        assert.equal(MAX_ACTION_REQUEST_CANONICAL_JSON_LENGTH,400_000);
        assert.equal(valid.ok,true,valid.reason);
        assert.ok(Buffer.byteLength(JSON.stringify(mobileRequest))<4_000);
        // The verifier's fixed public RPC is replaced ONLY by a loopback-only
        // test adapter. The sandbox chain ID is aliased to testnet after its
        // actual identity was checked; no public-chain request is possible.
        let observeDeployment=false;const deploymentObservations=[];
        const describeActions=actions=>Array.isArray(actions)?actions.map(item=>{
          if(typeof item==='string')return item;
          if(item?.DeployContract)return {DeployContract:{code_length:item.DeployContract.code?.length,
            code:item.DeployContract.code?.length<=80?item.DeployContract.code:'<omitted>'}};
          if(item?.FunctionCall)return {FunctionCall:item.FunctionCall};
          if(item?.DeleteKey)return {DeleteKey:{key_matches:item.DeleteKey.public_key===pub(bootstrapKey)}};
          return {types:Object.keys(item??{})};
        }):null;
        const browserSandboxFetch=async (url,options)=>{
          assert.equal(url,V14_BOOTSTRAP_READ_RPC);
          const request=JSON.parse(options.body);
          assert.ok(['status','EXPERIMENTAL_tx_status','block','query'].includes(request.method));
          const response=await fetch(rpcUrl,options),body=await response.json();
          if(request.method==='status' && body.result)body.result.chain_id='testnet';
          // Only the disposable sandbox's public result shapes are recorded;
          // never record signed bytes, recovered secrets or real-owner data.
          if(observeDeployment&&request.method==='EXPERIMENTAL_tx_status'){
            const r=body.result,txn=r?.transaction;
            deploymentObservations.push({type:'transaction',error:body.error,final:r?.final_execution_status,status:r?.status,
              tx:{signer:txn?.signer_id,receiver:txn?.receiver_id,key_matches:txn?.public_key===pub(bootstrapKey),actions:describeActions(txn?.actions)},
              tx_outcome:r?.transaction_outcome?.outcome,
              receipts:r?.receipts?.map(x=>({id:x.receipt_id,predecessor:x.predecessor_id,receiver:x.receiver_id,
                action:{...x.receipt?.Action,signer_public_key:x.receipt?.Action?.signer_public_key===pub(bootstrapKey)?'<matches>':'<other>',
                  actions:describeActions(x.receipt?.Action?.actions)}})),
              outcomes:r?.receipts_outcome?.map(x=>({id:x.id,executor:x.outcome?.executor_id,status:x.outcome?.status,children:x.outcome?.receipt_ids}))});
          }
          if(observeDeployment&&request.method==='query'){
            const r=body.result;
            deploymentObservations.push({type:request.params.request_type,account:request.params.account_id,method:request.params.method_name,
              error:body.error,block_hash:r?.block_hash,code_hash:r?.code_hash,amount:r?.amount,locked:r?.locked,storage_usage:r?.storage_usage,
              keys:r?.keys?.map(x=>({matches:x.public_key===pub(bootstrapKey),permission:x.access_key?.permission,nonce:x.access_key?.nonce})),
              view:r?.result?Buffer.from(r.result).toString('utf8'):undefined});
          }
          return Response.json(body,{status:response.status});
        };
        const verifyCreateFinal=await createV14BootstrapCreateVerifier({review:plan.review,compressedV14:compressed,
          fetch:browserSandboxFetch,crypto:crypto.webcrypto});
        const simulatedCopy=()=>{let snapshot={revision:0,head_sha256:'0'.repeat(64),events:[]};return {
          read:async()=>structuredClone(snapshot),append:async({expected_revision,expected_head_sha256,record})=>{
            assert.equal(expected_revision,snapshot.revision);assert.equal(expected_head_sha256,snapshot.head_sha256);
            snapshot={revision:expected_revision+1,head_sha256:await bootstrapSha256(crypto.webcrypto,record),events:[...snapshot.events,record]};
            return structuredClone(snapshot);
          }};};
        const local=simulatedCopy(),simulatedIndependent=simulatedCopy();
        const witness=createBootstrapTwoCopyWitness({scopeId,reviewSha256:plan.review.review_sha256,
          localStore:local,remoteStore:simulatedIndependent,verifyCreateFinal,crypto:crypto.webcrypto});
        const retainer=await createBootstrapOriginalRetainer({review:plan.review,compressedV14:compressed,
          witness,verifyCreateFinal,crypto:crypto.webcrypto});
        await witness.claimCreate();
        const created=await must(owner,VAULT,plan.createActions,'create local bootstrap vault');
        // Simulate a wallet sending but losing its response. The existing
        // claim must remain; recover the synthetic hash from test-only wallet
        // history and verify the actual FINAL sandbox receipt before retaining.
        assert.equal((await retainer.retainWalletResult(undefined)).status,'WALLET_RESULT_UNKNOWN');
        assert.equal((await local.read()).revision,1);
        const recoveredOriginal=await retainer.recoverCreateFromWalletHistory(created.transaction_outcome.id);
        assert.equal(recoveredOriginal.status,'RECOVERED_CREATE_ORIGINAL_RETAINED');
        assert.equal(recoveredOriginal.final_execution_verified,true);
        assert.deepEqual(await local.read(),await simulatedIndependent.read());
        const before=await provider.viewAccessKeyList(VAULT,{finality:'final'});
        assert.equal(before.keys.length,1);
        assert.equal(before.keys[0].public_key,pub(bootstrapKey));
        assert.equal(before.keys[0].access_key.permission,'FullAccess');
        // Fetch the actual sandbox create receipt and fresh state before a
        // deployment claim. Both witness stores are still simulations.
        assert.equal((await witness.claimDeployment()).next_event,'deploy_original');
        await recovered.useSecrets(async ({temporaryKey,checkpointCapability})=>{
          assert.equal(checkpointCapability,capability);
          const block=await provider.viewBlock({finality:'final'});
          const access=await provider.viewAccessKey(VAULT,pub(temporaryKey),{finality:'final'});
          const original=await signV14TemporaryBootstrapDeployment({review:plan.review,expectedReviewSha256:plan.review.review_sha256,
            compressedV14:compressed,temporaryKey,nonce:String(BigInt(access.nonce)+1n),blockHash:block.header.hash,crypto:crypto.webcrypto});
          // Both copies are test-only memory stores, not independent cloud or
          // phone recovery. Verify the signed transaction's exact bytes and
          // retain its hash in both copies before the only sandbox send.
          const held=await retainer.retainSignedDeployment(original);
          assert.equal(held.status,'DEPLOYMENT_ORIGINAL_RETAINED');
          assert.equal(held.original_hash,original.transaction_hash);
          assert.deepEqual(await local.read(),await simulatedIndependent.read());
          const decoded=tx.SignedTransaction.decode(original.signed_bytes);
          const result=await provider.sendTransactionUntil(decoded,'FINAL');
          requireFinalSuccess(result,'deploy V14 and delete recovered local bootstrap key');
          assert.equal(result.transaction_outcome.id,original.transaction_hash);
          // Re-read this exact retained sandbox original and the final code,
          // contract owner and key list through the browser verifier. A local
          // transaction can omit its root receipt body; the verifier must say
          // so rather than constructing evidence that nearcore did not return.
          const verifyDeploymentFinal=await createV14BootstrapDeploymentVerifier({review:plan.review,compressedV14:compressed,
            fetch:browserSandboxFetch,crypto:crypto.webcrypto});
          observeDeployment=true;
          let proof;
          try {proof=await verifyDeploymentFinal({scope_id:scopeId,review_sha256:plan.review.review_sha256,original_hash:original.transaction_hash})}
          catch(error){console.error('Disposable sandbox deployment observations:',JSON.stringify(deploymentObservations));throw error}
          finally{observeDeployment=false}
          assert.equal(proof.status,'DEPLOYMENT_FINAL_AND_KEYLESS_VAULT_VERIFIED');
          assert.equal(proof.pinned_v14_code_verified,true);
          assert.equal(proof.temporary_key_absent,true);
          assert.equal(proof.all_vault_access_keys_absent,true);
          assert.equal(proof.independent_recovery_verified,false);
        });
        recovered.dispose();
        assert.deepEqual((await provider.viewAccessKeyList(VAULT,{finality:'final'})).keys,[]);
      } else {
        await must(owner, VAULT, [tx.createAccount(), tx.transfer(20n * N), tx.deployContract(wasm), call('new', { owner: OWNER })], 'deploy local V14');
      }
      const view = (method, args = {}) => provider.callFunction(VAULT, method, args, { finality: 'final' });
      assert.equal(await view('contract_version'), 'bouncer-agent-v14-native-storage-testnet');
      assert.equal(await view('get_owner'), OWNER);
      await must(owner, VAULT, [call('set_policy', { policy_id: 'store', token: 'native', per_tx_cap: String(N / 10n), daily_cap: String(N / 5n) }, 1n)], 'policy');
      await must(owner, VAULT, [call('allow_payee', { policy_id: 'store', payee: VAULT }, 1n)], 'vault allowlist');
      await must(owner, VAULT, [call('set_native_storage_route', { policy_id: 'store', prefix: 'mission-', max_value_bytes: 4096 }, 1n)], 'storage route');
      await must(owner, VAULT, [call('grant_agent_key', { policy_id: 'store', public_key: pub(agentKey) }, 1n)], 'grant agent');
      await must(owner, VAULT, [call('deposit_native', {}, N)], 'fund local vault');
      await must(owner, OWNER, [tx.addKey(agentKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_native_storage'], N / 2n))], 'scoped local agent key');
      const route = await view('get_native_storage_route', { policy_id: 'store' });
      assert.equal(route.active, true);
      failed(await send(owner, VAULT, [call('clear_native_storage_route', { policy_id: 'store' })]), /exactly 1 yoctoNEAR/);
      const rpc = new SandboxSetupRpc(rpcUrl), localAgent = account(OWNER, rpc, agentKey);
      // This test-only adapter normally requires a setup-specific last-moment
      // guard. Supply one for the native runner while keeping its one-shot,
      // loopback-fenced transport; never use this adapter in production.
      const setupSend = rpc.sendTransactionOnce.bind(rpc);
      rpc.sendTransactionOnce = (signed, wait) => setupSend(signed, wait, { beforeSubmit: () => {
        const original = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(tx.encodeTransaction(signed.transaction)).digest());
        assert.equal(signed.transaction.signerId, OWNER); assert.equal(signed.transaction.receiverId, VAULT);
        assert.equal(journal.get('storage')?.status, 'pending'); assert.equal(journal.get('storage')?.tx_hash, original);
      } });
      const codeHash = (await provider.viewAccount(VAULT, { finality: 'final' })).code_hash;
      const goal = { id: 'storage', contract_id: VAULT, contract_code_hash: codeHash, owner_account_id: OWNER, policy_id: 'store', amount: String(N / 10n),
        object_id: 'mission-sandbox', value: 'public sandbox result', route };
      journal = new FileJournal(path.join(dir, 'original.json'), VAULT, OWNER);
      assert.equal((await runNativeStorageGoal({ goal, account: localAgent, publicKey: agentKey.getPublicKey(), provider: rpc, journal, log: () => {} })).status, 'READY');
      const actual = await runNativeStorageGoal({ goal, account: localAgent, publicKey: agentKey.getPublicKey(), provider: rpc, journal, execute: true, log: () => {} });
      assert.equal(actual.status, 'FULFILLED'); assert.equal(rpc.transportCalls, 1);
      assert.equal(actual.delivery.result.value, goal.value);
      assert.ok(BigInt(actual.delivery.stake_yocto) > 0n && BigInt(actual.delivery.stake_yocto) <= N / 10n);
      assert.equal(await view('vault_balance', { token: 'native' }), String(N - BigInt(actual.delivery.stake_yocto)));
      assert.equal(await view('daily_spent', { policy_id: 'store' }), actual.delivery.stake_yocto);
      const recovered = await recoverNativeStorageGoal({ goal, provider: rpc, journal, log: () => {} });
      assert.equal(recovered.status, 'REUSED'); assert.deepEqual(recovered.delivery, actual.delivery); assert.equal(rpc.transportCalls, 1);
      const agent = account(OWNER, provider, agentKey);
      failed(await send(agent, VAULT, [call('execute_native_storage', { policy_id: 'store', amount: String(N / 10n + 1n),
        object_id: 'mission-over-cap', value: 'no', expected_route: route }, 0n, 100n * T)]), /amount exceeds per-tx cap/);
      failed(await send(agent, VAULT, [call('execute_native_storage', { policy_id: 'store', amount: String(N / 10n),
        object_id: goal.object_id, value: 'changed', expected_route: route }, 0n, 100n * T)]), /storage object ID already reserved/);
      const before = BigInt(await view('vault_balance', { token: 'native' }));
      await must(owner, VAULT, [call('release_native_storage', { policy_id: 'store', object_id: goal.object_id,
        expected_sha256: actual.delivery.result.value_sha256 }, 1n)], 'release public data');
      const after = BigInt(await view('vault_balance', { token: 'native' }));
      assert.ok(after > before && after < N); // tombstone remains locked
      assert.equal(await view('daily_spent', { policy_id: 'store' }), actual.delivery.stake_yocto);
      assert.equal(await view('get_native_storage_object', { policy_id: 'store', object_id: goal.object_id }), null);
      assert.equal(await view('native_storage_id_reserved', { policy_id: 'store', object_id: goal.object_id }), true);
      await assert.rejects(recoverNativeStorageGoal({ goal, provider: rpc, journal, log: () => {} }), /differs/);
      assert.equal(rpc.transportCalls, 1);
      return { scope: 'isolated nearcore, disposable keys and local WASM only', v14_deployed_locally: true,
        temporary_vault_bootstrap_tested: temporaryBootstrap,
        ...(temporaryBootstrap ? {small_meteor_request_synthetic:true, create_original_and_fresh_state_verified_on_sandbox:true,
          lost_wallet_result_reconciled_without_reprompt:true, deployment_original_retained_before_sandbox_send:true,
          deployment_original_and_keyless_state_verified_on_sandbox:true, bootstrap_key_deleted_on_chain:true, two_original_copies_simulated:true,
          actual_wallet_tested:false, independent_recovery_tested:false} : {}),
        scoped_agent_storage_and_receipt_verified: true, original_hash_reused_without_resend: true,
        zero_yocto_owner_guard_rejected: true, over_cap_and_duplicate_rejected: true,
        release_credited_freed_stake_and_retained_tombstone: true, public_chain_transactions: false };
    });
    console.log(JSON.stringify(output, null, 2));
  } finally {
    journal?.close();
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('V14 isolated storage sandbox FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
