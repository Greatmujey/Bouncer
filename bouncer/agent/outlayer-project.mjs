#!/usr/bin/env node
/**
 * Narrow paid OutLayer connector-probe integration, testnet only. The owner
 * pins a project version, exact fetch or bounded burn input, fake-USDC.e fee
 * and separate native/token policy budgets on chain. Burn is a deterministic
 * diagnostic workload, not general-purpose compute or TEE attestation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { MonotonicAccount } from './near-account.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const { KeyPair, KeyPairSigner, providers, transactions, utils } = nearApi;
const OUTLAYER = 'outlayer.testnet', PROJECT = 'connectors.outlayer.testnet/connector-probe', TOKEN = 'usdc.fakes.testnet';
const MAX = (1n << 128n) - 1n, GAS = 300n * 10n ** 12n;
const FIELDS = ['id', 'contract_id', 'owner_account_id', 'native_policy_id', 'amount', 'route', 'expected_author'];
const ROUTE = ['project', 'route_revision', 'native_policy_revision', 'usd_policy_revision', 'native_payee_revision', 'usd_payee_revision', 'active'];
const CONFIG = ['project_id', 'version_key', 'usd_policy_id', 'token', 'attached_usd', 'input_data', 'max_instructions', 'max_memory_mb', 'max_execution_seconds'];
const equal = isDeepStrictEqual;
const ownKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));
const validHash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(value);
function unsigned(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > MAX) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${label}`);
  return value;
}
function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) throw new Error(`invalid ${label}`);
  return value;
}

// Only two independently priced, owner-pinned test-connector operations are
// supported. Canonical JSON prevents alternate fields, duplicate keys and
// unreviewed inputs from being smuggled into a price-equivalent route.
function probeTerms(project) {
  if (project.project_id !== PROJECT || project.token !== TOKEN) throw new Error('only the pinned testnet connector-probe and fake test token are supported');
  if (project.input_data === '{"operation":"fetch"}' && project.attached_usd === '15000') {
    return { operation: 'fetch', developerShareBp: 10_000 };
  }
  let input;
  if (typeof project.input_data !== 'string' || Buffer.byteLength(project.input_data) > 128) throw new Error('invalid connector-probe input');
  try { input = JSON.parse(project.input_data); } catch { /* fail closed below */ }
  if (ownKeys(input, ['operation', 'rounds']) && input.operation === 'burn' && Number.isSafeInteger(input.rounds) &&
      input.rounds >= 1 && input.rounds <= 200 && project.attached_usd === '10000' &&
      project.input_data === JSON.stringify({ operation: 'burn', rounds: input.rounds })) {
    return { operation: 'burn', rounds: input.rounds, developerShareBp: 3333 };
  }
  throw new Error('only the explicitly priced testnet connector-probe fetch or bounded burn is supported');
}

// The published probe hashes SHA256("probe"), then 1,000 successive hashes per
// round. Its u64 checksum is little-endian, not a JS-safe integer in general.
// This recomputation verifies the returned value; it does not prove which
// machine performed the work or establish TEE attestation.
export function expectedBurnChecksum(rounds) {
  integer(rounds, 1, 200, 'burn rounds');
  let digest = crypto.createHash('sha256').update('probe').digest();
  for (let i = 0; i < rounds * 1_000; i++) digest = crypto.createHash('sha256').update(digest).digest();
  return digest.readBigUInt64LE(0).toString();
}

/**
 * Compare the provider's non-atomic views with reviewed terms. The optional
 * registry and native estimate let a funding caller fail closed BEFORE moving
 * FT into provider custody. These views are not reservations or attestation.
 */
