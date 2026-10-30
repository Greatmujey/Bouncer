/**
 * Verify one direct Bouncer FT payment from FINAL, receipt-inclusive trusted
 * NEAR RPC data. This is not a light-client proof or a delivery receipt: it
 * assumes the RPC and the deployed Bouncer/token code are trustworthy.
 */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { assertFinalPaymentReceipts } from './final-payment.mjs';

const { utils } = nearApi;
const equal = isDeepStrictEqual;
const owns = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
export function isTransactionHash(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(value)) return false;
  try {
    const bytes = utils.serialize.base_decode(value);
    return bytes.length === 32 && utils.serialize.base_encode(bytes) === value;
  } catch { return false; }
}
function json(value, label) {
  if (typeof value !== 'string' || value.length > 24_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > 16_000) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
}
function actionReceipt(receipt, predecessor, receiver, name) {
  if (receipt?.predecessor_id !== predecessor || receipt?.receiver_id !== receiver) return null;
  const actions = receipt?.receipt?.Action?.actions;
  return Array.isArray(actions) && actions.length === 1 && actions[0]?.FunctionCall?.method_name === name ? actions[0].FunctionCall : null;
}
function success(status) {
  return status && typeof status === 'object' && !Array.isArray(status) && status.Failure === undefined &&
    typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined;
}

/** `request` is the normalized, owner-reviewed payment already in the journal. */
export function verifyDirectPayment({ result, contractId, ownerAccountId, request, publicKey, txHash }) {
  if (!isTransactionHash(txHash) || typeof publicKey !== 'string' || !publicKey || !request ||
      typeof contractId !== 'string' || typeof ownerAccountId !== 'string') throw new Error('invalid direct-payment proof parameters');
  assertFinalPaymentReceipts(result, request.token);
  const tx = result?.transaction;
  if (result.transaction_outcome?.id !== txHash || tx?.hash !== txHash || tx.signer_id !== ownerAccountId ||
      tx.receiver_id !== contractId || tx.public_key !== publicKey || !Array.isArray(tx.actions) || tx.actions.length !== 1) {
    throw new Error('transaction hash, owner, contract or agent key mismatch');
  }
  const call = tx.actions[0]?.FunctionCall;
  const expected = { policy_id: request.policy_id, payee: request.payee, amount: request.amount,
    memo: request.memo, expected_token: request.token };
  if (!call || call.method_name !== 'execute' || String(call.deposit) !== '0' || String(call.gas) !== '200000000000000' ||
      !equal(json(call.args, 'execute arguments'), expected)) throw new Error('signed execute does not match the reviewed payment');
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) throw new Error('receipt-inclusive final result required');
  // An outcome must describe one unique receipt. In particular, a matching
  // token/callback outcome cannot be borrowed from a duplicated or ambiguous ID.
  const outcomeIds = result.receipts_outcome.map(r => r?.id), receiptIds = result.receipts.map(r => r?.receipt_id);
  if (outcomeIds.some(id => typeof id !== 'string' || !id) || new Set(outcomeIds).size !== outcomeIds.length ||
      receiptIds.some(id => typeof id !== 'string' || !id) || new Set(receiptIds).size !== receiptIds.length) {
    throw new Error('missing or duplicate receipt IDs');
  }
  const initiations = result.receipts_outcome.filter(r => r?.outcome?.executor_id === contractId &&
    r.outcome.logs?.includes('BOUNCER payment initiated'));
  if (initiations.length !== 1) throw new Error('missing unique guarded payment initiation');
  const txChildren = result.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(txChildren) || !txChildren.includes(initiations[0].id)) throw new Error('initiation is not bound to the transaction');
  const transfers = result.receipts.flatMap(receipt => {
    const method = actionReceipt(receipt, contractId, request.token, 'ft_transfer');
    return method ? [{ receipt, method }] : [];
  });
  if (transfers.length !== 1 || String(transfers[0].method.deposit) !== '1' ||
      !equal(json(transfers[0].method.args, 'FT transfer arguments'),
        { receiver_id: request.payee, amount: request.amount, memo: request.memo }) ||
      !result.receipts_outcome.some(r => r.id === transfers[0].receipt.receipt_id && r.outcome?.executor_id === request.token && success(r.outcome.status))) {
    throw new Error('missing matching successful Bouncer-to-token transfer');
  }
  const callbacks = result.receipts.flatMap(receipt => {
    const method = actionReceipt(receipt, contractId, contractId, 'after_execute');
    return method ? [{ receipt, method }] : [];
  });
  if (callbacks.length !== 1 || String(callbacks[0].method.deposit) !== '0') throw new Error('missing unique payment callback');
  const cb = json(callbacks[0].method.args, 'payment callback arguments');
  if (!owns(cb, ['policy_id', 'token', 'amount', 'bucket']) || cb.policy_id !== request.policy_id || cb.token !== request.token ||
      cb.amount !== request.amount || !Number.isSafeInteger(cb.bucket) || cb.bucket < 0 ||
      !result.receipts_outcome.some(r => r.id === callbacks[0].receipt.receipt_id && r.outcome?.executor_id === contractId &&
        success(r.outcome.status) && r.outcome.status.SuccessValue === result.status.SuccessValue)) {
    throw new Error('payment callback does not match the reviewed payment');
  }
  const children = initiations[0].outcome.receipt_ids;
  if (!Array.isArray(children) || !children.includes(transfers[0].receipt.receipt_id) || !children.includes(callbacks[0].receipt.receipt_id)) {
    throw new Error('transfer or callback is not bound to the initiating receipt');
  }
  return { tx_hash: txHash, token: request.token, payee: request.payee, amount: request.amount,
    verification: 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' };
}
