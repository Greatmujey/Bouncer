/**
 * Explicitly reviewed native-NEAR sequence: OutLayer compute and API data,
 * plus V14 PUBLIC, self-hosted NEAR protocol storage. Preview is the default;
 * resource legs are non-atomic. Local journal locking is cooperative only.
 * This is not proof of independent storage or live/provider fulfillment.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateOutlayerGoal } from './outlayer.mjs';
import { marketQuantity, marketInputFromOracle } from './market-summary.mjs';
import { validateOracleGoal, assertOracleFreshForUse } from './oracle-outlayer.mjs';
import { validateNativeStorageGoal, assertPinnedNativeStorageVault } from './native-storage.mjs';
import { runNativeResource } from './mixed-mission.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertJournalScope } from './journal-write.mjs';
import { readNativeJournal, writeConfirmedNativeJournal } from './synchronous-native-journal.mjs';
import {validateNativeOriginalCheckpoint,verifyNativeOriginalCheckpoint} from './native-original-checkpoint.mjs';

const MAX_U128 = (1n << 128n) - 1n;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const copy = value => value === undefined ? undefined : structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function amount(value, label, { zero = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 39) throw new Error(`invalid ${label}`);
  const n = BigInt(value);
  if (n > MAX_U128 || (!zero && n === 0n)) throw new Error(`invalid ${label}`);
  return n;
}
const resourceOf = kind => ['random','market'].includes(kind) ? 'compute' : kind === 'storage' ? 'storage' : 'api';
const allResources = ['compute', 'storage', 'api'];
const manifestId = mission => `native-mission:${mission.id}`; // payable goal ids cannot contain ':'
const fingerprint = mission => crypto.createHash('sha256').update(`bouncer-native-mission-v1\0${JSON.stringify(mission)}`).digest('hex');

/** Strictly snapshot all authority before any async provider or signer call. */
export function validateNativeMission(raw) {
  if (!exact(raw, ['version', 'id', 'contract_id', 'owner_account_id', 'max_native_amount', 'required_resources', 'goals']) ||
      raw.version !== 1 || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ||
      !isTestnetAccount(raw.contract_id) || !isTestnetAccount(raw.owner_account_id)) throw new Error('invalid native mission identity or fields');
  const maximum = amount(raw.max_native_amount, 'mission native maximum');
  if (!Array.isArray(raw.required_resources) || raw.required_resources.length < 1 || raw.required_resources.length > 3 ||
      raw.required_resources.some(r => !['compute', 'storage', 'api'].includes(r)) ||
      new Set(raw.required_resources).size !== raw.required_resources.length) throw new Error('invalid required native mission resources');
  if (!Array.isArray(raw.goals) || raw.goals.length < 1 || raw.goals.length > 10) throw new Error('native mission requires 1 to 10 goals');
  const ids = new Map(); let total = 0n;
  const goals = raw.goals.map(item => {
    if (!exact(item, ['kind', 'goal']) || !['random', 'market', 'oracle', 'storage'].includes(item.kind)) throw new Error('unsupported native mission goal');
    let goal;
    if (item.kind === 'market') {
      const reference = item.goal?.input;
      if (!exact(reference, ['from_goal_id', 'quantity']) || ids.get(reference.from_goal_id) !== 'oracle') {
        throw new Error('market calculation must reference one earlier verified oracle goal');
      }
      const quantity = marketQuantity(reference.quantity);
      // Validate all financial/program fields now. This placeholder is only
      // used for a read-only preflight, never as a live calculation input.
      goal = validateOutlayerGoal({ ...item.goal, input: {
        price_usd_micros: 1, quantity, oracle_tx_hash: '1'.repeat(32),
      } });
      goal.input = { from_goal_id: reference.from_goal_id, quantity };
    } else if (item.kind === 'storage' && typeof item.goal?.value !== 'string') {
      const reference = item.goal?.value;
      if (!exact(reference, ['from_goal_ids']) || !Array.isArray(reference.from_goal_ids) || !reference.from_goal_ids.length ||
          reference.from_goal_ids.length > 2 || new Set(reference.from_goal_ids).size !== reference.from_goal_ids.length ||
          reference.from_goal_ids.some(id => typeof id !== 'string' || !['random', 'market', 'oracle'].includes(ids.get(id)))) {
        throw new Error('storage may reference only distinct earlier verified compute or oracle goals');
      }
      goal = validateNativeStorageGoal({ ...item.goal, value: 'pending verified results' });
      if (goal.route.max_value_bytes !== 4096) throw new Error('result storage requires a 4096-byte owner limit');
      goal.value = { from_goal_ids: [...reference.from_goal_ids] };
    } else {
      goal = item.kind === 'oracle' ? validateOracleGoal(item.goal) : item.kind === 'storage'
        ? validateNativeStorageGoal(item.goal) : validateOutlayerGoal(item.goal);
      if (item.kind === 'random' && !Object.hasOwn(goal.input, 'min')) throw new Error('random goal requires random input');
    }
    if (goal.contract_id !== raw.contract_id || goal.owner_account_id !== raw.owner_account_id) throw new Error('all native goals must share one reviewed owner and vault');
    if (ids.has(goal.id)) throw new Error('native mission goal ids must be unique');
    ids.set(goal.id, item.kind); total += BigInt(goal.amount);
    if (total > maximum) throw new Error('native goal maximums exceed the owner-reviewed mission maximum');
    return { kind: item.kind, goal };
  });
  if (new Set(goals.filter(item => item.kind === 'storage').map(item => item.goal.contract_code_hash)).size > 1) {
    throw new Error('all storage goals must pin the same V14 vault code');
  }
  return freeze({ version: 1, id: raw.id, contract_id: raw.contract_id, owner_account_id: raw.owner_account_id,
    max_native_amount: maximum.toString(), required_resources: [...raw.required_resources], goals });
}

