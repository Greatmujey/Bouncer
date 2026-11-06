/**
 * Unsigned setup batches for a fresh, wallet-owned Buffer testnet trial.
 * This module cannot use a wallet, create an account, contact a seller, sign
 * or send. Callers must independently retain and review the returned stage
 * commitments, obtain separate wallet approval, and reconcile each original
 * transaction before proceeding. A setup deposit is not a provider payment.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH, V12_EXPECTED_BYTES, V12_EXPECTED_SHA256,
  VAULT_NATIVE_FUNDING_YOCTO } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { unsignedSvalinBatchCommitment } from './svalin-setup-plan.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

const TGAS = 10n ** 12n, MAX = (1n << 128n) - 1n;
export const BUFFER_FIXED_PRICE_ATOMS = '20000000'; // 20 TEST USDC; not a reservation
export const BUFFER_FIXED_PRODUCT_SKU = 'weekly-market-brief';
const REQUIRED_CHECKS = ['named_owner_has_no_local_or_global_code', 'owner_has_full_access_key', 'owner_circle_registered',
  'reviewed_circle_code_and_metadata', 'new_direct_child_absent', 'child_not_already_circle_registered',
  'circle_registration_cost_bounded', 'protocol_and_selected_features', 'owner_native_estimate', 'vault_native_estimate',
  'buffer_accepts_circle_and_is_registered', 'fixed_product_active', 'owner_balance_covers_fixed_price'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function validatedSnapshot(raw, nowMs) {
  if (!record(raw)) throw new Error('fresh testnet wallet funding snapshot required');
  const s = structuredClone(raw);
  const prefix = typeof s.candidate_vault === 'string' && typeof s.owner === 'string' && s.candidate_vault.endsWith(`.${s.owner}`)
    ? s.candidate_vault.slice(0, -s.owner.length - 1) : '';
  if (s.version !== 1 || s.network !== 'testnet' || !isTestnetAccount(s.owner) || !isTestnetAccount(s.candidate_vault) ||
      !prefix || prefix.includes('.') || s.circle_token !== CIRCLE || s.circle_code_hash !== CIRCLE_TESTNET_CODE_HASH ||
      !uint(s.owner_circle_atoms) || BigInt(s.owner_circle_atoms) < BigInt(BUFFER_FIXED_PRICE_ATOMS) ||
      !uint(s.circle_registration_min_yocto) || s.circle_registration_min_yocto === '0' ||
      BigInt(s.circle_registration_min_yocto) > 10n ** 22n || s.planned_vault_native_yocto !== VAULT_NATIVE_FUNDING_YOCTO ||
      !record(s.checks) || REQUIRED_CHECKS.some(k => s.checks[k] !== true) || !Array.isArray(s.blockers) || s.blockers.length !== 0 ||
      s.wallet_control_proven !== false || s.wallet_approval_obtained !== false || s.signer_present !== false ||
      s.signed !== false || s.sent !== false || s.vault_deployed !== false || s.seller_contacted !== false ||
      s.quote_or_order_created !== false || s.independently_fulfilled !== false || !record(s.seller) ||
      s.seller.account_id !== SELLER || s.seller.token !== CIRCLE || s.seller.paused !== false ||
      s.seller.circle_registered !== true || !Array.isArray(s.seller.fixed_products) ||
      s.seller.fixed_products.filter(p => p?.sku === BUFFER_FIXED_PRODUCT_SKU && p.active === true &&
        p.price_atoms === BUFFER_FIXED_PRICE_ATOMS).length !== 1) {
    throw new Error('testnet wallet snapshot does not meet the bounded Buffer setup profile');
  }
  assertFreshFinalBlock({ header: { hash: s.block_hash, timestamp_nanosec: s.block_timestamp_nanosec } }, nowMs);
  return s;
}
function checkedWasm(input) {
  if (!(input instanceof Uint8Array)) throw new Error('pinned V12 WASM required');
  const bytes = Buffer.from(input);
  if (bytes.length !== V12_EXPECTED_BYTES || sha(bytes) !== V12_EXPECTED_SHA256 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      !bytes.includes(Buffer.from('bouncer-agent-v12-exact-ft-testnet'))) throw new Error('V12 artifact differs from the reviewed testnet hash');
  return bytes;
}
function summarize(action) {
  switch (action.enum) {
    case 'createAccount': return { type: 'create_account' };
    case 'transfer': return { type: 'transfer', deposit_yocto: action.transfer.deposit.toString() };
    case 'deployContract': {
      const code = Buffer.from(action.deployContract.code);
      return { type: 'deploy_contract', bytes: code.length, sha256: sha(code), near_code_hash: V12_NEAR_CODE_HASH };
    }
    case 'functionCall': return { type: 'function_call', method: action.functionCall.methodName,
      args: JSON.parse(Buffer.from(action.functionCall.args).toString('utf8')),
      gas: action.functionCall.gas.toString(), deposit_yocto: action.functionCall.deposit.toString() };
    default: throw new Error('unsupported Buffer setup action');
  }
}

/** This review fingerprint is not a signed transaction hash. The caller must
 * retain an independent copy of the exact reviewed stage and compare it again
 * before sending; mutating both the batch and the review defeats this check. */
