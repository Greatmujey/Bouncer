/**
 * Experimental, read-only correlation of a Bouncer exact-FT transfer, the
 * order-specific PayPerCall forwarder, an escrow opening and a seller payout.
 * All inputs are already-observed public terms, caller-retained answer bytes,
 * receipt graphs and historical views. This module never signs, sends, calls a
 * seller, or authorizes a retry. The caller is responsible for obtaining each
 * snapshot from a trusted archival RPC and retaining the original review.
 *
 * The pinned PayPerCall source is an assumption, not proof that its deployed
 * binary was built from that source. A matched answer hash is not proof of
 * HTTP origin, answer quality, independent provider delivery, or an audit.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { buildPayPerCallMessage, classifyPayPerCallView } from './paypercall-inspect.mjs';
import { verifyReviewedExactFtReceipts, multiAgencyExactExecutionBlock } from './multiagency-exact-ft.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';

// These are specific experimental artifacts, not a proof that either is safe.
export const PAYPERCALL_VAULT_CODE_HASHES = Object.freeze([
  '2ofBTEQTwUtrYAye4NPH2r9ccQkgfGgRZ3yRS9aP97aG', // recovered V11
  'Dg53QzTrw3cDWdgYTptmpkqvoeUpSXQsxL5HLcoF6Cq', // reproduced V12
]);
export const CIRCLE_TESTNET_REVIEWED_CODE_HASH = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z';

const MAX_U128 = (1n << 128n) - 1n, MAX_U64 = (1n << 64n) - 1n;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fields = (x, names) => obj(x) && Object.keys(x).sort().join(',') === [...names].sort().join(',');
const equal = isDeepStrictEqual;
const uint = (x, max = MAX_U128) => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= max;
const positive = x => uint(x) && x !== '0';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const success = x => fields(x, ['SuccessValue']) && typeof x.SuccessValue === 'string';
const forward = x => fields(x, ['SuccessReceiptId']) && isTransactionHash(x.SuccessReceiptId);

function decode(value, max, label) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  return bytes;
}
function json(value, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value, 16_000, label))); }
  catch { throw new Error(`invalid ${label}`); }
}
function receiptAction(receipt, predecessor, receiver, method) {
  const actions = receipt?.receipt?.Action?.actions;
  return receipt?.predecessor_id === predecessor && receipt?.receiver_id === receiver &&
    Array.isArray(actions) && actions.length === 1 && actions[0]?.FunctionCall?.method_name === method ? actions[0].FunctionCall : null;
}
function graph(result, txHash) {
  if (!isTransactionHash(txHash) || result?.final_execution_status !== 'FINAL' || !success(result.status) ||
      result.transaction?.hash !== txHash || result.transaction_outcome?.id !== txHash ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
      result.receipts.length < 1 || result.receipts.length > 100 || result.receipts_outcome.length < 1 || result.receipts_outcome.length > 100) {
    throw new Error('receipt-inclusive FINAL original transaction required');
  }
  const receipts = new Map(), outcomes = new Map();
  for (const r of result.receipts) {
    if (!isTransactionHash(r?.receipt_id) || receipts.has(r.receipt_id)) throw new Error('invalid or duplicate receipt ID');
    receipts.set(r.receipt_id, r);
  }
  for (const item of result.receipts_outcome) {
    const out = item?.outcome;
    if (!isTransactionHash(item?.id) || !isTransactionHash(item?.block_hash) || outcomes.has(item.id) ||
        !obj(out) || !(success(out.status) || forward(out.status)) || !Array.isArray(out.receipt_ids) ||
        out.receipt_ids.length > 100 || out.receipt_ids.some(id => !isTransactionHash(id)) ||
        new Set(out.receipt_ids).size !== out.receipt_ids.length || !Array.isArray(out.logs) || out.logs.length > 200) {
      throw new Error('failed, incomplete or ambiguous receipt outcome');
    }
    outcomes.set(item.id, item);
  }
  return { result, receipts, outcomes };
}
function oneReceipt(g, pred, receiver, method) {
  const found = [...g.receipts.values()].flatMap(receipt => {
    const action = receiptAction(receipt, pred, receiver, method);
    return action ? [{ receipt, action }] : [];
  });
  if (found.length !== 1) throw new Error(`unique ${method} receipt required`);
  const item = g.outcomes.get(found[0].receipt.receipt_id);
  if (!item || item.outcome.executor_id !== receiver) throw new Error(`${method} outcome is missing or mismatched`);
  return { ...found[0], item };
}
function root(g, { signer, receiver, publicKey, method, args }) {
  const { result } = g, tx = result.transaction, out = result.transaction_outcome?.outcome;
  if (tx?.signer_id !== signer || tx.receiver_id !== receiver || (publicKey && tx.public_key !== publicKey) ||
      !Array.isArray(tx.actions) || tx.actions.length !== 1 || !obj(tx.actions[0]?.FunctionCall) ||
      tx.actions[0].FunctionCall.method_name !== method || String(tx.actions[0].FunctionCall.deposit) !== '0' ||
      !equal(json(tx.actions[0].FunctionCall.args, `${method} transaction arguments`), args) ||
      out?.executor_id !== signer || !forward(out.status) || !Array.isArray(out.receipt_ids) ||
      !out.receipt_ids.includes(out.status.SuccessReceiptId)) throw new Error(`${method} transaction identity or root differs`);
  const id = out.status.SuccessReceiptId, receipt = g.receipts.get(id), item = g.outcomes.get(id);
  const call = receiptAction(receipt, signer, receiver, method);
  if (!call || !equal(call, tx.actions[0].FunctionCall) || item?.outcome?.executor_id !== receiver) {
    throw new Error(`${method} root receipt is absent or differs`);
  }
  return { id, receipt, item };
}
function linked(parent, child) {
  if (!parent?.outcome?.receipt_ids?.includes(child?.receipt?.receipt_id)) throw new Error('receipt is not linked to its parent');
}
function oneEvent(item, standard, name) {
  const found = [];
  for (const line of item?.outcome?.logs ?? []) {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 16_384) throw new Error('invalid receipt log');
    if (!line.startsWith('EVENT_JSON:')) continue;
    let e; try { e = JSON.parse(line.slice(11)); } catch { throw new Error('invalid event JSON'); }
    if (e?.standard === standard && e.event === name) found.push(e);
  }
  if (found.length !== 1 || found[0].version !== '1.0.0' || !Array.isArray(found[0].data) || found[0].data.length !== 1 ||
      !obj(found[0].data[0])) throw new Error(`unique ${standard} ${name} event required`);
  return found[0].data[0];
}
function transferEvent(item, oldOwner, newOwner, amount, memo) {
  const event = oneEvent(item, 'nep141', 'ft_transfer');
  if (event.old_owner_id !== oldOwner || event.new_owner_id !== newOwner || event.amount !== amount ||
      (memo !== undefined && event.memo !== memo)) throw new Error('token transfer event differs');
}
function codeAt(states, block, expected) {
  if (!Array.isArray(states)) throw new Error('historical code snapshots required');
  const found = states.filter(x => x?.block_hash === block);
  if (found.length !== 1 || found[0].code_hash !== expected) throw new Error('historical contract code differs');
}
function keylessAt(state, block, codeHash) {
  if (!obj(state) || state.block_hash !== block || state.code_hash !== codeHash || !Array.isArray(state.keys) || state.keys.length !== 0) {
    throw new Error('historical keyless contract snapshot differs');
  }
}
function pinnedView(state, block) {
  if (!obj(state) || state.block_hash !== block || !obj(state.view)) throw new Error('historical view is unavailable or unpinned');
  return state.view;
}
function blockAt(blocks, hash) {
  if (!Array.isArray(blocks)) throw new Error('historical blocks required');
  const found = blocks.filter(x => x?.header?.hash === hash);
  const header = found[0]?.header;
  if (found.length !== 1 || !Number.isSafeInteger(header?.height) || header.height < 1 || !isTransactionHash(header.prev_hash)) {
    throw new Error('historical block or parent is unavailable');
  }
  return header;
}
function balanceAt(balances, block, adapter, token, expected) {
  if (!Array.isArray(balances)) throw new Error('historical forwarder balances required');
  const found = balances.filter(x => x?.block_hash === block && x?.account_id === adapter && x?.token === token);
  if (found.length !== 1 || found[0].amount !== expected) throw new Error('historical forwarder token balance differs');
}
function checkService(view, offer, token) {
  if (view.provider !== offer.provider || view.operator !== offer.operator || view.token !== token ||
      view.price !== offer.price || view.active !== true) throw new Error('historical service terms differ from the supplied offer');
}

/** Rebuild an order-specific immutable forwarder entirely offline. This is a
 * historical verification helper, not a fresh preflight or approval. It
 * accepts a caller-pinned escrow/token hash because deployed-source identity
 * and the trustworthiness of these contracts are separate questions. */