export function assertProjectRegistry({ project, expectedAuthor, configuredToken, pricing, versionInfo, registry, estimate, maximumNative }) {
  const terms = probeTerms(project);
  const row = Array.isArray(pricing?.operations) ? pricing.operations.filter(item => item?.operation === terms.operation) : [];
  if (!isTestnetAccount(expectedAuthor) || typeof project.version_key !== 'string' || !/^[a-f0-9]{64}$/.test(project.version_key) ||
      configuredToken !== project.token || pricing?.author_account_id !== expectedAuthor || row.length !== 1 ||
      row[0].price_usd !== project.attached_usd || row[0].developer_share_bp !== terms.developerShareBp ||
      versionInfo?.wasm_hash !== project.version_key || versionInfo?.source?.WasmUrl?.hash !== project.version_key ||
      versionInfo?.source?.WasmUrl?.build_target !== 'wasm32-wasip2') {
    throw new Error('provider token, price, author or pinned project version changed');
  }
  if (registry !== undefined && (registry?.project_id !== PROJECT || registry?.uuid !== 'p0000000000000020' ||
      registry?.owner !== 'connectors.outlayer.testnet' || registry?.active_version !== project.version_key)) {
    throw new Error('provider project identity or active version changed');
  }
  if (estimate !== undefined || maximumNative !== undefined) {
    const cost = unsigned(estimate, 'provider compute estimate'), cap = unsigned(maximumNative, 'maximum NEAR deposit');
    if (cost === 0n || cap === 0n || cost > cap) throw new Error('provider compute estimate exceeds the owner-approved native maximum');
  }
}

export function validateProjectGoal(value) {
  if (!ownKeys(value, FIELDS) || !ownKeys(value.route, ROUTE) || !ownKeys(value.route.project, CONFIG)) throw new Error('project goal must contain exactly the reviewed fields');
  const id = text(value.id, 'goal id', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid goal id');
  if (![value.contract_id, value.owner_account_id, value.expected_author].every(isTestnetAccount)) throw new Error('only named testnet accounts are supported');
  const nativePolicy = text(value.native_policy_id, 'native policy', 128), p = value.route.project;
  probeTerms(p);
  if (typeof p.version_key !== 'string' || !/^[a-f0-9]{64}$/.test(p.version_key)) throw new Error('invalid pinned project version');
  const usdPolicy = text(p.usd_policy_id, 'prepaid policy', 128);
  if (usdPolicy === nativePolicy) throw new Error('project requires separate native and prepaid policies');
  const project = { project_id: p.project_id, version_key: p.version_key, usd_policy_id: usdPolicy, token: p.token,
    attached_usd: p.attached_usd, input_data: p.input_data,
    max_instructions: integer(p.max_instructions, 1, 500_000_000_000, 'instruction limit'),
    max_memory_mb: integer(p.max_memory_mb, 1, 4096, 'memory limit'),
    max_execution_seconds: integer(p.max_execution_seconds, 1, 180, 'time limit') };
  const route = { project, route_revision: integer(value.route.route_revision, 1, Number.MAX_SAFE_INTEGER, 'route revision'),
    native_policy_revision: integer(value.route.native_policy_revision, 1, Number.MAX_SAFE_INTEGER, 'native policy revision'),
    usd_policy_revision: integer(value.route.usd_policy_revision, 1, Number.MAX_SAFE_INTEGER, 'prepaid policy revision'),
    native_payee_revision: integer(value.route.native_payee_revision, 1, Number.MAX_SAFE_INTEGER, 'native payee revision'),
    usd_payee_revision: integer(value.route.usd_payee_revision, 1, Number.MAX_SAFE_INTEGER, 'prepaid payee revision'), active: value.route.active };
  if (route.active !== true) throw new Error('project route is not active');
  const amount = unsigned(value.amount, 'maximum NEAR deposit');
  if (amount === 0n) throw new Error('maximum NEAR deposit must be positive');
  return { id, contract_id: value.contract_id, owner_account_id: value.owner_account_id, native_policy_id: nativePolicy,
    amount: amount.toString(), route, expected_author: value.expected_author };
}
const fingerprint = goal => crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
const signedArgs = goal => ({ native_policy_id: goal.native_policy_id, amount: goal.amount, expected_route: goal.route });
function decode(value, label, limit = 16_384, reviver) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8'), reviver); } catch { throw new Error(`invalid ${label}`); }
}

