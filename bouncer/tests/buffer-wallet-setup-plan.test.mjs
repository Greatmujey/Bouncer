import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBufferWalletSetup, assertBufferWalletBatchMatchesReview } from '../agent/buffer-wallet-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, V12_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, BLOCK = mockHash('wallet-plan-block');
const ALL_CHECKS = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
  'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
  'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
  'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
const snapshot = () => ({ version: 1, network: 'testnet', owner: 'buyer.testnet', candidate_vault: 'vault.buyer.testnet',
  block_hash: BLOCK, block_timestamp_nanosec: String(BigInt(NOW) * 1_000_000n), circle_token: CIRCLE,
  circle_code_hash: CIRCLE_TESTNET_CODE_HASH, owner_circle_atoms: '20000000', circle_registration_min_yocto: '1250000000000000000000',
  planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO, checks: Object.fromEntries(ALL_CHECKS.map(k => [k, true])), blockers: [],
  wallet_control_proven: false, wallet_approval_obtained: false, signer_present: false, signed: false, sent: false,
  vault_deployed: false, seller_contacted: false, quote_or_order_created: false, independently_fulfilled: false,
  seller: { account_id: SELLER, token: CIRCLE, paused: false, circle_registered: true, code_hash: mockHash('seller-code'),
    fixed_products: [{ sku: 'weekly-market-brief', active: true, price_atoms: '20000000' }] } });
const wasmPath = process.env.BOUNCER_V12_WASM_PATH;
const wasm = wasmPath && fs.existsSync(wasmPath) ? fs.readFileSync(wasmPath) : null;

test('unsigned setup is bounded to a keyless V12, Circle registration and 20 test USDC deposit', { skip: !wasm }, () => {
  const { review, batches } = buildBufferWalletSetup({ snapshot: snapshot(), wasmBytes: wasm, nowMs: NOW });
  assert.equal(review.network, 'testnet'); assert.equal(review.signing_or_broadcast_authorized, false);
  assert.equal(review.wallet_approval_obtained, false); assert.equal(review.vault_wasm_sha256, V12_EXPECTED_SHA256);
  assert.deepEqual(review.stages.map(s => s.id), ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle']);
  assert.deepEqual(review.stages[0].actions.map(a => a.type), ['create_account', 'transfer', 'deploy_contract', 'function_call']);
  assert.equal(review.stages[0].actions[1].deposit_yocto, VAULT_NATIVE_FUNDING_YOCTO);
  assert.deepEqual(review.stages[0].actions[3].args, { owner: 'buyer.testnet' });
  assert.equal(review.stages[1].receiver_id, CIRCLE); assert.equal(review.stages[1].actions[0].method, 'storage_deposit');
  assert.deepEqual(review.stages[2].actions[0].args, { receiver_id: 'vault.buyer.testnet', amount: '20000000', msg: '' });
  assert.equal(review.stages[2].actions[0].deposit_yocto, '1');
  assert(!JSON.stringify(review).includes('signed_tx')); assert(!JSON.stringify(review).includes('private_key'));
  for (let i = 0; i < batches.length; i++) assert.equal(assertBufferWalletBatchMatchesReview(batches[i], review.stages[i]), true);
  const retained = structuredClone(review.stages[2]);
  batches[2].actions[0].functionCall.args = Buffer.from(JSON.stringify({ receiver_id: 'thief.testnet', amount: '20000000', msg: '' }));
  assert.throws(() => assertBufferWalletBatchMatchesReview(batches[2], retained), /does not match/);
});

test('changed, mainnet, stale or incomplete public snapshot fails before artifact handling', () => {
  const changes = [s => { s.network = 'mainnet'; }, s => { s.owner_circle_atoms = '19999999'; },
    s => { s.owner = 'buyer.near'; }, s => { s.candidate_vault = 'vault.other.testnet'; },
    s => { s.circle_code_hash = mockHash('wrong'); }, s => { s.checks.new_direct_child_absent = false; },
    s => { s.blockers = ['unknown']; }, s => { s.sent = true; }, s => { s.seller.fixed_products[0].price_atoms = '21000000'; },
    s => { s.circle_registration_min_yocto = '10000000000000000000001'; },
    s => { s.block_timestamp_nanosec = String(BigInt(NOW - 121000) * 1_000_000n); }];
  for (const change of changes) {
    const s = snapshot(); change(s);
    assert.throws(() => buildBufferWalletSetup({ snapshot: s, wasmBytes: Buffer.alloc(0), nowMs: NOW }));
  }
});

test('unreviewed or altered artifact is rejected even when public snapshot appears ready', () => {
  assert.throws(() => buildBufferWalletSetup({ snapshot: snapshot(), wasmBytes: Buffer.alloc(100), nowMs: NOW }), /artifact/);
  if (wasm) {
    const altered = Buffer.from(wasm); altered[100] ^= 1;
    assert.throws(() => buildBufferWalletSetup({ snapshot: snapshot(), wasmBytes: altered, nowMs: NOW }), /artifact/);
  }
});
