#!/usr/bin/env node
/**
 * Buy a bounded, owner-pinned single-source price lookup from OutLayer on NEAR
 * testnet. Bouncer v9 pins a project version, input, revisions and maximum
 * native spend on chain; a function-call key is scoped ONLY to that method.
 * The journal persists the signed hash before the single broadcast. Recovery
 * uses only public chain evidence and never signs or retries a payment.
 *
 * We trust the configured RPC, OutLayer and the external market-data source.
 * The returned timestamp is the worker's request time, not authenticated
 * market-data freshness; no TEE attestation, price accuracy, consensus or
 * suitability for trading is verified. Testnet NEAR has no real value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { openConfiguredFileJournal } from './procurement.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { normalizeProgram, verifyOutlayerEvidence, OUTLAYER, NATIVE } from './outlayer.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertJournalScope } from './journal-write.mjs';
import { readNativeJournal, writeConfirmedNativeJournal, assertNativeJournalUnchanged } from './synchronous-native-journal.mjs';
import { validateNativeBroadcastGuard, checkNativeBroadcastGuard } from './native-broadcast-guard.mjs';

const { KeyPair, KeyPairSigner } = nearApi;
const HASH = '3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0';
// Independently published project version observed in the testnet registry;
// its WasmUrl is pinned, not followed through the mutable active-version view.
export const ORACLE_TESTNET_PROGRAM = Object.freeze({
  url: `https://wasmhub.testnet.fastfs.io/fastfs.testnet/${HASH}.wasm`, sha256: HASH,
  build_target: 'wasm32-wasip2', max_instructions: 10_000_000_000, max_memory_mb: 256, max_execution_seconds: 60,
});
export const ORACLE_NEAR_INPUT = Object.freeze({ command: 'fetch_external', token_id: 'near', source: 'coingecko' });
// One explicitly reviewed public source, not an agent-supplied URL. The
// deployed oracle parses only data.amount and labels the output "custom";
// neither the full Coinbase response nor market freshness is authenticated.
export const ORACLE_COINBASE_NEAR_INPUT = Object.freeze({ command: 'fetch_external', token_id: 'near', source: Object.freeze({
  custom: Object.freeze({ url: 'https://api.coinbase.com/v2/prices/NEAR-USD/spot', json_path: 'data.amount', value_type: 'number', method: 'GET' }),
}) });
export const ORACLE_PROJECT_ID = 'zavodil2.testnet/price-oracle';
export const ORACLE_PROJECT_UUID = 'p0000000000000007';
export const ORACLE_TESTNET_PROJECT = Object.freeze({ project_id: ORACLE_PROJECT_ID, version_key: HASH,
  input_data: JSON.stringify(ORACLE_COINBASE_NEAR_INPUT), max_instructions: ORACLE_TESTNET_PROGRAM.max_instructions,
  max_memory_mb: ORACLE_TESTNET_PROGRAM.max_memory_mb, max_execution_seconds: ORACLE_TESTNET_PROGRAM.max_execution_seconds });
const APPROVED = new Map([
  ['coingecko', new Set(['near', 'bitcoin', 'ethereum'])],
  ['binance', new Set(['NEARUSDT', 'BTCUSDT', 'ETHUSDT'])],
]);
const MAX_U128 = (1n << 128n) - 1n, GAS = 300n * 10n ** 12n;
const FIELDS = ['id', 'contract_id', 'owner_account_id', 'policy_id', 'amount', 'route', 'max_age_seconds'];
const ROUTE = ['project', 'route_revision', 'policy_revision', 'payee_revision', 'active'];
const PROJECT = ['project_id', 'version_key', 'input_data', 'max_instructions', 'max_memory_mb', 'max_execution_seconds'];
const equal = isDeepStrictEqual;
const ownKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
const validHash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(value);
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error(`invalid ${label}`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${label}`);
  return value;
}
function unsigned(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > MAX_U128) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function parseInput(value) {
  text(value, 'pinned oracle input', 4096);
  let input;
  try { input = JSON.parse(value); } catch { throw new Error('invalid pinned oracle input JSON'); }
  const approvedBuiltin = typeof input?.source === 'string' && typeof input?.token_id === 'string' &&
    APPROVED.get(input.source)?.has(input.token_id);
  const approvedCoinbase = input?.token_id === 'near' && equal(input?.source, ORACLE_COINBASE_NEAR_INPUT.source);
  if (!ownKeys(input, ['command', 'token_id', 'source']) || input.command !== 'fetch_external' ||
      (!approvedBuiltin && !approvedCoinbase) || JSON.stringify(input) !== value) {
    throw new Error('only an exact canonical, approved single-source price request is supported');
  }
  return input;
}

/** Validate the complete owner-reviewed route and bounded lookup. */
export function validateOracleGoal(value) {
  if (!ownKeys(value, FIELDS) || !ownKeys(value.route, ROUTE) || !ownKeys(value.route.project, PROJECT)) throw new Error('oracle goal must contain exactly the reviewed fields');
  const id = text(value.id, 'goal id', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid goal id');
  if (!isTestnetAccount(value.contract_id) || !isTestnetAccount(value.owner_account_id)) throw new Error('only named NEAR testnet accounts are supported');
  const policy = text(value.policy_id, 'policy id', 128), amount = unsigned(value.amount, 'maximum deposit');
  if (amount === 0n) throw new Error('maximum deposit must be positive');
  const p = value.route.project;
  if (p.project_id !== ORACLE_PROJECT_ID || p.version_key !== HASH) throw new Error('oracle project is not the explicitly reviewed testnet version');
  parseInput(p.input_data);
  const project = { project_id: p.project_id, version_key: p.version_key, input_data: p.input_data,
    max_instructions: integer(p.max_instructions, 1, 500_000_000_000, 'instruction limit'),
    max_memory_mb: integer(p.max_memory_mb, 1, 4096, 'memory limit'),
    max_execution_seconds: integer(p.max_execution_seconds, 1, 180, 'time limit') };
  const route = { project,
    route_revision: integer(value.route.route_revision, 1, Number.MAX_SAFE_INTEGER, 'route revision'),
    policy_revision: integer(value.route.policy_revision, 1, Number.MAX_SAFE_INTEGER, 'policy revision'),
    payee_revision: integer(value.route.payee_revision, 1, Number.MAX_SAFE_INTEGER, 'payee revision'), active: value.route.active };
  if (route.active !== true) throw new Error('pinned oracle route is not active');
  return { id, contract_id: value.contract_id, owner_account_id: value.owner_account_id, policy_id: policy,
    amount: amount.toString(), route, max_age_seconds: integer(value.max_age_seconds, 1, 900, 'maximum result age') };
}
const fingerprint = goal => crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
const signedArgs = goal => ({ policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route });
const commonGoal = goal => ({ ...goal, input: parseInput(goal.route.project.input_data), program: normalizeProgram({
  ...ORACLE_TESTNET_PROGRAM, max_instructions: goal.route.project.max_instructions,
  max_memory_mb: goal.route.project.max_memory_mb, max_execution_seconds: goal.route.project.max_execution_seconds,
}) });

function validatePrice(input, output) {
  const permitted = new Set(['success', 'token_id', 'source', 'price_usd', 'timestamp', 'warning']);
  const expectedSource = typeof input.source === 'string' ? input.source : 'custom';
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some(k => !permitted.has(k)) ||
      output.success !== true || output.token_id !== input.token_id || output.source !== expectedSource ||
      typeof output.price_usd !== 'number' || !Number.isFinite(output.price_usd) || output.price_usd <= 0 ||
      !Number.isSafeInteger(output.timestamp) || output.timestamp <= 0 ||
      (output.warning !== undefined && (typeof output.warning !== 'string' || Buffer.byteLength(output.warning) > 512))) {
    throw new Error('provider did not deliver the requested positive single-source price');
  }
}