// Node 22's source context preserves an integer's original JSON spelling. A
// plain JSON.parse rounds most u64s; comparing rounded doubles could accept a
// neighboring wrong checksum. Reject runtimes without source context and every
// non-canonical, signed, fractional, quoted or out-of-range checksum.
function losslessChecksum(key, value, context) {
  if (key !== 'checksum') return value;
  const source = context?.source;
  if (typeof value !== 'number' || typeof source !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(source) ||
      BigInt(source) > (1n << 64n) - 1n) throw new Error('invalid checksum');
  return source;
}
function successful(status) {
  return status && typeof status === 'object' && !Array.isArray(status) && status.Failure === undefined &&
    ((typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined) ||
      (typeof status.SuccessReceiptId === 'string' && status.SuccessValue === undefined));
}
function actionReceipt(receipt, predecessor, receiver) {
  return receipt?.predecessor_id === predecessor && receipt?.receiver_id === receiver &&
    Array.isArray(receipt.receipt?.Action?.actions) ? receipt.receipt.Action.actions : null;
}
function events(result, name) {
  const found = [];
  for (const receipt of result.receipts_outcome) {
    if (receipt?.outcome?.executor_id !== OUTLAYER) continue;
    for (const log of receipt.outcome.logs || []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:') || log.length > 32_768) continue;
      try {
        const event = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (event.standard === 'near-outlayer' && event.event === name && Array.isArray(event.data)) {
          for (const data of event.data) found.push({ data, outcome: receipt.outcome, receiptId: receipt.id });
        }
      } catch { /* unrelated logs are not proof */ }
    }
  }
  return found;
}

