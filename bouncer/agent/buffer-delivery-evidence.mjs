/**
 * Read-only correlation of a Buffer one-shot order, V12 funding, seller
 * acceptance and a seller-committed report hash. This code never creates an
 * order, signs, broadcasts, authorizes a retry or proves deployed-source
 * equivalence, HTTP provenance, independent delivery, report quality or audit.
 * Caller-retained terms, the private order response and a trusted archival RPC
 * are assumptions. Testnet only. Never print the brief, bearer or report.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { buildBufferForwarder } from '../experiments/buffer-forwarder/build.mjs';
import { experimentalReceiptGraph as g, CIRCLE_TESTNET_REVIEWED_CODE_HASH } from './paypercall-forwarder-evidence.mjs';
import { verifyReviewedExactFtReceipts, multiAgencyExactExecutionBlock } from './multiagency-exact-ft.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const BUFFER_V12_CODE_HASH = 'Dg53QzTrw3cDWdgYTptmpkqvoeUpSXQsxL5HLcoF6Cq';
const SELLER_ORIGIN = 'https://buffer-zeta.vercel.app';
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fields = (x, names) => obj(x) && Object.keys(x).sort().join(',') === [...names].sort().join(',');
const equal = isDeepStrictEqual;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = (x, max) => typeof x === 'string' && x.isWellFormed() && Buffer.byteLength(x) <= max;
const unique = items => [...new Set(items)];

/** Read the private Buffer order once, over its fixed HTTPS origin. The seller
 * API requires the bearer in the query string, so the seller's infrastructure
 * may log it. It must never be logged, included in an exception, or committed
 * by Bouncer. A successful GET is not chain proof or authorization to retry. */
export async function fetchBufferPrivateOrder({ orderId, accessToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof orderId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(orderId) ||
      typeof accessToken !== 'string' || !/^[0-9a-f]{48}$/.test(accessToken) || typeof fetchImpl !== 'function') {
    throw new Error('invalid private Buffer order credentials');
  }
  const url = new URL(`/api/orders/${orderId}`, SELLER_ORIGIN);
  url.searchParams.set('token', accessToken);
  let response;
  try {
    response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok || response.redirected === true) throw new Error('unavailable');
    const bytes = await readBoundedBytes(response, { maxBytes: 1024 * 1024, label: 'private order' });
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!obj(body)) throw new Error('invalid');
    return body; // Caller must keep this private; do not log it.
  } catch {
    throw new Error('private Buffer order could not be read');
  } finally { await response?.body?.cancel().catch(() => {}); }
}

/** Rebuild historical code without treating an expired order as executable. */
export async function prepareBufferDeliveryEvidence(terms, pins) {
  if (!fields(pins, ['vault_code_hash', 'token_code_hash', 'seller_code_hash', 'fulfillment_signer']) ||
      pins.vault_code_hash !== BUFFER_V12_CODE_HASH || !isTransactionHash(pins.token_code_hash) ||
      !isTransactionHash(pins.seller_code_hash) || !isTestnetAccount(pins.fulfillment_signer) ||
      !Number.isSafeInteger(terms?.expires_at_ms) || terms.expires_at_ms <= 1) {
    throw new Error('invalid owner-reviewed Buffer evidence pins');
  }
  const artifact = await buildBufferForwarder(terms, { nowMs: terms.expires_at_ms - 1 });
  const adapterCodeHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(artifact.wasm).digest());
  return { review: artifact.review, adapterCodeHash, pins: structuredClone(pins) };
}

