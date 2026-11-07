#!/usr/bin/env node
/**
 * ISOLATED LOOPBACK-ONLY TEST. Exercises the exact pinned V9 wallet plan and
 * receipt checks on disposable nearcore. OutLayer's registry is a FABRICATED
 * view; no public chain, wallet, independent provider or real delivery occurs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, assertNativeOracleBatchMatchesReview, NATIVE_ORACLE_V9_SHA256,
  NATIVE_ORACLE_V9_CODE_HASH, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { inspectNativeOracleWalletStage } from '../agent/native-oracle-wallet-preflight.mjs';
import { prepareNativeOracleWalletAttempt, inspectNativeOracleWalletAttempt } from '../agent/native-oracle-wallet-evidence.mjs';
import { buildNativeOracleRevocationPlan, prepareNativeOracleRevocationAttempt, inspectNativeOracleRevocationAttempt } from '../agent/native-oracle-wallet-recovery.mjs';
import { inspectNativeOracleRevocationStage } from '../agent/native-oracle-recovery-preflight.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const { transactions: tx } = nearApi, NEAR = 10n ** 24n, TGAS = 10n ** 12n;
const BUYER = 'native-buyer.testnet', VAULT = `native.${BUYER}`, OUTLAYER = 'outlayer.testnet';
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const makeAccount = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const call = (method, args = {}, deposit = 0n, gas = 30n * TGAS) => tx.functionCall(method, args, gas, deposit);
function expectFailure(result, label, pattern) {
  assert.equal(result?.final_execution_status, 'FINAL', `${label}: not FINAL`);
  assert.ok(result?.status?.Failure, `${label}: expected failure`);
  assert.match(JSON.stringify(result.status.Failure), pattern, label);
}
async function protocolReject(promise, pattern) {
  let error; try { await promise; } catch (e) { error = e; }
  assert.ok(error, 'restricted key unexpectedly accepted a deposit');
  assert.match(`${error.message ?? ''} ${JSON.stringify(error)}`, pattern);
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const wasm = readVerifiedFile(new URL('../../bouncer.wasm', import.meta.url).pathname, NATIVE_ORACLE_V9_SHA256, { maxBytes: 1_000_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-oracle-sandbox-'));
  const tokenKey = key(), buyerKey = key(), agentKey = key(), outlayerKey = key(), probeKey = key();
  let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider, rpcUrl } = sandbox;
    const result = await withSandboxOnlyFetch(rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const root = makeAccount('testnet', provider, sandbox.rootKey), buyer = makeAccount(BUYER, provider, buyerKey);
      const agent = makeAccount(BUYER, provider, agentKey), probe = makeAccount(BUYER, provider, probeKey);
      const send = (signer, receiverId, actions) => signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
      const must = async (signer, receiverId, actions, label) => { const response = await send(signer, receiverId, actions); requireFinalSuccess(response, label); return response; };
      for (const [id, pair] of [[BUYER, buyerKey], [OUTLAYER, outlayerKey]]) {
        await must(root, id, [tx.createAccount(), tx.transfer(100n * NEAR), tx.addKey(pair.getPublicKey(), tx.fullAccessKey())], 'create isolated account');
      }
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
      const plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: BUYER, vault: VAULT,
        policy_id: 'native-price', agent_public_key: pub(agentKey), per_tx_cap_yocto: (NEAR / 10n).toString(),
        daily_cap_yocto: (NEAR / 10n).toString(), vault_deposit_yocto: (NEAR / 10n).toString(),
        agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
      const review = structuredClone(plan.review), prior = [], preflights = [], outcomes = [];
      for (let i = 0; i < plan.batches.length; i++) {
        const batch = plan.batches[i];
        const preflight = await inspectNativeOracleWalletStage({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
          trustedOwnerPublicKey: pub(buyerKey), stageId: batch.id, prior, provider: sandboxViews });
        assert.equal(preflight.status, 'STATE_CHECKS_PASSED_NOT_AUTHORIZED', `preflight ${batch.id}: ${JSON.stringify(preflight.blockers)}`);
        assert.equal(preflight.wallet_prompt_authorized, false); preflights.push(batch.id);
        assertNativeOracleBatchMatchesReview(batch, review.stages[i]);
        // Only disposable local keys and the named sandbox are used here.
        const sent = await must(buyer, batch.receiverId, batch.actions, `sandbox native setup ${batch.id}`);
        const trustedOriginalHash = sent.transaction_outcome.id;
        const attempt = prepareNativeOracleWalletAttempt({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
          trustedOwnerPublicKey: pub(buyerKey), stageId: batch.id, trustedOriginalHash });
        const receiptResult = await provider.txStatusReceipts(trustedOriginalHash, BUYER, 'FINAL');
        const evidence = inspectNativeOracleWalletAttempt({ review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
          trustedOwnerPublicKey: pub(buyerKey), trustedOriginalHash, attempt, result: receiptResult });
        assert.ok(['FINAL_NATIVE_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH'].includes(evidence.status));
        assert.equal(evidence.do_not_resend, true); outcomes.push(evidence.status);
        prior.push({ attempt, trustedOriginalHash, result: receiptResult });
      }
      const ref = { finality: 'final' };
      const view = (method, args = {}) => provider.callFunction(VAULT, method, args, ref);
      const vaultAccount = await provider.viewAccount(VAULT, ref), vaultKeys = await provider.viewAccessKeyList(VAULT, ref);
      assert.equal(vaultAccount.code_hash, NATIVE_ORACLE_V9_CODE_HASH); assert.deepEqual(vaultKeys.keys, []);
      const access = await provider.viewAccessKey(BUYER, pub(agentKey), ref);
      assert.equal(access.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(access.permission.FunctionCall.method_names, ['execute_outlayer_native_project']);
      assert.equal(String(access.permission.FunctionCall.allowance), NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE);
      const route = await view('get_outlayer_native_project', { policy_id: review.policy_id });
      assert.equal(route.active, true); assert.deepEqual(route.project, review.project);
      const args = { policy_id: review.policy_id, token: 'native', per_tx_cap: review.per_tx_cap_yocto, daily_cap: review.daily_cap_yocto };
      await must(buyer, BUYER, [tx.addKey(probeKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['set_policy'], NEAR / 2n))], 'install local guard probe');
      expectFailure(await send(probe, VAULT, [call('set_policy', args)]), 'zero-yocto owner guard', /exactly 1 yoctoNEAR/);
      await protocolReject(send(probe, VAULT, [call('set_policy', args, 1n)]), /DepositWithFunctionCall|attached deposit|deposit.*(?:function|access.key)|requires.*full.access/i);
      const tooMuch = (BigInt(review.per_tx_cap_yocto) + 1n).toString();
      expectFailure(await send(agent, VAULT, [call('execute_outlayer_native_project', { policy_id: review.policy_id,
        amount: tooMuch, expected_route: route }, 0n, 300n * TGAS)]), 'per-transaction cap', /amount exceeds per-tx cap/);
      assert.equal(await view('vault_balance', { token: 'native' }), review.vault_deposit_yocto);
      assert.equal(await view('daily_spent', { policy_id: review.policy_id }), '0');
      // Exercise the owner-led recovery plan using only these disposable local
      // keys. A zero-yocto revoke fails; the two reviewed original hashes and
      // fresh state must match before each subsequent action.
      const recovery = buildNativeOracleRevocationPlan({ setupReview: review, wasmBytes: wasm,
        trustedSetupReviewHash: review.review_sha256, trustedOwnerPublicKey: pub(buyerKey), expectedAccessKeyPresent: true });
      const anchors = { setupReview: review, wasmBytes: wasm, trustedSetupReviewHash: review.review_sha256,
        trustedOwnerPublicKey: pub(buyerKey), recoveryReview: recovery.review, trustedRecoveryReviewHash: recovery.review.review_sha256 };
      expectFailure(await send(buyer, VAULT, [call('revoke_agent_key', { policy_id: review.policy_id, public_key: pub(agentKey) })]),
        'zero-yocto recovery guard', /exactly 1 yoctoNEAR/);
      assert.equal(await view('is_agent_key_allowed', { policy_id: review.policy_id, public_key: pub(agentKey) }), true);
      const recoveryPrior = [], recoveryProofs = [];
      for (let i = 0; i < recovery.batches.length; i++) {
        const batch = recovery.batches[i];
        const preflight = await inspectNativeOracleRevocationStage({ ...anchors, stageId: batch.id, prior: recoveryPrior, provider: sandboxViews });
        assert.equal(preflight.status, 'STATE_CHECKS_PASSED_NOT_AUTHORIZED', `recovery preflight ${batch.id}: ${JSON.stringify(preflight.blockers)}`);
        assert.equal(preflight.wallet_prompt_authorized, false);
        const sent = await must(buyer, batch.receiverId, batch.actions, `sandbox native recovery ${batch.id}`);
        const trustedOriginalHash = sent.transaction_outcome.id;
        const attempt = prepareNativeOracleRevocationAttempt({ ...anchors, stageId: batch.id, trustedOriginalHash });
        const receiptResult = await provider.txStatusReceipts(trustedOriginalHash, BUYER, 'FINAL');
        const proof = inspectNativeOracleRevocationAttempt({ ...anchors, trustedOriginalHash, attempt, result: receiptResult });
        assert.ok(['FINAL_NATIVE_RECOVERY_RECEIPT_MATCH', 'FINAL_LOCAL_DELETE_KEY_OUTCOME_MATCH'].includes(proof.status));
        assert.equal(proof.do_not_resend, true); recoveryProofs.push(proof.status);
        recoveryPrior.push({ attempt, trustedOriginalHash, result: receiptResult });
      }
      const remaining = await provider.viewAccessKeyList(BUYER, { finality: 'final' });
      assert.equal(remaining.keys.some(k => k.public_key === pub(agentKey)), false);
      assert.equal(await view('is_agent_key_allowed', { policy_id: review.policy_id, public_key: pub(agentKey) }), false);
      assert.equal(await view('vault_balance', { token: 'native' }), review.vault_deposit_yocto);
      return { scope: 'isolated loopback nearcore with fabricated OutLayer registry views; no provider request or independent delivery',
        four_reviewed_setup_stages_checked: preflights, four_original_receipts_checked: outcomes,
        pinned_v9_and_keyless_vault_checked: true, one_method_agent_key_checked: true,
        zero_yocto_guard_rejected: true, restricted_key_one_yocto_rejected: true, over_cap_rejected: true,
        native_balance_unchanged_after_rejections: true, zero_yocto_recovery_guard_rejected: true,
        two_reviewed_recovery_stages_checked: recovery.batches.map(batch => batch.id), two_recovery_original_receipts_checked: recoveryProofs,
        agent_access_key_and_grant_absent_after_recovery: true, native_balance_unchanged_after_recovery: true,
        signed_or_sent_to_public_chain: false,
        independent_delivery_verified: false };
    });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({ ...result, chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText,
      protocol_version: sandbox.protocol }, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Native oracle isolated sandbox FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
}
