/**
 * Offline matching of an independently retained ORIGINAL wallet transaction
 * against the Buffer forwarder owner plan. This cannot contact an RPC, open a
 * wallet, sign, send, write a journal or authorize the next stage. The RPC
 * result is trusted input, not a consensus proof. Missing/ambiguous originals
 * remain unresolved and must never be retried on the strength of this module.
 * A match does not verify current code, state, owner consent, token provenance,
 * real seller delivery, or whether an original was ever durably recorded.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyBufferForwarderWalletReview } from './buffer-forwarder-wallet-plan.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_buffer_forwarder', 'register_buffer_forwarder_circle', 'pin_buffer_exact_intent'];
const FIELDS = ['kind', 'status', 'network', 'review_sha256', 'stage_id', 'action_commitment_sha256',
  'tx_hash', 'signer_id', 'signer_public_key', 'receiver_id'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (x, names) => record(x) && Object.keys(x).length === names.length && names.every(name => Object.hasOwn(x, name));
const numberString = x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? String(x) :
  typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) ? x : null;
const sha = x => crypto.createHash('sha256').update(x).digest();

// Rebuilding at a deterministic instant before expiry permits reconciliation of
// old transactions after the intent expires. This is NOT a current-time or
// historical-execution freshness check, and must not be used as a preflight.
async function historicalPlan(input) {
  const expires = input.terms?.expires_at_ms;
  if (!Number.isSafeInteger(expires) || expires <= 2) throw new Error('valid retained expiry required');
  return verifyBufferForwarderWalletReview({ review: input.review, trustedReviewHash: input.trustedReviewHash,
    terms: input.terms, spendingReview: input.spendingReview, trustedSpendingReviewHash: input.trustedSpendingReviewHash,
    trustedOwnerPublicKey: input.trustedOwnerPublicKey, nowMs: expires - 1 });
}

/** Create public metadata for an independently retained original hash. This
 * writes nothing and does not prove that the user approved or sent anything. */
export async function prepareBufferForwarderWalletAttempt(raw = {}) {
  const input = structuredClone(raw);
  if (!isTransactionHash(input.trustedOriginalHash) || !STAGES.includes(input.stageId)) {
    throw new Error('reviewed stage and independently retained original hash required');
  }
  const plan = await historicalPlan(input), stage = plan.review.stages[STAGES.indexOf(input.stageId)];
  return { kind: 'buffer-forwarder-wallet-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: input.trustedReviewHash, stage_id: input.stageId, action_commitment_sha256: stage.action_commitment_sha256,
    tx_hash: input.trustedOriginalHash, signer_id: stage.signer_id, signer_public_key: input.trustedOwnerPublicKey,
    receiver_id: stage.receiver_id };
}
function actionMatches(expected, actual) {
  if (expected.enum === 'createAccount') return actual === 'CreateAccount';
  if (expected.enum === 'transfer') return keysAre(actual, ['Transfer']) && keysAre(actual.Transfer, ['deposit']) &&
    numberString(actual.Transfer.deposit) === expected.transfer.deposit.toString();
  // nearcore exposes base64(SHA-256(code)), NOT the raw WASM in ActionView.
  if (expected.enum === 'deployContract') return keysAre(actual, ['DeployContract']) && keysAre(actual.DeployContract, ['code']) &&
    actual.DeployContract.code === sha(Buffer.from(expected.deployContract.code)).toString('base64');
  if (expected.enum === 'functionCall') {
    const a = actual?.FunctionCall, e = expected.functionCall;
    return keysAre(actual, ['FunctionCall']) && keysAre(a, ['method_name', 'args', 'gas', 'deposit']) &&
      a.method_name === e.methodName && a.args === Buffer.from(e.args).toString('base64') &&
      numberString(a.gas) === e.gas.toString() && numberString(a.deposit) === e.deposit.toString();
  }
  return false;
}
const actionsMatch = (expected, actual) => Array.isArray(actual) && expected.length === actual.length &&
  expected.every((action, i) => actionMatches(action, actual[i]));