/** Verify the provider's paid probe result, not its TEE or independent HTTP truth. */
export function verifyProjectResult(rawGoal, result, publicKey) {
  const goal = validateProjectGoal(rawGoal), p = goal.route.project, terms = probeTerms(p), tx = result?.transaction, hash = result?.transaction_outcome?.id;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' || !validHash(hash)) throw new Error('transaction is not a successful FINAL result');
  if (!tx || tx.hash !== hash || tx.signer_id !== goal.owner_account_id || tx.receiver_id !== goal.contract_id ||
      (publicKey !== undefined && tx.public_key !== String(publicKey)) || !Array.isArray(tx.actions) || tx.actions.length !== 1) throw new Error('transaction owner, contract or key mismatch');
  const signed = tx.actions[0]?.FunctionCall;
  if (!signed || signed.method_name !== 'execute_outlayer_project' || String(signed.deposit) !== '0' ||
      !equal(decode(signed.args, 'signed project arguments'), signedArgs(goal))) throw new Error('signed project does not match the reviewed goal');
  if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length || result.receipts_outcome.some(r => !successful(r?.outcome?.status)) || !Array.isArray(result.receipts)) throw new Error('receipt outcomes failed, incomplete or missing');
  const outcomeIds = result.receipts_outcome.map(r => r?.id), receiptIds = result.receipts.map(r => r?.receipt_id);
  if (outcomeIds.some(id => !validHash(id)) || new Set(outcomeIds).size !== outcomeIds.length ||
      receiptIds.some(id => !validHash(id)) || new Set(receiptIds).size !== receiptIds.length) throw new Error('duplicate or invalid receipt identifiers');
  const initiations = result.receipts_outcome.filter(r => r.outcome?.executor_id === goal.contract_id &&
    r.outcome.logs?.includes('BOUNCER independent paid project initiated; native and prepaid maxima reserved'));
  if (initiations.length !== 1) throw new Error('missing guarded project initiation');
  const requests = result.receipts.flatMap(receipt => {
    const actions = actionReceipt(receipt, goal.contract_id, OUTLAYER);
    return actions?.length === 1 && actions[0]?.FunctionCall?.method_name === 'request_execution' ? [{ receipt, call: actions[0].FunctionCall }] : [];
  });
  if (requests.length !== 1 || String(requests[0].call.deposit) !== goal.amount ||
      !result.receipts_outcome.some(r => r.id === requests[0].receipt.receipt_id && successful(r.outcome?.status))) throw new Error('missing exact Bouncer-to-OutLayer request');
  const args = decode(requests[0].call.args, 'provider project arguments');
  if (!equal(args.source, { Project: { project_id: p.project_id, version_key: p.version_key } }) ||
      !equal(args.resource_limits, { max_instructions: p.max_instructions, max_memory_mb: p.max_memory_mb, max_execution_seconds: p.max_execution_seconds }) ||
      args.input_data !== p.input_data || args.payer_account_id !== goal.owner_account_id || args.response_format !== 'Json' || args.secrets_ref !== null ||
      !equal(args.params, { attached_usd: p.attached_usd })) throw new Error('provider receipt does not match the approved project, input, fee and limits');
  const requested = events(result, 'execution_requested').filter(({ data, receiptId }) => {
    if (receiptId !== requests[0].receipt.receipt_id) return false;
    try {
      const request = JSON.parse(data.request_data);
      return request.sender_id === goal.owner_account_id && request.predecessor_id === goal.contract_id &&
        request.payment === goal.amount && request.attached_usd === p.attached_usd && request.project_id === p.project_id &&
        request.input_data === p.input_data && request.code_source?.WasmUrl?.hash === p.version_key &&
        request.code_source?.WasmUrl?.build_target === 'wasm32-wasip2';
    } catch { return false; }
  });
  const completed = events(result, 'execution_completed').filter(({ data, outcome }) => data?.success === true &&
    data.sender_id === goal.owner_account_id && data.code_source?.WasmUrl?.hash === p.version_key &&
    outcome.status?.SuccessValue === result.status.SuccessValue);
  if (requested.length !== 1 || completed.length !== 1 || !equal(requested[0].data && JSON.parse(requested[0].data.request_data).code_source, completed[0].data.code_source)) {
    throw new Error('missing matching provider request and successful completion');
  }
  // The project's current on-chain row is checked before sending, and this
  // transaction's provider log must confirm the exact operation-specific
  // fee split. OutLayer remains trusted and can change its pricing in between.
  const authorCut = BigInt(p.attached_usd) * BigInt(terms.developerShareBp) / 10_000n;
  const ownerCut = BigInt(p.attached_usd) - authorCut;
  const split = `Split ${p.attached_usd} stablecoin for project ${PROJECT}: ${authorCut} to author ${goal.expected_author}, ${ownerCut} to owner connectors.outlayer.testnet (attached=${p.attached_usd}, refund=0)`;
  if (!completed[0].outcome.logs?.includes(split)) throw new Error('missing matching provider prepaid-fee settlement');
  const charge = unsigned(completed[0].data.payment_charged, 'NEAR charge');
  const refund = unsigned(completed[0].data.payment_refunded, 'NEAR refund');
  if (charge === 0n || charge + refund !== BigInt(goal.amount)) throw new Error('native charge and refund do not reconcile');
  if (refund > 0n) {
    const transfers = result.receipts.filter(receipt => {
      const actions = actionReceipt(receipt, OUTLAYER, goal.owner_account_id);
      return actions?.length === 1 && String(actions[0]?.Transfer?.deposit) === refund.toString() &&
        result.receipts_outcome.some(r => r.id === receipt.receipt_id && successful(r.outcome?.status));
    });
    if (transfers.length !== 1) throw new Error('native refund to owner not confirmed');
  }
  const output = decode(result.status.SuccessValue, 'provider output', 4096, terms.operation === 'burn' ? losslessChecksum : undefined);
  if (!output || typeof output !== 'object' || Array.isArray(output) || output.ok !== true || output.operation !== terms.operation) throw new Error('provider did not deliver the expected connector-probe result');
  let verifiedResult, verification;
  if (terms.operation === 'burn') {
    if (output.rounds_done !== terms.rounds || output.checksum !== expectedBurnChecksum(terms.rounds)) {
      throw new Error('provider did not deliver the expected independently recomputed burn checksum');
    }
    verifiedResult = { operation: 'burn', rounds_done: terms.rounds, hashes: terms.rounds * 1_000, checksum: output.checksum };
    verification = 'trusted RPC and OutLayer receipts; deterministic checksum independently recomputed; no proof of execution location or TEE';
  } else {
    if (!Number.isSafeInteger(output.http_status) || output.http_status < 100 || output.http_status > 599) throw new Error('provider did not deliver the expected connectivity-probe result');
    verifiedResult = { operation: 'fetch', http_status: output.http_status };
    verification = 'trusted RPC and OutLayer receipts; connector-probe status only; no independent HTTP or TEE proof';
  }
  return { tx_hash: hash, provider: OUTLAYER, project: PROJECT, version_key: p.version_key, asset: TOKEN,
    prepaid_charged: p.attached_usd, author: goal.expected_author, maximum_yocto: goal.amount,
    near_charged: charge.toString(), near_refunded_to_owner: refund.toString(), result: verifiedResult, verification };
}

