/**
 * Adapter for using a single paid x402 onchain-proof GET as a dependent
 * workflow source. The transfer and response are reconciled by the existing
 * buyer; the selected data is still an untrusted seller assertion, not an
 * oracle or a cryptographic proof of truth. No output can select authority.
 */
import { runOnchainProofGoal, recoverOnchainProofGoal, redeemOnchainProofOnce } from './onchain-proof.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exact(value, names) {
  return plain(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
}

/** An owner pins a small JSON path and primitive type, and accepts the risk. */
export function validateOnchainProofOutput(value) {
  if (!exact(value, ['path', 'type', 'max_age_seconds', 'accept_untrusted_data_risk']) ||
      !Array.isArray(value.path) || value.path.length > 5 ||
      value.path.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key)) ||
      !['string', 'number', 'boolean'].includes(value.type) ||
      !Number.isSafeInteger(value.max_age_seconds) || value.max_age_seconds < 1 || value.max_age_seconds > 900 ||
      value.accept_untrusted_data_risk !== true) throw new Error('invalid or unapproved x402 workflow output selection');
  return { path: [...value.path], type: value.type, max_age_seconds: value.max_age_seconds, accept_untrusted_data_risk: true };
}

/** A strict, bounded projection: never execute, follow links or trust seller metadata. */
export function projectOnchainProofResponse(response, rawSelection) {
  const selection = validateOnchainProofOutput(rawSelection);
  if (!plain(response) || typeof response.content_type !== 'string' ||
      !/^application\/json(?:\s*;[^\r\n]*)?$/i.test(response.content_type) ||
      typeof response.body_base64 !== 'string' || response.body_base64.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.body_base64)) {
    throw new Error('paid x402 response is not bounded application/json; retain the journal, do not repay');
  }
  const bytes = Buffer.from(response.body_base64, 'base64');
  if (bytes.length > 65536 || bytes.toString('base64') !== response.body_base64) throw new Error('invalid paid x402 response bytes');
  let current;
  try { current = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('paid x402 response is not valid UTF-8 JSON; retain the journal, do not repay'); }
  for (const key of selection.path) {
    if (!plain(current) || !Object.hasOwn(current, key)) throw new Error('paid x402 response does not contain the reviewed JSON path; do not repay');
    current = current[key];
  }
  return validateOnchainProofProjection({ value: current }, selection);
}

export function validateOnchainProofProjection(result, rawSelection) {
  const selection = validateOnchainProofOutput(rawSelection), value = result?.value;
  if (!exact(result, ['value']) || typeof value !== selection.type || (selection.type === 'number' &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) ||
      (selection.type === 'string' && (Buffer.byteLength(value, 'utf8') > 512 ||
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)))) {
    throw new Error('paid x402 response does not match the reviewed primitive type and bounds; do not repay');
  }
  return { value };
}

/**
 * Bound the local receipt age before NEW purchases. This does not authenticate
 * the seller's data timestamp or establish that the underlying data is fresh.
 */
export function assertOnchainProofResponseFresh(delivery, rawSelection, now = Date.now()) {
  const selection = validateOnchainProofOutput(rawSelection), value = delivery?.received_at;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || !Number.isSafeInteger(now) ||
      parsed > now + 1000 || now - parsed > selection.max_age_seconds * 1000) {
    throw new Error('x402 response local receipt is stale or invalid; no new downstream payment');
  }
}

function deliveryFrom(goal, selection, journal, result) {
  const entry = journal.get(goal.id);
  if (entry?.status !== 'completed' || entry.redemption?.status !== 'delivered' ||
      !result?.settlement || result.settlement.tx_hash !== entry.tx_hash || !result.response) {
    throw new Error('x402 source was not durably settled and delivered');
  }
  const delivery = { tx_hash: entry.tx_hash, result: projectOnchainProofResponse(result.response, selection),
    received_at: entry.redemption.received_at, verification: 'seller-supplied data; payment verified, content untrusted' };
  // Validate the timestamp shape even when replaying history. Freshness is
  // checked separately, only when a downstream payment is about to happen.
  const received = typeof delivery.received_at === 'string' ? Date.parse(delivery.received_at) : NaN;
  if (!Number.isFinite(received) || new Date(received).toISOString() !== delivery.received_at) throw new Error('invalid recorded x402 receipt time');
  return delivery;
}

export async function runOnchainProofWorkflowSource({ goal, selection, provider, account, publicKey, journal,
  execute = false, fetchImpl = globalThis.fetch, log = console.log }) {
  const result = await runOnchainProofGoal({ goal, provider, account, publicKey, journal, execute, fetchImpl, log });
  if (!execute || result.status === 'BLOCKED') return result;
  if (result.status !== 'RESPONDED') throw new Error('x402 source did not return a recorded response');
  return { status: 'FULFILLED', delivery: deliveryFrom(goal, selection, journal, result) };
}

/** Reconcile FINAL payment without keys; only explicit opt-in may start the first seller request. */
export async function recoverOnchainProofWorkflowSource({ goal, selection, provider, journal, redeemSource = false,
  update = true, fetchImpl = globalThis.fetch, log = console.log }) {
  if (redeemSource && !update) throw new Error('first seller redemption requires writable recovery');
  const recovered = await recoverOnchainProofGoal({ goal, provider, journal, update, log });
  if (recovered.redemption_status === 'delivered') {
    return { status: 'REUSED', delivery: deliveryFrom(goal, selection, journal, recovered) };
  }
  if (recovered.redemption_status === 'not_started' && redeemSource) {
    const response = await redeemOnchainProofOnce({ goal, provider, journal, fetchImpl, log });
    return { status: 'REUSED', delivery: deliveryFrom(goal, selection, journal, response) };
  }
  return { status: 'RECOVERY_REQUIRED', redemption_status: recovered.redemption_status,
    note: recovered.redemption_status === 'not_started'
      ? 'Payment is confirmed; explicitly request the first seller redemption or stop. No new payment.'
      : 'Seller redemption was already attempted and may have been consumed; do not retry or repay automatically.' };
}
