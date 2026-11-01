#!/usr/bin/env node
/**
 * Experimental one-shot testnet swap runner. No implicit retries: the input
 * and sweep are independently signed, durably journaled before broadcast and
 * recovered by original hash. FileJournal is local/cooperative, not a
 * distributed coordinator or a defense against stale backups.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { openConfiguredFileJournal } from './procurement.mjs';
import { runFtCallGoal, recoverFtCallGoal } from './ft-call.mjs';
import { MonotonicAccount, PaymentRpcProvider } from './near-account.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateRefSwapGoal, refSwapFtGoal, verifyRefSwapOutput, verifyRefSweep, REF_SWAP_INPUT,
  REF_SWAP_OUTPUT, REF_SWAP_EXCHANGE, REF_SWAP_INPUT_MESSAGE, REF_SWEEP_GAS } from './ref-swap-evidence.mjs';

const { KeyPair, KeyPairSigner } = nearApi;
const final = { finality: 'final' };
const routeId = goal => `${goal.id}-route`;
const sweepId = goal => `${goal.id}-sweep`;
function fingerprint(value) {
  const keys = Object.keys(value).sort();
  return crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(key => [key, value[key]])))).digest('hex');
}
function requireJournal(journal) {
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function' || journal.sharedDirectV3 === true) {
    throw new Error('one-shot swap requires its original exclusive file journal; shared buyer does not coordinate this route');
  }
}
function matchingRouteEntry(goal, journal, required = true) {
  const entry = journal?.get(routeId(goal));
  if (!entry) {
    if (required) throw new Error('original swap route is missing from the journal; stop and reconcile');
    if (journal?.get(refSwapFtGoal(goal).id) || journal?.get(sweepId(goal))) throw new Error('swap records exist without their route manifest; stop and reconcile');
    return null;
  }
  if (entry.fingerprint !== fingerprint(goal) || !isDeepStrictEqual(entry.ref_swap_goal, goal) ||
      !['pending', 'completed'].includes(entry.status)) throw new Error('original route manifest differs from the reviewed swap');
  return entry;
}
function sweepFingerprint(goal, proof) {
  return fingerprint({ goal_fingerprint: fingerprint(goal), swap_hash: proof.tx_hash, output_receipt_id: proof.output_receipt_id,
    output_amount: proof.output_amount });
}
function validStorage(value) {
  return value && typeof value === 'object' && typeof value.total === 'string' && /^[0-9]+$/.test(value.total) && BigInt(value.total) > 0n;
}

/** Verify pinned code, lack of deploy keys and immutable route via FINAL views. */
export async function checkRefRouter(rawGoal, provider, { ready = false, forSweep = false, checkStorage = false } = {}) {
  const goal = validateRefSwapGoal(rawGoal);
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const [account, keys, route] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: goal.router_id, ...final }),
    provider.query({ request_type: 'view_access_key_list', account_id: goal.router_id, ...final }),
    provider.callFunction(goal.router_id, 'get_route', {}, final),
  ]);
  if (!account || account.code_hash !== goal.router_code_hash || !Array.isArray(keys?.keys) || keys.keys.length !== 0) {
    throw new Error('router bytecode hash differs or router still has access keys; stop before spending');
  }
  const expected = { version: 'bouncer-ref-router-v1', owner: goal.owner_account_id, vault: goal.contract_id,
    exchange: REF_SWAP_EXCHANGE, token_in: REF_SWAP_INPUT, token_out: REF_SWAP_OUTPUT, pool_id: goal.pool_id,
    amount_in: goal.input_amount, min_amount_out: goal.min_output, input_message: REF_SWAP_INPUT_MESSAGE };
  if (!route || typeof route !== 'object' || Object.keys(route).length !== Object.keys(expected).length + 3 ||
      !Object.entries(expected).every(([key, value]) => isDeepStrictEqual(route[key], value)) ||
      typeof route.started !== 'boolean' || !['ready', 'inner_pending', 'inner_settled', 'inner_unknown'].includes(route.input_state) ||
      !(route.inner_used === null || (typeof route.inner_used === 'string' && /^(0|[1-9][0-9]*)$/.test(route.inner_used)))) {
    throw new Error('router immutable configuration differs from the reviewed route');
  }
  if (ready && (route.started || route.input_state !== 'ready' || route.inner_used !== null)) throw new Error('one-shot router is no longer ready; do not start another input');
  if (forSweep && (!route.started || route.input_state !== 'inner_settled' || route.inner_used !== goal.input_amount)) {
    throw new Error('original router input is not fully reconciled; do not sweep automatically');
  }
  if (checkStorage) {
    if (typeof account.amount !== 'string' || !/^[0-9]+$/.test(account.amount) || BigInt(account.amount) < 100_000_000_000_000_000_000_000n) {
      throw new Error('router requires at least 0.1 testnet NEAR for storage and gas');
    }
    const registrations = await Promise.all([
      provider.callFunction(REF_SWAP_INPUT, 'storage_balance_of', { account_id: goal.router_id }, final),
      provider.callFunction(REF_SWAP_OUTPUT, 'storage_balance_of', { account_id: goal.router_id }, final),
      provider.callFunction(REF_SWAP_OUTPUT, 'storage_balance_of', { account_id: goal.contract_id }, final),
    ]);
    if (registrations.some(value => !validStorage(value))) throw new Error('router and vault token storage registrations must be funded first');
  }
  return route;
}
async function checkSweepKey(goal, provider, account, publicKey) {
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('sweep key account does not match the owner');
  const access = await provider.viewAccessKey(goal.owner_account_id, publicKey, final);
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.router_id || !isDeepStrictEqual(permission.method_names, ['sweep_output'])) {
    throw new Error('sweep key must be scoped ONLY to sweep_output on the immutable router');
  }
}
async function readVerifiedSwap(goal, provider, journal, log, update = true) {
  const input = refSwapFtGoal(goal), entry = journal.get(input.id);
  if (!entry) return null;
  await recoverFtCallGoal({ goal: input, provider, journal, update, log });
  const result = await provider.txStatusReceipts(entry.tx_hash, goal.owner_account_id, 'FINAL');
  const proof = verifyRefSwapOutput(goal, result, entry.agent_public_key);
  if (proof.tx_hash !== entry.tx_hash) throw new Error('RPC returned a different original swap');
  return proof;
}
async function readVerifiedSweep(goal, provider, journal, proof, log, update = true) {
  const entry = journal.get(sweepId(goal));
  if (!entry) return null;
  if (entry.fingerprint !== sweepFingerprint(goal, proof) || !['pending', 'completed'].includes(entry.status) ||
      !isTransactionHash(entry.tx_hash) || typeof entry.sweep_public_key !== 'string' || !entry.sweep_public_key ||
      entry.swap_hash !== proof.tx_hash || entry.output_amount !== proof.output_amount || entry.output_receipt_id !== proof.output_receipt_id) {
    throw new Error('original sweep journal differs from the verified swap; never resend');
  }
  const result = await provider.txStatusReceipts(entry.tx_hash, goal.owner_account_id, 'FINAL');
  const credit = verifyRefSweep(goal, proof.output_amount, result, entry.sweep_public_key);
  if (credit.tx_hash !== entry.tx_hash || (entry.status === 'completed' && !isDeepStrictEqual(entry.vault_credit, credit))) {
    throw new Error('recorded sweep differs from FINAL chain evidence; never resend');
  }
  const route = matchingRouteEntry(goal, journal);
  if (route.status === 'completed' && (route.tx_hash !== credit.tx_hash || !isDeepStrictEqual(route.swap, proof) || !isDeepStrictEqual(route.vault_credit, credit))) {
    throw new Error('completed route differs from FINAL chain evidence');
  }
  if (update && entry.status !== 'completed') journal.put(sweepId(goal), { ...entry, status: 'completed', vault_credit: credit, completed_at: new Date().toISOString() });
  if (update && route.status !== 'completed') journal.put(routeId(goal), { ...route, status: 'completed', tx_hash: credit.tx_hash,
    swap: proof, vault_credit: credit, completed_at: new Date().toISOString() });
  log(`[ref-swap] VERIFIED vault credit ${credit.credited} ${credit.token}; original swap ${proof.tx_hash}; sweep ${credit.tx_hash}`);
  return credit;
}

