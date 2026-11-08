#!/usr/bin/env node
/**
 * RESEARCH ONLY: one possible marker-first native setup, on disposable local
 * nearcore. Two independent full-access sandbox keys race to reserve one
 * owner/vault pair; the winner deploys the pinned vault, records the setup and
 * trial originals, and sends one restricted-key call to a fabricated provider.
 *
 * This is NOT a wallet flow, a production review, an independent witness, a
 * proof of cross-device recovery, or evidence of an actual OutLayer delivery.
 * A marker can be removed by the owner and an unknown original must never be
 * retried just because a marker is absent. Nothing here enables a UI.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import wabtFactory from 'wabt';
import { buildAtomicNativeOracleWalletPlan, assertAtomicNativeBatchMatchesReview,
  prepareAtomicNativeOracleWalletAttempt, inspectAtomicNativeOracleWalletAttempt } from '../agent/native-oracle-atomic-wallet.mjs';
import { NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_CODE_HASH,
  NATIVE_ORACLE_V9_SHA256 } from '../agent/native-oracle-wallet-plan.mjs';
import { SANDBOX_CHAIN_ID, SANDBOX_SHA256, readVerifiedFile, assertSandboxStatus,
  requireFinalSuccess } from './v11-sandbox-support.mjs';
import { withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const { transactions: tx } = nearApi;
const ONE = 10n ** 24n, TGAS = 10n ** 12n;
const OWNER = 'marker-buyer.testnet', VAULT = `native.${OWNER}`, PROVIDER = 'outlayer.testnet';
const ref = { finality: 'final' };
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const hashTx = value => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(tx.encodeTransaction(value)).digest());

// The private seed is intentionally public in this experiment. The security
// assertion is the zero allowance, NOT secrecy of the marker's private key.
function publicSandboxMarker(purpose) {
  const seed = crypto.createHash('sha256').update(`bouncer-sandbox-marker-only\0${purpose}\0${OWNER}\0${VAULT}`).digest();
  return nearApi.KeyPair.fromString(`ed25519:${nearApi.utils.serialize.base_encode(seed)}`);
}
function marker(pair, methods) {
  return tx.addKey(pair.getPublicKey(), tx.functionCallAccessKey(VAULT, methods, 0n));
}
function terms(agent) {
  return { owner: OWNER, vault: VAULT, policy_id: 'marker-native', agent_public_key: pub(agent),
    per_tx_cap_yocto: (ONE / 10n).toString(), daily_cap_yocto: (ONE / 10n).toString(),
    vault_deposit_yocto: (ONE / 10n).toString(), agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE };
}
function success(result) { return typeof result?.status?.SuccessValue === 'string'; }
function failure(result, label, pattern) {
  assert.equal(result?.final_execution_status, 'FINAL', `${label}: not FINAL`);
  assert.ok(result?.status?.Failure, `${label}: expected failure`);
  assert.match(JSON.stringify(result.status.Failure), pattern, label);
}
async function noAccessKey(provider, publicKey) {
  let err;
  try { await provider.viewAccessKey(OWNER, publicKey, ref); } catch (error) { err = error; }
  assert.ok(err, 'losing restricted key unexpectedly exists');
  assert.match(`${err.message ?? ''} ${JSON.stringify(err)}`, /UNKNOWN_ACCESS_KEY|does not exist|doesn't exist|not found|unknown access key/i);
}
async function mockProviderWasm() {
  const wabt = await wabtFactory();
  const answer = Buffer.from('{"synthetic":true}', 'utf8');
  const data = [...answer].map(value => `\\${value.toString(16).padStart(2, '0')}`).join('');
  const source = `(module
    (import "env" "value_return" (func $return (param i64 i64)))
    (memory (export "memory") 1)
    (data (i32.const 0) "${data}")
    (func (export "request_execution") i64.const ${answer.length} i64.const 0 call $return))`;
  const module = wabt.parseWat('synthetic-outlayer.wat', source);
  try { return Buffer.from(module.toBinary({}).buffer); } finally { module.destroy(); }
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const wasm = readVerifiedFile(new URL('../../bouncer.wasm', import.meta.url).pathname,
    NATIVE_ORACLE_V9_SHA256, { maxBytes: 1_000_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-marker-first-sandbox-'));
  const tokenKey = key(), ownerKeys = [key(), key()], agentKeys = [key(), key()], providerKey = key();
  const reserveMarker = publicSandboxMarker('reserve'), originalsMarker = publicSandboxMarker('originals');
  let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider, rpcUrl } = sandbox;
    const result = await withSandboxOnlyFetch(rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const root = account('testnet', provider, sandbox.rootKey);
      const send = (signer, receiverId, actions) => signer.signAndSendTransaction({ receiverId, actions,
        waitUntil: 'FINAL', throwOnFailure: false });
      const must = async (signer, receiverId, actions, label) => {
        const outcome = await send(signer, receiverId, actions);
        requireFinalSuccess(outcome, label);
        return outcome;
      };
      await must(root, OWNER, [tx.createAccount(), tx.transfer(100n * ONE),
        ...ownerKeys.map(pair => tx.addKey(pair.getPublicKey(), tx.fullAccessKey()))], 'create sandbox owner');
      await must(root, PROVIDER, [tx.createAccount(), tx.transfer(100n * ONE),
        tx.addKey(providerKey.getPublicKey(), tx.fullAccessKey()), tx.deployContract(await mockProviderWasm())],
      'create synthetic provider');
      const candidates = ownerKeys.map((ownerKey, index) => {
        const agentKey = agentKeys[index];
        const plan = buildAtomicNativeOracleWalletPlan({ wasmBytes: wasm, terms: terms(agentKey), trustedOwnerPublicKey: pub(ownerKey) });
        const reservationMethod = `sandbox_reservation_${plan.review.review_sha256}`;
        const reservation = [marker(reserveMarker, [reservationMethod]),
          tx.addKey(agentKey.getPublicKey(), tx.functionCallAccessKey(VAULT,
            ['execute_outlayer_native_project'], BigInt(NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE)))];
        return { ownerKey, agentKey, plan, reservationMethod, reservation,
          owner: account(OWNER, provider, ownerKey) };
      });
      assert.notEqual(candidates[0].plan.review.review_sha256, candidates[1].plan.review.review_sha256);
      assert.equal(pub(publicSandboxMarker('reserve')), pub(reserveMarker));
      assert.notEqual(pub(reserveMarker), pub(originalsMarker));
      // Different full-access keys avoid shared-nonce artifacts. The chain, not
      // an in-process mutex, serializes two competing reservation receipts.
      const raced = await Promise.all(candidates.map(candidate => send(candidate.owner, OWNER, candidate.reservation)));
      const winningIndex = raced.findIndex(success), losingIndex = 1 - winningIndex;
      assert.ok(winningIndex === 0 || winningIndex === 1, 'exactly one reservation must succeed');
      assert.equal(raced.filter(success).length, 1, 'two different setups cannot both reserve the same marker');
      failure(raced[losingIndex], 'losing reservation', /already exists|AlreadyExists/i);
      const winner = candidates[winningIndex], loser = candidates[losingIndex], reservationHash = raced[winningIndex].transaction_outcome.id;
      await noAccessKey(provider, pub(loser.agentKey));
      const reserved = await provider.viewAccessKey(OWNER, pub(reserveMarker), ref);
      assert.equal(String(reserved.permission.FunctionCall.allowance), '0');
      assert.equal(reserved.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(reserved.permission.FunctionCall.method_names, [winner.reservationMethod]);
      const installed = await provider.viewAccessKey(OWNER, pub(winner.agentKey), ref);
      assert.equal(String(installed.permission.FunctionCall.allowance), NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE);
      assert.equal(installed.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(installed.permission.FunctionCall.method_names, ['execute_outlayer_native_project']);

      // The nine actions are the existing atomic setup, but in this research
      // order the restricted key was installed with the preceding reservation.
      const { review, batches } = winner.plan, batch = batches[0];
      assertAtomicNativeBatchMatchesReview(batch, review.stages[0]);
      const setup = await must(winner.owner, VAULT, batch.actions, 'create and configure sandbox vault');
      const setupHash = setup.transaction_outcome.id;
      const anchors = { review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
        trustedOwnerPublicKey: pub(winner.ownerKey), stageId: batch.id, trustedOriginalHash: setupHash };
      const attempt = prepareAtomicNativeOracleWalletAttempt(anchors);
      const checked = inspectAtomicNativeOracleWalletAttempt({ ...anchors, attempt,
        result: await provider.txStatusReceipts(setupHash, OWNER, 'FINAL') });
      assert.equal(checked.status, 'FINAL_ATOMIC_NATIVE_SETUP_RECEIPT_MATCH');
      const vault = await provider.viewAccount(VAULT, ref);
      assert.equal(vault.code_hash, NATIVE_ORACLE_V9_CODE_HASH);
      assert.deepEqual((await provider.viewAccessKeyList(VAULT, ref)).keys, []);
      const view = (method, args = {}) => provider.callFunction(VAULT, method, args, ref);
      const route = await view('get_outlayer_native_project', { policy_id: review.policy_id });
      assert.equal(route.active, true);
      assert.deepEqual(route.project, review.project);
      assert.equal(await view('is_agent_key_allowed', { policy_id: review.policy_id, public_key: pub(winner.agentKey) }), true);
      assert.equal(await view('vault_balance', { token: 'native' }), review.vault_deposit_yocto);

      // Commit the exact unsigned trial hash to a second zero-allowance marker
      // BEFORE the disposable restricted agent signs or sends it.
      const agent = await provider.viewAccessKey(OWNER, pub(winner.agentKey), ref);
      const block = await provider.viewBlock(ref);
      const actions = [tx.functionCall('execute_outlayer_native_project', { policy_id: review.policy_id,
        amount: review.per_tx_cap_yocto, expected_route: route }, 300n * TGAS, 0n)];
      const transaction = tx.createTransaction(OWNER, winner.agentKey.getPublicKey(), VAULT, BigInt(agent.nonce) + 1n,
        actions, Buffer.from(nearApi.utils.serialize.base_decode(block.header.hash)));
      const originalHash = hashTx(transaction);
      const methods = [`sandbox_reservation_original_${reservationHash}`, `sandbox_setup_original_${setupHash}`,
        `sandbox_trial_original_${originalHash}`];
      const markerOutcome = await must(winner.owner, OWNER, [marker(originalsMarker, methods)], 'record sandbox originals');
      const markerOriginal = markerOutcome.transaction_outcome.id;
      const saved = await provider.viewAccessKey(OWNER, pub(originalsMarker), ref);
      assert.equal(String(saved.permission.FunctionCall.allowance), '0');
      assert.equal(saved.permission.FunctionCall.receiver_id, VAULT);
      assert.deepEqual(saved.permission.FunctionCall.method_names, methods);
      failure(await send(winner.owner, OWNER, [marker(originalsMarker, ['sandbox_replace'])]),
        'replacement of marker', /already exists|AlreadyExists/i);
      assert.deepEqual((await provider.viewAccessKey(OWNER, pub(originalsMarker), ref)).permission.FunctionCall.method_names, methods);

      // The seed for the reservation marker is known, but the protocol must
      // refuse a gas-consuming call with its zero-allowance access key.
      let prohibited;
      try { prohibited = await send(account(OWNER, provider, reserveMarker), VAULT,
        [tx.functionCall(winner.reservationMethod, {}, 10n * TGAS, 0n)]); } catch (error) { prohibited = error; }
      assert.match(`${prohibited?.message ?? ''} ${JSON.stringify(prohibited?.status ?? prohibited)}`,
        /allowance|NotEnoughAllowance/i, 'zero-allowance reservation marker unexpectedly spent gas');

      const [signedHash, signed] = await new nearApi.KeyPairSigner(winner.agentKey).signTransaction(transaction);
      assert.equal(nearApi.utils.serialize.base_encode(signedHash), originalHash);
      let transportCalls = 0;
      transportCalls++;
      await provider.sendTransactionUntil(signed, 'FINAL');
      // Simulate a lost acknowledgement: read the independently retrievable
      // marker and query the SAME original; never send the transaction again.
      const recoveredHash = (await provider.viewAccessKey(OWNER, pub(originalsMarker), ref))
        .permission.FunctionCall.method_names[2].slice('sandbox_trial_original_'.length);
      assert.equal(recoveredHash, originalHash);
      const recovered = await provider.txStatusReceipts(recoveredHash, OWNER, 'FINAL');
      requireFinalSuccess(recovered, 'recover synthetic trial original');
      assert.equal(recovered.transaction.hash, originalHash);
      assert.equal(recovered.transaction.signer_id, OWNER);
      assert.equal(recovered.transaction.receiver_id, VAULT);
      assert.equal(transportCalls, 1);
      assert.equal(await view('vault_balance', { token: 'native' }), '0');
      assert.equal(await view('daily_spent', { policy_id: review.policy_id }), review.per_tx_cap_yocto);
      assert.equal(BigInt((await provider.viewAccount(PROVIDER, ref)).amount), 100n * ONE + ONE / 10n);
      return { scope: 'disposable loopback nearcore with a fabricated provider; no public wallet or delivery',
        competing_reservations: 2, successful_reservations: 1, losing_agent_key_installed: false,
        winner_vault_original_receipt_verified: true, setup_and_trial_hashes_in_zero_allowance_marker: true,
        original_marker_receipt_returned: typeof markerOriginal === 'string',
        zero_allowance_known_marker_key_could_not_spend_gas: true, trial_send_count: transportCalls,
        lost_acknowledgement_recovered_by_original_hash: true, synthetic_provider_received_maximum: true,
        owner_can_remove_marker: true, absent_marker_proves_no_attempt: false,
        complete_cross_device_recovery_proven: false, real_phone_provider_or_consent_verified: false };
    });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({ ...result, chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText }, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Marker-first native sandbox failed:', error?.stack ?? String(error)); process.exitCode = 1; });
}
