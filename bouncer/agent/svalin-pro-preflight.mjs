#!/usr/bin/env node
/**
 * Strict READ-ONLY pre-reservation checks for one experimental Svalin Pro
 * testnet trial. No journal, bearer, reservation, owner key, signature or
 * transaction is created. An affirmative result is only a point-in-time
 * indication, NOT an approval, code audit, funding guarantee or payment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { validateSvalinProGoal } from './svalin-pro-session.mjs';
import { probeSvalinProOffer, SVALIN_PAYEE } from './svalin-pro-readiness.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { ReadOnlyNearRpcProvider, readPinnedJsonView } from './read-only-near-rpc.mjs';

// This deliberately narrow one-purchase profile covers the largest possible
// reviewed checkout. Other policies may be valid, but are not this profile.
export const SVALIN_TRIAL_MAX_ATOMS = '5009999';
export const SVALIN_TRIAL_MAX_GAS_ALLOWANCE = (10n ** 24n).toString(); // one testnet NEAR, NOT an estimate of gas needed
const U128_MAX = (1n << 128n) - 1n;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

async function boundedSettled(tasks, concurrency = 4) {
  const results = Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
      catch { results[index] = { status: 'rejected' }; }
    }
  }));
  return results;
}
function amount(x) {
  if (typeof x !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(x)) return null;
  const n = BigInt(x);
  return n <= U128_MAX ? n : null;
}
function publicKeyString(value) {
  if (typeof value !== 'string') throw new Error('a canonical Ed25519 agent public key is required');
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('invalid agent public key'); }
  if (key.keyType !== 0 || String(key) !== value) throw new Error('a canonical Ed25519 agent public key is required');
  return value;
}
function registered(value) {
  const total = amount(value?.total), available = amount(value?.available);
  return record(value) && total !== null && total > 0n && available !== null && available <= total;
}
function positiveNative(value) {
  // near-api-js converts viewAccount's raw decimal amount to bigint.
  const n = typeof value?.amount === 'bigint' ? value.amount : amount(value?.amount);
  return n !== null && n > 1n && n <= U128_MAX;
}
function exactPermission(access, vault) {
  const permission = access?.permission?.FunctionCall, allowance = amount(permission?.allowance);
  return record(permission) && permission.receiver_id === vault &&
    Array.isArray(permission.method_names) && permission.method_names.length === 1 &&
    permission.method_names[0] === 'execute_exact_ft' && allowance !== null && allowance > 0n &&
    allowance <= BigInt(SVALIN_TRIAL_MAX_GAS_ALLOWANCE);
}
function trialPolicy(value) {
  return record(value) && value.token === CIRCLE_TESTNET_USDC && value.per_tx_cap === SVALIN_TRIAL_MAX_ATOMS &&
    value.daily_cap === SVALIN_TRIAL_MAX_ATOMS;
}

/**
 * RPC views are all pinned to one reported FINAL block. A hostile RPC/token or
 * compromised local installation can lie; an otherwise valid snapshot can
 * become stale. UNAVAILABLE is not proof of absence. This does not inspect
 * historic transactions, independently review the artifact, prove backups,
 * reserve funds, pin an intent, or verify the seller's attribution/delivery.
 */
