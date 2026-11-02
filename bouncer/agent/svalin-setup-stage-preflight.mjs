/**
 * Read-only checks for the NEXT stage of the constrained five-batch Svalin
 * testnet setup, or a post-funding snapshot. This is not an executor: it has
 * no signer, broadcaster, journal writer or seller HTTP client.
 *
 * The encrypted original journal and independently retained plan must be
 * supplied by the caller. Journal receipt entries and all state views trust
 * the RPC and local clock; they do not prove consensus, audit, user consent,
 * sufficient fees/storage, backups, or that no other journal/process exists.
 * A snapshot is inherently subject to races. Recheck immediately before any
 * separately approved action and never repeat an unresolved original hash.
 */
import { isDeepStrictEqual } from 'node:util';
import { inspectSvalinSetupJournal } from './svalin-setup-journal.mjs';
import { verifySvalinSetupPlan } from './svalin-setup-evidence.mjs';
import { inspectSvalinSetupPrerequisites, MIN_V11_TESTNET_PROTOCOL, reportedV11WasmFeatures,
  selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { SVALIN_TRIAL_MAX_ATOMS } from './svalin-pro-preflight.mjs';
import { SVALIN_PAYEE } from './svalin-pro-readiness.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = Object.freeze(['create_keyless_vault', 'configure_locked_policy', 'install_restricted_agent_key',
  'register_vault_for_test_usdc', 'fund_vault_with_test_usdc', 'verify_funded_vault']);
const U128_MAX = (1n << 128n) - 1n;
const OWNER_RESERVE = 10n ** 24n; // 1 test NEAR, not a fee or storage guarantee
const VAULT_RESERVE = 10n ** 23n; // 0.1 test NEAR, not a fee or storage guarantee
const VAULT_STORAGE_MARGIN = 50_000n; // estimated extra bytes, not a bound
const VERSION = 'bouncer-agent-v11-exact-ft-testnet';
const UNFUNDED_MESSAGE = 'BLOCKED: insufficient vault balance (fund first)';
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

function amount(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= U128_MAX ? value : null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const n = BigInt(value);
  return n <= U128_MAX ? n : null;
}
function registered(value) {
  const total = amount(value?.total), available = amount(value?.available);
  return record(value) && total !== null && total > 0n && available !== null && available <= total;
}
function keyList(value, hash, identity, installed, allowance) {
  const keys = value?.keys;
  if (value?.block_hash !== hash || !Array.isArray(keys) || keys.length > 10_000 ||
      !keys.every(k => record(k) && typeof k.public_key === 'string' && record(k.access_key)) ||
      new Set(keys.map(k => k.public_key)).size !== keys.length ||
      !keys.some(k => k.public_key === identity.owner_public_key && k.access_key.permission === 'FullAccess')) return false;
  const agent = keys.find(k => k.public_key === identity.agent_public_key);
  if (!installed) return agent === undefined;
  const permission = agent?.access_key?.permission?.FunctionCall;
  return record(permission) && permission.receiver_id === identity.vault &&
    Array.isArray(permission.method_names) && permission.method_names.length === 1 &&
    permission.method_names[0] === 'execute_exact_ft' && amount(permission.allowance) === allowance;
}
function safeTime(now) {
  const ms = now();
  if (!Number.isSafeInteger(ms) || ms < 1 || !Number.isFinite(new Date(ms).getTime())) throw new Error('invalid local time');
  return ms;
}
function nextStage(state, index, pendingHash) {
  return state?.status === 'LOCAL_SETUP_JOURNAL_ONLY' && Array.isArray(state.stages) && state.stages.length === 5 &&
    state.stages.every((entry, i) => entry.stage_id === STAGES[i] && (i < index ?
      (entry.state === 'FINAL_RECEIPTS_MATCH' || (i === 2 && entry.state === 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH')) :
      i === index && pendingHash !== null ? entry.state === 'ORIGINAL_HASH_PENDING' && entry.tx_hash === pendingHash && entry.do_not_resend === true :
        entry.state === 'NOT_RECORDED'));
}
async function bounded(tasks, limit = 4) {
  const result = Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      try { result[index] = { available: true, value: await tasks[index]() }; }
      catch { result[index] = { available: false }; }
    }
  }));
  return result;
}
function flags() {
  return { artifact_independently_reviewed: false, deployed_circle_code_verified: false,
    runtime_linking_and_all_host_imports_verified: false, receipt_consensus_verified: false,
    all_payees_and_agents_enumerated: false, backup_verified: false, owner_approval_verified: false,
    setup_or_funding_independently_verified: false, seller_fulfillment_verified: false,
    execution_authorized: false, transaction_signed: false, transaction_sent: false, seller_contacted: false,
    estimates_are_not_storage_or_gas_guarantees: true };
}
function summarized(checks) {
  return Object.entries(checks).filter(([, status]) => status !== 'PASS').map(([check, status]) => ({ check, status }));
}

