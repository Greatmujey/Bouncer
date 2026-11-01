#!/usr/bin/env node
/**
 * Testnet-only buyer for PipRail-style x402 v2 `onchain-proof` NEP-141 offers.
 * The agent's ONLY signing authority is Bouncer.execute with zero deposit.
 * An owner explicitly pins the URL, Circle testnet token, payee, policy and
 * price ceiling, and acknowledges that a public on-chain proof can be stolen.
 *
 * This is NOT standard x402 `exact` / NEP-366 and does not give the agent a
 * full-access key. A seller has to advertise and actually accept this scheme.
 * Journal the signed hash before ONE broadcast; a failed/ambiguous payment is
 * read-only recovery by that hash, never an automatic re-payment. Likewise,
 * record an HTTP redemption attempt before sending it and never auto-repeat
 * an ambiguous request to a potentially non-idempotent seller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';
import { FileJournal, requestFingerprint, validatePlan } from './procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';

const { KeyPair, KeyPairSigner } = nearApi;
const U128_MAX = (1n << 128n) - 1n;
const GAS = 200n * 10n ** 12n;
const MAX_HEADER = 8192, MAX_BODY = 64 * 1024;
const VERSION = 'piprail-onchain-proof-testnet-v1';
const GOAL_KEYS = ['version', 'id', 'contract_id', 'owner_account_id', 'policy_id', 'token', 'payee',
  'max_amount', 'resource_url', 'max_quote_age_seconds', 'accept_public_proof_risk', 'accept_unbound_resource_risk'];
const OFFER_KEYS = ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'];
const EXTRA_KEYS = ['nonce', 'decimals', 'minConfirmations', 'amountFormatted'];
const eq = isDeepStrictEqual;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v, required, optional = []) => record(v) && required.every(k => Object.hasOwn(v, k)) &&
  Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');
const goalFingerprint = v => sha256(JSON.stringify(v));
function positive(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,38}$/.test(value) || BigInt(value) > U128_MAX) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function safeText(value, label, max) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
export function validateOnchainProofResourceUrl(value) {
  safeText(value, 'resource URL', 2048);
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid resource URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password ||
      url.search || url.hash || url.href !== value) throw new Error('resource URL must be canonical HTTPS (or loopback HTTP), without credentials, query or fragment');
  return url.href;
}

/** The owner approves these exact limits and the public-proof risk up front. */
export function validateOnchainProofGoal(input) {
  if (!exactKeys(input, GOAL_KEYS) || input.version !== 1 || input.accept_public_proof_risk !== true || input.accept_unbound_resource_risk !== true) {
    throw new Error('owner goal must contain the exact v1 fields and explicitly accept public-proof and unbound-resource risks');
  }
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id) ||
      typeof input.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.policy_id) ||
      !isTestnetAccount(input.contract_id) || !isTestnetAccount(input.owner_account_id) || !isTestnetAccount(input.payee)) {
    throw new Error('invalid goal ID, policy or testnet account');
  }
  // The proof verifier needs NEP-297 transfer events with memo. This first
  // adapter deliberately limits itself to the independently identified Circle
  // testnet contract; generic NEP-141 implementations need separate review.
  if (input.token !== CIRCLE_TESTNET_USDC) throw new Error('onchain-proof v1 supports only Circle NEAR testnet USDC');
  positive(input.max_amount, 'maximum amount');
  const url = validateOnchainProofResourceUrl(input.resource_url);
  if (!Number.isSafeInteger(input.max_quote_age_seconds) || input.max_quote_age_seconds < 1 || input.max_quote_age_seconds > 600) {
    throw new Error('quote age must be 1–600 seconds');
  }
  return { version: 1, id: input.id, contract_id: input.contract_id, owner_account_id: input.owner_account_id,
    policy_id: input.policy_id, token: input.token, payee: input.payee, max_amount: input.max_amount,
    resource_url: url, max_quote_age_seconds: input.max_quote_age_seconds, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
}