/**
 * Verify the transaction/receipts and worker timestamp against the historical
 * block in which OutLayer completed. This remains deterministic on recovery;
 * it does not assert the market observation itself was fresh or accurate.
 */
export async function verifyOracleResult(rawGoal, chain, publicKey, provider) {
  const goal = validateOracleGoal(rawGoal), common = commonGoal(goal);
  const evidence = verifyOutlayerEvidence(common, chain, publicKey, 'execute_outlayer_native_project', signedArgs(goal),
    { id: goal.route.project.project_id, version: goal.route.project.version_key, uuid: ORACLE_PROJECT_UUID });
  validatePrice(common.input, evidence.result);
  const blockHash = evidence.completion_block_hash;
  if (!validHash(blockHash) || !provider || typeof provider.block !== 'function') throw new Error('missing provider completion block evidence');
  const block = await provider.block({ blockId: blockHash });
  const timestamp = block?.header?.timestamp_nanosec;
  if (block?.header?.hash !== blockHash || typeof timestamp !== 'string' || !/^[1-9][0-9]{0,20}$/.test(timestamp)) {
    throw new Error('RPC returned an invalid completion block');
  }
  const blockSec = BigInt(timestamp) / 1_000_000_000n, reported = BigInt(evidence.result.timestamp);
  if (reported > blockSec + 30n || reported + BigInt(goal.max_age_seconds) < blockSec) {
    throw new Error('provider request timestamp is outside the reviewed settlement window');
  }
  return { ...evidence, completion_block_timestamp: blockSec.toString(), max_age_seconds: goal.max_age_seconds,
    verification: 'trusted RPC and provider receipts; worker timestamp checked at settlement; single source, no TEE attestation or market-data accuracy proof' };
}

