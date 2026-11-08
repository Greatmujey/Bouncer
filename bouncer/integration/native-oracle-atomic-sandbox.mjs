#!/usr/bin/env node
/**
 * Research-only, isolated nearcore test of a shorter native-vault setup and a
 * zero-allowance access-key original-hash marker. It uses disposable keys on
 * loopback; it does not contact testnet or a wallet. It does NOT enable the
 * phone flow or establish a complete cross-device recovery protocol.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_CODE_HASH,
  NATIVE_ORACLE_V9_SHA256 } from '../agent/native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan, assertAtomicNativeBatchMatchesReview, prepareAtomicNativeOracleWalletAttempt,
  inspectAtomicNativeOracleWalletAttempt } from '../agent/native-oracle-atomic-wallet.mjs';
import { inspectAtomicNativeOracleWalletStage, inspectAtomicNativeOracleWalletCompletion } from '../agent/native-oracle-wallet-preflight.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const { transactions: tx } = nearApi;
const ONE = 10n ** 24n, TGAS = 10n ** 12n, BUYER = 'atomic-buyer.testnet', VAULT = `native.${BUYER}`, OUTLAYER = 'outlayer.testnet';
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const options = { finality: 'final' };
const markerMethod = hash => `bouncer_original_${hash}`;

function requireFailure(result, label, pattern) {
  assert.equal(result?.final_execution_status, 'FINAL', `${label}: not FINAL`);
  assert.ok(result?.status?.Failure, `${label}: expected failure`);
  assert.match(JSON.stringify(result.status.Failure), pattern, label);
}
async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const wasm = readVerifiedFile(new URL('../../bouncer.wasm', import.meta.url).pathname,
    NATIVE_ORACLE_V9_SHA256, { maxBytes: 1_000_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-atomic-sandbox-'));
  const tokenKey = key(), ownerKey = key(), agentKey = key(), outlayerKey = key(), setupMarker = key(), trialMarker = key(), combinedProbeKey = key();
  let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider, rpcUrl } = sandbox;
    const result = await withSandboxOnlyFetch(rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const root = account('testnet', provider, sandbox.rootKey), owner = account(BUYER, provider, ownerKey);
      const send = (signer, receiverId, actions) => signer.signAndSendTransaction({ receiverId, actions,
        waitUntil: 'FINAL', throwOnFailure: false });
      const must = async (signer, receiverId, actions, label) => {
        const result = await send(signer, receiverId, actions); requireFinalSuccess(result, label); return result;
      };
      await must(root, BUYER, [tx.createAccount(), tx.transfer(100n * ONE), tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())],
        'create disposable sandbox owner');
      await must(root, OUTLAYER, [tx.createAccount(), tx.transfer(100n * ONE), tx.addKey(outlayerKey.getPublicKey(), tx.fullAccessKey())],
        'create disposable sandbox provider placeholder');
      // The provider registry is deliberately fabricated. Real delivery and
      // current public testnet pricing are outside this loopback test.
      const source = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256,
        build_target: ORACLE_TESTNET_PROGRAM.build_target } };
      const presence = new ReadOnlyNearRpcProvider(rpcUrl);
      const sandboxViews = {
        async viewNodeStatus() { const status = await provider.viewNodeStatus(); assertSandboxStatus(status); return { ...status, chain_id: 'testnet' }; },
        async experimental_protocolConfig(ref) { const config = await provider.experimental_protocolConfig(ref); return { ...config, chain_id: 'testnet' }; },
        viewBlock: provider.viewBlock.bind(provider), query: provider.query.bind(provider), gasPrice: provider.gasPrice.bind(provider),
        viewTestnetAccountPresenceAt: presence.viewTestnetAccountPresenceAt.bind(presence),
        async callFunctionRaw(accountId, method, args, ref) {
          if (accountId === OUTLAYER) {
            let data;
            if (method === 'get_project') data = { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
            else if (method === 'get_version') data = { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source };
            else if (method === 'get_project_pricing') data = null;
            else throw Error('unexpected mock registry view');
            return { block_hash: ref.blockId, result: [...Buffer.from(JSON.stringify(data))] };
          }
          return provider.callFunctionRaw(accountId, method, args, ref);
        },
      };
      const terms = vault => ({ owner: BUYER, vault, policy_id: 'atomic-price', agent_public_key: pub(agentKey),
        per_tx_cap_yocto: (ONE / 10n).toString(), daily_cap_yocto: (ONE / 10n).toString(),
        vault_deposit_yocto: (ONE / 10n).toString(), agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE });
      const combine = plan => {
        const first = plan.batches.slice(0, 3);
        assert(first.every(batch => batch.signerId === BUYER && batch.receiverId === first[0].receiverId));
        const actions = first.flatMap(batch => batch.actions);
        assert.equal(actions.length, 9);
        return actions;
      };
      const badVault = `failed.${BUYER}`, badPlan = buildNativeOracleWalletPlan({ terms: terms(badVault), wasmBytes: wasm });
      const badActions = combine(badPlan);
      // The owner-only policy action is deliberately missing its required yocto.
      assert.equal(badActions[4].functionCall.methodName, 'set_policy');
      badActions[4].functionCall.deposit = 0n;
      const before = BigInt((await provider.viewAccount(BUYER, options)).amount);
      requireFailure(await send(owner, badVault, badActions), 'failed combined setup', /exactly 1 yoctoNEAR/);
      let unexpectedlyExists = false, missingError;
      try { await provider.viewAccount(badVault, options); unexpectedlyExists = true; } catch (error) { missingError = error; }
      assert.equal(unexpectedlyExists, false, 'failed action receipt must not leave a child account');
      assert.match(`${missingError?.message ?? ''} ${JSON.stringify(missingError)}`, /UNKNOWN_ACCOUNT|does not exist|doesn't exist|unknown account/i);
      const after = BigInt((await provider.viewAccount(BUYER, options)).amount);
      assert(after <= before && before - after < ONE / 2n, 'failed combined setup must refund the 5.5 NEAR transfer/deposit; gas may be charged');

      const plan = buildNativeOracleWalletPlan({ terms: terms(VAULT), wasmBytes: wasm });
      const atomicPlan = buildAtomicNativeOracleWalletPlan({ terms: terms(VAULT), wasmBytes: wasm, trustedOwnerPublicKey: pub(ownerKey) });
      const review = structuredClone(atomicPlan.review), prior = [], proofs = [], preflights = [];
      const anchors = { review, wasmBytes: wasm, trustedReviewHash: review.review_sha256, trustedOwnerPublicKey: pub(ownerKey) };
      for (let i = 0; i < atomicPlan.batches.length; i++) {
        const batch = atomicPlan.batches[i];
        const preflight = await inspectAtomicNativeOracleWalletStage({ ...anchors, stageId: batch.id, prior, provider: sandboxViews });
        assert.equal(preflight.status, 'STATE_CHECKS_PASSED_NOT_AUTHORIZED', `atomic preflight ${batch.id}: ${JSON.stringify(preflight.blockers)}`);
        assert.equal(preflight.wallet_prompt_authorized, false); preflights.push(batch.id);
        assertAtomicNativeBatchMatchesReview(batch, review.stages[i]);
        // Disposable sandbox signing only; this is not a Meteor approval.
        const sent = await must(owner, batch.receiverId, batch.actions, `atomic sandbox ${batch.id}`);
        const trustedOriginalHash = sent.transaction_outcome.id;
        const attempt = prepareAtomicNativeOracleWalletAttempt({ ...anchors, stageId: batch.id, trustedOriginalHash });
        const result = await provider.txStatusReceipts(trustedOriginalHash, BUYER, 'FINAL');
        const proof = inspectAtomicNativeOracleWalletAttempt({ ...anchors, trustedOriginalHash, attempt, result });
        assert.ok(['FINAL_ATOMIC_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH'].includes(proof.status));
        assert.equal(proof.do_not_resend, true); proofs.push(proof.status);
        prior.push({ attempt, trustedOriginalHash, result });
      }
      const completion = await inspectAtomicNativeOracleWalletCompletion({ ...anchors, prior, provider: sandboxViews });
      assert.equal(completion.status, 'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED', JSON.stringify(completion.blockers));
      assert.equal(completion.wallet_prompt_authorized, false); assert.equal(completion.independent_delivery_verified, false);
      const actions = atomicPlan.batches[0].actions, setupHash = prior[0].trustedOriginalHash;
      const view = (method, args = {}) => provider.callFunction(VAULT, method, args, options);
      const vaultAccount = await provider.viewAccount(VAULT, options);
      const vaultKeys = await provider.viewAccessKeyList(VAULT, options);
      assert.equal(vaultAccount.code_hash, NATIVE_ORACLE_V9_CODE_HASH);
      assert.deepEqual(vaultKeys.keys, []);
      assert.equal(await view('get_owner'), BUYER);
      assert.equal(await view('vault_balance', { token: 'native' }), terms(VAULT).vault_deposit_yocto);
      assert.equal(await view('is_agent_key_allowed', { policy_id: plan.review.policy_id, public_key: pub(agentKey) }), true);
      const route = await view('get_outlayer_native_project', { policy_id: plan.review.policy_id });
      assert.equal(route.active, true); assert.deepEqual(route.project, plan.review.project);
      requireFailure(await send(owner, VAULT, actions), 'duplicate combined setup', /already exists|AlreadyExists/i);
      assert.equal(await view('vault_balance', { token: 'native' }), terms(VAULT).vault_deposit_yocto);

      // Separately exercise a marker and a restricted probe key in one owner
      // transaction. The actual reviewed agent was installed in stage 2 above;
      // this extra sandbox-only key is not granted a vault policy. The marker
      // has zero allowance and names a method that the vault does not expose.
      const marker = (pair, hash) => tx.addKey(pair.getPublicKey(),
        tx.functionCallAccessKey(VAULT, [markerMethod(hash)], 0n));
      await must(owner, BUYER, [marker(setupMarker, setupHash), tx.addKey(combinedProbeKey.getPublicKey(),
        tx.functionCallAccessKey(VAULT, ['execute_outlayer_native_project'], BigInt(NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE)) )],
      'setup hash marker and sandbox-only restricted probe key');
      const setupView = await provider.viewAccessKey(BUYER, pub(setupMarker), options);
      assert.equal(String(setupView.permission.FunctionCall.allowance), '0');
      assert.equal(setupView.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(setupView.permission.FunctionCall.method_names, [markerMethod(setupHash)]);

      // Hash the exact proposed trial before signing. This simulation does NOT
      // sign or send it. A second zero-allowance key holds the original hash.
      const agentView = await provider.viewAccessKey(BUYER, pub(agentKey), options);
      const block = await provider.viewBlock(options);
      const trialActions = [tx.functionCall('execute_outlayer_native_project', { policy_id: plan.review.policy_id,
        amount: plan.review.per_tx_cap_yocto, expected_route: route }, 300n * TGAS, 0n)];
      const trialTx = tx.createTransaction(BUYER, agentKey.getPublicKey(), VAULT, BigInt(agentView.nonce) + 1n,
        trialActions, Buffer.from(nearApi.utils.serialize.base_decode(block.header.hash)));
      const trialHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(tx.encodeTransaction(trialTx)).digest());
      await must(owner, BUYER, [marker(trialMarker, trialHash)], 'trial original marker');
      const readTrialMarker = () => provider.viewAccessKey(BUYER, pub(trialMarker), options);
      const trialView = await readTrialMarker();
      assert.equal(String(trialView.permission.FunctionCall.allowance), '0');
      assert.equal(trialView.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(trialView.permission.FunctionCall.method_names, [markerMethod(trialHash)]);
      requireFailure(await send(owner, BUYER, [marker(trialMarker, setupHash)]), 'duplicate marker', /already exists|AlreadyExists/i);
      assert.deepEqual((await readTrialMarker()).permission.FunctionCall.method_names, [markerMethod(trialHash)]);

      // Worst case: the marker private key is known. Zero allowance must still
      // prevent even its one permitted, nonexistent method from consuming gas.
      const markerSigner = account(BUYER, provider, trialMarker);
      let markerAttempt;
      try { markerAttempt = await send(markerSigner, VAULT, [tx.functionCall(markerMethod(trialHash), {}, 10n * TGAS, 0n)]); }
      catch (error) { markerAttempt = error; }
      const description = `${markerAttempt?.message ?? ''} ${JSON.stringify(markerAttempt?.status ?? markerAttempt)}`;
      assert.match(description, /allowance|NotEnoughAllowance/i, 'zero-allowance marker must not be able to submit');
      assert.equal(await view('vault_balance', { token: 'native' }), terms(VAULT).vault_deposit_yocto);
      return { two_reviewed_setup_stages_checked: preflights, two_original_receipts_checked: proofs,
        two_originals_and_state_matched: true, fabricated_provider_registry: true,
        combined_nine_action_setup_succeeded: true, failed_setup_rolled_back: true,
        duplicate_vault_creation_rejected: true, setup_original_marker_retained: true,
        trial_original_marker_retained_before_signing: true, marker_overwrite_rejected: true,
        zero_allowance_marker_could_not_spend_gas: true, trial_signed_or_broadcast: false,
        public_chain_wallet_or_provider_used: false, complete_cross_device_recovery_proven: false };
    });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({ ...result, chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText }, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Atomic native sandbox failed:', error?.stack ?? String(error)); process.exitCode = 1; });
}