function checkPrivateResponse(review, response) {
  if (!obj(response) || response.authorised !== true || response.id !== review.api_order_id ||
      response.onchainOrderId !== review.onchain_order_id || response.contractId !== review.escrow ||
      response.tokenContract !== review.token || response.sku !== review.sku || response.priceUnits !== review.amount ||
      !['DELIVERED', 'SETTLING', 'SETTLED'].includes(response.state) || !text(response.brief, 16_000) ||
      sha(Buffer.from(response.brief, 'utf8')) !== review.brief_sha256 || !obj(response.report) ||
      !text(response.report.content, 1024 * 1024) || response.report.content.length < 200 ||
      response.report.content !== response.report.content.trim()) {
    throw new Error('private seller order, request or report differs from the review');
  }
  const bytes = Buffer.from(response.report.content, 'utf8'), digest = sha(bytes);
  if (response.report.content_hash !== digest) throw new Error('private report hash differs');
  return { digest, size: bytes.length };
}
function bufferEvent(item, eventName) {
  const found = [];
  for (const line of item?.outcome?.logs ?? []) {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 16_384) throw new Error('invalid seller receipt log');
    if (!line.startsWith('EVENT_JSON:')) continue;
    let event; try { event = JSON.parse(line.slice(11)); } catch { throw new Error('invalid seller event'); }
    if (event?.standard === 'buffer' && event.event === eventName) found.push(event);
  }
  if (found.length !== 1 || found[0].version !== '1.1.0' || !Array.isArray(found[0].data) ||
      found[0].data.length !== 1 || !obj(found[0].data[0])) throw new Error(`unique Buffer ${eventName} event required`);
  return found[0].data[0];
}
function fundingGraph(prepared, funding, snapshots) {
  const r = prepared.review, graph = g.graph(funding.result, funding.txHash), executionBlock = multiAgencyExactExecutionBlock(funding.result, r.vault);
  const txBlock = funding.result.transaction_outcome?.block_hash;
  const intent = { intent_id: r.intent_id, policy_id: r.policy_id, expected_token: r.token, payee: r.adapter,
    amount: r.amount, memo: r.intent_memo, review_hash: r.review_sha256, expires_at_ms: String(r.expires_at_ms),
    agent_public_key: r.vault_agent_public_key };
  const root = g.root(graph, { signer: r.owner, receiver: r.vault, publicKey: r.vault_agent_public_key,
    method: 'execute_exact_ft', args: { intent_id: r.intent_id } });
  if (root.item.block_hash !== executionBlock ||
      !root.item.outcome.logs?.includes('BOUNCER exact FT intent consumed; transfer initiated')) {
    throw new Error('funding initiation is not the original transaction root');
  }
  const proof = verifyReviewedExactFtReceipts({ owner: r.owner, vault: r.vault, vaultCodeHash: prepared.pins.vault_code_hash,
    publicKey: r.vault_agent_public_key, terms: intent, txHash: funding.txHash, result: funding.result,
    vaultState: { ...snapshots.vault_transaction, execution: snapshots.vault_execution }, intentState: snapshots.intent });
  const transfer = g.oneReceipt(graph, r.vault, r.token, 'ft_transfer');
  const callback = g.oneReceipt(graph, r.vault, r.vault, 'after_exact_ft_transfer');
  if (!g.success(transfer.item.outcome.status) || !g.success(callback.item.outcome.status)) throw new Error('funding failed');
  g.codeAt(snapshots.token_states, transfer.item.block_hash, prepared.pins.token_code_hash);
  return { proof, txBlock, executionBlock, transferBlock: transfer.item.block_hash, callbackBlock: callback.item.block_hash };
}
function openingGraph(prepared, opening) {
  const r = prepared.review, graph = g.graph(opening.result, opening.txHash);
  const initial = g.root(graph, { signer: r.owner, receiver: r.adapter, publicKey: r.forwarder_agent_public_key, method: 'open', args: {} });
  const transfer = g.oneReceipt(graph, r.adapter, r.token, 'ft_transfer_call'); g.linked(initial.item, transfer);
  const msg = JSON.stringify({ order_id: r.onchain_order_id, sku: r.sku });
  if (initial.item.outcome.status?.SuccessReceiptId !== transfer.receipt.receipt_id || String(transfer.action.deposit) !== '1' ||
      !equal(g.json(transfer.action.args, 'Buffer token call'), { receiver_id: r.escrow, amount: r.amount,
        memo: 'bouncer:experimental-forwarder', msg })) throw new Error('Buffer opening differs from the fixed review');
  g.transferEvent(transfer.item, r.adapter, r.escrow, r.amount, 'bouncer:experimental-forwarder');
  const receive = g.oneReceipt(graph, r.token, r.escrow, 'ft_on_transfer'); g.linked(transfer.item, receive);
  if (String(receive.action.deposit) !== '0' || !equal(g.json(receive.action.args, 'Buffer receiver call'),
      { sender_id: r.adapter, amount: r.amount, msg }) || !g.success(receive.item.outcome.status) ||
      g.json(receive.item.outcome.status.SuccessValue, 'unused Buffer amount') !== '0') {
    throw new Error('seller did not accept the reviewed order and full amount');
  }
  const event = bufferEvent(receive.item, 'payment_received');
  if (!fields(event, ['order_id', 'sku', 'customer', 'amount']) || event.order_id !== r.onchain_order_id ||
      event.sku !== r.sku || event.customer !== r.adapter || event.amount !== r.amount) throw new Error('Buffer payment event differs');
  const resolver = g.oneReceipt(graph, r.token, r.token, 'ft_resolve_transfer');
  g.linked(transfer.item, resolver); g.linkedPromiseResult(receive, resolver, r.token);
  if (transfer.item.outcome.status?.SuccessReceiptId !== resolver.receipt.receipt_id || !g.success(resolver.item.outcome.status) ||
      resolver.item.outcome.status.SuccessValue !== opening.result.status.SuccessValue ||
      g.json(opening.result.status.SuccessValue, 'used Buffer amount') !== r.amount || String(resolver.action.deposit) !== '0' ||
      !equal(g.json(resolver.action.args, 'Buffer token resolver'), { sender_id: r.adapter, receiver_id: r.escrow, amount: r.amount })) {
    throw new Error('token resolver did not settle the exact Buffer amount');
  }
  return { txBlock: opening.result.transaction_outcome.block_hash, adapterBlock: initial.item.block_hash,
    tokenBlock: transfer.item.block_hash, sellerBlock: receive.item.block_hash };
}
function fulfillmentGraph(prepared, fulfillment, digest) {
  const r = prepared.review, graph = g.graph(fulfillment.result, fulfillment.txHash);
  const initial = g.root(graph, { signer: prepared.pins.fulfillment_signer, receiver: r.escrow,
    method: 'mark_fulfilled', args: { order_id: r.onchain_order_id, report_hash: digest } });
  if (!g.success(initial.item.outcome.status) || initial.item.outcome.status.SuccessValue !== fulfillment.result.status.SuccessValue) {
    throw new Error('Buffer report commitment did not succeed');
  }
  const event = bufferEvent(initial.item, 'order_fulfilled');
  if (!fields(event, ['order_id', 'report_hash']) || event.order_id !== r.onchain_order_id || event.report_hash !== digest) {
    throw new Error('Buffer fulfillment event differs');
  }
  return { txBlock: fulfillment.result.transaction_outcome.block_hash, sellerBlock: initial.item.block_hash };
}