export async function preparePayPerCallEvidence(terms, offer) {
  if (!fields(offer, ['provider', 'operator', 'price', 'vault_code_hash', 'token_code_hash', 'escrow_code_hash']) ||
      !isTestnetAccount(offer.provider) || !isTestnetAccount(offer.operator) || !positive(offer.price) ||
      !PAYPERCALL_VAULT_CODE_HASHES.includes(offer.vault_code_hash) || !isTransactionHash(offer.token_code_hash) ||
      !isTransactionHash(offer.escrow_code_hash) || !Number.isSafeInteger(terms?.expires_at_ms) || terms.expires_at_ms <= 1) {
    throw new Error('invalid reviewed forwarder and public service terms');
  }
  // Expiration is checked by the original contract execution; using the last
  // possible millisecond here permits historical reconstruction, not payment.
  const artifact = await buildExperimentalForwarder(terms, { nowMs: terms.expires_at_ms - 1 });
  if (BigInt(offer.price) > BigInt(artifact.review.amount)) throw new Error('service price exceeds the reviewed cap');
  const adapterCodeHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(artifact.wasm).digest());
  return { review: artifact.review, adapterCodeHash, offer: structuredClone(offer) };
}

function fundingGraph(prepared, txHash, result, snapshots) {
  const r = prepared.review, g = graph(result, txHash);
  const args = { intent_id: r.intent_id, policy_id: r.policy_id, expected_token: r.token, payee: r.adapter,
    amount: r.amount, memo: r.intent_memo, review_hash: r.review_sha256, expires_at_ms: String(r.expires_at_ms),
    agent_public_key: r.vault_agent_public_key };
  const executionBlock = multiAgencyExactExecutionBlock(result, r.vault);
  const txBlock = result.transaction_outcome?.block_hash;
  const proof = verifyReviewedExactFtReceipts({ owner: r.owner, vault: r.vault, vaultCodeHash: prepared.offer.vault_code_hash,
    publicKey: r.vault_agent_public_key, terms: args, txHash, result,
    vaultState: { ...snapshots.vault_transaction, execution: snapshots.vault_execution }, intentState: snapshots.intent });
  const initial = root(g, { signer: r.owner, receiver: r.vault, publicKey: r.vault_agent_public_key,
    method: 'execute_exact_ft', args: { intent_id: r.intent_id } });
  if (initial.item.block_hash !== executionBlock || !isTransactionHash(txBlock)) throw new Error('funding execution block differs');
  const transfer = oneReceipt(g, r.vault, r.token, 'ft_transfer');
  const callback = oneReceipt(g, r.vault, r.vault, 'after_exact_ft_transfer');
  linked(initial.item, transfer); linked(initial.item, callback);
  if (!success(transfer.item.outcome.status) || !success(callback.item.outcome.status)) throw new Error('funding transfer or callback failed');
  codeAt(snapshots.token_states, transfer.item.block_hash, prepared.offer.token_code_hash);
  return { proof, txBlock, executionBlock, transferBlock: transfer.item.block_hash, callbackBlock: callback.item.block_hash };
}

