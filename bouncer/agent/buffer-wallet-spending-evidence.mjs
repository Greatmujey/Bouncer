/**
 * Offline, original-hash reconciliation for the three unsigned Buffer wallet
 * policy/key batches. This module never opens a wallet, signs, sends, writes a
 * journal, queries RPC, or decides that a later stage is safe. Its inputs must
 * include an independently retained review, original hash and owner key. A
 * matching receipt trusts the supplied RPC, not a consensus/light-client proof.
 *
 * Crucially, this does NOT solve the pre-prompt fence: wallets may broadcast
 * before returning a hash. If that original hash is missing or the result is
 * ambiguous, keep the attempt blocked and never manufacture a replacement.
 */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from './buffer-wallet-spending-plan.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent'];
const ATTEMPT_FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const numberString = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) :
  typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) ? value : null;

function canonicalOwnerKey(value) {
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('canonical owner public key required'); }
  if (typeof value !== 'string' || String(key) !== value ||
      !((key.keyType === 0 && key.ed25519Key?.data?.length === 32) ||
        (key.keyType === 1 && key.secp256k1Key?.data?.length === 64))) {
    throw new Error('canonical owner public key required');
  }
  return value;
}

// Rebuild all of the constrained policy and key batches from the retained
// public review, not from a caller-provided mutable SDK transaction.
function canonicalPlan(review, trustedReviewHash) {
  if (!record(review) || typeof trustedReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedReviewHash) ||
      review.review_sha256 !== trustedReviewHash) throw new Error('independently retained review digest required');
  let plan;
  try {
    plan = buildBufferWalletSpendingPlan({ owner: review.owner, vault: review.vault, adapter: review.adapter,
      policy_id: review.policy_id, vault_agent_public_key: review.vault_agent_public_key,
      forwarder_agent_public_key: review.forwarder_agent_public_key, per_tx_cap_atoms: review.per_tx_cap_atoms,
      daily_cap_atoms: review.daily_cap_atoms, vault_agent_gas_allowance_yocto: review.stages?.[1]?.actions?.[0]?.allowance_yocto,
      forwarder_agent_gas_allowance_yocto: review.stages?.[2]?.actions?.[0]?.allowance_yocto });
    if (!isDeepStrictEqual(plan.review, review)) throw new Error('review differs');
  } catch { throw new Error('Buffer spending review differs from its constrained canonical plan'); }
  return plan;
}

/** Returns PUBLIC metadata only; this does not retain it or prove approval.
 * The hash and owner key must be retained independently, not taken on faith
 * from a later RPC response. A missing wallet-returned hash remains unresolved. */
export function prepareBufferSpendingAttempt({ review, trustedReviewHash, stageId, trustedOriginalHash, trustedOwnerPublicKey } = {}) {
  const plan = canonicalPlan(review, trustedReviewHash), index = STAGES.indexOf(stageId);
  const key = canonicalOwnerKey(trustedOwnerPublicKey);
  if (index < 0 || !isTransactionHash(trustedOriginalHash) || key === review.vault_agent_public_key ||
      key === review.forwarder_agent_public_key) throw new Error('reviewed stage, original hash and distinct owner key required');
  const stage = plan.review.stages[index];
  return { kind: 'buffer-wallet-spending-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: trustedReviewHash, stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256,
    tx_hash: trustedOriginalHash, signer_id: stage.signer_id, signer_public_key: key, receiver_id: stage.receiver_id };
}