function decodeHeader(value) {
  if (typeof value !== 'string' || value.length > MAX_HEADER || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid PAYMENT-REQUIRED header');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical PAYMENT-REQUIRED header');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid PAYMENT-REQUIRED JSON'); }
}
function validateOffer(value, goal) {
  if (!exactKeys(value, OFFER_KEYS) || value.scheme !== 'onchain-proof' || value.network !== 'near:testnet' ||
      value.asset !== goal.token || value.payTo !== goal.payee || positive(value.amount, 'offer amount') > BigInt(goal.max_amount) ||
      !Number.isSafeInteger(value.maxTimeoutSeconds) || value.maxTimeoutSeconds < 60 || value.maxTimeoutSeconds > 86_400 ||
      !exactKeys(value.extra, EXTRA_KEYS, ['symbol'])) throw new Error('offer is not an owner-approved testnet onchain-proof payment');
  const e = value.extra;
  safeText(e.nonce, 'challenge nonce', 256); // NEP-141 memo limit in Bouncer
  if (!Number.isSafeInteger(e.decimals) || e.decimals !== 6 || !Number.isSafeInteger(e.minConfirmations) ||
      e.minConfirmations < 1 || e.minConfirmations > 100 || typeof e.amountFormatted !== 'string' ||
      Buffer.byteLength(e.amountFormatted) > 80 || (e.symbol !== undefined && (typeof e.symbol !== 'string' || Buffer.byteLength(e.symbol) > 32))) {
    throw new Error('unsupported onchain-proof offer metadata');
  }
  return structuredClone(value);
}

/** Parse a 402 without trusting the body, redirects, seller price or network. */
export function selectOnchainProofOffer(goalInput, header) {
  const goal = validateOnchainProofGoal(goalInput), challenge = decodeHeader(header);
  // PipRail's default HTTP adapter emits an empty resource URL. Even when a
  // seller includes the URL, its onchain-proof verifier does not bind it to
  // the token event. The owner must separately acknowledge this risk above;
  // a NONEMPTY different URL is nevertheless rejected rather than ignored.
  if (!record(challenge) || challenge.x402Version !== 2 || !record(challenge.resource) ||
      !['', goal.resource_url].includes(challenge.resource.url) || !Array.isArray(challenge.accepts) ||
      !challenge.accepts.length || challenge.accepts.length > 16) throw new Error('challenge does not match the reviewed resource');
  const candidates = challenge.accepts.filter(a => record(a) && a.scheme === 'onchain-proof' && a.network === 'near:testnet' &&
    a.asset === goal.token && a.payTo === goal.payee);
  if (candidates.length !== 1) throw new Error('challenge must contain exactly one matching owner-approved offer');
  return validateOffer(candidates[0], goal);
}

