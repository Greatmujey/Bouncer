#!/usr/bin/env node
/**
 * A single owner-pinned NEP-141 transfer-call under Bouncer v6 or v7. This reports
 * token settlement ONLY: a receiver retaining tokens is not proof that it
 * delivered a storage/API/compute service. The exact action/message, receiver,
 * token and revisions must already have been approved on chain by the owner.
 *
 * A durable journal records the signed hash before the one broadcast. If any
 * send or receipt is uncertain, recover by hash without signing or resending.
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
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';

const { KeyPair, KeyPairSigner } = nearApi;
const MAX = (1n << 128n) - 1n;
const GAS = 300n * 10n ** 12n;
const FIELDS = ['id', 'contract_id', 'owner_account_id', 'policy_id', 'payee', 'token', 'amount', 'msg', 'policy_revision', 'route_revision'];
const equal = isDeepStrictEqual;
const owns = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));
const validHash = isTransactionHash;
function amount(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > MAX) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function text(value, label, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value) > max) throw new Error(`invalid ${label}`);
  return value;
}
function revision(value) { return Number.isSafeInteger(value) && value > 0; }
export function validateFtCallGoal(value) {
  if (!owns(value, FIELDS)) throw new Error('FT goal must contain exactly the owner-reviewed fields');
  const id = text(value.id, 'goal id', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid goal id');
  if (!isTestnetAccount(value.contract_id) || !isTestnetAccount(value.owner_account_id) || !isTestnetAccount(value.payee) ||
      !isTestnetToken(value.token)) throw new Error('only explicitly pinned testnet accounts and tokens are supported');
  const policy_id = text(value.policy_id, 'policy id', 128);
  const msg = text(value.msg, 'owner-pinned receiver message', 2048, true);
  if (!revision(value.policy_revision) || !revision(value.route_revision)) throw new Error('invalid route revision');
  const n = amount(value.amount, 'FT amount');
  if (!n) throw new Error('FT amount must be positive');
  return { id, contract_id: value.contract_id, owner_account_id: value.owner_account_id, policy_id,
    payee: value.payee, token: value.token, amount: n.toString(), msg,
    policy_revision: value.policy_revision, route_revision: value.route_revision };
}
const fingerprint = goal => crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
const expectedArgs = goal => ({ policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount,
  expected_token: goal.token, expected_msg: goal.msg, expected_policy_revision: goal.policy_revision,
  expected_route_revision: goal.route_revision });
function decode(value, label, limit = 16_384) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
}
function successful(status) {
  return status && typeof status === 'object' && !Array.isArray(status) && status.Failure === undefined &&
    ((typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined) ||
     (typeof status.SuccessReceiptId === 'string' && status.SuccessValue === undefined));
}
function actionReceipt(receipt, predecessor, receiver, name) {
  if (receipt?.predecessor_id !== predecessor || receipt?.receiver_id !== receiver) return null;
  const actions = receipt?.receipt?.Action?.actions;
  return Array.isArray(actions) && actions.length === 1 && actions[0]?.FunctionCall?.method_name === name ? actions[0].FunctionCall : null;
}

/** Check finalized chain receipts for settlement, not provider fulfillment. */
export function verifyFtCallSettlement(rawGoal, result, publicKey) {
  const goal = validateFtCallGoal(rawGoal);
  const tx = result?.transaction, hash = result?.transaction_outcome?.id;
  if (result?.final_execution_status !== 'FINAL' || typeof result.status?.SuccessValue !== 'string' ||
      result.status?.Failure !== undefined || result.status?.SuccessReceiptId !== undefined || !validHash(hash)) {
    throw new Error('transaction is not a successful FINAL result');
  }
  if (!tx || tx.hash !== hash || tx.signer_id !== goal.owner_account_id || tx.receiver_id !== goal.contract_id ||
      (publicKey !== undefined && tx.public_key !== String(publicKey)) || !Array.isArray(tx.actions) || tx.actions.length !== 1) throw new Error('transaction owner, contract or key mismatch');
  const signed = tx.actions[0]?.FunctionCall;
  if (!signed || signed.method_name !== 'execute_ft_call' || String(signed.deposit) !== '0' || String(signed.gas) !== String(GAS) ||
      !equal(decode(signed.args, 'signed arguments'), expectedArgs(goal))) throw new Error('signed FT call does not match the reviewed goal');
  const used = amount(decode(result.status.SuccessValue, 'settlement result'), 'used amount');
  if (used > BigInt(goal.amount)) throw new Error('used amount exceeds the payment');
  const unused = BigInt(goal.amount) - used;
  if (!Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) || !result.receipts.length || !result.receipts_outcome.length) throw new Error('missing raw receipts');
  const receiptIds = result.receipts.map(r => r?.receipt_id), outcomeIds = result.receipts_outcome.map(r => r?.id);
  if (receiptIds.some(id => typeof id !== 'string' || !id) || new Set(receiptIds).size !== receiptIds.length ||
      outcomeIds.some(id => typeof id !== 'string' || !id) || new Set(outcomeIds).size !== outcomeIds.length) {
    throw new Error('missing or duplicate FT-call receipt IDs');
  }
  const initiations = result.receipts_outcome.filter(r => r?.outcome?.executor_id === goal.contract_id && successful(r.outcome.status) &&
    r.outcome.logs?.includes('BOUNCER guarded ft_transfer_call initiated; full amount reserved'));
  if (initiations.length !== 1) throw new Error('missing unique guarded initiation');
  const txChildren = result.transaction_outcome?.outcome?.receipt_ids;
  if (!Array.isArray(txChildren) || !txChildren.includes(initiations[0].id)) throw new Error('FT-call initiation is not bound to the transaction');
  const requests = result.receipts.flatMap(receipt => {
    const call = actionReceipt(receipt, goal.contract_id, goal.token, 'ft_transfer_call');
    return call ? [{ receipt, call }] : [];
  });
  if (requests.length !== 1 || String(requests[0].call.deposit) !== '1' ||
      !result.receipts_outcome.some(r => r.id === requests[0].receipt.receipt_id && r.outcome?.executor_id === goal.token && successful(r.outcome.status))) {
    throw new Error('missing successful Bouncer-to-token transfer-call receipt');
  }
  const transferArgs = decode(requests[0].call.args, 'FT transfer-call arguments');
  if (!equal(transferArgs, { receiver_id: goal.payee, amount: goal.amount, memo: 'bouncer:guarded-ft-call', msg: goal.msg })) {
    throw new Error('token receipt does not match the pinned receiver, amount and message');
  }
  const expectedLog = `BOUNCER ft_transfer_call settled; used=${used}; unused=${unused}`;
  const callbacks = result.receipts.flatMap(receipt => {
    const call = actionReceipt(receipt, goal.contract_id, goal.contract_id, 'after_execute_ft_call');
    return call ? [{ receipt, call }] : [];
  });
  if (callbacks.length !== 1 || String(callbacks[0].call.deposit) !== '0') throw new Error('missing unique settlement callback');
  const callbackArgs = decode(callbacks[0].call.args, 'settlement callback arguments');
  const callbackFields = ['policy_id', 'token', 'amount', 'bucket', 'policy_revision'];
  // Early v6 test deployments used the five-field callback. Later v6 and v7 also
  // carries the pinned payee/message to account for OutLayer prepaid credit.
  const legacyCallback = owns(callbackArgs, callbackFields);
  const currentCallback = owns(callbackArgs, [...callbackFields, 'payee', 'msg']) && callbackArgs.payee === goal.payee && callbackArgs.msg === goal.msg;
  if ((!legacyCallback && !currentCallback) || callbackArgs.policy_id !== goal.policy_id ||
      callbackArgs.token !== goal.token || callbackArgs.amount !== goal.amount || callbackArgs.policy_revision !== goal.policy_revision ||
      !Number.isSafeInteger(callbackArgs.bucket) || callbackArgs.bucket < 0) throw new Error('settlement callback does not match the payment');
  const callbackOutcome = result.receipts_outcome.filter(r => r.id === callbacks[0].receipt.receipt_id &&
    r.outcome?.executor_id === goal.contract_id && successful(r.outcome?.status) &&
    r.outcome?.status?.SuccessValue === result.status.SuccessValue && r.outcome.logs?.includes(expectedLog));
  if (callbackOutcome.length !== 1) throw new Error('missing matching successful settlement outcome');
  // The request and callback were scheduled by the unique initiation. This
  // prevents borrowing otherwise plausible receipts from another execution.
  const children = initiations[0].outcome.receipt_ids;
  if (!Array.isArray(children) || !children.includes(requests[0].receipt.receipt_id) || !children.includes(callbacks[0].receipt.receipt_id) ||
      initiations[0].outcome.status?.SuccessReceiptId !== callbacks[0].receipt.receipt_id) {
    throw new Error('FT request or returned callback is not bound to the initiating receipt');
  }
  return { tx_hash: hash, token: goal.token, receiver: goal.payee, requested: goal.amount,
    used: used.toString(), unused: unused.toString(),
    verification: 'NEP-141 settlement via trusted RPC, token and Bouncer; no provider delivery verified' };
}

