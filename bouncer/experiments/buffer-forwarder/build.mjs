/**
 * Experimental, offline Buffer-specific forwarder builder. This creates no
 * order, key, account, transaction, or network request. It is not audited,
 * deployed, or an authorization to spend. The keyless account and reviewed
 * bytecode have to be verified separately before a future live test.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { compileFixedForwarder } from '../paypercall-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC } from '../../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount } from '../../shared/account-id.mjs';
import { isTransactionHash } from '../../shared/direct-payment-settlement.mjs';

export const BUFFER_TESTNET_CONTRACT = 'buffer-john-desk.testnet';
export const BUFFER_FIXED_SKUS = Object.freeze(['weekly-market-brief', 'crosschain-brief']);
export const BUFFER_QUOTE_SKU = 'custom-brief';
const MAX_U128 = (1n << 128n) - 1n, MIN_NATIVE_RESERVE = 10n ** 24n, MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalUint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) <= MAX_U128;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const ownData = (object, names) => {
  if (!plain(object)) return false;
  const fields = Object.getOwnPropertyDescriptors(object);
  return Object.keys(fields).sort().join(',') === [...names].sort().join(',') &&
    names.every(name => Object.hasOwn(fields[name], 'value'));
};
const directChild = (child, parent) => child.endsWith(`.${parent}`) &&
  child.slice(0, -parent.length - 1).length > 0 && !child.slice(0, -parent.length - 1).includes('.');
function keyBytes(publicKey) {
  try {
    const key = nearApi.utils.PublicKey.from(publicKey);
    if (String(key) !== publicKey || !publicKey.startsWith('ed25519:') || key.ed25519Key?.data?.length !== 32) throw Error();
    return Buffer.concat([Buffer.from([0]), Buffer.from(key.ed25519Key.data)]);
  } catch { throw new Error('canonical public ed25519 agent keys are required'); }
}
const NAMES = ['owner', 'vault', 'adapter', 'forwarder_agent_public_key', 'vault_agent_public_key',
  'policy_id', 'intent_id', 'amount', 'expires_at_ms', 'native_return_cap', 'native_reserve',
  'api_order_id', 'onchain_order_id', 'sku', 'brief_sha256'];

/** Validate explicit owner-reviewed public terms. Local time and the source
 * interface are assumptions, not proof of the live price or deployed code. */
export function validateBufferForwarderTerms(raw, { nowMs = Date.now() } = {}) {
  if (!ownData(raw, NAMES)) throw new Error('invalid Buffer forwarder terms');
  const r = Object.fromEntries(NAMES.map(name => [name, raw[name]]));
  if (!isTestnetAccount(r.owner) || !isTestnetAccount(r.vault) || !isTestnetAccount(r.adapter) ||
      !directChild(r.vault, r.owner) || !directChild(r.adapter, r.owner) || r.vault === r.adapter ||
      typeof r.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.policy_id) ||
      typeof r.intent_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.intent_id) ||
      !canonicalUint(r.amount) || r.amount === '0' || !canonicalUint(r.native_return_cap) || !canonicalUint(r.native_reserve) ||
      BigInt(r.native_reserve) < MIN_NATIVE_RESERVE || !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(r.expires_at_ms) || r.expires_at_ms <= nowMs || r.expires_at_ms > nowMs + MAX_LIFETIME_MS ||
      typeof r.api_order_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.api_order_id) ||
      typeof r.onchain_order_id !== 'string' ||
      !((/^o-[0-9a-f]{12}$/.test(r.onchain_order_id) && BUFFER_FIXED_SKUS.includes(r.sku)) ||
        (/^q-[0-9a-f]{12}$/.test(r.onchain_order_id) && r.sku === BUFFER_QUOTE_SKU)) ||
      typeof r.brief_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.brief_sha256)) {
    throw new Error('invalid Buffer forwarder terms');
  }
  const agent = keyBytes(r.forwarder_agent_public_key), vaultAgent = keyBytes(r.vault_agent_public_key);
  if (agent.equals(vaultAgent)) throw new Error('distinct receiver-scoped agent keys are required');
  return { terms: r, agent };
}