export async function recoverProjectGoal({ goal: rawGoal, provider, journal, publicKey, update = true, log = console.log }) {
  const goal = validateProjectGoal(rawGoal);
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('recovery requires the original journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const previous = journal.get(goal.id);
  if (!previous || previous.fingerprint !== fingerprint(goal)) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (!validHash(previous.tx_hash)) throw new Error(`${goal.id}: missing transaction hash; reconcile manually, never resend automatically`);
  const signedBy = previous.agent_public_key;
  if (typeof signedBy !== 'string' || !signedBy || (publicKey && signedBy !== String(publicKey))) throw new Error(`${goal.id}: journal signing key mismatch`);
  const chain = await provider.txStatusReceipts(previous.tx_hash, goal.owner_account_id, 'FINAL');
  const delivery = verifyProjectResult(goal, chain, signedBy);
  if (delivery.tx_hash !== previous.tx_hash) throw new Error(`${goal.id}: RPC returned a different transaction`);
  if (previous.status === 'completed' && !equal(previous.delivery, delivery)) throw new Error(`${goal.id}: recorded delivery differs from chain`);
  if (update && previous.status !== 'completed') journal.put(goal.id, { ...previous, status: 'completed', delivery, completed_at: new Date().toISOString() });
  log(`[project] REUSED ${goal.id}: ${delivery.tx_hash}; no new payment`);
  return { status: 'REUSED', delivery };
}

export async function runProjectGoal({ goal: rawGoal, provider, account, publicKey, journal, execute = false, log = console.log }) {
  const goal = validateProjectGoal(rawGoal), p = goal.route.project;
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('agent key account does not match owner');
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live execution requires a journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  const [version, owner, access] = await Promise.all([provider.callFunction(goal.contract_id, 'contract_version', {}, final),
    provider.callFunction(goal.contract_id, 'get_owner', {}, final), provider.viewAccessKey(goal.owner_account_id, publicKey, final)]);
  if (!['bouncer-agent-v7', 'bouncer-agent-v8', 'bouncer-agent-v9'].includes(version) || owner !== goal.owner_account_id) throw new Error('unsupported Bouncer version or unexpected owner');
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !equal(permission.method_names, ['execute_outlayer_project'])) throw new Error('agent key must be scoped ONLY to execute_outlayer_project on this contract');
  const previous = journal?.get(goal.id), hash = fingerprint(goal);
  if (previous && previous.fingerprint !== hash) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (previous) return recoverProjectGoal({ goal, provider, journal, publicKey, log });
  const [route, nativePolicy, usdPolicy, nativeGrant, usdGrant, verdict, credit, usdSpent, configuredToken, pricing, versionInfo] = await Promise.all([
    provider.callFunction(goal.contract_id, 'get_outlayer_project', { native_policy_id: goal.native_policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.native_policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: p.usd_policy_id }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.native_policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: p.usd_policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.native_policy_id, payee: OUTLAYER, amount: goal.amount }, final),
    provider.callFunction(goal.contract_id, 'outlayer_prepaid_balance', { token: p.token }, final),
    provider.callFunction(goal.contract_id, 'daily_spent', { policy_id: p.usd_policy_id }, final),
    provider.callFunction(OUTLAYER, 'get_payment_token_contract', {}, final),
    provider.callFunction(OUTLAYER, 'get_project_pricing', { project_id: p.project_id }, final),
    provider.callFunction(OUTLAYER, 'get_version', { project_id: p.project_id, version_key: p.version_key }, final),
  ]);
  if (!equal(route, goal.route) || nativePolicy?.token !== 'native' || usdPolicy?.token !== p.token || nativeGrant !== true || usdGrant !== true) throw new Error('project route, policies or key grants changed');
  const usd = BigInt(p.attached_usd), max = unsigned(usdPolicy.per_tx_cap, 'prepaid cap'), daily = unsigned(usdPolicy.daily_cap, 'prepaid daily cap');
  const available = unsigned(credit, 'prepaid credit');
  if (usd > max || (daily > 0n && unsigned(usdSpent, 'prepaid spend') + usd > daily)) {
    log(`[project] BLOCKED ${goal.id}: prepaid cap or rolling budget`); return { status: 'BLOCKED' };
  }
  assertProjectRegistry({ project: p, expectedAuthor: goal.expected_author, configuredToken, pricing, versionInfo });
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid native policy verdict');
  if (!verdict[0]) { log(`[project] BLOCKED ${goal.id}: ${String(verdict[1]).slice(0, 200)}`); return { status: 'BLOCKED' }; }
  if (available < usd) {
    if (!execute) {
      log(`[project] FUNDING REQUIRED ${goal.id}: shortfall ${usd - available} test-token units; no payment sent`);
      return { status: 'FUNDING_REQUIRED', shortfall: (usd - available).toString() };
    }
    log(`[project] BLOCKED ${goal.id}: insufficient recorded prepaid credit`); return { status: 'BLOCKED' };
  }
  if (!execute) { log(`[project] READY ${goal.id}: native <=${goal.amount}, fake test USD=${p.attached_usd} (dry run)`); return { status: 'READY' }; }
  if (!account.signer || typeof account.createTransaction !== 'function' || String(await account.signer.getPublicKey()) !== String(publicKey)) throw new Error('signer does not match reviewed key');
  const action = transactions.functionCall('execute_outlayer_project', signedArgs(goal), GAS, 0n);
  const transaction = await account.createTransaction(goal.contract_id, [action], publicKey);
  const [bytes, signed] = await account.signer.signTransaction(transaction);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32 || !signed) throw new Error('signer did not return a transaction hash');
  const txHash = utils.serialize.base_encode(bytes);
  if (!validHash(txHash)) throw new Error('invalid transaction hash');
  const pending = { fingerprint: hash, status: 'pending', project_goal: goal, agent_public_key: String(publicKey), tx_hash: txHash, started_at: new Date().toISOString() };
  journal.put(goal.id, pending);
  try {
    const sent = await provider.sendTransactionUntil(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different or missing transaction hash');
    const chain = await provider.txStatusReceipts(txHash, goal.owner_account_id, 'FINAL');
    const delivery = verifyProjectResult(goal, chain, publicKey);
    if (delivery.tx_hash !== txHash) throw new Error('RPC returned a different transaction');
    journal.put(goal.id, { ...pending, status: 'completed', delivery, completed_at: new Date().toISOString() });
    log(`[project] FULFILLED ${goal.id}: ${txHash}; fake test USD=${delivery.prepaid_charged}; result=${JSON.stringify(delivery.result)}`);
    return { status: 'FULFILLED', delivery };
  } catch (error) {
    throw new Error(`${goal.id}: paid project unresolved (tx ${txHash}); do not resend automatically: ${error.message}`, { cause: error });
  }
}
function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') options.execute = true;
    else if (args[i] === '--recover') options.recover = true;
    else if (args[i] === '--help') options.help = true;
    else if (['--goal', '--key', '--state', '--rpc'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/outlayer-project.mjs --goal GOAL.json --key AGENT_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('       node bouncer/agent/outlayer-project.mjs --goal GOAL.json --state JOURNAL.json [--rpc URL] --recover');
    console.log('A narrowly pinned paid testnet fetch or diagnostic burn probe; dry run by default. Recovery needs no key and never resends.'); return;
  }
  if (!options.goal || (!options.recover && !options.key)) throw new Error('provide --goal and --key, or --goal with --recover');
  if (options.recover && (options.execute || options.key)) throw new Error('--recover cannot be combined with --execute or --key');
  const goalPath = path.resolve(home(options.goal)), goal = validateProjectGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const provider = new providers.JsonRpcProvider({ url: validateRpcEndpoint(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  const state = path.resolve(home(options.state || `${goalPath}.bouncer-journal.json`));
  if (options.recover && !fs.existsSync(state)) throw new Error('original journal not found; recovery cannot create one');
  const journal = options.execute || options.recover ? new FileJournal(state, goal.contract_id, goal.owner_account_id) : null;
  try {
    let outcome;
    if (options.recover) outcome = await recoverProjectGoal({ goal, provider, journal });
    else {
      const file = JSON.parse(fs.readFileSync(home(options.key), 'utf8'));
      if (file.account_id !== goal.owner_account_id || typeof file.private_key !== 'string') throw new Error('agent key file does not match owner');
      const key = KeyPair.fromString(file.private_key), account = new MonotonicAccount(goal.owner_account_id, provider, new KeyPairSigner(key));
      outcome = await runProjectGoal({ goal, provider, account, publicKey: key.getPublicKey(), journal, execute: options.execute });
    }
    if (outcome.delivery) console.log(JSON.stringify(outcome.delivery, null, 2));
    if (outcome.status === 'BLOCKED' || outcome.status === 'FUNDING_REQUIRED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[project] ERROR: ${error.message}`); process.exitCode = 1; });
}