/** Verify three original receipt graphs and pinned state. A positive result is
 * correlation under RPC, seller-code and caller-response assumptions; not an
 * assertion that the response actually came over HTTPS or was independently
 * fulfilled. No report or brief is returned. */
export async function verifyBufferDeliveryEvidence({ terms, pins, funding, opening, fulfillment, privateOrder, snapshots } = {}) {
  const prepared = await prepareBufferDeliveryEvidence(terms, pins), r = prepared.review;
  if (![funding, opening, fulfillment, snapshots].every(obj) ||
      ![funding.txHash, opening.txHash, fulfillment.txHash].every(isTransactionHash) ||
      new Set([funding.txHash, opening.txHash, fulfillment.txHash]).size !== 3) throw new Error('three distinct original transactions are required');
  const report = checkPrivateResponse(r, privateOrder);
  const paid = fundingGraph(prepared, funding, snapshots), opened = openingGraph(prepared, opening);
  const fulfilled = fulfillmentGraph(prepared, fulfillment, report.digest);
  g.keylessAt(snapshots.adapter_funding, paid.transferBlock, prepared.adapterCodeHash);
  g.keylessAt(snapshots.adapter_transaction, opened.txBlock, prepared.adapterCodeHash);
  g.keylessAt(snapshots.adapter_execution, opened.adapterBlock, prepared.adapterCodeHash);
  g.codeAt(snapshots.token_states, opened.tokenBlock, pins.token_code_hash);
  g.codeAt(snapshots.seller_states, opened.sellerBlock, pins.seller_code_hash);
  g.codeAt(snapshots.seller_states, fulfilled.sellerBlock, pins.seller_code_hash);
  const initial = g.pinnedView(snapshots.order_paid, opened.sellerBlock);
  const done = g.pinnedView(snapshots.order_fulfilled, fulfilled.sellerBlock);
  const config = g.pinnedView(snapshots.seller_config, fulfilled.sellerBlock);
  if (config.agent !== pins.fulfillment_signer || config.token_id !== r.token || initial.state !== 'Paid' ||
      initial.customer !== r.adapter || initial.sku !== r.sku || initial.gross !== r.amount || initial.report_hash !== null ||
      !['Fulfilled', 'Settling', 'Settled'].includes(done.state) || done.customer !== r.adapter || done.sku !== r.sku ||
      done.gross !== r.amount || done.report_hash !== report.digest) throw new Error('pinned seller order or agent state differs');
  const a = g.blockAt(snapshots.blocks, paid.txBlock), b = g.blockAt(snapshots.blocks, paid.executionBlock);
  const c = g.blockAt(snapshots.blocks, paid.transferBlock), d = g.blockAt(snapshots.blocks, paid.callbackBlock);
  const e = g.blockAt(snapshots.blocks, opened.txBlock), f = g.blockAt(snapshots.blocks, opened.adapterBlock);
  const h = g.blockAt(snapshots.blocks, opened.tokenBlock), i = g.blockAt(snapshots.blocks, opened.sellerBlock);
  const j = g.blockAt(snapshots.blocks, fulfilled.txBlock), k = g.blockAt(snapshots.blocks, fulfilled.sellerBlock);
  if (a.height > b.height || b.height > c.height || c.height > d.height || d.height >= e.height ||
      e.height > f.height || f.height > h.height || h.height > i.height || i.height >= j.height || j.height > k.height) {
    throw new Error('funding, opening and fulfillment block order is not established');
  }
  g.balanceAt(snapshots.balances, c.prev_hash, r.adapter, r.token, '0');
  g.balanceAt(snapshots.balances, c.hash, r.adapter, r.token, r.amount);
  g.balanceAt(snapshots.balances, h.prev_hash, r.adapter, r.token, r.amount);
  g.codeAt(snapshots.token_states, c.prev_hash, pins.token_code_hash);
  g.codeAt(snapshots.token_states, h.prev_hash, pins.token_code_hash);
  return { status: 'BUFFER_RECEIPTS_AND_REPORT_HASH_CORRELATED', network_assumption: 'testnet',
    review_sha256: r.review_sha256, vault: r.vault, forwarder: r.adapter, seller: r.escrow, token: r.token,
    order_id: r.onchain_order_id, sku: r.sku, amount_atoms: r.amount, report_sha256: report.digest, report_bytes: report.size,
    funding_tx_hash: funding.txHash, opening_tx_hash: opening.txHash, fulfillment_tx_hash: fulfillment.txHash,
    guarded_forwarder_funding_verified: true, seller_payment_receipt_verified: true, report_hash_matches_onchain_commitment: true,
    seller_payout_verified: false, seller_http_delivery_verified: false, independent_fulfillment_verified: false, report_correctness_verified: false,
    deployed_source_equivalence_verified: false, late_refund_verified: false, retry_authorized: false, signed: false, sent: false,
    scope: 'trusted caller response, RPC and historical code pins; fungible balances and block-level views do not prove HTTP origin, correctness, deployed source or independent delivery' };
}

