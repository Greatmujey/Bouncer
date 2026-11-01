/**
 * Read-only preparation and receipt verification for the experimental V11
 * exact-FT intent route. No quote POST, signature, broadcast or state write.
 * The reviewed provider remains unsigned and independent delivery unproven.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { assertFinalPaymentReceipts } from '../packages/provider-sdk/lib/final-payment.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateMultiAgencyGoal, validateMultiAgencyQuote } from './multiagency-research.mjs';

const GAS = '200000000000000';
const INIT_LOG = 'BOUNCER exact FT intent consumed; transfer initiated';
const SUCCESS_LOG = 'BOUNCER exact FT transfer succeeded; intent stays consumed';
const equals = isDeepStrictEqual;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const positiveRevision = n => Number.isSafeInteger(n) && n > 0;

function normalizeAgentKey(value) {
  if (typeof value !== 'string') throw new Error('an explicit agent public key is required');
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('invalid agent public key'); }
  if (key.keyType !== 0 || String(key) !== value) throw new Error('agent key must be a canonical Ed25519 public key');
  return value;
}

/**
 * Deterministically bind the exact public goal, unsigned quote, agent and
 * safety cutoff. The JSON preimage uses only the explicitly ordered fields
 * below. The 1-yocto owner call still requires independent human review and
 * signing; producing this object does not approve or send it.
 */
export function prepareMultiAgencyExactFt({ goal: rawGoal, quote: rawQuote, agentPublicKey, nowMs = Date.now(), allowExpired = false }) {
  const goal = validateMultiAgencyGoal(rawGoal);
  const q = validateMultiAgencyQuote(goal, rawQuote, { nowMs, allowExpired });
  const publicKey = normalizeAgentKey(agentPublicKey);
  const expires = Date.parse(q.expires_at), cutoff = expires - 5 * 60_000;
  if (!Number.isSafeInteger(cutoff) || cutoff <= 0 || (!allowExpired && cutoff < nowMs + 60_000)) {
    throw new Error('quote is too close to expiry for a five-minute execution cutoff');
  }
  const quote = { code: q.code, title: q.title, status: q.status, channel: q.channel, expires_at: q.expires_at,
    payment: { network: q.payment.network, token: q.payment.token, receiver: q.payment.receiver,
      amount: q.payment.amount, memo: q.payment.memo } };
  const review = { protocol: 'bouncer:multiagency-exact-ft:v1', goal, quote, agent_public_key: publicKey, expires_at_ms: String(cutoff) };
  const reviewHash = crypto.createHash('sha256').update(JSON.stringify(review), 'utf8').digest('hex');
  // 240 bits from a full SHA-256 commitment fit the on-chain 64-byte ID bound.
  const intentId = `ma-${reviewHash.slice(0, 60)}`;
  const args = { intent_id: intentId, policy_id: goal.policy_id, expected_token: quote.payment.token,
    payee: quote.payment.receiver, amount: goal.amount, memo: quote.code, review_hash: reviewHash,
    expires_at_ms: String(cutoff), agent_public_key: publicKey };
  return { review, review_hash: reviewHash, intent_id: intentId,
    owner_call: { receiver_id: goal.vault, method: 'set_exact_ft_intent', attached_yocto: '1', args },
    agent_call: { receiver_id: goal.vault, method: 'execute_exact_ft', attached_yocto: '0', args: { intent_id: intentId } },
    scope: 'unsigned preparation only; no owner signature, provider authentication, payment or delivery' };
}

/** Match all immutable fields and revisions; active is only a route/authority
 * signal and does not check token registration, funding or rolling budget. */