function openingGraph(prepared, txHash, result) {
  const r = prepared.review, g = graph(result, txHash);
  const initial = root(g, { signer: r.owner, receiver: r.adapter, publicKey: r.forwarder_agent_public_key, method: 'open', args: {} });
  const transfer = oneReceipt(g, r.adapter, r.token, 'ft_transfer_call');
  linked(initial.item, transfer);
  if (initial.item.outcome.status?.SuccessReceiptId !== transfer.receipt.receipt_id || String(transfer.action.deposit) !== '1') {
    throw new Error('opening does not return its fixed token call');
  }
  const msg = buildPayPerCallMessage({ service_id: r.service_id, request: r.request, max_price: r.amount }).msg;
  if (!equal(json(transfer.action.args, 'forwarder token call'), { receiver_id: r.escrow, amount: r.amount,
    memo: 'bouncer:experimental-forwarder', msg })) throw new Error('forwarder token call differs from its fixed review');
  transferEvent(transfer.item, r.adapter, r.escrow, r.amount, 'bouncer:experimental-forwarder');
  const receive = oneReceipt(g, r.token, r.escrow, 'ft_on_transfer');
  linked(transfer.item, receive);
  if (String(receive.action.deposit) !== '0' || !equal(json(receive.action.args, 'escrow receiver arguments'),
    { sender_id: r.adapter, amount: r.amount, msg }) || !success(receive.item.outcome.status)) {
    throw new Error('escrow receiver call differs');
  }
  const unused = (BigInt(r.amount) - BigInt(prepared.offer.price)).toString();
  if (json(receive.item.outcome.status.SuccessValue, 'escrow unused amount') !== unused) throw new Error('escrow used amount differs');
  const event = oneEvent(receive.item, 'paypercall', 'call_requested');
  if (!fields(event, ['call_id', 'service_id', 'payer', 'referrer', 'token', 'amount', 'request_hash', 'deadline_ms', 'request']) ||
      !Number.isSafeInteger(event.call_id) || event.call_id < 0 || event.call_id > 0xffffffff || event.service_id !== r.service_id ||
      event.payer !== r.adapter || event.referrer !== null || event.token !== r.token || event.amount !== prepared.offer.price ||
      event.request_hash !== r.request_hash || event.request !== r.request || !uint(event.deadline_ms, MAX_U64) || event.deadline_ms === '0') {
    throw new Error('escrow opening event differs from the reviewed request');
  }
  const resolver = oneReceipt(g, r.token, r.token, 'ft_resolve_transfer');
  linked(transfer.item, resolver);
  if (transfer.item.outcome.status?.SuccessReceiptId !== resolver.receipt.receipt_id || !success(resolver.item.outcome.status) ||
      resolver.item.outcome.status.SuccessValue !== result.status.SuccessValue ||
      json(result.status.SuccessValue, 'resolved used amount') !== prepared.offer.price) {
    throw new Error('token resolver did not finalize the exact escrowed amount');
  }
  const resolverArgs = json(resolver.action.args, 'resolver arguments');
  if (String(resolver.action.deposit) !== '0' || !fields(resolverArgs, ['sender_id', 'receiver_id', 'amount']) ||
      resolverArgs.sender_id !== r.adapter || resolverArgs.receiver_id !== r.escrow || resolverArgs.amount !== r.amount) {
    throw new Error('token resolver identity differs');
  }
  return { callId: event.call_id, deadlineMs: event.deadline_ms, txBlock: result.transaction_outcome.block_hash,
    adapterBlock: initial.item.block_hash, tokenBlock: transfer.item.block_hash, escrowBlock: receive.item.block_hash };
}

