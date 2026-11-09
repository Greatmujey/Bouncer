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
        await must(owner,VAULT,plan.createActions,'create local bootstrap vault');
        const before=await provider.viewAccessKeyList(VAULT,{finality:'final'});
        assert.equal(before.keys.length,1);
        assert.equal(before.keys[0].public_key,pub(bootstrapKey));
        assert.equal(before.keys[0].access_key.permission,'FullAccess');
        await recovered.useSecrets(async ({temporaryKey,checkpointCapability})=>{
          assert.equal(checkpointCapability,capability);
          const block=await provider.viewBlock({finality:'final'});
          const access=await provider.viewAccessKey(VAULT,pub(temporaryKey),{finality:'final'});
          const original=await signV14TemporaryBootstrapDeployment({review:plan.review,expectedReviewSha256:plan.review.review_sha256,
            compressedV14:compressed,temporaryKey,nonce:String(BigInt(access.nonce)+1n),blockHash:block.header.hash,crypto:crypto.webcrypto});
          // Test-only simulated two-copy witnesses. The real remote checkpoint,
          // its freshness and phone recovery have NOT been enabled or proven.
          const localOriginal={tx_hash:original.transaction_hash},simulatedIndependent=JSON.parse(JSON.stringify(localOriginal));
          assert.equal(localOriginal.tx_hash,simulatedIndependent.tx_hash);
          const decoded=tx.SignedTransaction.decode(original.signed_bytes);
          const result=await provider.sendTransactionUntil(decoded,'FINAL');
          requireFinalSuccess(result,'deploy V14 and delete recovered local bootstrap key');
          assert.equal(result.transaction_outcome.id,localOriginal.tx_hash);
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
        ...(temporaryBootstrap ? {small_meteor_request_synthetic:true, bootstrap_key_deleted_on_chain:true,
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