/** Compare the exact request and seller response to already-reviewed terms.
 * Neither the private access token nor the private brief is returned. The
 * response is untrusted, and this routine does not create or send an order. */
export function checkBufferOrderResponse(raw, request, response, { nowMs = Date.now() } = {}) {
  const { terms: r } = validateBufferForwarderTerms(raw, { nowMs });
  if (!BUFFER_FIXED_SKUS.includes(r.sku) || !ownData(request, ['brief', 'sku', 'customerAccount']) || typeof request.brief !== 'string' ||
      !request.brief.isWellFormed() || request.brief !== request.brief.trim() || request.brief.length < 10 || request.brief.length > 4000 ||
      Buffer.byteLength(request.brief) > 16_000 || sha(Buffer.from(request.brief, 'utf8')) !== r.brief_sha256 ||
      request.sku !== r.sku || request.customerAccount !== r.adapter ||
      !ownData(response, ['orderId', 'accessToken', 'onchainOrderId', 'payment', 'nearCliCommand']) ||
      response.orderId !== r.api_order_id || response.onchainOrderId !== r.onchain_order_id ||
      typeof response.accessToken !== 'string' || !/^[0-9a-f]{48}$/.test(response.accessToken)) {
    throw new Error('Buffer order request or private response differs from the reviewed terms');
  }
  const p = response.payment;
  if (!ownData(p, ['tokenContract', 'method', 'args', 'attachedDeposit', 'gas']) ||
      !ownData(p.args, ['receiver_id', 'amount', 'msg'])) {
    throw new Error('invalid Buffer payment response');
  }
  const args = p.args;
  const price = typeof args.amount === 'string' ? args.amount :
    Number.isSafeInteger(args.amount) && args.amount >= 0 ? String(args.amount) : '';
  const message = JSON.stringify({ order_id: r.onchain_order_id, sku: r.sku });
  if (p.tokenContract !== CIRCLE_TESTNET_USDC || p.method !== 'ft_transfer_call' ||
      p.attachedDeposit !== '1 yoctoNEAR' || p.gas !== '100 Tgas' ||
      args.receiver_id !== BUFFER_TESTNET_CONTRACT || price !== r.amount || args.msg !== message) {
    throw new Error('Buffer payment response differs from the pinned token, payee, price or message');
  }
  return { checked: true, token: CIRCLE_TESTNET_USDC, seller: BUFFER_TESTNET_CONTRACT, amount: r.amount,
    message_sha256: sha(Buffer.from(message)), brief_sha256: r.brief_sha256,
    bearer_returned: false, request_is_private: true, execution_authorized: false };
}

/** Compare an already-issued private quote and a caller-supplied chain view to
 * exact owner-reviewed terms. This does not obtain a quote, prove the view's
 * provenance, or authorize payment. Both the quote and the FT intent expire. */