/** Check again before *using* a historical result; recovery alone does not make it fresh. */
export function assertOracleFreshForUse(delivery, nowSeconds = Math.floor(Date.now() / 1000)) {
  const observed = delivery?.result?.timestamp, maxAge = delivery?.max_age_seconds;
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(observed) || !Number.isSafeInteger(maxAge) ||
      maxAge < 1 || maxAge > 900 || observed > nowSeconds + 30 || observed + maxAge < nowSeconds) {
    throw new Error('oracle result is too old or in the future for use');
  }
  return delivery;
}

/** Key-free recovery by the original signed transaction hash, never a send. */
async function recoverOracleGoalUnlocked({ goal: rawGoal, provider, journal, publicKey, update = true, log = console.log }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate oracle payments');
  const goal = validateOracleGoal(rawGoal);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('recovery requires the original journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const existing = readNativeJournal(journal, goal.id), previous = existing ? structuredClone(existing) : existing;
  if (!previous || previous.fingerprint !== fingerprint(goal)) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (!['pending', 'completed'].includes(previous.status)) throw new Error(`${goal.id}: invalid journal status; stop and reconcile`);
  if (!validHash(previous.tx_hash)) throw new Error(`${goal.id}: unresolved payment without a transaction hash; reconcile manually, never resend automatically`);
  const signedBy = previous.agent_public_key || (publicKey && String(publicKey));
  if (typeof signedBy !== 'string' || !signedBy) throw new Error(`${goal.id}: original signing public key is required for recovery`);
  if (publicKey && signedBy !== String(publicKey)) throw new Error(`${goal.id}: journal signing key differs from the supplied key`);
  const chain = await provider.txStatusReceipts(previous.tx_hash, goal.owner_account_id, 'FINAL');
  const delivery = await verifyOracleResult(goal, chain, signedBy, provider);
  if (delivery.tx_hash !== previous.tx_hash) throw new Error(`${goal.id}: RPC returned a different transaction`);
  if (previous.status === 'completed' && previous.delivery && !equal(previous.delivery, delivery)) throw new Error(`${goal.id}: recorded result differs from chain evidence`);
  if (update && previous.status !== 'completed') writeConfirmedNativeJournal(journal, goal.id,
    { ...previous, status: 'completed', delivery, completed_at: new Date().toISOString() }, previous);
  log(`[oracle] REUSED ${goal.id}: ${delivery.tx_hash}; no new payment`);
  return { status: 'REUSED', delivery };
}

// Fail closed if the public registry no longer resolves the reviewed version to
// the expected project namespace, bytecode hash and native-only pricing. This
// is a non-atomic view of an independent provider, not a code attestation.
export async function assertOracleProjectRegistry(provider) {
  const final = { finality: 'final' };
  const [project, projectVersion, pricing] = await Promise.all([
    provider.callFunction(OUTLAYER, 'get_project', { project_id: ORACLE_PROJECT_ID }, final),
    provider.callFunction(OUTLAYER, 'get_version', { project_id: ORACLE_PROJECT_ID, version_key: HASH }, final),
    provider.callFunction(OUTLAYER, 'get_project_pricing', { project_id: ORACLE_PROJECT_ID }, final),
  ]);
  const p = ORACLE_TESTNET_PROGRAM;
  if (project?.project_id !== ORACLE_PROJECT_ID || project?.uuid !== ORACLE_PROJECT_UUID || project?.owner !== 'zavodil2.testnet' ||
      projectVersion?.wasm_hash !== HASH || !equal(projectVersion?.source, { WasmUrl: { url: p.url, hash: p.sha256, build_target: p.build_target } }) || pricing !== null) {
    throw new Error('independent project identity, pinned source or native-only pricing changed');
  }
}

/** Dry-run or sign one exact-input request after on-chain policy preflight. */
async function runOracleGoalUnlocked({ goal: rawGoal, provider, account, publicKey, journal, execute = false, log = console.log, beforeBroadcast }) {
  validateNativeBroadcastGuard(beforeBroadcast);
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate oracle payments');
  const goal = validateOracleGoal(rawGoal);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('agent key account does not match the owner');
  if (account.requiresWitnessedOriginal === true && typeof account.assertWitnessedOriginal !== 'function') {
    throw new Error('witnessed phone account requires original-hash verification');
  }
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live execution requires a journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  const [version, owner, access] = await Promise.all([
    provider.callFunction(goal.contract_id, 'contract_version', {}, final), provider.callFunction(goal.contract_id, 'get_owner', {}, final),
    provider.viewAccessKey(goal.owner_account_id, publicKey, final),
  ]);
  if (!['bouncer-agent-v9', 'bouncer-agent-v14-native-storage-testnet'].includes(version) || owner !== goal.owner_account_id) {
    throw new Error('pinned oracle requires supported Bouncer v9/V14 and the reviewed owner');
  }
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !equal(permission.method_names, ['execute_outlayer_native_project'])) {
    throw new Error('agent key must be scoped ONLY to execute_outlayer_native_project on this contract');
  }
  const fp = fingerprint(goal), previous = journal ? readNativeJournal(journal, goal.id) : undefined;
  if (previous && previous.fingerprint !== fp) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (previous) return recoverOracleGoalUnlocked({ goal, provider, journal, publicKey, update: execute, log });
  const [policy, route, allowed, verdict] = await Promise.all([
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_outlayer_native_project', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.policy_id, payee: OUTLAYER, amount: goal.amount }, final),
    assertOracleProjectRegistry(provider),
  ]);
  if (!policy || policy.token !== NATIVE || !equal(route, goal.route) || allowed !== true) throw new Error('policy, native asset, pinned route or key grant does not match');
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid policy verdict');
  if (!verdict[0]) { log(`[oracle] BLOCKED ${goal.id}: ${String(verdict[1]).slice(0, 200)}`); return { status: 'BLOCKED' }; }
  if (!execute) { log(`[oracle] READY ${goal.id}: at most ${goal.amount} yoctoNEAR to ${OUTLAYER} (dry run)`); return { status: 'READY' }; }
  if (typeof provider.sendTransactionOnce !== 'function') throw new Error('live execution requires a bounded one-shot transaction transport');
  checkNativeBroadcastGuard(beforeBroadcast);
  const { txHash, signed } = await signReviewedCall({ account, publicKey, ownerId: goal.owner_account_id, contractId: goal.contract_id,
    method: 'execute_outlayer_native_project', args: signedArgs(goal), gas: GAS });
  if (!validHash(txHash)) throw new Error('signer returned an invalid transaction hash');
  const pending = { fingerprint: fp, status: 'pending', oracle_goal: goal, agent_public_key: String(publicKey),
    tx_hash: txHash, started_at: new Date().toISOString() };
  writeConfirmedNativeJournal(journal, goal.id, pending, null);
  if (account.requiresWitnessedOriginal === true) {
    // The independently retained original must still match after the local
    // write. Any lost acknowledgement or changed journal is reconciliation,
    // never a reason to send or sign a replacement.
    const witnessed = await account.assertWitnessedOriginal(txHash), current = readNativeJournal(journal,goal.id);
    if (witnessed?.status !== 'WITNESSED_ORIGINAL_MATCH' || witnessed.owner !== goal.owner_account_id ||
        witnessed.original_hash !== txHash || !/^[a-f0-9]{40}$/.test(witnessed.witness_head ?? '') ||
        !current || current.status !== pending.status || current.fingerprint !== pending.fingerprint ||
        current.tx_hash !== pending.tx_hash || current.agent_public_key !== pending.agent_public_key || !equal(current.oracle_goal,pending.oracle_goal)) {
      throw new Error('witnessed native original changed or is uncertain; stop and reconcile');
    }
  }
  try {
    // Freshness and the original journal are rechecked after signing, fsync
    // and any witnessed-original verification, immediately before submission.
    checkNativeBroadcastGuard(beforeBroadcast);
    assertNativeJournalUnchanged(journal, goal.id, pending);
    // Exactly one submission; even an explicit expiry or timeout is not retried.
    const sent = await provider.sendTransactionOnce(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different or missing transaction hash');
    const chain = await provider.txStatusReceipts(txHash, goal.owner_account_id, 'FINAL');
    const delivery = await verifyOracleResult(goal, chain, publicKey, provider);
    if (delivery.tx_hash !== txHash) throw new Error('RPC returned a different transaction');
    writeConfirmedNativeJournal(journal, goal.id, { ...pending, status: 'completed', delivery, completed_at: new Date().toISOString() }, pending);
    log(`[oracle] FULFILLED ${goal.id}: ${txHash}; charged ${delivery.charged_yocto}, owner refund ${delivery.refunded_to_owner_yocto} yoctoNEAR`);
    return { status: 'FULFILLED', delivery };
  } catch (error) {
    throw new Error(`${goal.id}: payment/delivery unresolved (tx ${txHash}); do not resend automatically: ${error.message}`, { cause: error });
  }
}

// Serialize every participating operation on this journal object, including
// read/recovery, before any async state checks or signing. The FileJournal
// lock covers other compliant processes opening the same file; neither layer
// protects different journals, restored backups or bypassing clients.
export async function recoverOracleGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => recoverOracleGoalUnlocked(options), options?.exclusiveJournalScope);
}
export async function runOracleGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => runOracleGoalUnlocked(options), options?.exclusiveJournalScope);
}