function fulfillmentGraph(prepared, opening, txHash, result, answerBytes) {
  const r = prepared.review, o = prepared.offer;
  if (!(answerBytes instanceof Uint8Array) || answerBytes.byteLength < 1 || answerBytes.byteLength > 1024 * 1024) {
    throw new Error('bounded exact answer bytes required');
  }
  const digest = sha(answerBytes), g = graph(result, txHash), tx = result.transaction;
  if (tx.signer_id !== o.operator && tx.signer_id !== o.provider) throw new Error('fulfillment signer differs from reviewed service');
  const args = json(tx.actions?.[0]?.FunctionCall?.args, 'fulfillment arguments');
  if (!fields(args, ['call_id', 'result_hash', 'result_uri']) || args.call_id !== opening.callId || args.result_hash !== digest ||
      !(args.result_uri === null || (typeof args.result_uri === 'string' && Buffer.byteLength(args.result_uri, 'utf8') <= 256))) {
    throw new Error('fulfillment does not commit to the exact supplied answer bytes');
  }
  const initial = root(g, { signer: tx.signer_id, receiver: r.escrow, method: 'fulfill', args });
  if (!success(initial.item.outcome.status) || initial.item.outcome.status.SuccessValue !== result.status.SuccessValue) {
    throw new Error('fulfillment execution did not succeed');
  }
  const event = oneEvent(initial.item, 'paypercall', 'call_fulfilled');
  if (!fields(event, ['call_id', 'result_hash', 'result_uri', 'provider_amount', 'referrer_amount']) ||
      event.call_id !== opening.callId || event.result_hash !== digest || event.result_uri !== args.result_uri ||
      event.provider_amount !== o.price || event.referrer_amount !== '0') throw new Error('fulfillment event differs');
  const payout = oneReceipt(g, r.escrow, r.token, 'ft_transfer');
  linked(initial.item, payout);
  if (String(payout.action.deposit) !== '1' || !equal(json(payout.action.args, 'provider payout arguments'),
      { receiver_id: o.provider, amount: o.price }) || !success(payout.item.outcome.status)) {
    throw new Error('detached provider payout is missing or failed');
  }
  transferEvent(payout.item, r.escrow, o.provider, o.price);
  return { digest, uri: args.result_uri, escrowBlock: initial.item.block_hash, tokenBlock: payout.item.block_hash,
    payoutReceiptId: payout.receipt.receipt_id, signer: tx.signer_id };
}