/** Collect exactly the needed historical snapshots from an injected read-only
 * provider. The seller and token hashes are owner-reviewed assumptions. */
export async function collectBufferDeliverySnapshots({ terms, pins, funding, opening, fulfillment, privateOrder, provider } = {}) {
  const prepared = await prepareBufferDeliveryEvidence(terms, pins), r = prepared.review;
  if (!provider || ['query', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      ![funding, opening, fulfillment].every(obj)) throw new Error('original receipts and read-only provider are required');
  const report = checkPrivateResponse(r, privateOrder);
  const fundingGraphRaw = g.graph(funding.result, funding.txHash);
  const fundRoot = g.root(fundingGraphRaw, { signer: r.owner, receiver: r.vault, publicKey: r.vault_agent_public_key,
    method: 'execute_exact_ft', args: { intent_id: r.intent_id } });
  const executionBlock = multiAgencyExactExecutionBlock(funding.result, r.vault);
  if (fundRoot.item.block_hash !== executionBlock) throw new Error('funding execution block differs');
  const transfer = g.oneReceipt(fundingGraphRaw, r.vault, r.token, 'ft_transfer');
  const callback = g.oneReceipt(fundingGraphRaw, r.vault, r.vault, 'after_exact_ft_transfer');
  const opened = openingGraph(prepared, opening), fulfilled = fulfillmentGraph(prepared, fulfillment, report.digest);
  const txBlock = funding.result.transaction_outcome?.block_hash;
  const hashes = unique([txBlock, executionBlock, transfer.item.block_hash, callback.item.block_hash,
    opened.txBlock, opened.adapterBlock, opened.tokenBlock, opened.sellerBlock, fulfilled.txBlock, fulfilled.sellerBlock]);
  if (hashes.some(hash => !isTransactionHash(hash))) throw new Error('historical receipt block unavailable');
  const blocks = await Promise.all(hashes.map(async hash => {
    const b = await provider.viewBlock({ blockId: hash });
    if (b?.header?.hash !== hash || !isTransactionHash(b.header.prev_hash) || !Number.isSafeInteger(b.header.height) || b.header.height < 1) {
      throw new Error('historical block query differs');
    }
    return { header: { hash, prev_hash: b.header.prev_hash, height: b.header.height } };
  }));
  const fundBlock = g.blockAt(blocks, transfer.item.block_hash), openTokenBlock = g.blockAt(blocks, opened.tokenBlock);
  const tokenBlocks = unique([transfer.item.block_hash, opened.tokenBlock, fundBlock.prev_hash, openTokenBlock.prev_hash]);
  const sellerBlocks = unique([opened.sellerBlock, fulfilled.sellerBlock]);
  const balanceBlocks = unique([fundBlock.prev_hash, fundBlock.hash, openTokenBlock.prev_hash]);
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
    ['vault_execution', () => accountAt(r.vault, executionBlock, true)],
    ['adapter_funding', () => accountAt(r.adapter, transfer.item.block_hash, true)],
    ['adapter_transaction', () => accountAt(r.adapter, opened.txBlock, true)],
    ['adapter_execution', () => accountAt(r.adapter, opened.adapterBlock, true)],
    ['intent', async () => ({ block_hash: executionBlock,
      view: await readPinnedJsonView(provider, executionBlock, r.vault, 'get_exact_ft_intent', { intent_id: r.intent_id }) })],
    ['order_paid', async () => ({ block_hash: opened.sellerBlock,
      view: await readPinnedJsonView(provider, opened.sellerBlock, r.escrow, 'get_order', { order_id: r.onchain_order_id }) })],
    ['order_fulfilled', async () => ({ block_hash: fulfilled.sellerBlock,
      view: await readPinnedJsonView(provider, fulfilled.sellerBlock, r.escrow, 'get_order', { order_id: r.onchain_order_id }) })],
    ['seller_config', async () => ({ block_hash: fulfilled.sellerBlock,
      view: await readPinnedJsonView(provider, fulfilled.sellerBlock, r.escrow, 'get_config', {}) })],
    ...tokenBlocks.map(block => [`token:${block}`, () => accountAt(r.token, block)]),
    ...sellerBlocks.map(block => [`seller:${block}`, () => accountAt(r.escrow, block)]),
    ...balanceBlocks.map(block => [`balance:${block}`, async () => ({ block_hash: block, account_id: r.adapter, token: r.token,
      amount: await readPinnedJsonView(provider, block, r.token, 'ft_balance_of', { account_id: r.adapter }) })]),
  ];
  const entries = await Promise.all(tasks.map(async ([name, get]) => [name, await get()])), map = new Map(entries);
  const result = Object.fromEntries(entries.filter(([name]) => !name.includes(':')));
  return { ...result, blocks, token_states: tokenBlocks.map(block => map.get(`token:${block}`)),
    seller_states: sellerBlocks.map(block => map.get(`seller:${block}`)), balances: balanceBlocks.map(block => map.get(`balance:${block}`)) };
}