function actionMatches(expected, actual) {
  if (expected.enum === 'functionCall') {
    const e = expected.functionCall, a = actual?.FunctionCall;
    return keysAre(actual, ['FunctionCall']) && keysAre(a, ['method_name', 'args', 'gas', 'deposit']) &&
      a.method_name === e.methodName && a.args === Buffer.from(e.args).toString('base64') &&
      numberString(a.gas) === e.gas.toString() && numberString(a.deposit) === e.deposit.toString();
  }
  if (expected.enum === 'addKey') {
    const e = expected.addKey, a = actual?.AddKey, access = a?.access_key;
    const perm = access?.permission?.FunctionCall, expectedPerm = e.accessKey.permission.functionCall;
    return keysAre(actual, ['AddKey']) && keysAre(a, ['public_key', 'access_key']) &&
      a.public_key === String(e.publicKey) && keysAre(access, ['nonce', 'permission']) &&
      numberString(access.nonce) === e.accessKey.nonce.toString() && keysAre(access.permission, ['FunctionCall']) &&
      keysAre(perm, ['allowance', 'receiver_id', 'method_names']) && numberString(perm.allowance) === expectedPerm.allowance.toString() &&
      perm.receiver_id === expectedPerm.receiverId && isDeepStrictEqual(perm.method_names, expectedPerm.methodNames);
  }
  return false;
}
const actionsMatch = (expected, actual) => Array.isArray(actual) && actual.length === expected.length &&
  expected.every((item, index) => actionMatches(item, actual[index]));
function statusKind(status) {
  if (!record(status) || Object.keys(status).length !== 1) return null;
  if (typeof status.SuccessValue === 'string') return 'value';
  if (isTransactionHash(status.SuccessReceiptId)) return 'receipt';
  if (record(status.Failure)) return 'failure';
  return null;
}
function readGraph(result) {
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length > 16 || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 16) {
    throw new Error('bounded receipt-inclusive FINAL result required');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const receipt of result.receipts) {
    if (!isTransactionHash(receipt?.receipt_id) || receipts.has(receipt.receipt_id)) throw new Error('invalid or duplicate receipt');
    receipts.set(receipt.receipt_id, receipt);
  }
  for (const item of result.receipts_outcome) {
    const out = item?.outcome;
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(out) || !statusKind(out.status) ||
        !Array.isArray(out.receipt_ids) || out.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(out.receipt_ids).size !== out.receipt_ids.length) throw new Error('invalid or duplicate outcome');
    outcomes.set(item.id, out);
  }
  return { receipts, outcomes };
}
function protocolGasRefund(receipt, outcome, attempt) {
  const action = receipt?.receipt?.Action, actions = action?.actions, transfer = actions?.[0]?.Transfer;
  const deposit = numberString(transfer?.deposit);
  const fields = ['signer_id', 'signer_public_key', 'gas_price', 'input_data_ids', 'output_data_receivers',
    'actions', 'is_promise_yield', 'refund_to'];
  return receipt?.predecessor_id === 'system' && receipt?.receiver_id === attempt.signer_id &&
    keysAre(receipt?.receipt, ['Action']) && record(action) && Object.keys(action).every(k => fields.includes(k)) &&
    action.signer_id === attempt.signer_id && action.signer_public_key === attempt.signer_public_key &&
    numberString(action.gas_price) === '0' && (action.is_promise_yield === undefined || action.is_promise_yield === false) &&
    (action.refund_to === undefined || action.refund_to === null) &&
    Array.isArray(action.input_data_ids) && action.input_data_ids.length === 0 &&
    Array.isArray(action.output_data_receivers) && action.output_data_receivers.length === 0 &&
    Array.isArray(actions) && actions.length === 1 && keysAre(actions[0], ['Transfer']) && keysAre(transfer, ['deposit']) &&
    deposit !== null && BigInt(deposit) > 0n && BigInt(deposit) <= (1n << 128n) - 1n &&
    outcome?.executor_id === attempt.signer_id && isDeepStrictEqual(outcome.status, { SuccessValue: '' }) &&
    Array.isArray(outcome.receipt_ids) && outcome.receipt_ids.length === 0;
}

/** Match a receipt-inclusive FINAL trusted-RPC result to an independently
 * retained original attempt. Even a match never verifies current state,
 * deployed code, owner consent, key backup, or an independent FT delivery. */
