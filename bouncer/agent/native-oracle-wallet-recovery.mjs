/**
 * UNSIGNED, OFFLINE owner recovery for the native-oracle trial. Generates at
 * most two owner-wallet batches: delete the exact agent access key from the
 * owner's account (if it is present), then revoke the vault's one-yocto agent
 * grant. If a fresh independently checked state already shows the access key
 * absent, the review can contain only the grant revocation.
 *
 * This is not a wallet UI, prompt fence, authorization, signature, transaction,
 * chain-state observation or independent backup. A missing local key or
 * failed/unknown transaction is not proof of on-chain revocation. Retain each
 * original hash, check its complete FINAL receipts and fresh state before the
 * next prompt. Pending provider promises may still finish after revocation.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { verifyNativeOracleWalletReview } from './native-oracle-wallet-evidence.mjs';
import { unsignedSvalinBatchCommitment, assertSvalinBatchMatchesReview } from './svalin-setup-plan.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { graph, rootOf, statusKind, onlyProtocolGasRefund } from './setup-receipt-graph.mjs';

const TGAS = 10n ** 12n;
const REMOVE = 'remove_native_oracle_access_key', REVOKE = 'revoke_native_oracle_vault_grant';
const FIELDS = ['kind', 'status', 'network', 'recovery_review_sha256', 'setup_review_sha256', 'stage_id',
  'action_commitment_sha256', 'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => object(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

/** The setup review digest and owner key must be separately retained. The
 * initial presence is an untrusted expectation that a stage preflight must
 * check at a fresh FINAL block, not a claim about current on-chain state. */
export function buildNativeOracleRevocationPlan({ setupReview, wasmBytes, trustedSetupReviewHash,
  trustedOwnerPublicKey, expectedAccessKeyPresent } = {}) {
  if (typeof expectedAccessKeyPresent !== 'boolean') throw new Error('explicit expected on-chain access-key state required');
  const setup = structuredClone(setupReview);
  const id = verifyNativeOracleWalletReview({ review: setup, wasmBytes, trustedReviewHash: trustedSetupReviewHash, trustedOwnerPublicKey });
  const key = nearApi.utils.PublicKey.from(id.agent_public_key), tx = nearApi.transactions;
  const batches = [];
  if (expectedAccessKeyPresent) batches.push({ id: REMOVE, signerId: id.owner, receiverId: id.owner, actions: [tx.deleteKey(key)] });
  batches.push({ id: REVOKE, signerId: id.owner, receiverId: id.vault,
    actions: [tx.functionCall('revoke_agent_key', { policy_id: setup.policy_id, public_key: id.agent_public_key }, 30n * TGAS, 1n)] });
  const stages = batches.map(batch => ({ id: batch.id, signer_id: batch.signerId, receiver_id: batch.receiverId,
    actions: batch.id === REMOVE ? [{ type: 'delete_key', public_key: id.agent_public_key }] :
      [{ type: 'function_call', method: 'revoke_agent_key', args: { policy_id: setup.policy_id, public_key: id.agent_public_key },
        gas: String(30n * TGAS), deposit_yocto: '1' }], action_commitment_sha256: unsignedSvalinBatchCommitment(batch) }));
  batches.forEach((batch, i) => assertSvalinBatchMatchesReview(batch, stages[i]));
  const review = { format: 'bouncer-native-oracle-revocation-review-v1', status: 'UNSIGNED_OFFLINE_PLAN_ONLY', network: 'testnet',
    setup_review_sha256: trustedSetupReviewHash, owner: id.owner, owner_public_key: id.owner_public_key,
    vault: id.vault, policy_id: setup.policy_id, agent_public_key: id.agent_public_key,
    expected_access_key_present: expectedAccessKeyPresent, stages,
    limitations: [
      'Public offline recovery review only; no current state, wallet control, approval, prompt claim or transaction is established.',
      'Confirm the exact owner FullAccess key, agent access-key state, vault code/owner and grant at fresh FINAL blocks before each independently fenced owner prompt.',
      'Record and reconcile the original transaction and its complete FINAL receipt graph before the next stage; a missing or uncertain original must never be resent automatically.',
      'Removing the account access key and revoking the vault grant are separate transactions. A provider request already in flight may still finish.',
      'Local storage loss does not prove the agent key was deleted or the grant revoked; deleting browser data is not on-chain revocation.',
      'This review does not recover locked vault storage collateral or prove independent service delivery.',
    ], signing_authorized: false, transaction_sent: false, onchain_revocation_verified: false };
  return { review: { ...review, review_sha256: sha(JSON.stringify(review)) }, batches };
}