export async function inspectSvalinProPreflight({ goal: rawGoal, agentPublicKey, provider,
  fetchImpl = globalThis.fetch, now = Date.now }) {
  const goal = validateSvalinProGoal(rawGoal), key = publicKeyString(agentPublicKey);
  if (typeof now !== 'function' || typeof fetchImpl !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKeyList', 'viewAccessKey', 'callFunctionRaw']
        .some(name => typeof provider[name] !== 'function')) throw new Error('read-only testnet RPC and seller GET transport are required');
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1 || !Number.isFinite(new Date(nowMs).getTime())) throw new Error('invalid local time');
  let network;
  try { network = await provider.viewNodeStatus(); } catch { throw new Error('testnet RPC status is unavailable; no seller request was made'); }
  if (network?.chain_id !== 'testnet') throw new Error('RPC must report testnet; no seller request was made');
  let block;
  try { block = await provider.viewBlock({ finality: 'final' }); } catch { throw new Error('FINAL block is unavailable; no seller request was made'); }
  // A FINAL label alone is insufficient: a frozen endpoint can serve an
  // internally consistent but obsolete snapshot. Local time is a dependency.
  let fresh;
  try { fresh = assertFreshFinalBlock(block, nowMs); }
  catch { throw new Error('FINAL block is invalid, stale or local clock is incorrect; no seller request was made'); }
  const snapshot = { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
  const blockHash = fresh.hash, final = { blockId: blockHash };
  const view = (contract, method, args) => readPinnedJsonView(provider, blockHash, contract, method, args);

  // Fail each independent read closed, without echoing untrusted RPC/seller
  // messages. Still report all missing prerequisites where possible.
  const tasks = {
    vault_account: () => provider.viewAccount(goal.vault, final),
    vault_keys: () => provider.viewAccessKeyList(goal.vault, final),
    owner_account: () => provider.viewAccount(goal.owner, final),
    agent_access: () => provider.viewAccessKey(goal.owner, key, final),
    owner: () => view(goal.vault, 'get_owner', {}),
    version: () => view(goal.vault, 'contract_version', {}),
    policy: () => view(goal.vault, 'get_policy', { policy_id: goal.policy_id }),
    policy_locked: () => view(goal.vault, 'is_exact_ft_policy_locked', { policy_id: goal.policy_id }),
    pair_locked: () => view(goal.vault, 'is_exact_ft_payee_locked', { token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE }),
    agent_granted: () => view(goal.vault, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: key }),
    daily_spent: () => view(goal.vault, 'daily_spent', { policy_id: goal.policy_id }),
    vault_tracked: () => view(goal.vault, 'vault_balance', { token: CIRCLE_TESTNET_USDC }),
    vault_token: () => view(CIRCLE_TESTNET_USDC, 'ft_balance_of', { account_id: goal.vault }),
    vault_registration: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: goal.vault }),
    seller_registration: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: SVALIN_PAYEE }),
    verdict: () => view(goal.vault, 'check', { policy_id: goal.policy_id, payee: SVALIN_PAYEE, amount: SVALIN_TRIAL_MAX_ATOMS }),
    offer: () => probeSvalinProOffer({ fetchImpl, nowMs }),
  };
  const names = Object.keys(tasks), results = await boundedSettled(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, results[i].status === 'fulfilled'
    ? { available: true, value: results[i].value } : { available: false }]));
  // These views include block_hash, which must match the pinned query block.
  // A missing hash, even with an otherwise plausible value, fails closed.
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === blockHash;
  const checks = {};
  const put = (name, dependencies, predicate) => {
    checks[name] = dependencies.some(dep => !reads[dep].available) ? 'UNKNOWN' : predicate() ? 'PASS' : 'BLOCKED';
  };
  put('vault_code_matches_user_pin', ['vault_account'], () => atBlock('vault_account') && reads.vault_account.value.code_hash === goal.vault_code_hash);
  put('vault_has_no_access_keys', ['vault_keys'], () => atBlock('vault_keys') && Array.isArray(reads.vault_keys.value.keys) && reads.vault_keys.value.keys.length === 0);
  put('owner_and_v11_version', ['owner', 'version'], () => reads.owner.value === goal.owner && reads.version.value === 'bouncer-agent-v11-exact-ft-testnet');
  put('restricted_agent_key', ['agent_access'], () => atBlock('agent_access') && exactPermission(reads.agent_access.value, goal.vault));
  put('strict_trial_caps', ['policy'], () => trialPolicy(reads.policy.value));
  put('exact_policy_lock', ['policy_locked'], () => reads.policy_locked.value === true);
  put('token_payee_not_previously_locked_on_vault', ['pair_locked'], () => reads.pair_locked.value === false);
  put('agent_granted_for_policy', ['agent_granted'], () => reads.agent_granted.value === true);
  put('unused_daily_budget', ['daily_spent'], () => reads.daily_spent.value === '0');
  put('vault_tracked_balance', ['vault_tracked'], () => { const n = amount(reads.vault_tracked.value); return n !== null && n >= BigInt(SVALIN_TRIAL_MAX_ATOMS); });
  put('vault_token_balance', ['vault_token'], () => { const n = amount(reads.vault_token.value); return n !== null && n >= BigInt(SVALIN_TRIAL_MAX_ATOMS); });
  put('vault_registered_for_token', ['vault_registration'], () => registered(reads.vault_registration.value));
  put('seller_registered_for_token', ['seller_registration'], () => registered(reads.seller_registration.value));
  put('max_checkout_allowed_by_contract', ['verdict'], () => Array.isArray(reads.verdict.value) && reads.verdict.value.length === 2 &&
    reads.verdict.value[0] === true && typeof reads.verdict.value[1] === 'string');
  put('owner_native_balance_nonzero', ['owner_account'], () => atBlock('owner_account') && positiveNative(reads.owner_account.value));
  put('vault_native_balance_nonzero', ['vault_account'], () => atBlock('vault_account') && positiveNative(reads.vault_account.value));
  put('public_offer_matches_reviewed_testnet_profile', ['offer'], () => reads.offer.value?.status === 'PUBLIC_OFFER_ONLY');
  const completedMs = now();
  if (!Number.isSafeInteger(completedMs) || completedMs < nowMs || !Number.isFinite(new Date(completedMs).getTime())) {
    throw new Error('local clock is invalid or moved backwards during preflight');
  }
  try { assertFreshFinalBlock(snapshot, completedMs); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  const blockers = Object.entries(checks).filter(([, status]) => status !== 'PASS').map(([name, status]) => ({ check: name, status }));
  return { status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_PROFILE_MATCH', chain: 'testnet', block_hash: blockHash,
    checked_at: new Date(completedMs).toISOString(), block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    vault: goal.vault, owner: goal.owner, policy_id: goal.policy_id,
    token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE, max_checkout_atoms: SVALIN_TRIAL_MAX_ATOMS,
    max_agent_gas_allowance_yocto: SVALIN_TRIAL_MAX_GAS_ALLOWANCE, checks, blockers,
    reservation_created: false, intent_pinned: false, signature_created: false, transaction_sent: false,
    seller_attribution_verified: false, fulfillment_verified: false,
    scope: 'point-in-time trusted-RPC views only; no code audit, sufficient gas, backups, consent, reservation, payment, attribution or delivery is established' };
}

