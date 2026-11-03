/** FINAL trusted-RPC verification of the first Tollgate `settle` transaction.
 * A seller acknowledgement is not a settlement. The on-chain `settle` method
 * updates accounting and schedules a DETACHED native transfer, whose separate
 * receipt must also succeed. No signing, transaction broadcast, seller HTTP
 * request or voucher retry occurs here. Trust assumptions: the supplied RPC,
 * the reviewed pre-purchase snapshot and the pinned provider code; this is not
 * a light-client proof or an audit. Return only public summary fields, never
 * the transaction/voucher signature or raw receipt arguments. */
import nearApi from 'near-api-js';
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateTollgateQuakesReview, tollgateQuakesReviewHash, TOLLGATE_CHANNEL_CODE_HASH } from './tollgate-quakes-v13.mjs';

const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, a) => obj(x) && Object.keys(x).sort().join(',') === [...a].sort().join(',');
const dec = (x, max = (1n << 128n) - 1n) => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= max;
const same = isDeepStrictEqual;
function b64(value, max, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  return bytes;
}
function json64(value, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64(value, 16_000, label))); }
  catch { throw new Error(`invalid ${label}`); }
}
function success(status) {
  return obj(status) && Object.keys(status).length === 1 && typeof status.SuccessValue === 'string';
}
function oneAction(receipt) {
  const actions = receipt?.receipt?.Action?.actions;
  return Array.isArray(actions) && actions.length === 1 ? actions[0] : null;
}
function eventLog(logs) {
  if (!Array.isArray(logs) || logs.length > 100) throw new Error('settlement logs missing or excessive');
  const matches = [];
  for (const line of logs) {
    if (typeof line !== 'string' || line.length > 16_000) throw new Error('invalid settlement log');
    if (!line.startsWith('EVENT_JSON:')) continue;
    let event; try { event = JSON.parse(line.slice('EVENT_JSON:'.length)); } catch { throw new Error('invalid settlement event'); }
    if (event?.standard === 'tollgate' && event?.event === 'channel_settled') matches.push(event);
  }
  if (matches.length !== 1 || matches[0].version !== '1.0.0' || !Array.isArray(matches[0].data) || matches[0].data.length !== 1) {
    throw new Error('unique Tollgate settlement event required');
  }
  return matches[0].data[0];
}
function context(raw, purchase, txHash) {
  const review = validateTollgateQuakesReview(raw), reviewHash = tollgateQuakesReviewHash(review);
  if (!isTransactionHash(txHash) || !obj(purchase) || purchase.network !== 'testnet' || purchase.fenced !== true ||
      purchase.owner !== review.owner || purchase.vault !== review.vault || purchase.review_hash !== reviewHash ||
      purchase.intent_id !== review.intent_id || !dec(purchase.channel_id, 0xffffffffn) ||
      purchase.price_yocto !== review.price_yocto || purchase.channel_budget_yocto !== review.channel_budget_yocto ||
      !dec(purchase.channel_deposit_yocto) || !dec(purchase.channel_storage_fee_yocto) ||
      BigInt(purchase.channel_deposit_yocto) + BigInt(purchase.channel_storage_fee_yocto) !== BigInt(review.channel_budget_yocto) ||
      BigInt(purchase.channel_deposit_yocto) < BigInt(review.price_yocto) || !isTransactionHash(purchase.snapshot_block_hash)) {
    throw new Error('matching pre-purchase reviewed channel snapshot required');
  }
  return { review, reviewHash };
}

/** Pure receipt-graph check for the *first* reviewed settle, using caller-
 * supplied RPC data. For a public-chain claim use inspectTollgateSettlement,
 * which also checks the RPC chain and contract code at the execution block. */
