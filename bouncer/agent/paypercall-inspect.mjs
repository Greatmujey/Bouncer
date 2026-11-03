#!/usr/bin/env node
/**
 * READ ONLY. Inspect a bounded PayPerCall service catalog or a previously
 * identified call at one fresh FINAL testnet block. This file never contacts an
 * operator endpoint, opens an escrow, signs, sends, claims, or funds anything.
 *
 * The reviewed PayPerCall source is not an attestation of deployed code. Even
 * a matching answer hash says nothing about answer quality or whether a Bouncer
 * transaction paid the call. In particular, an escrow's Refunded status is not
 * proof of successful token payout or credit in Bouncer's internal ledger.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { ReadOnlyNearRpcProvider, readPinnedJsonView } from './read-only-near-rpc.mjs';

export const PAYPERCALL_TESTNET_ESCROW = 'devx-paypercall.testnet';
const MAX_U128 = (1n << 128n) - 1n, MAX_U64 = (1n << 64n) - 1n;
const MAX_SERVICES = 20, MAX_RESPONSE_BYTES = 1024 * 1024;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
const uint = (x, max) => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= max;
const id32 = x => Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff;
const id64Safe = x => Number.isSafeInteger(x) && x >= 0;

/** Ensure we hash exactly the UTF-8 the seller receives; reject lossy lone
 * surrogates and enforce the pinned source's 256-byte *UTF-8* request limit. */
function publicRequest(request) {
  if (typeof request !== 'string') throw new Error('public request must be a string');
  const bytes = Buffer.from(request, 'utf8');
  if (!bytes.length || bytes.length > 256 || bytes.toString('utf8') !== request) {
    throw new Error('public request must be 1..256 valid UTF-8 bytes');
  }
  return bytes;
}

function expectedCall(input) {
  if (!record(input) || !id64Safe(input.call_id) || !id32(input.service_id) ||
      !isTestnetAccount(input.payer) || !isTestnetToken(input.token) ||
      !uint(input.amount, MAX_U128) || input.amount === '0' ||
      !(input.referrer === null || isTestnetAccount(input.referrer))) {
    throw new Error('invalid expected testnet call identity');
  }
  if (input.referrer === input.payer) throw new Error('referrer cannot be payer');
  return { call_id: input.call_id, service_id: input.service_id, payer: input.payer,
    token: input.token, amount: input.amount, referrer: input.referrer, request: input.request,
    request_hash: sha256(publicRequest(input.request)) };
}

/** Construct only a public message, not a transaction or authorization.
 * max_price is an upper bound: the service could charge a lower price. */
export function buildPayPerCallMessage({ service_id, request, referrer = null, max_price } = {}) {
  if (!id32(service_id) || !(referrer === null || isTestnetAccount(referrer)) ||
      !uint(max_price, MAX_U128) || max_price === '0') throw new Error('invalid public call terms');
  const requestHash = sha256(publicRequest(request));
  const msg = JSON.stringify({ service_id, request, referrer, max_price });
  if (Buffer.byteLength(msg, 'utf8') > 2048) throw new Error('receiver message exceeds Bouncer limit');
  return { msg, request_hash: requestHash, max_price, public_request: true, signed: false, sent: false,
    scope: 'offline draft only; exact-FT V11 cannot open this escrow and later refunds need a safe accounting path' };
}

/** A hostname-shaped HTTPS URL is not proof that DNS is public or that an
 * operator is available. This checker never fetches the endpoint. */
function looksLikePublicHttps(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 256) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || net.isIP(host.replace(/^\[|\]$/g, '')) ||
        !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')) return false;
    return true;
  } catch { return false; }
}

function inspectService(service, serviceId) {
  if (!record(service) || !isTestnetAccount(service.provider) || !isTestnetAccount(service.operator) ||
      !(service.token === null || isTestnetToken(service.token)) || !uint(service.price, MAX_U128) || service.price === '0' ||
      !Number.isSafeInteger(service.timeout_secs) || service.timeout_secs < 60 || service.timeout_secs > 604800 ||
      !Number.isSafeInteger(service.referrer_bps) || service.referrer_bps < 0 || service.referrer_bps > 5000 ||
      typeof service.active !== 'boolean' || typeof service.name !== 'string' || !service.name ||
      Buffer.byteLength(service.name, 'utf8') > 256 || typeof service.endpoint !== 'string' ||
      Buffer.byteLength(service.endpoint, 'utf8') > 256) {
    return { service_id: serviceId, status: 'UNRECOGNIZED_OR_UNAVAILABLE' };
  }
  const httpsSyntax = looksLikePublicHttps(service.endpoint);
  return { service_id: serviceId, status: 'SERVICE_VIEW_ONLY', provider: service.provider, operator: service.operator,
    token: service.token, price_base_units: service.price, timeout_secs: service.timeout_secs,
    referrer_bps: service.referrer_bps, active: service.active, name: service.name,
    endpoint: service.endpoint, https_hostname_syntax: httpsSyntax, endpoint_reachability_checked: false,
    circle_candidate: service.active && service.token === CIRCLE_TESTNET_USDC && httpsSyntax };
}