function paymentRequest(goal, offer) {
  return validatePlan({ contract_id: goal.contract_id, owner_account_id: goal.owner_account_id,
    requests: [{ id: goal.id, resource: 'api', policy_id: goal.policy_id, token: goal.token, payee: goal.payee,
      amount: offer.amount, memo: offer.extra.nonce }] }).requests[0];
}
function plan(goal, request) { return { contract_id: goal.contract_id, owner_account_id: goal.owner_account_id, requests: [request] }; }
function requireJournal(journal) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate x402 onchain-proof payments');
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function' || typeof journal.list !== 'function') {
    throw new Error('the original exclusive durable journal is required');
  }
}
function checkUnusedNonce(journal, nonce) {
  if (journal.list().some(entry => entry?.protocol?.kind === VERSION && entry.protocol.offer?.extra?.nonce === nonce)) {
    throw new Error('seller challenge was already recorded in this journal; do not pay again');
  }
}
function validateEntry(goal, entry) {
  if (!entry || !['pending', 'completed'].includes(entry.status) || entry.payment_version !== 'direct-signed-v1' ||
      !isTransactionHash(entry.tx_hash) || typeof entry.agent_public_key !== 'string' || !entry.agent_public_key ||
      entry.protocol?.kind !== VERSION || entry.protocol.goal_fingerprint !== goalFingerprint(goal) || !eq(entry.protocol.goal, goal)) {
    throw new Error('original journal does not match the reviewed onchain-proof goal');
  }
  const offer = validateOffer(entry.protocol.offer, goal), request = paymentRequest(goal, offer);
  if (!eq(entry.request, request) || entry.fingerprint !== requestFingerprint(request)) throw new Error('recorded offer or payment was changed');
  if (!record(entry.redemption) || !['not_started', 'attempted', 'delivered'].includes(entry.redemption.status)) throw new Error('invalid redemption state');
  return { request, offer };
}
function delivered(entry) {
  const r = entry.redemption;
  if (r.status !== 'delivered') return null;
  if (typeof r.body_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.body_base64) ||
      r.body_base64.length > Math.ceil(MAX_BODY / 3) * 4 + 4 || typeof r.sha256 !== 'string' ||
      !Number.isSafeInteger(r.http_status) || r.http_status < 200 || r.http_status > 299 ||
      typeof r.content_type !== 'string' || Buffer.byteLength(r.content_type) > 256 || /[\x00-\x1f\x7f]/.test(r.content_type)) {
    throw new Error('invalid recorded resource response');
  }
  const bytes = Buffer.from(r.body_base64, 'base64');
  if (bytes.length > MAX_BODY || bytes.toString('base64') !== r.body_base64 || sha256(bytes) !== r.sha256) throw new Error('recorded resource response changed');
  return { http_status: r.http_status, content_type: r.content_type, sha256: r.sha256, body_base64: r.body_base64 };
}

/** Require the specific nested Circle token event the third-party verifier reads. */
export function verifyOnchainProofSettlement({ result, goal: rawGoal, request, publicKey, txHash }) {
  const goal = validateOnchainProofGoal(rawGoal);
  if (!record(request) || request.id !== goal.id || request.resource !== 'api' || request.policy_id !== goal.policy_id ||
      request.token !== goal.token || request.payee !== goal.payee || positive(request.amount, 'recorded amount') > BigInt(goal.max_amount)) {
    throw new Error('payment request does not match the reviewed goal');
  }
  safeText(request.memo, 'challenge nonce', 256);
  const settlement = verifyDirectPayment({ result, contractId: goal.contract_id, ownerAccountId: goal.owner_account_id,
    request, publicKey, txHash });
  // Select using the same single-action criteria as verifyDirectPayment;
  // otherwise an unrelated multi-action receipt could lend us its event log.
  const receipt = result.receipts.find(r => r.predecessor_id === goal.contract_id && r.receiver_id === goal.token &&
    Array.isArray(r.receipt?.Action?.actions) && r.receipt.Action.actions.length === 1 &&
    r.receipt.Action.actions[0]?.FunctionCall?.method_name === 'ft_transfer');
  const outcome = result.receipts_outcome.find(r => r.id === receipt?.receipt_id && r.outcome?.executor_id === goal.token);
  let matches = 0;
  for (const line of outcome?.outcome?.logs ?? []) {
    if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:') || Buffer.byteLength(line) > 16_384) continue;
    let event;
    try { event = JSON.parse(line.slice('EVENT_JSON:'.length)); } catch { continue; }
    if (event?.standard !== 'nep141' || event.version !== '1.0.0' || event.event !== 'ft_transfer' || !Array.isArray(event.data)) continue;
    for (const item of event.data) if (item?.old_owner_id === goal.contract_id && item.new_owner_id === goal.payee &&
      item.amount === request.amount && item.memo === request.memo) matches++;
  }
  if (matches !== 1) throw new Error('missing unique matching Circle NEP-297 transfer event; payment may have settled, do not resend');
  return { ...settlement, event: 'unique matching Circle NEP-297 ft_transfer with challenge memo' };
}

