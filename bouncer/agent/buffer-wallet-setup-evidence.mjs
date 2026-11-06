/**
 * Offline reconciliation for the ORIGINAL wallet transactions that create,
 * register and fund the Buffer V12 vault. This never opens a wallet, signs,
 * broadcasts, fetches RPC data, retains anything, or permits another attempt.
 * A missing hash or ambiguous outcome remains blocked; never resend it.
 *
 * The caller must independently retain the public setup review and its hash,
 * the snapshot used to build it, the actual owner key, and the original hash.
 * Supplied RPC results are trusted, not a light-client or consensus proof.
 */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup, BUFFER_FIXED_PRICE_ATOMS } from './buffer-wallet-setup-plan.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { statusKind, decodeJson, graph, rootOf, onlyProtocolGasRefund, fundingEvidence } from './setup-receipt-graph.mjs';

const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function ownerKey(value) {
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('canonical owner public key required'); }
  if (typeof value !== 'string' || String(key) !== value ||
      !((key.keyType === 0 && key.ed25519Key?.data?.length === 32) ||
        (key.keyType === 1 && key.secp256k1Key?.data?.length === 64))) {
    throw new Error('canonical owner public key required');
  }
  return value;
}

// Recreate the constrained batches from the separately retained setup snapshot
// and the pinned V12 bytes. The old block's timestamp is used ONLY to rebuild
// the historical plan; it never establishes freshness or permits execution.
function canonicalPlan(review, snapshot, wasmBytes, trustedReviewHash) {
  if (!record(review) || typeof trustedReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedReviewHash) ||
      review.review_sha256 !== trustedReviewHash) throw new Error('independently retained setup review digest required');
  try {
    const nanos = snapshot?.block_timestamp_nanosec;
    if (typeof nanos !== 'string' || !/^[1-9][0-9]{0,19}$/.test(nanos)) throw new Error('invalid timestamp');
    const millis = BigInt(nanos) / 1_000_000n;
    if (millis < 1n || millis > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid timestamp');
    const plan = buildBufferWalletSetup({ snapshot, wasmBytes, nowMs: Number(millis) });
    if (!isDeepStrictEqual(plan.review, review)) throw new Error('review differs');
    return plan;
  } catch {
    throw new Error('Buffer setup review differs from its constrained canonical plan');
  }
}

function attemptFor(plan, trustedReviewHash, stageId, trustedOriginalHash, key) {
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(trustedOriginalHash)) throw new Error('reviewed setup stage and original hash required');
  const stage = plan.review.stages[index];
  return { kind: 'buffer-wallet-setup-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: trustedReviewHash, stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256,
    tx_hash: trustedOriginalHash, signer_id: stage.signer_id, signer_public_key: key, receiver_id: stage.receiver_id };
}

/** Verify the independently retained anchors and canonical public review only.
 * Neither the historical snapshot nor this result proves current state. */
export function verifyBufferWalletSetupReview({ review, snapshot, wasmBytes, trustedReviewHash, trustedOwnerPublicKey } = {}) {
  const plan = canonicalPlan(review, snapshot, wasmBytes, trustedReviewHash), key = ownerKey(trustedOwnerPublicKey);
  return { review_sha256: trustedReviewHash, owner: plan.review.owner, vault: plan.review.vault, owner_public_key: key };
}

/** Create public metadata for a single, independently retained ORIGINAL hash.
 * A wallet result without a hash is unresolved, not authority to try again. */
export function prepareBufferWalletSetupAttempt({ review, snapshot, wasmBytes, trustedReviewHash,
  stageId, trustedOriginalHash, trustedOwnerPublicKey } = {}) {
  const plan = canonicalPlan(review, snapshot, wasmBytes, trustedReviewHash), key = ownerKey(trustedOwnerPublicKey);
  return attemptFor(plan, trustedReviewHash, stageId, trustedOriginalHash, key);
}

/** Match the original reviewed transaction and its linked receipt graph.
 * FINAL failure still needs reconciliation; any incomplete or altered result
 * throws. A match is not approval, deployed-code/current-state verification,
 * an independent audit, seller payment, or seller delivery. */
export function inspectBufferWalletSetupAttempt({ review, snapshot, wasmBytes, trustedReviewHash, trustedOriginalHash,
  trustedOwnerPublicKey, attempt, result } = {}) {
  if (!keysAre(attempt, ATTEMPT_FIELDS) || !isTransactionHash(trustedOriginalHash) ||
      attempt.tx_hash !== trustedOriginalHash || ownerKey(trustedOwnerPublicKey) !== attempt.signer_public_key) {
    throw new Error('the independently retained original hash and owner key are required');
  }
  const plan = canonicalPlan(review, snapshot, wasmBytes, trustedReviewHash);
  const expected = attemptFor(plan, trustedReviewHash, attempt.stage_id, trustedOriginalHash, trustedOwnerPublicKey);
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('setup attempt differs from the retained original');
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original transaction is not terminal FINAL; preserve it and do not resend');
  }
  const batch = plan.batches[STAGES.indexOf(attempt.stage_id)], g = graph(result), root = rootOf(result, batch, attempt, g);
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash, status: 'FINAL_FAILURE_NEEDS_RECONCILIATION',
      do_not_resend: true, current_state_verified: false,
      scope: 'trusted-RPC failure indication only; inspect all effects before any separately approved action' };
  }
  let funding = null;
  if (attempt.stage_id === 'fund_vault_circle') {
    funding = fundingEvidence(result, root, g, { owner: review.owner, vault: review.vault,
      token: CIRCLE_TESTNET_USDC, amount: BUFFER_FIXED_PRICE_ATOMS });
  } else {
    if (statusKind(root.outcome.status) !== 'value' || root.outcome.status.SuccessValue !== result.status.SuccessValue ||
        result.transaction_outcome.outcome.receipt_ids.length !== 1 || !onlyProtocolGasRefund(root.outcome, g, attempt)) {
      throw new Error('setup action receipt or its linked outcomes are incomplete or unexpected');
    }
    if (attempt.stage_id === 'create_keyless_vault') {
      if (root.outcome.status.SuccessValue !== '') throw new Error('vault initialization returned an unexpected value');
    } else {
      const balance = decodeJson(root.outcome.status.SuccessValue, 'token registration result');
      const deposit = batch.actions[0].functionCall.deposit.toString();
      if (!keysAre(balance, ['total', 'available']) || balance.total !== deposit || balance.available !== '0') {
        throw new Error('token registration result does not match the reviewed fresh registration');
      }
    }
  }
  return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash,
    status: funding ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH', root_receipt: root.id, funding,
    do_not_resend: true, current_state_verified: false, deployed_code_at_execution_verified: false,
    owner_approval_verified: false, seller_payment_verified: false, seller_delivery_verified: false,
    scope: 'trusted-RPC original-hash action and receipt matching only; verify deployed code and fresh state separately' };
}