export function assertBufferWalletBatchMatchesReview(batch, stage) {
  if (!record(batch) || !record(stage) || batch.id !== stage.id || batch.signerId !== stage.signer_id ||
      batch.receiverId !== stage.receiver_id || !Array.isArray(batch.actions) || !Array.isArray(stage.actions) ||
      typeof stage.action_commitment_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stage.action_commitment_sha256)) {
    throw new Error('wallet setup batch does not match retained review');
  }
  let actual;
  try { actual = batch.actions.map(summarize); }
  catch { throw new Error('wallet setup batch does not match retained review'); }
  if (unsignedSvalinBatchCommitment(batch) !== stage.action_commitment_sha256 ||
      JSON.stringify(actual) !== JSON.stringify(stage.actions)) throw new Error('wallet setup batch does not match retained review');
  return true;
}

/** Produce THREE unsigned action batches, never a transaction. The owner must
 * separately approve each stage; the next stage is not safe until the previous
 * one is reconciled. No automatic retry is allowed after an ambiguous result. */
export function buildBufferWalletSetup({ snapshot, wasmBytes, nowMs = Date.now() } = {}) {
  const s = validatedSnapshot(snapshot, nowMs), wasm = checkedWasm(wasmBytes);
  const t = nearApi.transactions;
  const fc = (method, args, gas, deposit) => t.functionCall(method, args, gas, deposit);
  const batches = [
    { id: 'create_keyless_vault', signerId: s.owner, receiverId: s.candidate_vault, actions: [
      t.createAccount(), t.transfer(BigInt(VAULT_NATIVE_FUNDING_YOCTO)), t.deployContract(wasm),
      fc('new', { owner: s.owner }, 30n * TGAS, 0n),
    ] },
    { id: 'register_vault_circle', signerId: s.owner, receiverId: CIRCLE, actions: [
      fc('storage_deposit', { account_id: s.candidate_vault, registration_only: true }, 50n * TGAS,
        BigInt(s.circle_registration_min_yocto)),
    ] },
    { id: 'fund_vault_circle', signerId: s.owner, receiverId: CIRCLE, actions: [
      fc('ft_transfer_call', { receiver_id: s.candidate_vault, amount: BUFFER_FIXED_PRICE_ATOMS, msg: '' }, 300n * TGAS, 1n),
    ] },
  ];
  const stages = batches.map(b => ({ id: b.id, signer_id: b.signerId, receiver_id: b.receiverId,
    actions: b.actions.map(summarize), action_commitment_sha256: unsignedSvalinBatchCommitment(b) }));
  const review = { format: 'bouncer-buffer-wallet-setup-review-v1', network: 'testnet',
    owner: s.owner, vault: s.candidate_vault, snapshot_block_hash: s.block_hash, token: CIRCLE,
    fixed_product: BUFFER_FIXED_PRODUCT_SKU, fixed_product_price_atoms: BUFFER_FIXED_PRICE_ATOMS,
    seller: SELLER, seller_code_hash_observed: s.seller.code_hash,
    vault_wasm_sha256: V12_EXPECTED_SHA256, vault_wasm_near_hash: V12_NEAR_CODE_HASH,
    stages, signing_or_broadcast_authorized: false, wallet_approval_obtained: false,
    safety: 'Testnet only. A keyless deployment can lock its NEAR storage stake; Circle deposit is NOT a seller payment. Reconcile each original before the next stage and never retry an ambiguous send. This does not configure policy or prove delivery.' };
  for (let i = 0; i < batches.length; i++) assertBufferWalletBatchMatchesReview(batches[i], review.stages[i]);
  return { review, batches };
}
