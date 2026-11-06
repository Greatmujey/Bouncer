import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import nearConnect from '@hot-labs/near-connect';
import { buildBufferForwarderWalletPlan } from '../agent/buffer-forwarder-wallet-plan.mjs';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { inspectBufferConnectorCompatibility } from '../agent/buffer-wallet-connector-compat.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';

// Synthetic accounts, keys and fake connector executor only. No real wallet,
// device, RPC, signing, network send, user approval or transaction involved.
const NOW = 1_800_000_000_000, OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'buffer.buyer.testnet';
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const ownerKey = key(), vaultKey = key(), forwarderKey = key();
const spending = buildBufferWalletSpendingPlan({ owner: OWNER, vault: VAULT, adapter: ADAPTER, policy_id: 'research',
  vault_agent_public_key: vaultKey, forwarder_agent_public_key: forwarderKey, per_tx_cap_atoms: '20000000',
  daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '250000000000000000000000',
  forwarder_agent_gas_allowance_yocto: '250000000000000000000000' });
const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: forwarderKey,
  vault_agent_public_key: vaultKey, policy_id: 'research', intent_id: 'intent-1', amount: '20000000',
  expires_at_ms: NOW + 600_000, native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
  api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: 'o-000000000001',
  sku: 'weekly-market-brief', brief_sha256: 'a'.repeat(64) };
const forwarder = await buildBufferForwarderWalletPlan({ terms, spendingReview: spending.review,
  trustedSpendingReviewHash: spending.review.review_sha256, trustedOwnerPublicKey: ownerKey,
  registrationDepositYocto: '1250000000000000000000', nowMs: NOW });

async function stubbedWalletCall(batch) {
  const { SandboxWallet } = nearConnect;
  const wallet = new SandboxWallet({ network: 'testnet' }, { id: 'synthetic-wallet', name: 'Synthetic Wallet', features: {} });
  const calls = [];
  wallet.executor.call = async (method, params) => { calls.push({ method, params }); return { synthetic: true }; };
  const result = await wallet.signAndSendTransaction({ signerId: batch.signerId, receiverId: batch.receiverId, actions: batch.actions });
  assert.deepEqual(result, { synthetic: true }); assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'wallet:signAndSendTransaction'); assert.equal(calls[0].params.network, 'testnet');
  assert.equal(calls[0].params.signerId, batch.signerId); assert.equal(calls[0].params.receiverId, batch.receiverId);
  return calls[0].params.actions;
}

test('pinned NEAR Connect conversion preserves reviewed create, transfer, deploy, calls and scoped keys', async () => {
  for (const plan of [spending, forwarder]) {
    for (let i = 0; i < plan.batches.length; i++) {
      const batch = plan.batches[i], stage = plan.review.stages[i];
      const probe = inspectBufferConnectorCompatibility({ batch, retainedStage: stage });
      const actual = await stubbedWalletCall(batch);
      assert.deepEqual(actual.map(a => a.type), probe.action_types);
      assert.equal(probe.action_commitment_sha256, stage.action_commitment_sha256);
      for (const field of ['actual_wallet_or_phone_tested', 'transport_size_limit_verified', 'wallet_approval_obtained',
        'execution_authorized', 'transaction_signed', 'transaction_sent', 'ethereum_named_v12_path_supported', 'typed_account_is_signer']) {
        assert.equal(probe[field], false, field);
      }
      assert.equal(probe.walletconnect_account_only, true);
      assert.ok(probe.meteor_action_array_json_bytes > 0); assert.ok(probe.intear_action_array_json_bytes > 0);
      const deploy = actual.find(a => a.type === 'DeployContract');
      if (deploy) assert.deepEqual(Buffer.from(deploy.params.code), forwarder.forwarder_wasm);
      const add = actual.find(a => a.type === 'AddKey');
      if (add) assert.notEqual(add.params.accessKey.permission, 'FullAccess');
    }
  }
});

test('tampered action summaries, changed bytes and unknown stages fail before any wallet call', () => {
  const batch = forwarder.batches[0], stage = structuredClone(forwarder.review.stages[0]);
  stage.actions[1].deposit_yocto = '1';
  assert.throws(() => inspectBufferConnectorCompatibility({ batch, retainedStage: stage }), /does not match/);
  const changed = structuredClone(forwarder.review.stages[2]); changed.actions[0].args.payee = 'thief.testnet';
  assert.throws(() => inspectBufferConnectorCompatibility({ batch: forwarder.batches[2], retainedStage: changed }), /does not match/);
  assert.throws(() => inspectBufferConnectorCompatibility({ batch: { ...batch, id: 'unknown' }, retainedStage: stage }), /known reviewed/);
});

test('pinned V12 setup has a measured large phone payload but no proven transport limit', { skip: !process.env.BOUNCER_V12_WASM_PATH }, async () => {
  const checks = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
    'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
    'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
    'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
  const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
  const snapshot = { version: 1, network: 'testnet', owner: OWNER, candidate_vault: VAULT, block_hash: hash(9),
    block_timestamp_nanosec: String(BigInt(NOW) * 1_000_000n), circle_token: CIRCLE, circle_code_hash: CIRCLE_TESTNET_CODE_HASH,
    owner_circle_atoms: '20000000', circle_registration_min_yocto: '1250000000000000000000',
    planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, checks: Object.fromEntries(checks.map(k => [k, true])), blockers: [],
    wallet_control_proven: false, wallet_approval_obtained: false, signer_present: false, signed: false, sent: false,
    vault_deployed: false, seller_contacted: false, quote_or_order_created: false, independently_fulfilled: false,
    seller: { account_id: SELLER, token: CIRCLE, paused: false, circle_registered: true, code_hash: hash(8),
      fixed_products: [{ sku: 'weekly-market-brief', active: true, price_atoms: '20000000' }] } };
  const plan = buildBufferWalletSetup({ snapshot, wasmBytes: fs.readFileSync(process.env.BOUNCER_V12_WASM_PATH), nowMs: NOW });
  for (let i = 0; i < plan.batches.length; i++) {
    const probe = inspectBufferConnectorCompatibility({ batch: plan.batches[i], retainedStage: plan.review.stages[i] });
    const actual = await stubbedWalletCall(plan.batches[i]);
    assert.deepEqual(actual.map(a => a.type), probe.action_types);
    if (i === 0) {
      assert.equal(probe.code_bytes, 536651);
      assert.ok(probe.meteor_action_array_json_bytes > 715536);
      assert.ok(probe.intear_action_array_json_bytes > 1_568_153);
      assert.equal(probe.actual_wallet_or_phone_tested, false); assert.equal(probe.transport_size_limit_verified, false);
    }
  }
});