export function assertMultiAgencyExactFtView(prepared, view, { consumed = false } = {}) {
  const a = prepared?.owner_call?.args;
  const keys = ['intent_id', 'policy_id', 'token', 'payee', 'amount', 'memo', 'review_hash', 'expires_at_ms',
    'agent_public_key', 'policy_revision', 'payee_revision', 'agent_revision', 'consumed', 'cancelled', 'active'];
  if (!a || !fields(view, keys) || view.intent_id !== a.intent_id || view.policy_id !== a.policy_id || view.token !== a.expected_token ||
      view.payee !== a.payee || view.amount !== a.amount || view.memo !== a.memo || view.review_hash !== a.review_hash ||
      view.expires_at_ms !== a.expires_at_ms || view.agent_public_key !== a.agent_public_key ||
      !positiveRevision(view.policy_revision) || !positiveRevision(view.payee_revision) || !positiveRevision(view.agent_revision) ||
      view.cancelled !== false || view.consumed !== consumed || view.active !== !consumed) {
    throw new Error('on-chain exact FT intent differs from the reviewed terms or is not in the expected state');
  }
  return structuredClone(view);
}

function json(value, label) {
  if (typeof value !== 'string' || value.length > 24_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > 16_000) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
}
function receiptCall(receipt, predecessor, receiver, name) {
  if (receipt?.predecessor_id !== predecessor || receipt?.receiver_id !== receiver) return null;
  const a = receipt?.receipt?.Action?.actions;
  return Array.isArray(a) && a.length === 1 && a[0]?.FunctionCall?.method_name === name ? a[0].FunctionCall : null;
}
function success(status) {
  return record(status) && status.Failure === undefined && typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined;
}

/** Execution receipt block, used to pin the historic contract identity/view. */
export function multiAgencyExactExecutionBlock(result, vault) {
  const children = result?.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(children) || !Array.isArray(result?.receipts_outcome)) throw new Error('exact FT execution block is unavailable');
  const init = result.receipts_outcome.filter(o => children.includes(o?.id) && o?.outcome?.executor_id === vault && o.outcome.logs?.includes(INIT_LOG));
  if (init.length !== 1 || !isTransactionHash(init[0].block_hash)) throw new Error('exact FT execution block is unavailable or ambiguous');
  return init[0].block_hash;
}

/** Strict FINAL payment proof. Trusts the RPC and the owner-reviewed code hash;
 * does not prove the seller accepted the deposit or delivered useful work. */
