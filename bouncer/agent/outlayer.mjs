#!/usr/bin/env node
/**
 * Owner-pinned OutLayer testnet randomness procurement. The NEAR deposit and
 * delivery are one cross-contract transaction through Bouncer v5, not x402.
 * A local journal records intent before the single send and never repays an
 * unresolved transaction. Chain evidence is checked against a trusted RPC;
 * range checking does not prove randomness or verify a TEE attestation.
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

const { KeyPair, KeyPairSigner, providers } = nearApi;
export const OUTLAYER = 'outlayer.testnet';
export const NATIVE = 'native';
const VERSION = 'bouncer-agent-v5';
const MAX_U128 = (1n << 128n) - 1n;
const GAS = 300n * 10n ** 12n;
const PROGRAM_KEYS = ['url', 'sha256', 'build_target', 'max_instructions', 'max_memory_mb', 'max_execution_seconds'];
const ownKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`invalid ${label}`);
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
function normalizeProgram(value) {
  if (!ownKeys(value, PROGRAM_KEYS)) throw new Error('program must contain exactly the owner-reviewed fields');
  const url = boundedString(value.url, 'program URL', 512);
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('invalid program URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || /[\x00-\x20\x7f]/.test(url)) throw new Error('invalid program URL');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('invalid program sha256');
  if (!['wasm32-wasip1', 'wasm32-wasip2'].includes(value.build_target)) throw new Error('invalid WASI target');
  return { url, sha256: value.sha256, build_target: value.build_target,
    max_instructions: integer(value.max_instructions, 1, 500_000_000_000, 'instruction limit'),
    max_memory_mb: integer(value.max_memory_mb, 1, 4096, 'memory limit'),
    max_execution_seconds: integer(value.max_execution_seconds, 1, 180, 'execution time limit') };
}

/** A bounded random-number task, not a general arbitrary-code execution API. */
export function validateOutlayerGoal(value) {
  const keys = ['id', 'contract_id', 'owner_account_id', 'policy_id', 'amount', 'input', 'program'];
  if (!ownKeys(value, keys)) throw new Error('goal must contain exactly id, contract_id, owner_account_id, policy_id, amount, input and program');
  const id = boundedString(value.id, 'goal id', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid goal id');
  if (!isTestnetAccount(value.contract_id) || !isTestnetAccount(value.owner_account_id)) throw new Error('only named NEAR testnet accounts are supported');
  const policy = boundedString(value.policy_id, 'policy id', 128);
  if (!ownKeys(value.input, ['min', 'max'])) throw new Error('random input must contain only min and max');
  const min = integer(value.input.min, 0, 1_000_000_000, 'random minimum');
  const max = integer(value.input.max, min, 1_000_000_000, 'random maximum');
  const amount = unsigned(value.amount, 'maximum deposit');
  if (amount === 0n) throw new Error('maximum deposit must be positive');
  return { id, contract_id: value.contract_id, owner_account_id: value.owner_account_id, policy_id: policy,
    amount: amount.toString(), input: { min, max }, program: normalizeProgram(value.program) };
}

const goalFingerprint = goal => crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
const expectedArgs = goal => ({ policy_id: goal.policy_id, amount: goal.amount, input_data: JSON.stringify(goal.input), expected_program: goal.program });
const equal = (a, b) => isDeepStrictEqual(a, b);
const validHash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(value);
function decodeJson(value, label, maxBytes = 16_384) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
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
  const out = [];
  for (const receipt of result.receipts_outcome) {
    if (receipt?.outcome?.executor_id !== OUTLAYER) continue;
    for (const log of receipt.outcome.logs || []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:') || log.length > 32_768) continue;
      try {
        const event = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (event.standard === 'near-outlayer' && event.event === name && Array.isArray(event.data)) {
          for (const data of event.data) out.push({ data, outcome: receipt.outcome });
        }
      } catch { /* Unrelated malformed logs are not evidence. */ }
    }
  }
  return out;
}

/**
 * Verify FINAL transaction and actual request/refund receipts against the exact
 * owner-reviewed order. This trusts the RPC and OutLayer contract. It does not
 * independently verify TEE attestation or the statistical quality of entropy.
 */