const registration = value => {
  if (value === null) return 'NOT_REGISTERED_AT_VIEW';
  if (record(value) && uint(value.total, MAX_U128) && value.total !== '0' && uint(value.available, MAX_U128) &&
      BigInt(value.available) <= BigInt(value.total)) return 'REGISTERED_AT_VIEW';
  return 'UNKNOWN';
};

async function pinnedAccount(provider, account, blockHash) {
  const value = await provider.query({ request_type: 'view_account', account_id: account, block_id: blockHash });
  if (!record(value) || value.block_hash !== blockHash || !isTransactionHash(value.code_hash)) throw new Error('invalid pinned account');
  return value.code_hash;
}
async function pinnedKeySummary(provider, account, blockHash) {
  const value = await provider.query({ request_type: 'view_access_key_list', account_id: account, block_id: blockHash });
  if (!record(value) || value.block_hash !== blockHash || !Array.isArray(value.keys) || value.keys.length > 1000) {
    throw new Error('invalid pinned key list');
  }
  let full = 0;
  for (const key of value.keys) {
    const permission = key?.access_key?.permission;
    if (permission === 'FullAccess') full++;
    else if (!record(permission) || !record(permission.FunctionCall) || typeof permission.FunctionCall.receiver_id !== 'string' ||
             !Array.isArray(permission.FunctionCall.method_names)) throw new Error('unrecognized key permission');
  }
  return { key_count: value.keys.length, full_access_key_count: full };
}
async function settled(tasks, concurrency = 4) {
  const results = Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = { ok: true, value: await tasks[index]() }; }
      catch { results[index] = { ok: false }; }
    }
  }));
  return results;
}
async function finalSnapshot(provider, now) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('read-only testnet provider and clock required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const start = now(), block = await provider.viewBlock({ finality: 'final' });
  const fresh = assertFreshFinalBlock(block, start);
  return { start, fresh, snapshot: { header: { hash: fresh.hash, timestamp_nanosec: block.header.timestamp_nanosec } } };
}
function finishSnapshot(snapshot, start, now) {
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards during views');
  assertFreshFinalBlock(snapshot, end);
  return end;
}

/** Discover at most 20 services. UNKNOWN and truncation never mean absence.
 * A candidate is merely a service view, not an authorization or working offer. */
export async function inspectPayPerCallCatalog(provider, { vault = null, maxServices = MAX_SERVICES, offset = 0, now = Date.now } = {}) {
  if (!(vault === null || isTestnetAccount(vault)) || !Number.isSafeInteger(maxServices) || maxServices < 1 || maxServices > MAX_SERVICES ||
      !id32(offset) || typeof provider?.query !== 'function') throw new Error('invalid vault, bounded scan or read-only provider');
  const { start, fresh, snapshot } = await finalSnapshot(provider, now), blockHash = fresh.hash;
  const view = (contract, method, args) => readPinnedJsonView(provider, blockHash, contract, method, args);
  const reads = await settled([
    () => view(PAYPERCALL_TESTNET_ESCROW, 'service_count', {}),
    () => pinnedAccount(provider, PAYPERCALL_TESTNET_ESCROW, blockHash),
    () => pinnedKeySummary(provider, PAYPERCALL_TESTNET_ESCROW, blockHash),
    () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: PAYPERCALL_TESTNET_ESCROW }),
    ...(vault ? [() => view(PAYPERCALL_TESTNET_ESCROW, 'get_storage_credit', { account_id: vault }),
      () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: vault })] : []),
  ]);
  const count = reads[0].ok && id32(reads[0].value) ? reads[0].value : null;
  const scanCount = count === null ? 0 : Math.min(Math.max(0, count - offset), maxServices);
  const serviceReads = await settled(Array.from({ length: scanCount }, (_, index) =>
    () => view(PAYPERCALL_TESTNET_ESCROW, 'get_service', { service_id: offset + index })));
  const services = serviceReads.map((result, index) => result.ok ? inspectService(result.value, offset + index) :
    { service_id: offset + index, status: 'UNRECOGNIZED_OR_UNAVAILABLE' });
  const end = finishSnapshot(snapshot, start, now);
  const complete = count !== null && offset === 0 && count <= maxServices &&
    services.every(s => s.status === 'SERVICE_VIEW_ONLY');
  const credit = vault && reads[4].ok && uint(reads[4].value, MAX_U128) ? reads[4].value : null;
  return { status: 'READ_ONLY_CATALOG_NOT_PAYMENT_READY', chain: 'testnet', block_hash: blockHash,
    block_timestamp: new Date(fresh.timestamp_ms).toISOString(), observed_at: new Date(end).toISOString(),
    escrow: PAYPERCALL_TESTNET_ESCROW, escrow_code_hash: reads[1].ok ? reads[1].value : null,
    escrow_access_keys: reads[2].ok ? reads[2].value : null,
    escrow_circle_registration: reads[3].ok ? registration(reads[3].value) : 'UNKNOWN',
    vault, vault_storage_credit_yocto: credit,
    vault_circle_registration: vault ? (reads[5].ok ? registration(reads[5].value) : 'UNKNOWN') : 'NOT_CHECKED',
    service_count: count, scan_offset: offset, scanned_services: scanCount,
    next_offset: count !== null && offset + scanCount < count ? offset + scanCount : null,
    complete_catalog_snapshot: complete, services,
    circle_candidates_observed: services.filter(s => s.circle_candidate).length,
    operator_contacted: false, signed: false, sent: false, payment_ready: false,
    blockers: ['V11 exact-FT intent cannot open a transfer-call escrow',
      'later plain-transfer refunds and failed claims are not reconciled into the vault ledger',
      'deployed code, endpoint reachability, terms and delivery are not verified'],
    scope: 'trusted-RPC point-in-time views only; HTTPS syntax is not reachability, terms may change, and no fulfillment or payment is established' };
}