/** Key-free, no-send reconciliation of the original hashes. */
export async function recoverRefSwap({ goal: rawGoal, provider, journal, log = console.log }) {
  const goal = validateRefSwapGoal(rawGoal); requireJournal(journal);
  const route = matchingRouteEntry(goal, journal);
  await checkRefRouter(goal, provider);
  const proof = await readVerifiedSwap(goal, provider, journal, log);
  if (!proof) {
    if (route.status === 'completed' || journal.get(sweepId(goal))) throw new Error('swap history is incomplete; stop and reconcile');
    return { status: 'NOT_ATTEMPTED', verification: 'no input transaction is recorded in this original journal; no send performed' };
  }
  const credit = await readVerifiedSweep(goal, provider, journal, proof, log);
  if (!credit && route.status === 'completed') throw new Error('completed route is missing its original sweep; stop and reconcile');
  if (!credit) return { status: 'OUTPUT_RECEIVED', swap: proof, verification: 'Ref output reached the router; no vault credit is claimed' };
  return { status: 'COMPLETED', swap: proof, vault_credit: credit };
}

/** Dry-run by default. Live input and sweep each have an independent write-ahead hash. */
export async function runRefSwap({ goal: rawGoal, provider, account, publicKey, sweepAccount, sweepPublicKey, journal,
  execute = false, log = console.log }) {
  const goal = validateRefSwapGoal(rawGoal), input = refSwapFtGoal(goal);
  if (execute) requireJournal(journal);
  const routeEntry = matchingRouteEntry(goal, journal, false), hasInput = !!journal?.get(input.id);
  if (!hasInput && (routeEntry?.status === 'completed' || journal?.get(sweepId(goal)))) {
    throw new Error('swap history is missing its original input; stop and reconcile');
  }
  await checkRefRouter(goal, provider, { ready: !hasInput, checkStorage: !hasInput });
  await checkSweepKey(goal, provider, sweepAccount, sweepPublicKey);
  if (execute && !routeEntry) journal.put(routeId(goal), { fingerprint: fingerprint(goal), status: 'pending', ref_swap_goal: goal, started_at: new Date().toISOString() });
  const inputResult = await runFtCallGoal({ goal: input, provider, account, publicKey, journal, execute, log });
  if (inputResult.status === 'BLOCKED' || inputResult.status === 'READY') return inputResult;
  const proof = await readVerifiedSwap(goal, provider, journal, log, execute);
  if (!proof) throw new Error('original input is missing from journal; stop and reconcile');
  return finishVerifiedSweep({ goal, provider, sweepAccount, sweepPublicKey, journal, proof, routeEntry, execute, log });
}