function expandHome(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--execute', '--recover', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--goal', '--key', '--state', '--rpc'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (options[arg.slice(2)]) throw new Error(`duplicate ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/oracle-outlayer.mjs --goal GOAL.json --key AGENT_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('       node bouncer/agent/oracle-outlayer.mjs --goal GOAL.json --state JOURNAL.json [--rpc URL] --recover');
    console.log('Dry run by default; --execute spends testnet NEAR once. --recover needs no NEAR signing key; encrypted file journals still require their separate key.');
    return;
  }
  if (!options.goal || (!options.recover && !options.key)) throw new Error('provide --goal and --key, or --goal with --recover; see --help');
  if (options.recover && (options.execute || options.key)) throw new Error('--recover cannot be combined with --execute or --key');
  const goalPath = path.resolve(expandHome(options.goal));
  const goal = validateOracleGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const state = path.resolve(expandHome(options.state || `${goalPath}.bouncer-journal.json`));
  // Observe an existing journal even in dry-run mode. If it disappeared
  // before the lock was acquired, requireExisting prevents a new history.
  const requireExisting = !!options.recover || fs.existsSync(state);
  const journal = options.execute || requireExisting
    ? openConfiguredFileJournal(state, goal.contract_id, goal.owner_account_id, { requireExisting }) : null;
  try {
    let outcome;
    if (options.recover) outcome = await recoverOracleGoal({ goal, provider, journal });
    else {
      const credentials = JSON.parse(fs.readFileSync(expandHome(options.key), 'utf8'));
      if (credentials.account_id !== goal.owner_account_id || typeof credentials.private_key !== 'string') throw new Error('agent key file does not match the owner');
      const key = KeyPair.fromString(credentials.private_key);
      const account = new MonotonicAccount(goal.owner_account_id, provider, new KeyPairSigner(key));
      outcome = await runOracleGoal({ goal, provider, account, publicKey: key.getPublicKey(), journal, execute: options.execute });
    }
    if (outcome.delivery) console.log(JSON.stringify(outcome.delivery, null, 2));
    if (outcome.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[oracle] ERROR: ${error.message}`); process.exitCode = 1; });
}