/** Strictly compare a pinned get_call view with the expected public request.
 * An answer hash matches only the exact bytes supplied, not re-serialized JSON.
 * A refunded status does not prove the detached FT payout or vault credit. */
export function classifyPayPerCallView(rawExpected, call, answerBytes) {
  const expected = expectedCall(rawExpected);
  if (!record(call) || call.service_id !== expected.service_id || call.payer !== expected.payer ||
      call.token !== expected.token || call.amount !== expected.amount || call.referrer !== expected.referrer ||
      call.request_hash !== expected.request_hash || !uint(call.deadline_ms, MAX_U64) ||
      !['Open', 'Fulfilled', 'Refunded'].includes(call.status)) throw new Error('call view does not match the expected request and payer');
  if (answerBytes !== undefined && (!(answerBytes instanceof Uint8Array) || answerBytes.byteLength > MAX_RESPONSE_BYTES)) {
    throw new Error('answer must be bounded exact bytes');
  }
  const common = { call_id: expected.call_id, service_id: expected.service_id, payer: expected.payer,
    token: expected.token, amount: expected.amount, request_hash: expected.request_hash, escrow_status: call.status,
    bouncer_payment_verified: false, provider_payout_verified: false, vault_refund_credit_verified: false };
  if (call.status === 'Open') {
    if (call.result_hash !== null || call.result_uri !== null || answerBytes !== undefined) throw new Error('open call has unexpected result');
    return { ...common, status: 'OPEN_NO_DELIVERY', scope: 'escrow view only; payment and delivery are not proven' };
  }
  if (call.status === 'Refunded') {
    if (call.result_hash !== null || call.result_uri !== null || answerBytes !== undefined) throw new Error('refunded call has unexpected result');
    return { ...common, status: 'REFUND_REPORTED_NOT_VERIFIED',
      scope: 'escrow status alone does not prove token payout or Bouncer ledger credit; do not retry automatically' };
  }
  if (typeof call.result_hash !== 'string' || !/^[a-f0-9]{64}$/.test(call.result_hash) ||
      !(call.result_uri === null || (typeof call.result_uri === 'string' && Buffer.byteLength(call.result_uri, 'utf8') <= 256))) {
    throw new Error('invalid fulfilled result commitment');
  }
  if (answerBytes === undefined) return { ...common, status: 'FULFILLED_WITHOUT_ANSWER', result_hash: call.result_hash,
    scope: 'a committed hash is not possession of an answer or proof of a Bouncer payment' };
  const answerHash = sha256(answerBytes);
  if (answerHash !== call.result_hash) throw new Error('answer bytes do not match the on-chain hash');
  return { ...common, status: 'ANSWER_HASH_MATCH', result_hash: answerHash, answer_bytes: answerBytes.byteLength,
    scope: 'answer matches this caller-supplied view; correctness, usefulness, payment and payout remain unverified' };
}

/** Read one previously identified call. call_id must be obtained and verified
 * separately from the original payment receipt; this inspector never does so. */
