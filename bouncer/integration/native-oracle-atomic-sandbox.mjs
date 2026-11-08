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
import { withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile, assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const { transactions: tx } = nearApi;
const ONE = 10n ** 24n, TGAS = 10n ** 12n, BUYER = 'atomic-buyer.testnet', VAULT = `native.${BUYER}`;
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
  const tokenKey = key(), ownerKey = key(), agentKey = key(), setupMarker = key(), trialMarker = key();
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
      const actions = combine(plan), sent = await must(owner, VAULT, actions, 'combined setup');
      const setupHash = sent.transaction_outcome.id;
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

      // Record the wallet-returned setup original and install the restricted
      // agent key in one owner-account transaction. Marker has no spendable
      // gas allowance and only names a method that the vault does not expose.
      const marker = (pair, hash) => tx.addKey(pair.getPublicKey(),
        tx.functionCallAccessKey(VAULT, [markerMethod(hash)], 0n));
      await must(owner, BUYER, [marker(setupMarker, setupHash), ...plan.batches[3].actions], 'setup hash marker and agent key');
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
      return { combined_nine_action_setup_succeeded: true, failed_setup_rolled_back: true,
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