/** Non-atomic conservative snapshot, not a reservation or substitute for the on-chain policy. */
export async function previewNativeMissionBudget({ mission, remaining, provider }) {
  if (!Array.isArray(remaining) || !provider || typeof provider.callFunction !== 'function') throw new Error('invalid native mission budget request');
  if (!remaining.length) return { status: 'READY', required_yocto: '0', policies: [] };
  const groups = new Map();
  for (const item of remaining) {
    const policy = item.goal.policy_id;
    const group = groups.get(policy) ?? { required: 0n, amounts: [] };
    group.required += amount(item.goal.amount, 'native goal maximum');
    group.amounts.push(BigInt(item.goal.amount)); groups.set(policy, group);
  }
  const total = [...groups.values()].reduce((n, item) => n + item.required, 0n);
  const final = { finality: 'final' }, policies = [];
  for (const [policyId, group] of groups) {
    const [policy, spentValue] = await Promise.all([
      provider.callFunction(mission.contract_id, 'get_policy', { policy_id: policyId }, final),
      provider.callFunction(mission.contract_id, 'daily_spent', { policy_id: policyId }, final),
    ]);
    if (!policy || policy.token !== 'native') throw new Error(`native policy ${policyId} is missing or changed`);
    const perTx = amount(policy.per_tx_cap, 'per-transaction cap', { zero: true });
    const daily = amount(policy.daily_cap, 'rolling cap', { zero: true });
    const spent = amount(spentValue, 'rolling spend', { zero: true });
    const check = { policy_id: policyId, required_yocto: group.required.toString(), spent_yocto: spent.toString(),
      rolling_cap_yocto: daily.toString(), per_tx_cap_yocto: perTx.toString() };
    policies.push(check);
    if (daily === 0n) return { status: 'BLOCKED', reason: 'rolling-budget-required', policy_id: policyId, required_yocto: total.toString(), policies };
    if (group.amounts.some(n => n > perTx)) return { status: 'BLOCKED', reason: 'per-transaction-cap', policy_id: policyId, required_yocto: total.toString(), policies };
    if (spent + group.required > daily) return { status: 'BLOCKED', reason: 'rolling-budget', policy_id: policyId, required_yocto: total.toString(), policies };
  }
  const balance = amount(await provider.callFunction(mission.contract_id, 'vault_balance', { token: 'native' }, final), 'native vault balance', { zero: true });
  return { status: balance >= total ? 'READY' : 'BLOCKED', ...(balance >= total ? {} : { reason: 'native-vault-balance' }),
    required_yocto: total.toString(), available_yocto: balance.toString(), policies };
}