/** Verify all three supplied receipt graphs and block-pinned views. Its output
 * deliberately says "correlated" rather than "independently delivered":
 * FT fungibility, block-level snapshots, mutable service/escrow code, RPC
 * honesty, answer origin, correctness and code-source equivalence remain trust
 * boundaries. Missing data or failed receipts are errors, never retry signals. */
export async function verifyPayPerCallForwarderEvidence({ terms, offer, funding, opening, fulfillment, answerBytes, snapshots } = {}) {
  const prepared = await preparePayPerCallEvidence(terms, offer), r = prepared.review, checkedOffer = prepared.offer;
  if (!obj(funding) || !obj(opening) || !obj(fulfillment) || !obj(snapshots)) throw new Error('three original receipts and snapshots required');
  const paid = fundingGraph(prepared, funding.txHash, funding.result, snapshots);
  const opened = openingGraph(prepared, opening.txHash, opening.result);
  const settled = fulfillmentGraph(prepared, opened, fulfillment.txHash, fulfillment.result, answerBytes);
  keylessAt(snapshots.adapter_funding, paid.transferBlock, prepared.adapterCodeHash);
  keylessAt(snapshots.adapter_transaction, opened.txBlock, prepared.adapterCodeHash);
  keylessAt(snapshots.adapter_execution, opened.adapterBlock, prepared.adapterCodeHash);
  codeAt(snapshots.token_states, opened.tokenBlock, checkedOffer.token_code_hash);
  codeAt(snapshots.token_states, settled.tokenBlock, checkedOffer.token_code_hash);
  codeAt(snapshots.escrow_states, opened.escrowBlock, checkedOffer.escrow_code_hash);
  codeAt(snapshots.escrow_states, settled.escrowBlock, checkedOffer.escrow_code_hash);
  checkService(pinnedView(snapshots.service_open, opened.escrowBlock), checkedOffer, r.token);
  checkService(pinnedView(snapshots.service_fulfillment, settled.escrowBlock), checkedOffer, r.token);
  const call = pinnedView(snapshots.call_fulfillment, settled.escrowBlock);
  const answer = classifyPayPerCallView({ call_id: opened.callId, service_id: r.service_id, payer: r.adapter,
    token: r.token, amount: checkedOffer.price, referrer: null, request: r.request }, call, answerBytes);
  if (answer.status !== 'ANSWER_HASH_MATCH' || call.deadline_ms !== opened.deadlineMs || call.result_uri !== settled.uri) {
    throw new Error('historical escrow call does not match the opening and fulfillment');
  }
  const fundTxBlock = blockAt(snapshots.blocks, paid.txBlock), fundExecution = blockAt(snapshots.blocks, paid.executionBlock);
  const fundingBlock = blockAt(snapshots.blocks, paid.transferBlock), callbackBlock = blockAt(snapshots.blocks, paid.callbackBlock);
  const openTxBlock = blockAt(snapshots.blocks, opened.txBlock), adapterBlock = blockAt(snapshots.blocks, opened.adapterBlock);
  const openTokenBlock = blockAt(snapshots.blocks, opened.tokenBlock), escrowOpenBlock = blockAt(snapshots.blocks, opened.escrowBlock);
  const fulfillBlock = blockAt(snapshots.blocks, settled.escrowBlock), payoutBlock = blockAt(snapshots.blocks, settled.tokenBlock);
  if (fundTxBlock.height > fundExecution.height || fundExecution.height > fundingBlock.height || fundingBlock.height > callbackBlock.height ||
      callbackBlock.height >= openTxBlock.height || openTxBlock.height > adapterBlock.height || adapterBlock.height > openTokenBlock.height ||
      openTokenBlock.height > escrowOpenBlock.height || escrowOpenBlock.height >= fulfillBlock.height || fulfillBlock.height > payoutBlock.height) {
    throw new Error('funding, opening and fulfillment block order is not established');
  }
  // These are block-level balance observations, not attribution of fungible
  // units or proof that no intervening same-block transfers occurred.
  balanceAt(snapshots.balances, fundingBlock.prev_hash, r.adapter, r.token, '0');
  balanceAt(snapshots.balances, fundingBlock.hash, r.adapter, r.token, r.amount);
  balanceAt(snapshots.balances, openTokenBlock.prev_hash, r.adapter, r.token, r.amount);
  codeAt(snapshots.token_states, fundingBlock.prev_hash, checkedOffer.token_code_hash);
  codeAt(snapshots.token_states, openTokenBlock.prev_hash, checkedOffer.token_code_hash);
  return { status: 'RECEIPTS_AND_ANSWER_HASH_CORRELATED', network_assumption: 'testnet', review_sha256: r.review_sha256,
    vault: r.vault, forwarder: r.adapter, escrow: r.escrow, token: r.token, service_id: r.service_id,
    call_id: opened.callId, provider: checkedOffer.provider, fulfillment_signer: settled.signer,
    maximum_atoms: r.amount, escrowed_atoms: checkedOffer.price, answer_sha256: settled.digest, answer_bytes: answerBytes.byteLength,
    funding_tx_hash: funding.txHash, opening_tx_hash: opening.txHash, fulfillment_tx_hash: fulfillment.txHash,
    provider_payout_receipt_id: settled.payoutReceiptId, guarded_forwarder_funding_verified: true,
    escrow_opening_verified: true, provider_token_payout_verified: true, answer_hash_matches_onchain_commitment: true,
    forwarder_refund_credit_verified: false, seller_http_delivery_verified: false, answer_correctness_verified: false,
    deployed_source_equivalence_verified: false, independent_fulfillment_verified: false,
    signed: false, sent: false, retry_authorized: false,
    scope: 'caller-supplied historical views and FINAL receipt graphs trusted; order-specific unaudited forwarder, fungible tokens and block-level snapshots do not establish answer provenance, accuracy or independent delivery' };
}