export async function inspectPayPerCallResult(provider, expected, { answerBytes, now = Date.now } = {}) {
  const identity = expectedCall(expected);
  const { start, fresh, snapshot } = await finalSnapshot(provider, now);
  const call = await readPinnedJsonView(provider, fresh.hash, PAYPERCALL_TESTNET_ESCROW, 'get_call', { call_id: identity.call_id });
  const result = classifyPayPerCallView(expected, call, answerBytes), end = finishSnapshot(snapshot, start, now);
  return { ...result, chain: 'testnet', escrow: PAYPERCALL_TESTNET_ESCROW, block_hash: fresh.hash,
    block_timestamp: new Date(fresh.timestamp_ms).toISOString(), observed_at: new Date(end).toISOString(),
    operator_contacted: false, signed: false, sent: false,
    rpc_trust: 'a fresh FINAL block reported by the selected RPC; not a consensus proof' };
}

const USAGE = `Read-only PayPerCall testnet inspection; no operator contact or payment.
Catalog: node agent/paypercall-inspect.mjs catalog --rpc TESTNET_RPC [--vault VAULT.testnet] [--limit 1..20] [--offset SERVICE_ID]
Call:    node agent/paypercall-inspect.mjs call --rpc TESTNET_RPC --call-id ID --service-id ID --payer VAULT.testnet --amount BASE_UNITS --request PUBLIC_TEXT [--token TOKEN] [--referrer ACCOUNT] [--answer-file FILE]

Omitting catalog selects catalog for backward compatibility. Token defaults to
Circle testnet USDC; an omitted referrer means null. The answer file is read as
exact bytes, not fetched. Requests can be public: do not put secrets in them.
Views use one recent FINAL block reported by the supplied RPC; separate pages
may observe different blocks. Candidate or hash match does not establish a
safe purchase, Bouncer payment or correct delivery. V11 is not compatible with
this escrow. This tool never signs, sends, or creates a journal.`;
function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const mode = ['catalog', 'call'].includes(args[0]) ? args.shift() : 'catalog';
  const allowed = mode === 'catalog' ? ['rpc', 'vault', 'limit', 'max-services', 'offset'] :
    ['rpc', 'call-id', 'service-id', 'payer', 'token', 'amount', 'request', 'referrer', 'answer-file'];
  const out = { mode };
  for (let i = 0; i < args.length; i++) {
    const name = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(out, name) || !args[i + 1] ||
        (args[i + 1].startsWith('--') && name !== 'request')) {
      throw new Error('unknown, duplicate or incomplete option; use --help');
    }
    out[name] = args[++i];
  }
  if (!out.rpc) throw new Error('RPC is required; use --help');
  const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value));
  if (mode === 'catalog') {
    const limit = out.limit ?? out['max-services'] ?? String(MAX_SERVICES), offset = out.offset ?? '0';
    if ((out.vault && !isTestnetAccount(out.vault)) || (out.limit && out['max-services']) ||
        !decimal(limit) || Number(limit) < 1 || Number(limit) > MAX_SERVICES || !decimal(offset) || !id32(Number(offset))) {
      throw new Error('invalid catalog options; use --help');
    }
    return { mode, rpc: out.rpc, vault: out.vault ?? null, maxServices: Number(limit), offset: Number(offset) };
  }
  if (!decimal(out['call-id']) || !decimal(out['service-id']) || !id32(Number(out['service-id']))) {
    throw new Error('invalid call or service ID; use --help');
  }
  const expected = { call_id: Number(out['call-id']), service_id: Number(out['service-id']), payer: out.payer,
    token: out.token ?? CIRCLE_TESTNET_USDC, amount: out.amount, referrer: out.referrer ?? null, request: out.request };
  expectedCall(expected); // reject malformed identity and request before any network or file read
  return { mode, rpc: out.rpc, expected, answerFile: out['answer-file'] };
}

/** Read at most one bounded regular file without following symlinks. The bytes
 * actually read, not a string or JSON reserialization, are hashed. */
function readAnswerFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RESPONSE_BYTES) throw new Error('answer file must be regular and at most 1 MiB');
    const result = Buffer.alloc(stat.size); let offset = 0;
    while (offset < result.length) {
      const n = fs.readSync(fd, result, offset, result.length - offset, null);
      if (n < 1) throw new Error('answer file changed while reading');
      offset += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0 || fs.fstatSync(fd).size !== stat.size) {
      throw new Error('answer file changed while reading');
    }
    return result;
  } finally { fs.closeSync(fd); }
}
export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs([...args]);
  if (!opts) { console.log(USAGE); return; }
  // Validate the endpoint and any file before making a JSON-RPC request.
  const provider = new ReadOnlyNearRpcProvider(opts.rpc);
  const result = opts.mode === 'catalog' ?
    await inspectPayPerCallCatalog(provider, { vault: opts.vault, maxServices: opts.maxServices, offset: opts.offset }) :
    await inspectPayPerCallResult(provider, opts.expected,
      { answerBytes: opts.answerFile === undefined ? undefined : readAnswerFile(opts.answerFile) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) {
    console.error(`PayPerCall inspection stopped: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 350)}`);
    process.exitCode = 1;
  }
}