export function verifyTollgateSettlementReceipts({ review: raw, purchase, txHash, result } = {}) {
  const { review, reviewHash } = context(raw, purchase, txHash);
  if (result?.final_execution_status !== 'FINAL' || !success(result.status) ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length < 2 || result.receipts.length > 100 || result.receipts_outcome.length < 2 || result.receipts_outcome.length > 100) {
    throw new Error('receipt-inclusive FINAL settlement result required');
  }
  const tx = result.transaction, txOutcome = result.transaction_outcome;
  if (tx?.hash !== txHash || txOutcome?.id !== txHash || tx.signer_id !== review.seller || tx.receiver_id !== review.channel_contract ||
      !Array.isArray(tx.actions) || tx.actions.length !== 1 || !Array.isArray(txOutcome?.outcome?.receipt_ids) ||
      txOutcome.outcome.executor_id !== review.seller || !obj(txOutcome.outcome.status) ||
      !isTransactionHash(txOutcome.outcome.status.SuccessReceiptId)) throw new Error('settlement transaction identity differs');
  const action = tx.actions[0]?.FunctionCall;
  if (!action || action.method_name !== 'settle' || String(action.deposit) !== '0') throw new Error('seller did not call the reviewed settle method');
  const args = json64(action.args, 'settlement arguments');
  if (!keys(args, ['channel_id', 'cumulative_amount', 'nonce', 'signature']) || args.channel_id !== purchase.channel_id ||
      args.cumulative_amount !== review.price_yocto || args.nonce !== '1') throw new Error('settlement channel, amount or nonce differs');
  const sig = b64(args.signature, 64, 'voucher signature');
  const message = Buffer.from(`tollgate:v1:${review.channel_contract}:${purchase.channel_id}:${review.price_yocto}:1`, 'utf8');
  if (sig.length !== 64 || !nearApi.utils.PublicKey.fromString(review.voucher_public_key).verify(message, sig)) throw new Error('settlement voucher signature differs');
  if (json64(result.status.SuccessValue, 'settlement return') !== review.price_yocto) throw new Error('settlement return amount differs');
  const ids = result.receipts.map(r => r?.receipt_id), outcomeIds = result.receipts_outcome.map(r => r?.id);
  if (ids.some(i => !isTransactionHash(i)) || outcomeIds.some(i => !isTransactionHash(i)) ||
      new Set(ids).size !== ids.length || new Set(outcomeIds).size !== outcomeIds.length) throw new Error('missing or duplicate settlement receipt IDs');
  const calls = result.receipts.filter(r => r?.predecessor_id === review.seller && r?.receiver_id === review.channel_contract &&
    oneAction(r)?.FunctionCall?.method_name === 'settle');
  if (calls.length !== 1) throw new Error('unique settlement action receipt required');
  const callReceipt = calls[0], receiptAction = oneAction(callReceipt).FunctionCall;
  if (!same(receiptAction, action) || !txOutcome.outcome.receipt_ids.includes(callReceipt.receipt_id) ||
      txOutcome.outcome.status.SuccessReceiptId !== callReceipt.receipt_id) throw new Error('settlement action is not linked to the seller transaction');
  const callOut = result.receipts_outcome.find(r => r.id === callReceipt.receipt_id);
  if (callOut?.outcome?.executor_id !== review.channel_contract || !success(callOut.outcome.status) ||
      callOut.outcome.status.SuccessValue !== result.status.SuccessValue || !Array.isArray(callOut.outcome.receipt_ids) ||
      !isTransactionHash(callOut.block_hash)) throw new Error('successful settlement execution is missing');
  const event = eventLog(callOut.outcome.logs), remaining = (BigInt(purchase.channel_deposit_yocto) - BigInt(review.price_yocto)).toString();
  if (!keys(event, ['channel_id', 'seller', 'paid', 'cumulative', 'nonce', 'remaining']) ||
      event.channel_id !== purchase.channel_id || event.seller !== review.seller || event.paid !== review.price_yocto ||
      event.cumulative !== review.price_yocto || event.nonce !== '1' || event.remaining !== remaining) throw new Error('settlement event differs from the reviewed channel');
  const payouts = result.receipts.filter(r => r?.predecessor_id === review.channel_contract && r?.receiver_id === review.seller &&
    oneAction(r)?.Transfer && String(oneAction(r).Transfer.deposit) === review.price_yocto);
  if (payouts.length !== 1 || !callOut.outcome.receipt_ids.includes(payouts[0].receipt_id)) throw new Error('matching detached native transfer is missing or unlinked');
  const payoutOut = result.receipts_outcome.find(r => r.id === payouts[0].receipt_id);
  if (payoutOut?.outcome?.executor_id !== review.seller || !success(payoutOut.outcome.status) ||
      b64(payoutOut.outcome.status.SuccessValue, 100, 'transfer result').length !== 0 || !isTransactionHash(payoutOut.block_hash)) {
    throw new Error('detached native transfer did not succeed');
  }
  return { tx_hash: txHash, review_hash: reviewHash, channel_id: purchase.channel_id, seller: review.seller,
    channel_contract: review.channel_contract, amount_yocto: review.price_yocto, nonce: '1',
    settlement_receipt_id: callReceipt.receipt_id, settlement_block_hash: callOut.block_hash,
    payout_receipt_id: payouts[0].receipt_id, payout_block_hash: payoutOut.block_hash,
    scope: 'caller-supplied FINAL receipt graph only; no chain or contract-code check, no delivery proof' };
}

/** Query the claimed seller transaction and check pinned code at its execution
 * block. The transaction hash may come from an untrusted seller or indexer; it
 * is never accepted without the independent receipt graph. */
export async function inspectTollgateSettlement({ review: raw, purchase, txHash, provider } = {}) {
  const { review } = context(raw, purchase, txHash);
  if (!provider || ['viewNodeStatus', 'txStatusReceipts', 'query'].some(k => typeof provider[k] !== 'function')) throw new Error('read-only FINAL RPC provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const result = await provider.txStatusReceipts(txHash, review.seller, 'FINAL');
  const proof = verifyTollgateSettlementReceipts({ review, purchase, txHash, result });
  const code = await provider.query({ request_type: 'view_account', account_id: review.channel_contract, block_id: proof.settlement_block_hash });
  if (code?.block_hash !== proof.settlement_block_hash || code.code_hash !== TOLLGATE_CHANNEL_CODE_HASH) throw new Error('provider code at settlement block differs from the reviewed code');
  return { ...proof, status: 'SELLER_SETTLEMENT_AND_NATIVE_PAYOUT_VERIFIED', settlement_verified: true,
    paid_response_delivery_verified: false, code_hash: code.code_hash, seller_contacted: false, transaction_sent: false,
    scope: 'trusted testnet FINAL RPC receipts and pinned code at the settlement block; not a light-client proof, audit, or paid delivery proof' };
}