export function verifyOutlayerResult(rawGoal, result, publicKey) {
  const goal = validateOutlayerGoal(rawGoal);
  const tx = result?.transaction, txHash = result?.transaction_outcome?.id;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' || !validHash(txHash)) {
    throw new Error('transaction is not a successful FINAL result');
  }
  if (!tx || tx.hash !== txHash || tx.signer_id !== goal.owner_account_id || tx.receiver_id !== goal.contract_id ||
      (publicKey !== undefined && tx.public_key !== String(publicKey)) || !Array.isArray(tx.actions) || tx.actions.length !== 1) {
    throw new Error('transaction does not match the reviewed owner, contract and key');
  }
  const signed = tx.actions[0]?.FunctionCall;
  if (!signed || signed.method_name !== 'execute_outlayer' || String(signed.deposit) !== '0' ||
      !equal(decodeJson(signed.args, 'signed arguments'), expectedArgs(goal))) throw new Error('signed transaction does not match the reviewed goal');
  if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length ||
      result.receipts_outcome.some(r => !successful(r?.outcome?.status)) || !Array.isArray(result.receipts)) {
    throw new Error('receipt outcomes are failed, incomplete or missing');
  }
  if (!result.receipts_outcome.some(r => r.outcome?.executor_id === goal.contract_id &&
      r.outcome.logs?.includes('BOUNCER independent compute initiated; full maximum reserved'))) {
    throw new Error('missing Bouncer execution evidence');
  }
  const requests = result.receipts.flatMap(receipt => {
    const actions = actionReceipt(receipt, goal.contract_id, OUTLAYER);
    return actions?.length === 1 && actions[0]?.FunctionCall?.method_name === 'request_execution' ? [{ receipt, call: actions[0].FunctionCall }] : [];
  });
  if (requests.length !== 1 || String(requests[0].call.deposit) !== goal.amount ||
      !result.receipts_outcome.some(r => r.id === requests[0].receipt.receipt_id && successful(r.outcome?.status))) {
    throw new Error('missing exact Bouncer-to-OutLayer deposit receipt');
  }
  const args = decodeJson(requests[0].call.args, 'OutLayer arguments');
  const program = goal.program;
  if (!equal(args.source, { WasmUrl: { url: program.url, hash: program.sha256, build_target: program.build_target } }) ||
      !equal(args.resource_limits, { max_instructions: program.max_instructions, max_memory_mb: program.max_memory_mb,
        max_execution_seconds: program.max_execution_seconds }) || args.input_data !== JSON.stringify(goal.input) ||
      args.payer_account_id !== goal.owner_account_id || args.response_format !== 'Json' || args.secrets_ref !== null || args.params !== null) {
    throw new Error('OutLayer receipt does not match the pinned program, input, limits and owner refund');
  }
  const requested = events(result, 'execution_requested').filter(({ data }) => {
    try {
      const request = JSON.parse(data.request_data);
      return request.sender_id === goal.owner_account_id && request.predecessor_id === goal.contract_id &&
        request.payment === goal.amount && request.input_data === JSON.stringify(goal.input) &&
        equal(request.code_source?.WasmUrl, args.source.WasmUrl);
    } catch { return false; }
  });
  const completed = events(result, 'execution_completed').filter(({ data, outcome }) => data?.success === true &&
    data.sender_id === goal.owner_account_id && equal(data.code_source?.WasmUrl, args.source.WasmUrl) &&
    outcome.status?.SuccessValue === result.status.SuccessValue);
  if (requested.length !== 1 || completed.length !== 1) throw new Error('missing matching OutLayer request and successful completion');
  const event = completed[0].data;
  const charged = unsigned(event.payment_charged, 'provider charge');
  const refund = unsigned(event.payment_refunded, 'provider refund');
  const maximum = BigInt(goal.amount);
  if (charged === 0n || charged + refund !== maximum) throw new Error('provider charge and refund do not reconcile with the deposit');
  if (refund > 0n) {
    const transfers = result.receipts.filter(receipt => {
      const actions = actionReceipt(receipt, OUTLAYER, goal.owner_account_id);
      return actions?.length === 1 && String(actions[0]?.Transfer?.deposit) === refund.toString() &&
        result.receipts_outcome.some(r => r.id === receipt.receipt_id && successful(r.outcome?.status));
    });
    if (transfers.length !== 1) throw new Error('provider refund to the owner was not confirmed by a receipt');
  }
  const output = decodeJson(result.status.SuccessValue, 'provider result', 4096);
  if (!ownKeys(output, ['random_number']) || !Number.isSafeInteger(output.random_number) ||
      output.random_number < goal.input.min || output.random_number > goal.input.max) {
    throw new Error('provider result is not a random number inside the requested range');
  }
  return { tx_hash: txHash, provider: OUTLAYER, asset: 'NEAR', maximum_yocto: goal.amount,
    charged_yocto: charged.toString(), refunded_to_owner_yocto: refund.toString(), program_sha256: program.sha256,
    result: output, verification: 'trusted RPC and provider receipts; output range only; no TEE or randomness proof' };
}