export function checkBufferQuoteResponse(raw, request, response, order, chainQuote, { nowMs = Date.now() } = {}) {
  const { terms: r } = validateBufferForwarderTerms(raw, { nowMs });
  if (r.sku !== BUFFER_QUOTE_SKU || !ownData(request, ['request', 'customerAccount']) ||
      typeof request.request !== 'string' || !request.request.isWellFormed() || request.request !== request.request.trim() ||
      request.request.length < 20 || request.request.length > 4000 || Buffer.byteLength(request.request) > 16_000 ||
      sha(Buffer.from(request.request, 'utf8')) !== r.brief_sha256 || request.customerAccount !== r.adapter ||
      !ownData(response, ['orderId', 'accessToken']) || response.orderId !== r.api_order_id ||
      typeof response.accessToken !== 'string' || !/^[0-9a-f]{48}$/.test(response.accessToken) ||
      !plain(order) || order.authorised !== true || order.id !== r.api_order_id || order.onchainOrderId !== r.onchain_order_id ||
      order.contractId !== BUFFER_TESTNET_CONTRACT || order.tokenContract !== CIRCLE_TESTNET_USDC ||
      order.sku !== r.sku || order.priceUnits !== r.amount || order.state !== 'AWAITING_PAYMENT' || order.brief !== request.request ||
      !plain(order.quote) || typeof order.quote.expiresAt !== 'string' ||
      !isTransactionHash(order.quote.quoteTx) || !canonicalUint(order.quote.maxExpenseUnits) ||
      !plain(chainQuote) || chainQuote.sku !== r.sku || chainQuote.amount !== r.amount || chainQuote.paid !== false ||
      !canonicalUint(chainQuote.max_expense) || chainQuote.max_expense !== order.quote.maxExpenseUnits ||
      BigInt(chainQuote.max_expense) > BigInt(r.amount)) {
    throw new Error('Buffer quote or request differs from the reviewed terms');
  }
  // The seller source returns a nanosecond u64 as a JSON number, which can
  // round at this magnitude. A conservative ten-second margin dominates that
  // rounding; callers still need a fresh, block-pinned quote and chain clock.
  const ns = chainQuote.expires_ns;
  if (!((typeof ns === 'number' && Number.isFinite(ns) && Number.isInteger(ns) && ns > 0) || canonicalUint(ns))) {
    throw new Error('invalid Buffer quote expiry');
  }
  const chainExpiryMs = Number(BigInt(ns) / 1_000_000n), httpExpiryMs = Date.parse(order.quote.expiresAt);
  if (!Number.isSafeInteger(chainExpiryMs) || !Number.isSafeInteger(httpExpiryMs) ||
      Math.abs(chainExpiryMs - httpExpiryMs) > 1000 ||
      r.expires_at_ms > Math.min(chainExpiryMs, httpExpiryMs) - 10_000 || r.expires_at_ms <= nowMs) {
    throw new Error('Buffer quote expiry does not safely cover the reviewed intent');
  }
  const message = JSON.stringify({ order_id: r.onchain_order_id, sku: r.sku });
  return { checked: true, token: CIRCLE_TESTNET_USDC, seller: BUFFER_TESTNET_CONTRACT, amount: r.amount,
    quote_transaction: order.quote.quoteTx, quote_expires_at_ms: chainExpiryMs,
    message_sha256: sha(Buffer.from(message)), brief_sha256: r.brief_sha256,
    bearer_returned: false, request_is_private: true, chain_view_provenance_verified: false,
    deployed_source_equivalence_verified: false, execution_authorized: false };
}

/** Deterministically generate a one-order forwarder and public review. Unlike
 * the PayPerCall variant, no escrow claim or storage-withdrawal call exists. */
export async function buildBufferForwarder(raw, { nowMs = Date.now() } = {}) {
  const { terms: r, agent } = validateBufferForwarderTerms(raw, { nowMs });
  const msg = JSON.stringify({ order_id: r.onchain_order_id, sku: r.sku });
  const review = { version: 'EXPERIMENTAL_BUFFER_FORWARDER_V1', chain_assumption: 'testnet',
    owner: r.owner, vault: r.vault, adapter: r.adapter, forwarder_agent_public_key: r.forwarder_agent_public_key,
    vault_agent_public_key: r.vault_agent_public_key, policy_id: r.policy_id, intent_id: r.intent_id,
    intent_memo: `bouncer:buffer:${r.intent_id}`, token: CIRCLE_TESTNET_USDC, escrow: BUFFER_TESTNET_CONTRACT,
    amount: r.amount, api_order_id: r.api_order_id, onchain_order_id: r.onchain_order_id,
    sku: r.sku, brief_sha256: r.brief_sha256, message_sha256: sha(Buffer.from(msg)),
    expires_at_ms: r.expires_at_ms, native_return_cap: r.native_return_cap, native_reserve: r.native_reserve };
  return compileFixedForwarder({ review, agent, msg });
}