/**
 * By default the requested stage must be the journal's first unrecorded stage;
 * verify_funded_vault requires all five original stages reconciled, including
 * a separately labeled local AddKey outcome if its receipt body was omitted. An
 * optional exact pendingOriginalHash permits ONLY a read-only recheck of a
 * recorded original, never permission to broadcast or retry it. The journal is
 * checked before and after RPC, but later races and deleted, rolled-back,
 * bypassed or separate journals remain undetectable.
 */
export async function inspectSvalinSetupStage({ plan, trustedReviewHash, ownerPublicKey, journal, stageId,
  provider, now = Date.now, pendingOriginalHash = null, exclusiveScope }) {
  const identity = verifySvalinSetupPlan({ plan, trustedReviewHash, ownerPublicKey });
  const index = STAGES.indexOf(stageId);
  if (index < 0) throw new Error('a known setup stage is required');
  if (pendingOriginalHash !== null && (index === 5 || !isTransactionHash(pendingOriginalHash))) {
    throw new Error('an exact recorded original hash is required for a read-only pending-stage recheck');
  }
  if (typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList',
        'callFunctionRaw', 'experimental_protocolConfig'].some(name => typeof provider[name] !== 'function') ||
      (index === 0 && typeof provider.viewTestnetAccountPresenceAt !== 'function')) {
    throw new Error('a read-only testnet RPC is required');
  }
  const started = safeTime(now);
  const review = structuredClone(plan.review), goal = review.goal;
  const registration = BigInt(review.stages[3].actions[0].deposit_yocto);
  const allowance = BigInt(review.stages[2].actions[0].allowance_yocto);
  const journalArgs = { plan, trustedReviewHash, ownerPublicKey, journal, exclusiveScope };
  const original = await inspectSvalinSetupJournal(journalArgs);
  if (!nextStage(original, index, pendingOriginalHash)) throw new Error('journal is not ready for this stage; reconcile original hashes and never resend');

  if (index === 0) {
    const initial = await inspectSvalinSetupPrerequisites({ plan, trustedReviewHash, ownerPublicKey, provider, now });
    const after = await inspectSvalinSetupJournal(journalArgs);
    const finished = safeTime(now);
    if (finished < started) throw new Error('local clock moved backwards');
    const checks = { ...initial.checks, journal_unchanged: isDeepStrictEqual(original, after) ? 'PASS' : 'BLOCKED' };
    const header = { header: { hash: initial.block_hash,
      timestamp_nanosec: String(BigInt(Date.parse(initial.block_timestamp)) * 1_000_000n) } };
    try { assertFreshFinalBlock(header, finished); }
    catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
    const blockers = summarized(checks);
    return { ...initial, stage_id: stageId, pending_original_hash: pendingOriginalHash,
      checked_at: new Date(finished).toISOString(), checks, blockers,
      status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_STAGE_PROFILE_MATCH',
      ...flags(), current_state_is_not_authorization: true,
      scope: 'read-only pre-creation snapshot and original-journal sequence; no execution, code audit, backup or consent' };
  }

  let network, block;
  try { network = await provider.viewNodeStatus(); } catch { throw new Error('testnet RPC status unavailable'); }
  if (network?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  try { block = await provider.viewBlock({ finality: 'final' }); } catch { throw new Error('FINAL block unavailable'); }
  let fresh;
  try { fresh = assertFreshFinalBlock(block, safeTime(now)); }
  catch { throw new Error('FINAL block is invalid, stale or local clock is incorrect'); }
  const hash = fresh.hash, at = () => ({ blockId: hash });
  const header = { header: { hash, timestamp_nanosec: block.header.timestamp_nanosec } };
  const view = (contract, method, args) => readPinnedJsonView(provider, hash, contract, method, args);
  const policyArgs = () => ({ policy_id: goal.policy_id });
  const tasks = {
    protocol: () => provider.experimental_protocolConfig(at()),
    owner_account: () => provider.viewAccount(goal.owner, at()),
    owner_key: () => provider.viewAccessKey(goal.owner, identity.owner_public_key, at()),
    owner_keys: () => provider.viewAccessKeyList(goal.owner, at()),
    vault_account: () => provider.viewAccount(goal.vault, at()),
    vault_keys: () => provider.viewAccessKeyList(goal.vault, at()),
    contract_owner: () => view(goal.vault, 'get_owner', {}),
    contract_version: () => view(goal.vault, 'contract_version', {}),
    policy: () => view(goal.vault, 'get_policy', policyArgs()),
    policy_locked: () => view(goal.vault, 'is_exact_ft_policy_locked', policyArgs()),
    pair_locked: () => view(goal.vault, 'is_exact_ft_payee_locked', { token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE }),
    agent_granted: () => view(goal.vault, 'is_agent_key_allowed', { ...policyArgs(), public_key: identity.agent_public_key }),
    daily_spent: () => view(goal.vault, 'daily_spent', policyArgs()),
    vault_tracked: () => view(goal.vault, 'vault_balance', { token: CIRCLE_TESTNET_USDC }),
    bounds: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_bounds', {}),
    owner_registration: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: goal.owner }),
    vault_registration: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: goal.vault }),
    seller_registration: () => view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: SVALIN_PAYEE }),
    owner_usdc: () => view(CIRCLE_TESTNET_USDC, 'ft_balance_of', { account_id: goal.owner }),
    vault_usdc: () => view(CIRCLE_TESTNET_USDC, 'ft_balance_of', { account_id: goal.vault }),
  };
  if (index >= 2) tasks.verdict = () => view(goal.vault, 'check', { ...policyArgs(), payee: SVALIN_PAYEE, amount: SVALIN_TRIAL_MAX_ATOMS });
  const names = Object.keys(tasks), results = await bounded(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, results[i]]));
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === hash;
  const checks = {};
  const put = (name, deps, predicate) => {
    checks[name] = deps.some(dep => !reads[dep].available) ? 'UNKNOWN' : predicate() ? 'PASS' : 'BLOCKED';
  };
  put('testnet_protocol_and_storage_cost', ['protocol'], () => reads.protocol.value?.chain_id === 'testnet' &&
    Number.isSafeInteger(reads.protocol.value?.protocol_version) && reads.protocol.value.protocol_version >= MIN_V11_TESTNET_PROTOCOL &&
    amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte) > 0n);
  put('v11_selected_wasm_features_enabled', ['protocol'], () => selectedV11WasmFeaturesEnabled(reads.protocol.value));
  const cost = amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte);
  put('owner_full_access_key', ['owner_key'], () => atBlock('owner_key') && reads.owner_key.value.permission === 'FullAccess');
  put('owner_nonce_safely_represented', ['owner_key'], () => atBlock('owner_key') && pinnedAccessKeyNonce(reads.owner_key.value.nonce) !== null);
  put('agent_key_state', ['owner_keys'], () => keyList(reads.owner_keys.value, hash, identity, index >= 3, allowance));
  put('vault_code_matches_review', ['vault_account'], () => atBlock('vault_account') && reads.vault_account.value.code_hash === goal.vault_code_hash);
  put('vault_has_no_access_keys', ['vault_keys'], () => atBlock('vault_keys') &&
    Array.isArray(reads.vault_keys.value.keys) && reads.vault_keys.value.keys.length === 0);
  put('owner_and_version', ['contract_owner', 'contract_version'], () => reads.contract_owner.value === goal.owner && reads.contract_version.value === VERSION);
  if (index === 1) {
    put('policy_not_yet_configured', ['policy', 'policy_locked', 'agent_granted'], () =>
      reads.policy.value === null && reads.policy_locked.value === false && reads.agent_granted.value === false);
  } else {
    put('strict_trial_policy', ['policy'], () => reads.policy.value?.token === CIRCLE_TESTNET_USDC &&
      reads.policy.value?.per_tx_cap === SVALIN_TRIAL_MAX_ATOMS && reads.policy.value?.daily_cap === SVALIN_TRIAL_MAX_ATOMS);
    put('policy_locked_and_agent_granted', ['policy_locked', 'agent_granted'], () =>
      reads.policy_locked.value === true && reads.agent_granted.value === true);
    // Before funding, V11's check returns the exact unfunded reason only AFTER
    // validating the payee, caps and budget. This is a behavior-dependent
    // indication for the expected payee, not enumeration of every payee.
    put('expected_payee_check', ['verdict'], () => {
      const verdict = reads.verdict.value;
      return Array.isArray(verdict) && verdict.length === 2 && typeof verdict[1] === 'string' &&
        (index === 5 ? verdict[0] === true : verdict[0] === false && verdict[1] === UNFUNDED_MESSAGE);
    });
  }
  put('token_payee_not_consumed_or_locked', ['pair_locked'], () => reads.pair_locked.value === false);
  put('daily_budget_unused', ['daily_spent'], () => reads.daily_spent.value === '0');
  put('vault_token_and_tracked_balances', ['vault_tracked', 'vault_usdc'], () => {
    const expected = index === 5 ? SVALIN_TRIAL_MAX_ATOMS : '0';
    return reads.vault_tracked.value === expected && reads.vault_usdc.value === expected;
  });
  put('circle_bounds_match_review', ['bounds'], () => {
    const bounds = reads.bounds.value, min = amount(bounds?.min), max = bounds?.max === null ? null : amount(bounds?.max);
    return record(bounds) && min === registration && (bounds.max === null || (max !== null && max >= min));
  });
  put('owner_and_seller_registered', ['owner_registration', 'seller_registration'], () =>
    registered(reads.owner_registration.value) && registered(reads.seller_registration.value));
  put('vault_registration_state', ['vault_registration'], () => index <= 3 ? reads.vault_registration.value === null :
    registered(reads.vault_registration.value) && amount(reads.vault_registration.value.total) === registration);
  put('owner_token_balance', ['owner_usdc'], () => {
    const value = amount(reads.owner_usdc.value);
    return value !== null && (index === 5 || value >= BigInt(SVALIN_TRIAL_MAX_ATOMS));
  });
  let estimatedOwnerAvailable = null, estimatedVaultAvailable = null;
  put('owner_native_estimate', ['owner_account', 'protocol'], () => {
    const account = reads.owner_account.value, balance = amount(account?.amount);
    if (!atBlock('owner_account') || reads.protocol.value?.chain_id !== 'testnet' || cost === null || cost === 0n ||
        balance === null || !Number.isSafeInteger(account?.storage_usage) || account.storage_usage < 0) return false;
    const held = BigInt(account.storage_usage) * cost;
    estimatedOwnerAvailable = balance > held ? balance - held : 0n;
    return estimatedOwnerAvailable >= OWNER_RESERVE + (index <= 3 ? registration : 0n);
  });
  put('vault_native_estimate', ['vault_account', 'protocol'], () => {
    const account = reads.vault_account.value, balance = amount(account?.amount);
    if (!atBlock('vault_account') || reads.protocol.value?.chain_id !== 'testnet' || cost === null || cost === 0n ||
        balance === null || !Number.isSafeInteger(account?.storage_usage) || account.storage_usage < 0) return false;
    const held = BigInt(account.storage_usage) * cost;
    estimatedVaultAvailable = balance > held ? balance - held : 0n;
    return estimatedVaultAvailable >= VAULT_RESERVE + VAULT_STORAGE_MARGIN * cost;
  });

  const after = await inspectSvalinSetupJournal(journalArgs);
  checks.journal_unchanged = isDeepStrictEqual(original, after) ? 'PASS' : 'BLOCKED';
  const finished = safeTime(now);
  if (finished < started) throw new Error('local clock moved backwards');
  try { assertFreshFinalBlock(header, finished); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  const blockers = summarized(checks);
  return { status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : index === 5 ? 'READ_ONLY_FUNDED_VAULT_PROFILE_MATCH' : 'READ_ONLY_STAGE_PROFILE_MATCH',
    stage_id: stageId, pending_original_hash: pendingOriginalHash,
    network: 'testnet', block_hash: hash, block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    checked_at: new Date(finished).toISOString(), review_sha256: identity.review_sha256,
    owner: goal.owner, vault: goal.vault, token: CIRCLE_TESTNET_USDC, payee: SVALIN_PAYEE,
    observed_protocol_version: Number.isSafeInteger(reads.protocol.value?.protocol_version) ? reads.protocol.value.protocol_version : null,
    observed_owner_nonce: reads.owner_key.available && atBlock('owner_key') ? pinnedAccessKeyNonce(reads.owner_key.value?.nonce)?.toString() ?? null : null,
    v11_minimum_protocol_version: MIN_V11_TESTNET_PROTOCOL,
    observed_v11_selected_wasm_features: reportedV11WasmFeatures(reads.protocol.value),
    estimated_owner_available_yocto: estimatedOwnerAvailable?.toString() ?? null,
    estimated_vault_available_yocto: estimatedVaultAvailable?.toString() ?? null,
    checks, blockers, ...flags(), current_state_is_not_authorization: true,
    scope: 'trusted-RPC, pinned FINAL state plus original journal; no independent audit, consensus proof, backups, consent or seller delivery' };
}