function initialJournal(mission, journal) {
  if (!journal) return { intent: undefined, entries: new Map(mission.goals.map(({ goal }) => [goal.id, undefined])) };
  const intent = copy(readNativeJournal(journal, manifestId(mission))), fp = fingerprint(mission);
  if (intent && (intent.kind !== 'native-mission-intent-v1' || intent.status !== 'pending' || intent.fingerprint !== fp ||
      !isDeepStrictEqual(intent.mission, mission))) throw new Error('native mission journal does not match the reviewed manifest');
  const entries = new Map(mission.goals.map(({ goal }) => [goal.id, copy(readNativeJournal(journal, goal.id))]));
  if (!intent && [...entries.values()].some(Boolean)) throw new Error('native mission manifest is missing; reconcile the existing originals before any new work');
  let stopped = false;
  for (const entry of entries.values()) {
    if (!entry) { stopped = true; continue; }
    if (stopped || !['pending', 'completed'].includes(entry.status)) throw new Error('native mission has out-of-order or invalid original entries');
    if (entry.status === 'pending') stopped = true;
  }
  return { intent, entries };
}
function assertSnapshot(mission, journal, state, exceptId) {
  if (!journal) return;
  if (!isDeepStrictEqual(copy(readNativeJournal(journal, manifestId(mission))), state.intent)) throw new Error('native mission manifest changed; stop and reconcile');
  for (const [id, expected] of state.entries) {
    if (id !== exceptId && !isDeepStrictEqual(copy(readNativeJournal(journal, id)), expected)) {
      throw new Error('native mission original changed; stop and reconcile');
    }
  }
}
// Deferred data is derived ONLY from prior verified, journal-bound results.
// The on-chain value is public and includes each source's original hash.
function materialize(item, deliveries, { allowPending = false } = {}) {
  if (item.kind === 'market') {
    const source = deliveries.get(item.goal.input.from_goal_id);
    if (!source) {
      if (!allowPending) throw new Error('market oracle dependency has not been verified; stop');
      return { kind: 'market', goal: validateOutlayerGoal({ ...item.goal, input: {
        price_usd_micros: 1, quantity: item.goal.input.quantity, oracle_tx_hash: '1'.repeat(32),
      } }) };
    }
    if (source.kind !== 'oracle') throw new Error('market source is not a verified oracle result');
    const input = marketInputFromOracle(item.goal.input.quantity, source.delivery);
    return { kind: 'market', goal: validateOutlayerGoal({ ...item.goal, input }) };
  }
  if (item.kind !== 'storage' || typeof item.goal.value === 'string') return item;
  const sources = item.goal.value.from_goal_ids.map(id => deliveries.get(id));
  if (sources.some(source => !source)) {
    if (!allowPending) throw new Error('storage dependencies have not been verified; stop');
    return { kind: 'storage', goal: validateNativeStorageGoal({ ...item.goal, value: 'pending verified results' }) };
  }
  const value = JSON.stringify({ schema: 'bouncer-public-mission-results-v1', resources: sources.map(source => ({
    goal_id: source.goal_id, kind: source.kind, tx_hash: source.delivery.tx_hash, result: source.delivery.result,
  })) });
  return { kind: 'storage', goal: validateNativeStorageGoal({ ...item.goal, value }) };
}
function rememberResult(item, result, original, deliveries, { newlyPaid = false } = {}) {
  const delivery = result?.independent?.delivery;
  const goalKey = item.kind === 'oracle' ? 'oracle_goal' : item.kind === 'storage' ? 'storage_goal' : 'outlayer_goal';
  const goalFingerprint = crypto.createHash('sha256').update(JSON.stringify(item.goal)).digest('hex');
  if (!isTransactionHash(delivery?.tx_hash) || original?.tx_hash !== delivery.tx_hash || original?.fingerprint !== goalFingerprint ||
      (original[goalKey] !== undefined && !isDeepStrictEqual(original[goalKey], item.goal)) ||
      (original.delivery !== undefined && !isDeepStrictEqual(original.delivery, delivery)) ||
      (newlyPaid && (!isDeepStrictEqual(original[goalKey], item.goal) || !isDeepStrictEqual(original.delivery, delivery)))) {
    throw new Error('native original or verified delivery changed; stop and reconcile');
  }
  deliveries.set(item.goal.id, { kind: item.kind, goal_id: item.goal.id, delivery: freeze(copy(delivery)),
    oracle_fresh_for_use: result.oracle_fresh_for_use ?? null });
}
function guardFresh(deliveries) {
  for (const item of deliveries.values()) if (item.kind === 'oracle') assertOracleFreshForUse(item.delivery);
}
// When a mission pins V14 through a storage goal, do not accept compute/API
// evidence from another contract version. This is a trusted-RPC, end-of-block
// code/key view, not an atomic guarantee against a same-block upgrade.
async function assertLegExecutedAtPinnedVault(item, result, provider, pinnedStorage) {
  if (!pinnedStorage || item.kind === 'storage') return;
  const hash = result?.independent?.delivery?.tx_hash;
  if (!isTransactionHash(hash) || typeof provider?.txStatusReceipts !== 'function') throw new Error('mission original receipt unavailable');
  const chain = await provider.txStatusReceipts(hash, item.goal.owner_account_id, 'FINAL');
  const parent = chain?.transaction_outcome?.outcome?.status?.SuccessReceiptId;
  const log = item.kind === 'oracle' ? 'BOUNCER independent native project initiated; full maximum reserved' :
    'BOUNCER independent compute initiated; full maximum reserved';
  if (chain?.final_execution_status !== 'FINAL' || chain?.transaction_outcome?.id !== hash || chain?.transaction?.hash !== hash ||
      !isTransactionHash(parent) || !Array.isArray(chain.receipts_outcome)) throw new Error('mission original receipt unavailable');
  const receipts = chain.receipts_outcome.filter(row => row.id === parent && row.outcome?.executor_id === item.goal.contract_id &&
    row.outcome?.logs?.includes(log) && isTransactionHash(row.block_hash));
  if (receipts.length !== 1) throw new Error('mission vault execution block unavailable');
  await assertPinnedNativeStorageVault(provider, pinnedStorage, { blockId:receipts[0].block_hash });
}