export function inspectBufferSpendingAttempt({ review, trustedReviewHash, trustedOriginalHash, trustedOwnerPublicKey, attempt, result } = {}) {
  if (!keysAre(attempt, ATTEMPT_FIELDS)) throw new Error('original attempt metadata required');
  const expectedAttempt = prepareBufferSpendingAttempt({ review, trustedReviewHash, stageId: attempt.stage_id,
    trustedOriginalHash, trustedOwnerPublicKey });
  if (!isDeepStrictEqual(attempt, expectedAttempt)) throw new Error('attempt differs from independently retained original');
  const plan = canonicalPlan(review, trustedReviewHash), batch = plan.batches[STAGES.indexOf(attempt.stage_id)];
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original transaction is not terminal FINAL; preserve it and do not resend');
  }
  const graph = readGraph(result), tx = result.transaction, txo = result.transaction_outcome, top = txo?.outcome;
  if (!record(tx) || tx.hash !== trustedOriginalHash || tx.signer_id !== attempt.signer_id || tx.public_key !== attempt.signer_public_key ||
      tx.receiver_id !== attempt.receiver_id || !actionsMatch(batch.actions, tx.actions) || txo?.id !== trustedOriginalHash ||
      top?.executor_id !== attempt.signer_id || statusKind(top?.status) !== 'receipt' ||
      !Array.isArray(top.receipt_ids) || top.receipt_ids.length !== 1 || top.receipt_ids[0] !== top.status.SuccessReceiptId) {
    throw new Error('original transaction identity, actions or root link mismatch');
  }
  const rootId = top.status.SuccessReceiptId, root = graph.receipts.get(rootId), outcome = graph.outcomes.get(rootId);
  const localOmitted = !root;
  if (!outcome || outcome.executor_id !== attempt.receiver_id) throw new Error('original action outcome missing or mismatched');
  if (localOmitted) {
    if (attempt.signer_id !== attempt.receiver_id || !['install_buffer_vault_agent', 'install_buffer_forwarder_agent'].includes(attempt.stage_id) ||
        batch.actions.length !== 1 || batch.actions[0].enum !== 'addKey') throw new Error('root receipt body missing');
  } else {
    const action = root.receipt?.Action;
    if (root.predecessor_id !== attempt.signer_id || root.receiver_id !== attempt.receiver_id || !keysAre(root.receipt, ['Action']) ||
        action?.signer_id !== attempt.signer_id || action.signer_public_key !== attempt.signer_public_key ||
        !Array.isArray(action.input_data_ids) || action.input_data_ids.length !== 0 ||
        !Array.isArray(action.output_data_receivers) || action.output_data_receivers.length !== 0 ||
        (action.is_promise_yield !== undefined && action.is_promise_yield !== false) ||
        !actionsMatch(batch.actions, action.actions)) throw new Error('root receipt differs from reviewed transaction');
  }
  if (statusKind(result.status) === 'failure' || [...graph.outcomes.values()].some(out => statusKind(out.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: trustedOriginalHash, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
      do_not_resend: true, current_state_verified: false, scope: 'trusted-RPC failure indication only; reconcile all effects' };
  }
  if (!isDeepStrictEqual(result.status, { SuccessValue: '' }) || !isDeepStrictEqual(outcome.status, result.status) ||
      outcome.receipt_ids.length > 1 || graph.outcomes.size !== 1 + outcome.receipt_ids.length ||
      graph.receipts.size !== (localOmitted ? 0 : 1) + outcome.receipt_ids.length ||
      outcome.receipt_ids.some(id => !protocolGasRefund(graph.receipts.get(id), graph.outcomes.get(id), attempt))) {
    throw new Error('unexpected, incomplete or nonterminal spending setup receipt graph');
  }
  return { stage_id: attempt.stage_id, tx_hash: trustedOriginalHash, root_receipt: rootId,
    status: localOmitted ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_SPENDING_SETUP_RECEIPT_MATCH',
    local_receipt_body_omitted: localOmitted, do_not_resend: true, current_state_verified: false,
    deployed_code_at_execution_verified: false, owner_approval_verified: false, independent_delivery_verified: false,
    scope: 'trusted-RPC original-hash action/outcome match only; fresh state, code and all other prerequisites require separate checks' };
}