export function verifyMultiAgencyExactFtPayment({ goal, quote, publicKey, txHash, result, vaultState, intentState }) {
  const prepared = prepareMultiAgencyExactFt({ goal, quote, agentPublicKey: publicKey, allowExpired: true });
  const a = prepared.owner_call.args;
  if (!isTransactionHash(txHash)) throw new Error('invalid original exact FT transaction hash');
  assertFinalPaymentReceipts(result, a.expected_token);
  const tx = result.transaction;
  if (result.transaction_outcome?.id !== txHash || tx?.hash !== txHash || tx.signer_id !== prepared.review.goal.owner ||
      tx.receiver_id !== prepared.review.goal.vault || tx.public_key !== publicKey || !Array.isArray(tx.actions) || tx.actions.length !== 1) {
    throw new Error('exact FT transaction hash, owner, vault or key differs from review');
  }
  const call = tx.actions[0]?.FunctionCall;
  if (!call || call.method_name !== 'execute_exact_ft' || String(call.deposit) !== '0' || String(call.gas) !== GAS ||
      !equals(json(call.args, 'signed exact FT arguments'), { intent_id: prepared.intent_id })) {
    throw new Error('signed exact FT call differs from the reviewed intent');
  }
  const executionBlock = multiAgencyExactExecutionBlock(result, prepared.review.goal.vault);
  const txBlock = result.transaction_outcome?.block_hash;
  const reviewedState = (state, block) => record(state) && state.block_hash === block && state.code_hash === prepared.review.goal.vault_code_hash &&
    Array.isArray(state.keys) && state.keys.length === 0;
  if (!isTransactionHash(txBlock) || !reviewedState(vaultState, txBlock) || !reviewedState(vaultState.execution, executionBlock)) {
    throw new Error('transaction/execution block vault code or access keys differ from the reviewed keyless deployment');
  }
  if (!record(intentState) || intentState.block_hash !== executionBlock) throw new Error('historic intent view is not bound to the execution block');
  const pinned = assertMultiAgencyExactFtView(prepared, intentState.view, { consumed: true });
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) throw new Error('receipt-inclusive FINAL result required');
  const receiptIds = result.receipts.map(r => r?.receipt_id), outcomeIds = result.receipts_outcome.map(r => r?.id);
  if (receiptIds.some(id => typeof id !== 'string' || !id) || new Set(receiptIds).size !== receiptIds.length ||
      outcomeIds.some(id => typeof id !== 'string' || !id) || new Set(outcomeIds).size !== outcomeIds.length) {
    throw new Error('missing or duplicate exact FT receipt IDs');
  }
  const init = result.receipts_outcome.filter(o => o.block_hash === executionBlock && o.outcome?.executor_id === prepared.review.goal.vault &&
    o.outcome.logs?.includes(INIT_LOG));
  if (init.length !== 1 || !result.transaction_outcome.outcome.receipt_ids.includes(init[0].id)) throw new Error('missing unique bound exact FT initiation');
  const transfer = result.receipts.flatMap(receipt => {
    const method = receiptCall(receipt, prepared.review.goal.vault, a.expected_token, 'ft_transfer');
    return method ? [{ receipt, method }] : [];
  });
  if (transfer.length !== 1 || String(transfer[0].method.deposit) !== '1' ||
      !equals(json(transfer[0].method.args, 'exact FT transfer arguments'), { receiver_id: a.payee, amount: a.amount, memo: a.memo })) {
    throw new Error('token transfer does not match the exact intent');
  }
  const tokenOutcome = result.receipts_outcome.filter(o => o.id === transfer[0].receipt.receipt_id &&
    o.outcome?.executor_id === a.expected_token && success(o.outcome.status));
  if (tokenOutcome.length !== 1) throw new Error('missing unique successful Circle transfer outcome');
  let matches = 0;
  for (const line of tokenOutcome[0].outcome.logs ?? []) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:') || Buffer.byteLength(line) > 16_384) continue;
    let event; try { event = JSON.parse(line.slice(11)); } catch { continue; }
    if (event?.standard !== 'nep141' || event.version !== '1.0.0' || event.event !== 'ft_transfer' || !Array.isArray(event.data)) continue;
    matches += event.data.filter(e => e?.old_owner_id === prepared.review.goal.vault && e.new_owner_id === a.payee &&
      e.amount === a.amount && e.memo === a.memo).length;
  }
  if (matches !== 1) throw new Error('missing unique Circle event for the exact transfer memo; do not repay');
  const callback = result.receipts.flatMap(receipt => {
    const method = receiptCall(receipt, prepared.review.goal.vault, prepared.review.goal.vault, 'after_exact_ft_transfer');
    return method ? [{ receipt, method }] : [];
  });
  if (callback.length !== 1 || String(callback[0].method.deposit) !== '0') throw new Error('missing exact FT callback');
  const cb = json(callback[0].method.args, 'exact FT callback arguments');
  if (!fields(cb, ['intent_id', 'policy_id', 'token', 'amount', 'bucket', 'policy_revision']) || cb.intent_id !== a.intent_id ||
      cb.policy_id !== a.policy_id || cb.token !== a.expected_token || cb.amount !== a.amount || cb.policy_revision !== pinned.policy_revision ||
      !Number.isSafeInteger(cb.bucket) || cb.bucket < 0) throw new Error('exact FT callback arguments differ from review');
  const callbackOutcome = result.receipts_outcome.filter(o => o.id === callback[0].receipt.receipt_id &&
    o.outcome?.executor_id === prepared.review.goal.vault && success(o.outcome.status) &&
    o.outcome.status.SuccessValue === result.status.SuccessValue && o.outcome.logs?.includes(SUCCESS_LOG));
  const children = init[0].outcome.receipt_ids;
  if (callbackOutcome.length !== 1 || !Array.isArray(children) || !children.includes(transfer[0].receipt.receipt_id) ||
      !children.includes(callback[0].receipt.receipt_id) || init[0].outcome.status?.SuccessReceiptId !== callback[0].receipt.receipt_id) {
    throw new Error('exact FT transfer and callback are not bound to the initiation');
  }
  return { tx_hash: txHash, intent_id: a.intent_id, token: a.expected_token, payee: a.payee, amount: a.amount,
    event: 'unique Circle transfer event and reviewed quote memo',
    scope: 'FINAL exact-FT payment only; seller attribution, opening and delivery not established' };
}