function canonicalPlan({ recoveryReview, setupReview, wasmBytes, trustedSetupReviewHash, trustedRecoveryReviewHash, trustedOwnerPublicKey }) {
  if (!object(recoveryReview) || typeof trustedRecoveryReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedRecoveryReviewHash) ||
      recoveryReview.review_sha256 !== trustedRecoveryReviewHash) throw new Error('independently retained recovery review digest required');
  try {
    const plan = buildNativeOracleRevocationPlan({ setupReview, wasmBytes, trustedSetupReviewHash, trustedOwnerPublicKey,
      expectedAccessKeyPresent: recoveryReview.expected_access_key_present });
    if (!isDeepStrictEqual(plan.review, recoveryReview)) throw Error();
    return plan;
  } catch { throw new Error('recovery review differs from its constrained canonical plan'); }
}
export function verifyNativeOracleRevocationReview(options = {}) {
  const plan = canonicalPlan(options), r = plan.review;
  return { recovery_review_sha256: r.review_sha256, setup_review_sha256: r.setup_review_sha256,
    owner: r.owner, owner_public_key: r.owner_public_key, vault: r.vault, policy_id: r.policy_id,
    agent_public_key: r.agent_public_key, expected_access_key_present: r.expected_access_key_present };
}
export function prepareNativeOracleRevocationAttempt(options = {}) {
  const { stageId, trustedOriginalHash } = options, plan = canonicalPlan(options), i = plan.batches.findIndex(b => b.id === stageId);
  if (i < 0 || !isTransactionHash(trustedOriginalHash)) throw new Error('reviewed recovery stage and original hash required');
  const review = plan.review, stage = review.stages[i];
  return { kind: 'native-oracle-revocation-attempt-v1', status: 'pending', network: 'testnet',
    recovery_review_sha256: review.review_sha256, setup_review_sha256: review.setup_review_sha256,
    stage_id: stage.id, action_commitment_sha256: stage.action_commitment_sha256, tx_hash: trustedOriginalHash,
    signer_id: stage.signer_id, signer_public_key: review.owner_public_key, receiver_id: stage.receiver_id };
}
/** Match the retained original and trusted-RPC receipt graph only. It never
 * establishes that the key/grant remains absent at a later block. */
export function inspectNativeOracleRevocationAttempt(options = {}) {
  const { attempt, result } = options;
  if (!exact(attempt, FIELDS)) throw new Error('independently retained original recovery attempt required');
  const expected = prepareNativeOracleRevocationAttempt({ ...options, stageId: attempt.stage_id });
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('recovery attempt differs from the retained original');
  const plan = canonicalPlan(options), batch = plan.batches.find(b => b.id === attempt.stage_id);
  if (!object(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original recovery transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g = graph(result, attempt.stage_id === REMOVE), root = rootOf(result, batch, attempt, g);
  if (!root.localReceiptOmitted) {
    const action = root.receipt.receipt?.Action;
    if (!exact(root.receipt.receipt, ['Action']) || !Array.isArray(action?.input_data_ids) || action.input_data_ids.length ||
        !Array.isArray(action?.output_data_receivers) || action.output_data_receivers.length ||
        (action.is_promise_yield !== undefined && action.is_promise_yield !== false)) throw new Error('unexpected recovery action receipt metadata');
  }
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: options.trustedOriginalHash, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
      do_not_resend: true, onchain_revocation_verified: false, current_state_verified: false };
  }
  if (!isDeepStrictEqual(result.status, { SuccessValue: '' }) || !isDeepStrictEqual(root.outcome.status, result.status) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id ||
      !onlyProtocolGasRefund(root.outcome, g, attempt, root.localReceiptOmitted)) throw new Error('unexpected or incomplete recovery receipt graph');
  return { stage_id: attempt.stage_id, tx_hash: options.trustedOriginalHash, root_receipt: root.id,
    status: root.localReceiptOmitted ? 'FINAL_LOCAL_DELETE_KEY_OUTCOME_MATCH' : 'FINAL_NATIVE_RECOVERY_RECEIPT_MATCH',
    local_receipt_body_omitted: root.localReceiptOmitted, do_not_resend: true,
    current_state_verified: false, onchain_revocation_verified: false, owner_approval_verified: false,
    scope: 'trusted-RPC original action/outcome match only; fresh state and a separate prompt fence remain required' };
}