async function finishVerifiedSweep({ goal, provider, sweepAccount, sweepPublicKey, journal, proof, routeEntry, execute, log }) {
  const prior = await readVerifiedSweep(goal, provider, journal, proof, log, execute);
  if (prior) return { status: 'COMPLETED', swap: proof, vault_credit: prior };
  if (routeEntry?.status === 'completed') throw new Error('completed route is missing its original sweep; stop and reconcile');
  if (!execute) return { status: 'OUTPUT_RECEIVED', swap: proof, verification: 'dry run; vault not yet credited' };
  await checkRefRouter(goal, provider, { forSweep: true });
  const { txHash, signed } = await signReviewedCall({ account: sweepAccount, publicKey: sweepPublicKey, ownerId: goal.owner_account_id,
    contractId: goal.router_id, method: 'sweep_output', args: { amount: proof.output_amount }, gas: REF_SWEEP_GAS });
  if (!isTransactionHash(txHash)) throw new Error('invalid sweep transaction hash');
  const pending = { fingerprint: sweepFingerprint(goal, proof), status: 'pending', tx_hash: txHash, sweep_public_key: String(sweepPublicKey),
    swap_hash: proof.tx_hash, output_receipt_id: proof.output_receipt_id, output_amount: proof.output_amount, started_at: new Date().toISOString() };
  journal.put(sweepId(goal), pending);
  try {
    const sent = await provider.sendTransactionUntil(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different or missing sweep hash');
    const credit = await readVerifiedSweep(goal, provider, journal, proof, log);
    if (!credit) throw new Error('original sweep entry disappeared');
    return { status: 'COMPLETED', swap: proof, vault_credit: credit };
  } catch (error) {
    throw new Error(`${goal.id}: sweep unresolved (tx ${txHash}); reconcile the original hash, never resend automatically: ${error.message}`, { cause: error });
  }
}

/**
 * Resume only the separately authorized output sweep. The original route and
 * input hash must already exist and verify from FINAL receipts. This function
 * never constructs, signs or broadcasts an input transaction. Existing sweep
 * hashes are recovered, not resent. A preview does not mutate the journal.
 */
export async function runRefSweepOnly({ goal: rawGoal, provider, sweepAccount, sweepPublicKey, journal, execute = false, log = console.log }) {
  const goal = validateRefSwapGoal(rawGoal); requireJournal(journal);
  const routeEntry = matchingRouteEntry(goal, journal);
  if (!journal.get(refSwapFtGoal(goal).id)) throw new Error('original input is missing; sweep-only recovery cannot submit a swap');
  await checkRefRouter(goal, provider);
  await checkSweepKey(goal, provider, sweepAccount, sweepPublicKey);
  const proof = await readVerifiedSwap(goal, provider, journal, log, execute);
  if (!proof) throw new Error('original input is missing; sweep-only recovery cannot submit a swap');
  return finishVerifiedSweep({ goal, provider, sweepAccount, sweepPublicKey, journal, proof, routeEntry, execute, log });
}

function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parseArgs(args) {
  const options = { execute: false, recover: false };
  for (let i = 0; i < args.length; i++) {
    if (['--execute', '--recover', '--sweep-only', '--help'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--goal', '--key', '--sweep-key', '--state', '--rpc'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  return options;
}
function loadAccount(file, owner, provider) {
  const credentials = JSON.parse(fs.readFileSync(home(file), 'utf8'));
  if (credentials.account_id !== owner || typeof credentials.private_key !== 'string') throw new Error('key file does not match swap owner');
  const key = KeyPair.fromString(credentials.private_key);
  return { account: new MonotonicAccount(owner, provider, new KeyPairSigner(key)), publicKey: key.getPublicKey() };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/ref-swap.mjs --goal GOAL.json --key INPUT_KEY.json --sweep-key SWEEP_KEY.json [--state JOURNAL.json] [--rpc URL] [--execute]');
    console.log('       node bouncer/agent/ref-swap.mjs --goal GOAL.json --state ORIGINAL_JOURNAL.json [--rpc URL] --recover');
    console.log('       node bouncer/agent/ref-swap.mjs --goal GOAL.json --state ORIGINAL_JOURNAL.json --sweep-key SWEEP_KEY.json --sweep-only [--execute]');
    console.log('Testnet only. Dry-run by default. Recovery sends nothing; sweep-only can never sign an input and requires the original journal.');
    return;
  }
  if (!options.goal || (options.recover && (options.execute || options.key || options['sweep-key'] || options['sweep-only'] || !options.state)) ||
      (options['sweep-only'] && (options.key || !options['sweep-key'] || !options.state)) ||
      (!options.recover && !options['sweep-only'] && (!options.key || !options['sweep-key']))) {
    throw new Error('provide --goal with both scoped keys, --recover with the original --state, or --sweep-only with the original --state and sweep key');
  }
  const goalPath = path.resolve(home(options.goal)), goal = validateRefSwapGoal(JSON.parse(fs.readFileSync(goalPath, 'utf8')));
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const state = path.resolve(home(options.state || `${goalPath}.bouncer-journal.json`));
  // Dry runs must see an existing history, but must not create a new journal.
  const requireExisting = !!options.recover || !!options['sweep-only'] || fs.existsSync(state);
  const journal = options.execute || requireExisting
    ? openConfiguredFileJournal(state, goal.contract_id, goal.owner_account_id, { requireExisting }) : null;
  try {
    let result;
    if (options.recover) result = await recoverRefSwap({ goal, provider, journal });
    else if (options['sweep-only']) {
      const sweep = loadAccount(options['sweep-key'], goal.owner_account_id, provider);
      result = await runRefSweepOnly({ goal, provider, sweepAccount: sweep.account, sweepPublicKey: sweep.publicKey, journal, execute: options.execute });
    } else {
      const input = loadAccount(options.key, goal.owner_account_id, provider), sweep = loadAccount(options['sweep-key'], goal.owner_account_id, provider);
      result = await runRefSwap({ goal, provider, account: input.account, publicKey: input.publicKey,
        sweepAccount: sweep.account, sweepPublicKey: sweep.publicKey, journal, execute: options.execute });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 2;
  } finally { journal?.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[ref-swap] ERROR: ${error.message}`); process.exitCode = 1; });
}