/** Read-only testnet inspector: only original hashes are looked up. No order
 * creation, notification, signing, payment or automatic retry occurs. */
export async function inspectBufferDeliveryEvidence({ terms, pins, fundingHash, openingHash, fulfillmentHash, privateOrder, provider } = {}) {
  const prepared = await prepareBufferDeliveryEvidence(terms, pins), r = prepared.review;
  if (pins.token_code_hash !== CIRCLE_TESTNET_REVIEWED_CODE_HASH ||
      ![fundingHash, openingHash, fulfillmentHash].every(isTransactionHash) ||
      new Set([fundingHash, openingHash, fulfillmentHash]).size !== 3 || !provider ||
      ['viewNodeStatus', 'txStatusReceipts', 'query', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function')) {
    throw new Error('reviewed Circle testnet code, original hashes and a read-only provider are required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const results = await Promise.all([provider.txStatusReceipts(fundingHash, r.owner, 'FINAL'),
    provider.txStatusReceipts(openingHash, r.owner, 'FINAL'),
    provider.txStatusReceipts(fulfillmentHash, pins.fulfillment_signer, 'FINAL')]);
  const funding = { txHash: fundingHash, result: results[0] }, opening = { txHash: openingHash, result: results[1] },
    fulfillment = { txHash: fulfillmentHash, result: results[2] };
  const snapshots = await collectBufferDeliverySnapshots({ terms, pins, funding, opening, fulfillment, privateOrder, provider });
  const result = await verifyBufferDeliveryEvidence({ terms, pins, funding, opening, fulfillment, privateOrder, snapshots });
  return { ...result, network: 'testnet', rpc_trust: 'caller-selected RPC and historical blocks; not a consensus proof',
    historical_views_collected: true, seller_contacted_by_inspector: false };
}