/** Preflight, one guarded send, and chain-based recovery without resending. */
export async function runOutlayerGoal({ goal: rawGoal, provider, account, publicKey, journal, execute = false, log = console.log }) {
  const goal = validateOutlayerGoal(rawGoal);
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('agent key account does not match the owner');
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live execution requires a journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  const [version, owner, access] = await Promise.all([
    provider.callFunction(goal.contract_id, 'contract_version', {}, final),
    provider.callFunction(goal.contract_id, 'get_owner', {}, final),
    provider.viewAccessKey(goal.owner_account_id, publicKey, final),
  ]);
  if (version !== VERSION || owner !== goal.owner_account_id) throw new Error('unsupported Bouncer version or unexpected owner/refund account');
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !equal(permission.method_names, ['execute_outlayer'])) {
    throw new Error('agent key must be scoped ONLY to execute_outlayer on this contract');
  }
  const fingerprint = goalFingerprint(goal), previous = journal?.get(goal.id);
  if (previous && previous.fingerprint !== fingerprint) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (previous) {
    if (!validHash(previous.tx_hash)) throw new Error(`${goal.id}: unresolved payment without a transaction hash; reconcile manually, never resend automatically`);
    const chain = await provider.txStatusReceipts(previous.tx_hash, goal.owner_account_id, 'FINAL');
    const delivery = verifyOutlayerResult(goal, chain, publicKey);
    if (previous.status === 'completed' && previous.delivery && !equal(previous.delivery, delivery)) throw new Error(`${goal.id}: recorded result differs from chain evidence`);
    if (previous.status !== 'completed') journal.put(goal.id, { ...previous, status: 'completed', delivery, completed_at: new Date().toISOString() });
    log(`[outlayer] REUSED ${goal.id}: ${delivery.tx_hash}; no new payment`);
    return { status: 'REUSED', delivery };
  }
  const [policy, program, allowed, verdict] = await Promise.all([
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_outlayer_program', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: publicKey.toString() }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.policy_id, payee: OUTLAYER, amount: goal.amount }, final),
  ]);
  if (!policy || policy.token !== NATIVE || !equal(normalizeProgram(program), goal.program) || allowed !== true) {
    throw new Error('policy, native asset, approved program or key grant does not match the goal');
  }
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid policy verdict');
  if (!verdict[0]) { log(`[outlayer] BLOCKED ${goal.id}: ${String(verdict[1]).slice(0, 200)}`); return { status: 'BLOCKED' }; }
  if (!execute) { log(`[outlayer] READY ${goal.id}: at most ${goal.amount} yoctoNEAR to ${OUTLAYER} (dry run)`); return { status: 'READY' }; }
  const pending = { fingerprint, status: 'pending', outlayer_goal: goal, started_at: new Date().toISOString() };
  journal.put(goal.id, pending);
  let txHash;
  try {
    // Never retry this payment, including explicit expiry or a timeout.
    const sent = await account.callFunctionRaw({ contractId: goal.contract_id, methodName: 'execute_outlayer',
      args: expectedArgs(goal), deposit: 0n, gas: GAS, waitUntil: 'FINAL' });
    if (validHash(sent?.transaction_outcome?.id)) txHash = sent.transaction_outcome.id;
    if (!txHash) throw new Error('transaction did not return a valid hash');
    journal.put(goal.id, { ...pending, tx_hash: txHash });
    // Request raw receipts as well as outcomes; ordinary send_tx outcomes do
    // not establish the actual OutLayer refund transfer to the owner.
    const chain = await provider.txStatusReceipts(txHash, goal.owner_account_id, 'FINAL');
    const delivery = verifyOutlayerResult(goal, chain, publicKey);
    journal.put(goal.id, { ...pending, status: 'completed', tx_hash: txHash, delivery, completed_at: new Date().toISOString() });
    log(`[outlayer] FULFILLED ${goal.id}: ${txHash}; charged ${delivery.charged_yocto}, refund ${delivery.refunded_to_owner_yocto} yoctoNEAR`);
    return { status: 'FULFILLED', delivery };
  } catch (error) {
    if (!txHash && validHash(error?.transaction_outcome?.id)) {
      txHash = error.transaction_outcome.id;
      journal.put(goal.id, { ...pending, tx_hash: txHash });
    }
    throw new Error(`${goal.id}: payment/delivery unresolved${txHash ? ` (tx ${txHash})` : ''}; do not resend automatically: ${error.message}`, { cause: error });
  }
}

function expandHome(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = { execute: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execute') options.execute = true;
    else if (args[i] === '--help') options.help = true;
    else if (['--goal', '--key', '--state', '--rpc'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/outlayer.mjs --goal GOAL.json --key AGENT_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('Dry run by default; --execute spends testnet NEAR once through a v5 policy.');
    return;
  }
  if (!options.goal || !options.key) throw new Error('provide --goal and --key; see --help');
  const goalPath = path.resolve(expandHome(options.goal));
  const goal = validateOutlayerGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const keyFile = JSON.parse(fs.readFileSync(expandHome(options.key), 'utf8'));
  if (keyFile.account_id !== goal.owner_account_id || typeof keyFile.private_key !== 'string') throw new Error('agent key file does not match the owner');
  const key = KeyPair.fromString(keyFile.private_key);
  const provider = new providers.JsonRpcProvider({ url: validateRpcEndpoint(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  const account = new MonotonicAccount(goal.owner_account_id, provider, new KeyPairSigner(key));
  const state = path.resolve(expandHome(options.state || `${goalPath}.bouncer-journal.json`));
  const journal = options.execute ? new FileJournal(state, goal.contract_id, goal.owner_account_id) : null;
  try {
    const outcome = await runOutlayerGoal({ goal, provider, account, publicKey: key.getPublicKey(), journal, execute: options.execute });
    if (outcome.delivery) console.log(JSON.stringify(outcome.delivery, null, 2));
    if (outcome.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[outlayer] ERROR: ${error.message}`); process.exitCode = 1; });
}