/** The public proof points at the transaction signer (locator), not the vault. */
export function buildOnchainProofHeader(goalInput, offerInput, txHash) {
  const goal = validateOnchainProofGoal(goalInput), offer = validateOffer(offerInput, goal);
  if (!isTransactionHash(txHash)) throw new Error('invalid recorded transaction hash');
  const value = Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer,
    payload: { nonce: offer.extra.nonce, txHash: `${goal.owner_account_id}:${txHash}` } })).toString('base64');
  if (value.length > MAX_HEADER) throw new Error('payment proof header is too large');
  return value;
}

async function checkAgent(goal, request, provider, account, publicKey) {
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('agent account does not match owner');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  const [version, owner, access, policy, allowed, verdict, storage] = await Promise.all([
    provider.callFunction(goal.contract_id, 'contract_version', {}, final),
    provider.callFunction(goal.contract_id, 'get_owner', {}, final),
    provider.viewAccessKey(goal.owner_account_id, publicKey, final),
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.policy_id, payee: goal.payee, amount: request.amount }, final),
    provider.callFunction(goal.token, 'storage_balance_of', { account_id: goal.payee }, final),
  ]);
  if (version !== 'bouncer-agent-v9' || owner !== goal.owner_account_id) throw new Error('unsupported Bouncer version or owner');
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !eq(permission.method_names, ['execute'])) throw new Error('agent key must be scoped ONLY to execute on this contract');
  if (!policy || policy.token !== goal.token || allowed !== true) throw new Error('on-chain policy or key grant does not match the goal');
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid policy verdict');
  if (!record(storage) || typeof storage.total !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(storage.total)) throw new Error('seller is not registered on Circle testnet USDC');
  return verdict;
}
async function readQuote(goal, fetchImpl, timeoutMs) {
  const response = await fetchImpl(goal.resource_url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  try {
    if (response.status !== 402) throw new Error(`resource did not offer a 402 challenge (HTTP ${response.status})`);
    return selectOnchainProofOffer(goal, response.headers?.get('payment-required'));
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** Read-only by default. An execution writes before one send and one redemption. */
export async function runOnchainProofGoal({ goal: rawGoal, provider, account, publicKey, journal, execute = false,
  fetchImpl = globalThis.fetch, timeoutMs = 20_000, log = console.log }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate x402 onchain-proof payments');
  const goal = validateOnchainProofGoal(rawGoal);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('invalid HTTP client');
  if (execute) {
    requireJournal(journal);
    if (journal.get(goal.id)) throw new Error(`${goal.id}: existing journal entry; recover the original hash, never request another payment`);
  }
  const started = performance.now(), offer = await readQuote(goal, fetchImpl, timeoutMs), request = paymentRequest(goal, offer);
  if (execute) checkUnusedNonce(journal, offer.extra.nonce);
  const verdict = await checkAgent(goal, request, provider, account, publicKey);
  if (!verdict[0]) { log(`[onchain-proof] BLOCKED ${goal.id}`); return { status: 'BLOCKED', reason: String(verdict[1]).slice(0, 200) }; }
  if (performance.now() - started > goal.max_quote_age_seconds * 1000) throw new Error('local quote age exceeded; no payment sent');
  if (!execute) { log(`[onchain-proof] READY ${goal.id}; no payment; public proof is bearer-like`); return { status: 'READY', offer }; }
  const args = { policy_id: request.policy_id, payee: request.payee, amount: request.amount, memo: request.memo, expected_token: request.token };
  const { txHash, signed } = await signReviewedCall({ account, publicKey, ownerId: goal.owner_account_id,
    contractId: goal.contract_id, method: 'execute', args, gas: GAS });
  if (!isTransactionHash(txHash)) throw new Error('invalid signed transaction hash');
  if (performance.now() - started > goal.max_quote_age_seconds * 1000) throw new Error('local quote age exceeded; no payment sent');
  // Recheck synchronously after all awaits; concurrent users of the same open
  // journal must not both claim the same ID or challenge.
  if (journal.get(goal.id)) throw new Error(`${goal.id}: existing journal entry; recover instead of paying`);
  checkUnusedNonce(journal, offer.extra.nonce);
  const pending = { fingerprint: requestFingerprint(request), status: 'pending', request, payment_version: 'direct-signed-v1',
    agent_public_key: String(publicKey), tx_hash: txHash, started_at: new Date().toISOString(),
    protocol: { kind: VERSION, goal_fingerprint: goalFingerprint(goal), goal, offer }, redemption: { status: 'not_started' } };
  journal.put(goal.id, pending); // fsync file AND directory before any broadcast
  if (performance.now() - started > goal.max_quote_age_seconds * 1000) throw new Error(`${goal.id}: quote expired after journal write; no broadcast; retain and reconcile the pending hash`);
  try {
    const sent = await provider.sendTransactionUntil(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different or missing transaction hash');
    await recoverOnchainProofGoal({ goal, provider, journal, log: () => {} });
  } catch (error) {
    throw new Error(`${goal.id}: payment ${txHash} is unresolved; retain the original journal, never resend automatically: ${error.message}`, { cause: error });
  }
  return redeemOnchainProofOnce({ goal, provider, journal, fetchImpl, timeoutMs, log });
}

/** Only reads FINAL receipts by the original hash. Never contacts the seller. */
export async function recoverOnchainProofGoal({ goal: rawGoal, provider, journal, update = true, log = console.log }) {
  const goal = validateOnchainProofGoal(rawGoal);
  if (typeof update !== 'boolean') throw new Error('invalid reconciliation mode');
  requireJournal(journal);
  const entry = journal.get(goal.id), { request } = validateEntry(goal, entry);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const result = await provider.txStatusReceipts(entry.tx_hash, goal.owner_account_id, 'FINAL');
  const settlement = verifyOnchainProofSettlement({ result, goal, request, publicKey: entry.agent_public_key, txHash: entry.tx_hash });
  if (entry.status === 'completed' && !eq(entry.settlement, settlement)) throw new Error('recorded settlement differs from chain');
  if (entry.status === 'pending' && update) {
    // Do not overwrite an entry that changed while waiting for RPC.
    const current = journal.get(goal.id);
    if (!eq(current, entry)) throw new Error('journal changed during reconciliation; stop');
    journal.put(goal.id, { ...entry, status: 'completed', settlement, completed_at: new Date().toISOString() });
  }
  const current = journal.get(goal.id);
  if (!update && !eq(current, entry)) throw new Error('journal changed during read-only reconciliation; stop');
  const response = delivered(current);
  log(`[onchain-proof] RECONCILED ${goal.id}: ${entry.tx_hash}; no payment or seller request`);
  return { status: 'RECONCILED', settlement, redemption_status: current.redemption.status, ...(response ? { response } : {}) };
}

/**
 * ONE first redemption only, including during key-free recovery. An attempted
 * request may already have delivered even on timeout/HTTP error; never repeat
 * automatically. A merchant's single-use store and its delivery remain trust
 * assumptions, not guarantees supplied by the on-chain transfer.
 */
export async function redeemOnchainProofOnce({ goal: rawGoal, provider, journal, fetchImpl = globalThis.fetch,
  timeoutMs = 20_000, log = console.log }) {
  const goal = validateOnchainProofGoal(rawGoal);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('invalid HTTP client');
  await recoverOnchainProofGoal({ goal, provider, journal, log: () => {} });
  const entry = journal.get(goal.id), { offer } = validateEntry(goal, entry);
  if (entry.redemption.status === 'delivered') return { status: 'REUSED', settlement: entry.settlement, response: delivered(entry) };
  if (entry.redemption.status !== 'not_started') throw new Error(`${goal.id}: redemption already attempted; seller outcome is uncertain, never retry automatically`);
  const header = buildOnchainProofHeader(goal, offer, entry.tx_hash);
  const attempted = { ...entry, redemption: { status: 'attempted', attempted_at: new Date().toISOString() } };
  journal.put(goal.id, attempted); // persist BEFORE disclosing proof or requesting service
  try {
    const response = await fetchImpl(goal.resource_url, { method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { 'payment-signature': header }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`seller returned HTTP ${response.status}`);
    }
    const bytes = await readBoundedBytes(response, { maxBytes: MAX_BODY, label: 'paid resource' });
    const contentType = response.headers?.get('content-type') || '';
    if (Buffer.byteLength(contentType) > 256 || /[\x00-\x1f\x7f]/.test(contentType)) throw new Error('invalid resource content type');
    const result = { status: 'delivered', attempted_at: attempted.redemption.attempted_at, received_at: new Date().toISOString(),
      http_status: response.status, content_type: contentType, sha256: sha256(bytes), body_base64: bytes.toString('base64') };
    // Only the attempted entry may transition to delivered.
    if (!eq(journal.get(goal.id), attempted)) throw new Error('journal changed during redemption; stop');
    journal.put(goal.id, { ...attempted, redemption: result });
    log(`[onchain-proof] RESPONSE ${goal.id}: ${entry.tx_hash}; seller response is untrusted and proof was public`);
    return { status: 'RESPONDED', settlement: entry.settlement, response: delivered(journal.get(goal.id)) };
  } catch (error) {
    throw new Error(`${goal.id}: payment ${entry.tx_hash} is confirmed but seller redemption was attempted and may have been consumed; never repay or retry automatically: ${error.message}`, { cause: error });
  }
}

function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--execute', '--recover', '--redeem', '--help'].includes(arg)) {
      const key = arg.slice(2); if (out[key]) throw new Error(`duplicate ${arg}`); out[key] = true;
    } else if (['--goal', '--key', '--state', '--rpc'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = arg.slice(2); if (out[key]) throw new Error(`duplicate ${arg}`); out[key] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return out;
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node bouncer/agent/onchain-proof.mjs --goal GOAL.json --key AGENT.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('       node bouncer/agent/onchain-proof.mjs --goal GOAL.json --state ORIGINAL.json --recover [--redeem] [--rpc URL]');
    console.log('Testnet only. Dry run by default. Recovery never repays; --redeem sends only a first, previously unattempted seller request.');
    return;
  }
  if (!opts.goal || (opts.recover ? (!opts.state || opts.key || opts.execute) : (!opts.key || opts.redeem))) throw new Error('provide --goal and --key, or --goal --state --recover [--redeem]');
  const goalPath = path.resolve(home(opts.goal)), goal = validateOnchainProofGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const provider = new PaymentRpcProvider(opts.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const statePath = path.resolve(home(opts.state || `${goalPath}.bouncer-proof-journal.json`));
  if (opts.recover && !fs.existsSync(statePath)) throw new Error('original journal not found; recovery cannot create one');
  const journal = opts.execute || opts.recover ? new FileJournal(statePath, goal.contract_id, goal.owner_account_id) : null;
  try {
    let result;
    if (opts.recover) result = opts.redeem ? await redeemOnchainProofOnce({ goal, provider, journal }) : await recoverOnchainProofGoal({ goal, provider, journal });
    else {
      const file = JSON.parse(fs.readFileSync(home(opts.key), 'utf8'));
      if (file.account_id !== goal.owner_account_id || typeof file.private_key !== 'string') throw new Error('agent key file does not match owner');
      const key = KeyPair.fromString(file.private_key), account = new MonotonicAccount(goal.owner_account_id, provider, new KeyPairSigner(key));
      result = await runOnchainProofGoal({ goal, provider, account, publicKey: key.getPublicKey(), journal, execute: !!opts.execute });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[onchain-proof] ERROR: ${error.message}`); process.exitCode = 1; });
}