/**
 * `signers` is keyed by goal id because compute and oracle methods need
 * differently scoped function-call keys. Injected `runners` are for offline
 * tests only and are not an authorization boundary. Recovery requires no keys.
 */
export async function runNativeMission(options = {}) {
  return withExclusiveJournalOperation(options?.journal, scope => runNativeMissionUnlocked(options, scope), options?.exclusiveJournalScope);
}
async function runNativeMissionUnlocked({ mission: raw, signers = {}, provider, journal, execute = false, recoverOnly = false,
  checkpointGoalId, beforeOriginalBroadcast, afterOriginalVerified, log = console.log, runners = {} }, scope) {
  validateNativeOriginalCheckpoint(beforeOriginalBroadcast);validateNativeOriginalCheckpoint(afterOriginalVerified);
  // Execution requires the pair: retaining without checking a receipt cannot
  // safely advance to a later goal. Recovery receives only the verifier.
  if(execute && (beforeOriginalBroadcast===undefined)!==(afterOriginalVerified===undefined))throw new Error('both native original checkpoint hooks are required');
  if (typeof execute !== 'boolean' || typeof recoverOnly !== 'boolean' || (execute && recoverOnly) || typeof log !== 'function' ||
      !provider || !plain(signers) || !plain(runners) || (checkpointGoalId !== undefined &&
        (!execute || typeof checkpointGoalId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(checkpointGoalId)))) {
    throw new Error('invalid native mission request');
  }
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate native missions');
  if (journal && (typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('invalid native mission journal');
  if ((execute || recoverOnly) && !journal) throw new Error('native mission execution or recovery requires the original exclusive journal');
  if (recoverOnly && Object.keys(signers).length) throw new Error('native mission recovery must not receive signing keys');
  const mission = validateNativeMission(raw);
  const missionSha256=crypto.createHash('sha256').update(JSON.stringify(mission)).digest('hex');
  const beforeForMission=beforeOriginalBroadcast ? input=>beforeOriginalBroadcast(Object.freeze({...input,mission_sha256:missionSha256})) : undefined;
  const afterForMission=afterOriginalVerified ? input=>afterOriginalVerified(Object.freeze({...input,mission_sha256:missionSha256})) : undefined;
  const pinnedStorage = mission.goals.find(item => item.kind === 'storage')?.goal;
  assertJournalScope(journal, mission.contract_id, mission.owner_account_id);
  const state = initialJournal(mission, journal), deliveries = new Map();
  const signerSnapshot = new Map(mission.goals.map(({ goal }) => {
    const signer = signers[goal.id] ?? {};
    if (!plain(signer)) throw new Error('invalid native goal signer');
    return [goal.id, { account: signer.account, publicKey: signer.publicKey, recoveryPublicKey: signer.recoveryPublicKey }];
  }));
  const native = runners.native ?? runNativeResource;
  if (typeof native !== 'function') throw new Error('invalid native mission runner');
  const call = (item, extra) => {
    const args = { outlayer: { kind: item.kind, goal: item.goal, ...signerSnapshot.get(item.goal.id) }, provider, journal, log, ...extra };
    return native(native === runNativeResource && journal ? { ...args, exclusiveJournalScope: scope } : args);
  };
  const available = new Set(mission.goals.map(item => resourceOf(item.kind)));
  const missing = mission.required_resources.filter(resource => !available.has(resource));
  const incomplete = allResources.filter(resource => !available.has(resource));
  if (!recoverOnly && missing.length) return { status: 'BLOCKED', stage: 'unsupported-resources', missing_resources: missing,
    new_payments: 0, note: 'A required resource has no supported reviewed goal; nothing was sent.' };

  // Every recorded original is checked by its original hash, before any new
  // payment. Read-only previews do not alter pending entries.
  for (const template of mission.goals) {
    if (!state.entries.get(template.goal.id)) continue;
    const item = materialize(template, deliveries);
    const result = await call(item, { execute: execute || recoverOnly });
    assertSnapshot(mission, journal, state, item.goal.id);
    if (result?.status !== 'NATIVE_RESOURCE_REUSED') throw new Error('native original did not reconcile; never resend');
    const current = copy(readNativeJournal(journal, item.goal.id));
    if (!current || !['pending', 'completed'].includes(current.status) || (execute || recoverOnly) && current.status !== 'completed') {
      throw new Error('native original reconciliation was not retained; stop');
    }
    if (!(execute || recoverOnly) && !isDeepStrictEqual(current, state.entries.get(item.goal.id))) throw new Error('native read-only recovery changed the original');
    await assertLegExecutedAtPinnedVault(item, result, provider, pinnedStorage);
    assertSnapshot(mission, journal, state, item.goal.id);
    if (!isDeepStrictEqual(copy(readNativeJournal(journal, item.goal.id)), current)) throw new Error('native original changed during receipt check');
    if(afterOriginalVerified && (execute || recoverOnly)) {
      await verifyNativeOriginalCheckpoint(afterForMission,{goalId:item.goal.id,kind:item.kind,txHash:current.tx_hash,
        fingerprint:current.fingerprint,owner:mission.owner_account_id,vault:mission.contract_id});
      assertSnapshot(mission,journal,state,item.goal.id);
      if(!isDeepStrictEqual(copy(readNativeJournal(journal,item.goal.id)),current))throw new Error('native original changed during independent verification');
    }
    rememberResult(item, result, current, deliveries);
    state.entries.set(item.goal.id, current);
  }
  const remaining = mission.goals.filter(item => !state.entries.get(item.goal.id));
  if (checkpointGoalId !== undefined && remaining[0]?.goal.id !== checkpointGoalId) {
    throw new Error('authorized checkpoint is not the next unpaid goal; stop and reconcile');
  }
  if (recoverOnly && deliveries.size === 0) throw new Error('native mission has no original payment to recover');
  if (recoverOnly) return { status: !incomplete.length && !remaining.length ? 'RECOVERED' : 'RECOVERED_PARTIAL',
    new_payments: 0, remaining_goal_ids: remaining.map(item => item.goal.id), missing_resources: missing,
    deliveries: [...deliveries.values()], note: 'Original hashes only; no signing or new payment. Storage, when present, is public and self-hosted.' };

  if (remaining.length) {
    try { guardFresh(deliveries); }
    catch { return { status: 'BLOCKED', stage: 'stale-oracle', new_payments: 0, note: 'An earlier oracle is stale; no later payment was sent.' }; }
  }
  // When storage occurs before another leg, it no longer has an unpaid
  // storage preflight. Still pin the same keyless V14 vault for every later
  // call; FINAL RPC views are a conservative check, not an atomic guarantee
  // against a subsequent owner-authorized upgrade.
  if (remaining.length && pinnedStorage) await assertPinnedNativeStorageVault(provider, pinnedStorage, { finality: 'final' });
  // All remaining resource-specific policy/provider/key preflights must pass
  // before the first new signature or payment.
  for (const template of remaining) {
    const item = materialize(template, deliveries, { allowPending: true });
    const result = await call(item, { execute: false });
    assertSnapshot(mission, journal, state);
    if (result?.status === 'BLOCKED') return { status: 'BLOCKED', stage: 'native-preflight', goal_id: item.goal.id, new_payments: 0 };
    if (result?.status !== 'READY') throw new Error('invalid native mission preflight result');
  }
  let budget = await previewNativeMissionBudget({ mission, remaining, provider });
  assertSnapshot(mission, journal, state);
  if (budget.status !== 'READY') return { status: 'BLOCKED', stage: 'budget', budget, new_payments: 0 };
  if (!execute) return { status: incomplete.length ? 'READY_PARTIAL' : 'READY', budget, missing_resources: incomplete, new_payments: 0,
    next_goal_id: remaining[0]?.goal.id ?? null, verified_prior_deliveries: [...deliveries.values()],
    note: 'Read-only preview. Storage is PUBLIC, self-hosted NEAR state, not an independent vendor; no live fulfillment is established.' };

  if (!state.intent && remaining.length) {
    const intent = { kind: 'native-mission-intent-v1', status: 'pending', fingerprint: fingerprint(mission), mission, created_at: new Date().toISOString() };
    writeConfirmedNativeJournal(journal, manifestId(mission), intent, null);
    state.intent = copy(readNativeJournal(journal, manifestId(mission)));
  }
  let newPayments = 0;
  for (let index = 0; index < remaining.length; index++) {
    const item = materialize(remaining[index], deliveries);
    assertSnapshot(mission, journal, state);
    try { guardFresh(deliveries); }
    catch { return { status: 'BLOCKED', stage: 'stale-oracle', goal_id: item.goal.id, new_payments: newPayments }; }
    // Recheck the still-unpaid maximums: an earlier leg or policy edit may
    // have changed the balance or rolling window after the first preview.
    budget = await previewNativeMissionBudget({ mission, remaining: remaining.slice(index), provider });
    assertSnapshot(mission, journal, state);
    if (budget.status !== 'READY') return { status: 'BLOCKED', stage: 'budget', goal_id: item.goal.id, budget, new_payments: newPayments };
    try { guardFresh(deliveries); }
    catch { return { status: 'BLOCKED', stage: 'stale-oracle', goal_id: item.goal.id, new_payments: newPayments }; }
    if (pinnedStorage) await assertPinnedNativeStorageVault(provider, pinnedStorage, { finality: 'final' });
    assertSnapshot(mission, journal, state);
    const result = await call(item, { execute: true, ...(beforeForMission ? {beforeOriginalBroadcast:beforeForMission} : {}), beforeBroadcast: () => {
      guardFresh(deliveries);
      assertSnapshot(mission, journal, state, item.goal.id);
    } });
    assertSnapshot(mission, journal, state, item.goal.id);
    if (result?.status === 'BLOCKED') {
      assertSnapshot(mission, journal, state);
      return { status: 'BLOCKED', stage: 'native-execution', goal_id: item.goal.id, new_payments: newPayments };
    }
    if (result?.status !== 'NATIVE_RESOURCE_FULFILLED') throw new Error('new native resource was not independently verified; stop and reconcile');
    const original = copy(readNativeJournal(journal, item.goal.id));
    if (!original || original.status !== 'completed') throw new Error('native result has no completed original journal entry');
    await assertLegExecutedAtPinnedVault(item, result, provider, pinnedStorage);
    assertSnapshot(mission, journal, state, item.goal.id);
    if (!isDeepStrictEqual(copy(readNativeJournal(journal, item.goal.id)), original)) throw new Error('native original changed during receipt check');
    if(afterOriginalVerified) {
      await verifyNativeOriginalCheckpoint(afterForMission,{goalId:item.goal.id,kind:item.kind,txHash:original.tx_hash,
        fingerprint:original.fingerprint,owner:mission.owner_account_id,vault:mission.contract_id});
      assertSnapshot(mission,journal,state,item.goal.id);
      if(!isDeepStrictEqual(copy(readNativeJournal(journal,item.goal.id)),original))throw new Error('native original changed during independent verification');
    }
    rememberResult(item, result, original, deliveries, { newlyPaid: true });
    state.entries.set(item.goal.id, original);
    newPayments++;
    // A separately approved checkpoint can authorize this one goal only.
    // Never silently advance, including after a lost or delayed response.
    if (checkpointGoalId !== undefined && index + 1 < remaining.length) {
      return { status:'CHECKPOINT', new_payments:newPayments, remaining_goal_ids:remaining.slice(index + 1).map(x=>x.goal.id),
        deliveries:[...deliveries.values()], note:'One approved step completed. Review its result and separately approve the next step.' };
    }
  }
  try { guardFresh(deliveries); }
  catch { return { status: 'BLOCKED', stage: 'stale-oracle', new_payments: newPayments, deliveries: [...deliveries.values()] }; }
  return { status: incomplete.length ? 'FULFILLED_PARTIAL' : 'FULFILLED', new_payments: newPayments,
    missing_resources: incomplete, deliveries: [...deliveries.values()],
    note: 'Native testnet mission; public storage is self-hosted NEAR state, not an independent storage purchase or permanence proof.' };
}