async function recoverFtCallGoalUnlocked({ goal: rawGoal, provider, journal, publicKey, update = true, log = console.log }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate FT-call payments');
  const goal = validateFtCallGoal(rawGoal);
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('recovery requires the original journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const previous = journal.get(goal.id);
  if (!previous || previous.fingerprint !== fingerprint(goal)) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (!['pending', 'completed'].includes(previous.status)) throw new Error(`${goal.id}: invalid journal status; stop and reconcile`);
  if (!validHash(previous.tx_hash)) throw new Error(`${goal.id}: no reliable transaction hash; reconcile manually, never resend automatically`);
  const signedBy = previous.agent_public_key;
  if (typeof signedBy !== 'string' || !signedBy || (publicKey && signedBy !== String(publicKey))) throw new Error(`${goal.id}: journal signing key mismatch`);
  const result = await provider.txStatusReceipts(previous.tx_hash, goal.owner_account_id, 'FINAL');
  const settlement = verifyFtCallSettlement(goal, result, signedBy);
  if (settlement.tx_hash !== previous.tx_hash) throw new Error(`${goal.id}: RPC returned a different transaction`);
  if (previous.status === 'completed' && !equal(previous.settlement, settlement)) throw new Error(`${goal.id}: recorded settlement differs from chain`);
  if (update && previous.status !== 'completed') journal.put(goal.id, { ...previous, status: 'completed', settlement, completed_at: new Date().toISOString() });
  log(`[ft-call] REUSED ${goal.id}: ${settlement.tx_hash}; no new payment; delivery is not established`);
  return { status: 'REUSED', settlement };
}

async function runFtCallGoalUnlocked({ goal: rawGoal, provider, account, publicKey, journal, execute = false, log = console.log }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate FT-call payments');
  const goal = validateFtCallGoal(rawGoal);
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('agent key account does not match the owner');
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('live execution requires a journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  const [version, owner, access] = await Promise.all([
    provider.callFunction(goal.contract_id, 'contract_version', {}, final), provider.callFunction(goal.contract_id, 'get_owner', {}, final),
    provider.viewAccessKey(goal.owner_account_id, publicKey, final),
  ]);
  if (!['bouncer-agent-v6', 'bouncer-agent-v7', 'bouncer-agent-v8', 'bouncer-agent-v9', 'bouncer-agent-v10-youtick-testnet'].includes(version) || owner !== goal.owner_account_id) throw new Error('unsupported Bouncer version or unexpected owner');
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !equal(permission.method_names, ['execute_ft_call'])) throw new Error('agent key must be scoped ONLY to execute_ft_call on this contract');
  const previous = journal?.get(goal.id), hash = fingerprint(goal);
  if (previous && previous.fingerprint !== hash) throw new Error(`${goal.id}: journal does not match the reviewed goal`);
  if (previous) return recoverFtCallGoalUnlocked({ goal, provider, journal, publicKey, update: execute, log });
  const [policy, route, granted, verdict] = await Promise.all([
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_ft_call_route', { policy_id: goal.policy_id, payee: goal.payee }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount }, final),
  ]);
  const expectedRoute = { token: goal.token, msg: goal.msg, policy_revision: goal.policy_revision, route_revision: goal.route_revision, active: true };
  if (!policy || policy.token !== goal.token || !equal(route, expectedRoute) || granted !== true) throw new Error('policy, owner-pinned route or key grant does not match the goal');
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid policy verdict');
  if (!verdict[0]) { log(`[ft-call] BLOCKED ${goal.id}: ${String(verdict[1]).slice(0, 200)}`); return { status: 'BLOCKED' }; }
  if (!execute) { log(`[ft-call] READY ${goal.id}: at most ${goal.amount} ${goal.token} to ${goal.payee} (dry run)`); return { status: 'READY' }; }
  const { txHash, signed } = await signReviewedCall({ account, publicKey, ownerId: goal.owner_account_id, contractId: goal.contract_id,
    method: 'execute_ft_call', args: expectedArgs(goal), gas: GAS });
  if (!validHash(txHash)) throw new Error('invalid transaction hash');
  const pending = { fingerprint: hash, status: 'pending', ft_call_goal: goal, agent_public_key: String(publicKey), tx_hash: txHash, started_at: new Date().toISOString() };
  // Another protocol sharing this journal might have reserved the ID while
  // the read-only checks and signing awaited. Never overwrite its evidence.
  if (journal.get(goal.id)) throw new Error(`${goal.id}: journal entry appeared before broadcast; reconcile, do not overwrite`);
  journal.put(goal.id, pending);
  try {
    // The built-in provider bounds the request and disables redirects/retries.
    // Injected providers without this method must provide equivalent behavior.
    const sent = typeof provider.sendTransactionOnce === 'function'
      ? await provider.sendTransactionOnce(signed, 'FINAL') : await provider.sendTransactionUntil(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different or missing transaction hash');
    const chain = await provider.txStatusReceipts(txHash, goal.owner_account_id, 'FINAL');
    const settlement = verifyFtCallSettlement(goal, chain, publicKey);
    if (settlement.tx_hash !== txHash) throw new Error('RPC returned a different transaction');
    journal.put(goal.id, { ...pending, status: 'completed', settlement, completed_at: new Date().toISOString() });
    log(`[ft-call] SETTLED ${goal.id}: ${txHash}; used=${settlement.used}, unused=${settlement.unused}; delivery is not established`);
    return { status: 'SETTLED', settlement };
  } catch (error) {
    throw new Error(`${goal.id}: FT call unresolved (tx ${txHash}); do not resend automatically: ${error.message}`, { cause: error });
  }
}
export function recoverFtCallGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => recoverFtCallGoalUnlocked(options));
}
export function runFtCallGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => runFtCallGoalUnlocked(options));
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
    console.log('Usage: node bouncer/agent/ft-call.mjs --goal GOAL.json --key AGENT_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('       node bouncer/agent/ft-call.mjs --goal GOAL.json --state JOURNAL.json [--rpc URL] --recover');
    console.log('Dry run by default; --recover reads the original transaction without a NEAR signing key. Encrypted file journals still require their separate key. Settlement does not verify delivery.');
    return;
  }
  if (!options.goal || (!options.recover && !options.key)) throw new Error('provide --goal and --key, or --goal with --recover');
  if (options.recover && (options.execute || options.key)) throw new Error('--recover cannot be combined with --execute or --key');
  const goalPath = path.resolve(home(options.goal));
  const goal = validateFtCallGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const state = path.resolve(home(options.state || `${goalPath}.bouncer-journal.json`));
  // Observe an existing journal even in dry-run mode. If it disappeared
  // before the lock was acquired, requireExisting prevents a new history.
  const requireExisting = !!options.recover || fs.existsSync(state);
  const journal = options.execute || requireExisting
    ? openConfiguredFileJournal(state, goal.contract_id, goal.owner_account_id, { requireExisting }) : null;
  try {
    let outcome;
    if (options.recover) outcome = await recoverFtCallGoal({ goal, provider, journal });
    else {
      const file = JSON.parse(fs.readFileSync(home(options.key), 'utf8'));
      if (file.account_id !== goal.owner_account_id || typeof file.private_key !== 'string') throw new Error('agent key file does not match owner');
      const key = KeyPair.fromString(file.private_key);
      const account = new MonotonicAccount(goal.owner_account_id, provider, new KeyPairSigner(key));
      outcome = await runFtCallGoal({ goal, provider, account, publicKey: key.getPublicKey(), journal, execute: options.execute });
    }
    if (outcome.settlement) console.log(JSON.stringify(outcome.settlement, null, 2));
    if (outcome.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[ft-call] ERROR: ${error.message}`); process.exitCode = 1; });
}