const USAGE = `Read-only Svalin testnet preflight: no reservation, signing or transaction.
Usage: node agent/svalin-pro-preflight.mjs --goal PUBLIC-GOAL.json --public-key ED25519_KEY [--rpc TESTNET_RPC]
The public goal must pin the intended owner, fresh V11 vault, reviewed code hash and policy.
The strict one-purchase profile checks the largest possible 5.009999 test-USDC checkout,
exact trial caps, key and token registration at one FINAL block. It does not prove the
code was audited, enough gas or backups exist, or authorize any seller/payment action.`;
function parse(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i], name = word?.startsWith('--') ? word.slice(2) : '';
    if (!['goal', 'public-key', 'rpc'].includes(name) || Object.hasOwn(parsed, name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('unknown, duplicate or incomplete argument; use --help');
    }
    parsed[name] = argv[++i];
  }
  if (!parsed.goal || !parsed['public-key']) throw new Error('a public goal and agent public key are required; use --help');
  return parsed;
}
function readPublicGoal(file) {
  let fd;
  try {
    fd = fs.openSync(path.resolve(file), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) throw new Error();
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { throw new Error('public goal must be a bounded regular JSON file'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export async function main(argv = process.argv.slice(2)) {
  const opts = parse(argv);
  if (opts.help) { console.log(USAGE); return; }
  const goal = validateSvalinProGoal(readPublicGoal(opts.goal));
  const agentPublicKey = publicKeyString(opts['public-key']);
  const provider = new ReadOnlyNearRpcProvider(opts.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const result = await inspectSvalinProPreflight({ goal, agentPublicKey, provider });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'READ_ONLY_PROFILE_MATCH') process.exitCode = 2;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[svalin-preflight] ${error.message}`); process.exitCode = 1; });
}
