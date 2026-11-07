/**
 * Reconcile one ORIGINAL native-vault wallet transaction against a separately
 * retained review, public owner key and original hash. Supplied chain results
 * are trusted RPC data. No wallet, signature, submission, or retry occurs.
 * Success here is not current-state verification, consent, or provider work.
 */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan } from './native-oracle-wallet-plan.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { graph, rootOf, statusKind, onlyProtocolGasRefund } from './setup-receipt-graph.mjs';

const STAGES = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, names) => record(x) && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name));
function ownerKey(value) {
  try {
    const key = nearApi.utils.PublicKey.from(value);
    if (typeof value !== 'string' || String(key) !== value ||
        !((key.keyType === 0 && key.ed25519Key?.data?.length === 32) || (key.keyType === 1 && key.secp256k1Key?.data?.length === 64))) throw Error();
    return value;
  } catch { throw new Error('canonical owner public key required'); }
}
function canonicalPlan(review, wasmBytes, trustedReviewHash) {
  if (!record(review) || typeof trustedReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedReviewHash) ||
      review.review_sha256 !== trustedReviewHash) throw new Error('independently retained native review digest required');
  try {
    const plan = buildNativeOracleWalletPlan({ wasmBytes, terms: {
      owner: review.owner, vault: review.vault, policy_id: review.policy_id, agent_public_key: review.agent_public_key,
      per_tx_cap_yocto: review.per_tx_cap_yocto, daily_cap_yocto: review.daily_cap_yocto,
      vault_deposit_yocto: review.vault_deposit_yocto, agent_gas_allowance_yocto: review.agent_gas_allowance_yocto,
    } });
    if (!isDeepStrictEqual(plan.review, review)) throw Error();
    return plan;
  } catch { throw new Error('native review differs from its constrained canonical plan'); }
}
export function verifyNativeOracleWalletReview({ review, wasmBytes, trustedReviewHash, trustedOwnerPublicKey } = {}) {
  const plan = canonicalPlan(review, wasmBytes, trustedReviewHash), key = ownerKey(trustedOwnerPublicKey);
  if (key === plan.review.agent_public_key) throw new Error('owner and restricted agent keys must be distinct');
  return { review_sha256: trustedReviewHash, owner: plan.review.owner, vault: plan.review.vault,
    owner_public_key: key, agent_public_key: plan.review.agent_public_key };
}
export function prepareNativeOracleWalletAttempt({ review, wasmBytes, trustedReviewHash, trustedOwnerPublicKey,
  stageId, trustedOriginalHash } = {}) {
  const id = verifyNativeOracleWalletReview({ review, wasmBytes, trustedReviewHash, trustedOwnerPublicKey });
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(trustedOriginalHash)) throw new Error('reviewed native stage and original hash required');
  const stage = review.stages[index];
  return { kind: 'native-oracle-wallet-attempt-v1', status: 'pending', network: 'testnet', review_sha256: id.review_sha256,
    stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256, tx_hash: trustedOriginalHash,
    signer_id: stage.signer_id, signer_public_key: id.owner_public_key, receiver_id: stage.receiver_id };
}

/** Match exact transaction actions and close the bounded receipt graph.
 * Unknown, missing or failed originals do not authorize another prompt. */
export function inspectNativeOracleWalletAttempt({ review, wasmBytes, trustedReviewHash, trustedOriginalHash,
  trustedOwnerPublicKey, attempt, result } = {}) {
  if (!exact(attempt, ATTEMPT_FIELDS)) throw new Error('independently retained original attempt required');
  const expected = prepareNativeOracleWalletAttempt({ review, wasmBytes, trustedReviewHash, trustedOriginalHash,
    trustedOwnerPublicKey, stageId: attempt.stage_id });
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('native attempt differs from its retained original');
  const plan = canonicalPlan(review, wasmBytes, trustedReviewHash), batch = plan.batches[STAGES.indexOf(attempt.stage_id)];
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g = graph(result, attempt.stage_id === 'install_native_oracle_agent'), root = rootOf(result, batch, attempt, g);
  if (!root.localReceiptOmitted) {
    const action = root.receipt.receipt?.Action;
    if (!exact(root.receipt.receipt, ['Action']) || !Array.isArray(action?.input_data_ids) || action.input_data_ids.length ||
        !Array.isArray(action?.output_data_receivers) || action.output_data_receivers.length ||
        (action.is_promise_yield !== undefined && action.is_promise_yield !== false)) throw new Error('unexpected native action receipt metadata');
  }
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: trustedOriginalHash, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
      do_not_resend: true, current_state_verified: false, scope: 'trusted-RPC failure indication only; reconcile all effects' };
  }
  if (!isDeepStrictEqual(result.status, { SuccessValue: '' }) || !isDeepStrictEqual(root.outcome.status, result.status) ||
      result.transaction_outcome.outcome.receipt_ids.length !== 1 || result.transaction_outcome.outcome.receipt_ids[0] !== root.id ||
      !onlyProtocolGasRefund(root.outcome, g, attempt, root.localReceiptOmitted) ||
      (attempt.stage_id === 'fund_native_vault' && (!Array.isArray(root.outcome.logs) || !root.outcome.logs.includes('BOUNCER native deposit received')))) {
    throw new Error('unexpected, incomplete or nonterminal native setup receipt graph');
  }
  return { stage_id: attempt.stage_id, tx_hash: trustedOriginalHash, root_receipt: root.id,
    status: root.localReceiptOmitted ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_NATIVE_SETUP_RECEIPT_MATCH',
    local_receipt_body_omitted: root.localReceiptOmitted, do_not_resend: true, current_state_verified: false,
    deployed_code_at_execution_verified: false, owner_approval_verified: false, independent_delivery_verified: false,
    scope: 'trusted-RPC original-hash action/outcome match only; fresh state, code and all other prerequisites require separate checks' };
}