async function limitedMap(items, operation, limit = 4) {
  const results = Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await operation(items[i]);
    }
  }));
  return results;
}
const unique = values => [...new Set(values)];

/** Collect historic views for already-received receipts. This is a low-level,
 * strictly read-only collector, not chain identity verification; the caller
 * must fence its provider and check the network. It never broadcasts and does
 * not accept receipt absence as non-payment. `inspect...` below applies the
 * public testnet and reviewed Circle-code constraints. */
export async function collectPayPerCallHistoricalSnapshots({ terms, offer, funding, opening, fulfillment, answerBytes, provider } = {}) {
  const prepared = await preparePayPerCallEvidence(terms, offer), r = prepared.review;
  if (!provider || ['query', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      !obj(funding) || !obj(opening) || !obj(fulfillment)) throw new Error('read-only historical provider and original receipts required');
  const fg = graph(funding.result, funding.txHash);
  const fundingRoot = root(fg, { signer: r.owner, receiver: r.vault, publicKey: r.vault_agent_public_key,
    method: 'execute_exact_ft', args: { intent_id: r.intent_id } });
  const fundingExecution = multiAgencyExactExecutionBlock(funding.result, r.vault);
  if (fundingRoot.item.block_hash !== fundingExecution) throw new Error('funding root and execution blocks differ');
  const transfer = oneReceipt(fg, r.vault, r.token, 'ft_transfer');
  const callback = oneReceipt(fg, r.vault, r.vault, 'after_exact_ft_transfer');
  linked(fundingRoot.item, transfer); linked(fundingRoot.item, callback);
  const opened = openingGraph(prepared, opening.txHash, opening.result);
  const settled = fulfillmentGraph(prepared, opened, fulfillment.txHash, fulfillment.result, answerBytes);
  const txBlock = funding.result.transaction_outcome?.block_hash;
  const blockIds = unique([txBlock, fundingExecution, transfer.item.block_hash, callback.item.block_hash, opened.txBlock,
    opened.adapterBlock, opened.tokenBlock, opened.escrowBlock, settled.escrowBlock, settled.tokenBlock]);
  if (blockIds.some(h => !isTransactionHash(h)) || !isTransactionHash(txBlock)) throw new Error('historical receipt block is unavailable');
  const blocks = await limitedMap(blockIds, async hash => {
    const b = await provider.viewBlock({ blockId: hash });
    if (b?.header?.hash !== hash || !isTransactionHash(b.header.prev_hash) ||
        !Number.isSafeInteger(b.header.height) || b.header.height < 1) throw new Error('historical block query differs');
    return { header: { hash, prev_hash: b.header.prev_hash, height: b.header.height } };
  });
  const fundHeader = blockAt(blocks, transfer.item.block_hash), openHeader = blockAt(blocks, opened.tokenBlock);
  const tokenBlocks = unique([transfer.item.block_hash, opened.tokenBlock, settled.tokenBlock, fundHeader.prev_hash, openHeader.prev_hash]);
  const escrowBlocks = unique([opened.escrowBlock, settled.escrowBlock]);
  const balanceBlocks = unique([fundHeader.prev_hash, transfer.item.block_hash, openHeader.prev_hash]);
  async function accountAt(account, blockHash, keys = false) {
    const query = request_type => provider.query({ request_type, account_id: account, block_id: blockHash });
    const [accountView, keyView] = await Promise.all([query('view_account'), keys ? query('view_access_key_list') : Promise.resolve(null)]);
    if (accountView?.block_hash !== blockHash || !isTransactionHash(accountView.code_hash) ||
        (keys && (keyView?.block_hash !== blockHash || !Array.isArray(keyView.keys)))) throw new Error('historical account query differs');
    return keys ? { block_hash: blockHash, code_hash: accountView.code_hash, keys: keyView.keys } :
      { block_hash: blockHash, code_hash: accountView.code_hash };
  }
  const tasks = [
    ['vault_transaction', () => accountAt(r.vault, txBlock, true)],
    ['vault_execution', () => accountAt(r.vault, fundingExecution, true)],
    ['adapter_funding', () => accountAt(r.adapter, transfer.item.block_hash, true)],
    ['adapter_transaction', () => accountAt(r.adapter, opened.txBlock, true)],
    ['adapter_execution', () => accountAt(r.adapter, opened.adapterBlock, true)],
    ['intent', async () => ({ block_hash: fundingExecution,
      view: await readPinnedJsonView(provider, fundingExecution, r.vault, 'get_exact_ft_intent', { intent_id: r.intent_id }) })],
    ['service_open', async () => ({ block_hash: opened.escrowBlock,
      view: await readPinnedJsonView(provider, opened.escrowBlock, r.escrow, 'get_service', { service_id: r.service_id }) })],
    ['service_fulfillment', async () => ({ block_hash: settled.escrowBlock,
      view: await readPinnedJsonView(provider, settled.escrowBlock, r.escrow, 'get_service', { service_id: r.service_id }) })],
    ['call_fulfillment', async () => ({ block_hash: settled.escrowBlock,
      view: await readPinnedJsonView(provider, settled.escrowBlock, r.escrow, 'get_call', { call_id: opened.callId }) })],
    ...tokenBlocks.map(block => [`token:${block}`, () => accountAt(r.token, block)]),
    ...escrowBlocks.map(block => [`escrow:${block}`, () => accountAt(r.escrow, block)]),
    ...balanceBlocks.map(block => [`balance:${block}`, async () => ({ block_hash: block, account_id: r.adapter, token: r.token,
      amount: await readPinnedJsonView(provider, block, r.token, 'ft_balance_of', { account_id: r.adapter }) })]),
  ];
  const entries = await limitedMap(tasks, async ([name, get]) => [name, await get()]);
  const map = new Map(entries), snapshots = Object.fromEntries(entries.filter(([name]) => !name.includes(':')));
  snapshots.blocks = blocks;
  snapshots.token_states = tokenBlocks.map(block => map.get(`token:${block}`));
  snapshots.escrow_states = escrowBlocks.map(block => map.get(`escrow:${block}`));
  snapshots.balances = balanceBlocks.map(block => map.get(`balance:${block}`));
  return snapshots;
}

/** Look up exactly the three original hashes on a testnet-only, read-only RPC.
 * All contract and balance queries are pinned to their execution blocks or
 * parents. Historical views can be pruned/unavailable; that remains UNKNOWN,
 * never a reason to submit a new payment or repeat an order. A trusted RPC and
 * the caller's retained review/escrow pin remain assumptions. */
export async function inspectPayPerCallForwarderEvidence({ terms, offer, fundingHash, openingHash,
  fulfillmentHash, fulfillmentSigner, answerBytes, provider } = {}) {
  const prepared = await preparePayPerCallEvidence(terms, offer), r = prepared.review;
  if (prepared.offer.token_code_hash !== CIRCLE_TESTNET_REVIEWED_CODE_HASH ||
      ![prepared.offer.provider, prepared.offer.operator].includes(fulfillmentSigner) ||
      ![fundingHash, openingHash, fulfillmentHash].every(isTransactionHash) ||
      new Set([fundingHash, openingHash, fulfillmentHash]).size !== 3 ||
      !(answerBytes instanceof Uint8Array) || answerBytes.byteLength < 1 || answerBytes.byteLength > 1024 * 1024 ||
      !provider || ['viewNodeStatus', 'txStatusReceipts', 'query', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function')) {
    throw new Error('reviewed Circle testnet code, original hashes and a read-only provider are required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const receipts = await Promise.all([
    provider.txStatusReceipts(fundingHash, r.owner, 'FINAL'),
    provider.txStatusReceipts(openingHash, r.owner, 'FINAL'),
    provider.txStatusReceipts(fulfillmentHash, fulfillmentSigner, 'FINAL'),
  ]);
  const funding = { txHash: fundingHash, result: receipts[0] }, opening = { txHash: openingHash, result: receipts[1] },
    fulfillment = { txHash: fulfillmentHash, result: receipts[2] };
  if (fulfillment.result?.transaction?.signer_id !== fulfillmentSigner) throw new Error('fulfillment original signer differs');
  const snapshots = await collectPayPerCallHistoricalSnapshots({ terms, offer: prepared.offer, funding, opening, fulfillment, answerBytes, provider });
  const result = await verifyPayPerCallForwarderEvidence({ terms, offer: prepared.offer, funding, opening, fulfillment, answerBytes, snapshots });
  return { ...result, network: 'testnet', rpc_trust: 'testnet and historical blocks reported by the caller-selected RPC; not consensus proofs',
    historical_views_collected: true, operator_contacted: false };
}