function statusKind(status) {
  if (!record(status) || Object.keys(status).length !== 1) return null;
  if (typeof status.SuccessValue === 'string') return 'value';
  if (isTransactionHash(status.SuccessReceiptId)) return 'receipt';
  if (record(status.Failure)) return 'failure';
  return null;
}
function graph(result) {
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) || result.receipts.length < 1 ||
      result.receipts.length > 16 || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 16) {
    throw new Error('bounded receipt-inclusive FINAL outcome required');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const item of result.receipts) {
    if (!isTransactionHash(item?.receipt_id) || receipts.has(item.receipt_id)) throw new Error('invalid or duplicate receipt');
    receipts.set(item.receipt_id, item);
  }
  for (const item of result.receipts_outcome) {
    const out = item?.outcome;
    if (!isTransactionHash(item?.id) || outcomes.has(item.id) || !record(out) || !statusKind(out.status) ||
        !Array.isArray(out.receipt_ids) || out.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(out.receipt_ids).size !== out.receipt_ids.length) throw new Error('invalid or duplicate receipt outcome');
    outcomes.set(item.id, out);
  }
  return { receipts, outcomes };
}
function gasRefund(receipt, out, attempt) {
  const action = receipt?.receipt?.Action, actions = action?.actions, transfer = actions?.[0]?.Transfer;
  const deposit = numberString(transfer?.deposit);
  const fields = ['signer_id', 'signer_public_key', 'gas_price', 'input_data_ids', 'output_data_receivers',
    'actions', 'is_promise_yield', 'refund_to'];
  return receipt?.predecessor_id === 'system' && receipt?.receiver_id === attempt.signer_id &&
    keysAre(receipt?.receipt, ['Action']) && record(action) && Object.keys(action).every(k => fields.includes(k)) &&
    action.signer_id === attempt.signer_id && action.signer_public_key === attempt.signer_public_key &&
    numberString(action.gas_price) === '0' && (action.is_promise_yield === undefined || action.is_promise_yield === false) &&
    (action.refund_to === undefined || action.refund_to === null) && Array.isArray(action.input_data_ids) &&
    action.input_data_ids.length === 0 && Array.isArray(action.output_data_receivers) && action.output_data_receivers.length === 0 &&
    Array.isArray(actions) && actions.length === 1 && keysAre(actions[0], ['Transfer']) && keysAre(transfer, ['deposit']) &&
    deposit !== null && BigInt(deposit) > 0n && BigInt(deposit) <= (1n << 128n) - 1n &&
    out?.executor_id === attempt.signer_id && isDeepStrictEqual(out.status, { SuccessValue: '' }) &&
    Array.isArray(out.receipt_ids) && out.receipt_ids.length === 0;
}
function registrationBalance(encoded, expected) {
  if (typeof encoded !== 'string' || encoded.length > 16_384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return false;
  try {
    const balance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return keysAre(balance, ['total', 'available']) && balance.total === expected && balance.available === '0';
  } catch { return false; }
}

/** Check a receipt-inclusive FINAL result against ONLY the original hash and
 * retained action review. A failure still needs full reconciliation and is not
 * permission to resend. Unknown, incomplete or unavailable results throw. */
export async function inspectBufferForwarderWalletAttempt(raw = {}) {
  const input = structuredClone(raw), { attempt, result } = input;
  if (!keysAre(attempt, FIELDS)) throw new Error('original attempt metadata required');
  const plan = await historicalPlan(input);
  const index = STAGES.indexOf(attempt.stage_id), stage = plan.review.stages[index];
  if (index < 0 || !isTransactionHash(input.trustedOriginalHash)) throw new Error('reviewed original stage and hash required');
  const expected = { kind: 'buffer-forwarder-wallet-attempt-v1', status: 'pending', network: 'testnet',
    review_sha256: input.trustedReviewHash, stage_id: attempt.stage_id, action_commitment_sha256: stage.action_commitment_sha256,
    tx_hash: input.trustedOriginalHash, signer_id: stage.signer_id, signer_public_key: input.trustedOwnerPublicKey,
    receiver_id: stage.receiver_id };
  if (!isDeepStrictEqual(attempt, expected)) throw new Error('attempt differs from independently retained original');
  if (!record(result) || result.final_execution_status !== 'FINAL' || !['value', 'failure'].includes(statusKind(result.status))) {
    throw new Error('original transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g = graph(result), batch = plan.batches[index], tx = result.transaction, txo = result.transaction_outcome, top = txo?.outcome;
  if (!record(tx) || tx.hash !== input.trustedOriginalHash || tx.signer_id !== attempt.signer_id ||
      tx.public_key !== attempt.signer_public_key || tx.receiver_id !== attempt.receiver_id || !actionsMatch(batch.actions, tx.actions) ||
      txo?.id !== input.trustedOriginalHash || top?.executor_id !== attempt.signer_id || statusKind(top?.status) !== 'receipt' ||
      !Array.isArray(top.receipt_ids) || top.receipt_ids.length !== 1 || top.receipt_ids[0] !== top.status.SuccessReceiptId) {
    throw new Error('original transaction identity, actions or root link mismatch');
  }
  const rootId = top.status.SuccessReceiptId, root = g.receipts.get(rootId), out = g.outcomes.get(rootId), action = root?.receipt?.Action;
  if (!root || !out || out.executor_id !== attempt.receiver_id || root.predecessor_id !== attempt.signer_id ||
      root.receiver_id !== attempt.receiver_id || !keysAre(root.receipt, ['Action']) || action?.signer_id !== attempt.signer_id ||
      action.signer_public_key !== attempt.signer_public_key || !Array.isArray(action.input_data_ids) || action.input_data_ids.length !== 0 ||
      !Array.isArray(action.output_data_receivers) || action.output_data_receivers.length !== 0 ||
      (action.is_promise_yield !== undefined && action.is_promise_yield !== false) || !actionsMatch(batch.actions, action.actions)) {
    throw new Error('original action receipt missing or differs from reviewed transaction');
  }
  if (statusKind(result.status) === 'failure' || [...g.outcomes.values()].some(item => statusKind(item.status) === 'failure')) {
    return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash, status: 'FINAL_FAILURE_NEEDS_STATE_REVIEW',
      do_not_resend: true, current_state_verified: false, scope: 'trusted-RPC failure indication only; reconcile all effects' };
  }
  if (statusKind(out.status) !== 'value' || !isDeepStrictEqual(result.status, out.status) || out.receipt_ids.length > 1 ||
      g.outcomes.size !== 1 + out.receipt_ids.length || g.receipts.size !== 1 + out.receipt_ids.length ||
      out.receipt_ids.some(id => !gasRefund(g.receipts.get(id), g.outcomes.get(id), attempt))) {
    throw new Error('unexpected, incomplete or nonterminal forwarder setup receipt graph');
  }
  if (index === 1) {
    if (!registrationBalance(out.status.SuccessValue, batch.actions[0].functionCall.deposit.toString())) {
      throw new Error('fresh token registration result differs from the reviewed deposit');
    }
  } else if (out.status.SuccessValue !== '') throw new Error('unexpected forwarder setup return value');
  return { stage_id: attempt.stage_id, tx_hash: attempt.tx_hash, root_receipt: rootId,
    status: 'FINAL_FORWARDER_SETUP_RECEIPT_MATCH', do_not_resend: true, current_state_verified: false,
    deployed_code_at_execution_verified: false, token_code_at_execution_verified: false, owner_approval_verified: false,
    independent_delivery_verified: false, scope: 'trusted-RPC original-hash action/outcome match only; fresh state, code and prerequisites remain unverified' };
}
