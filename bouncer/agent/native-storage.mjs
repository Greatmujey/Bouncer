/**
 * Guarded public NEAR protocol storage, on the separate fresh-state V14
 * testnet prototype. Not an independent storage purchase or confidentiality.
 * One exact zero-deposit call is signed, its hash journaled, and sent once.
 * Reconciliation checks that same original and the current public object.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertJournalScope } from './journal-write.mjs';
import { readNativeJournal, writeConfirmedNativeJournal, assertNativeJournalUnchanged } from './synchronous-native-journal.mjs';
import { validateNativeBroadcastGuard, checkNativeBroadcastGuard } from './native-broadcast-guard.mjs';
import {validateNativeOriginalCheckpoint,retainNativeOriginalBeforeBroadcast} from './native-original-checkpoint.mjs';

const VERSION = 'bouncer-agent-v14-native-storage-testnet';
const GAS = 100n * 10n ** 12n;
const U128_MAX = (1n << 128n) - 1n;
const fields = ['id', 'contract_id', 'contract_code_hash', 'owner_account_id', 'policy_id', 'amount', 'object_id', 'value', 'route'];
const routeFields = ['prefix', 'max_value_bytes', 'route_revision', 'policy_revision', 'payee_revision', 'active'];
const objectFields = ['policy_id', 'object_id', 'value', 'value_sha256', 'value_bytes', 'stake_yocto'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const equal = isDeepStrictEqual;
const size = value => Buffer.byteLength(value, 'utf8');
function u128(value, label, positive = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > U128_MAX || (positive && value === '0')) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.length || size(value) > max) throw new Error(`invalid ${label}`);
  return value;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${label}`);
  return value;
}
function name(value, label, max) {
  if (!/^[A-Za-z0-9_-]+$/.test(text(value, label, max))) throw new Error(`invalid ${label}`);
  return value;
}

/** The value is always PUBLIC; pass no passwords, seeds or private data. */
export function validateNativeStorageGoal(value) {
  if (!exact(value, fields) || !exact(value.route, routeFields)) throw new Error('storage goal must contain exactly the reviewed fields');
  const id = name(value.id, 'storage goal id', 64);
  if (!isTestnetAccount(value.contract_id) || !isTestnetAccount(value.owner_account_id) || !isTransactionHash(value.contract_code_hash)) {
    throw new Error('named testnet owner, vault and reviewed contract code hash required');
  }
  const policy = text(value.policy_id, 'storage policy', 128), object = name(value.object_id, 'storage object id', 64);
  const route = { prefix: name(value.route.prefix, 'storage prefix', 48),
    max_value_bytes: integer(value.route.max_value_bytes, 'storage size limit', 1, 4096),
    route_revision: integer(value.route.route_revision, 'storage route revision', 1, Number.MAX_SAFE_INTEGER),
    policy_revision: integer(value.route.policy_revision, 'storage policy revision', 1, Number.MAX_SAFE_INTEGER),
    payee_revision: integer(value.route.payee_revision, 'storage payee revision', 1, Number.MAX_SAFE_INTEGER), active: value.route.active };
  if (route.active !== true || !object.startsWith(route.prefix)) throw new Error('storage object is outside the active reviewed route');
  const content = text(value.value, 'PUBLIC storage value', route.max_value_bytes);
  const amount = u128(value.amount, 'storage maximum', true);
  return { id, contract_id: value.contract_id, contract_code_hash: value.contract_code_hash, owner_account_id: value.owner_account_id, policy_id: policy,
    amount: amount.toString(), object_id: object, value: content, route };
}
const fingerprint = goal => crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex');
const argsFor = goal => ({ policy_id: goal.policy_id, amount: goal.amount, object_id: goal.object_id, value: goal.value, expected_route: goal.route });
function decodeJson(value, label, maximum = 65_536) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) throw new Error(`invalid ${label}`);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid ${label}`); }
}
function successful(status) {
  return plain(status) && status.Failure === undefined &&
    ((typeof status.SuccessValue === 'string' && status.SuccessReceiptId === undefined) ||
     (typeof status.SuccessReceiptId === 'string' && status.SuccessValue === undefined));
}
export async function assertPinnedNativeStorageVault(provider, goal, reference) {
  if (typeof provider?.viewAccount !== 'function' || typeof provider?.viewAccessKeyList !== 'function') {
    throw new Error('trusted RPC must verify the pinned, keyless V14 vault');
  }
  const [account, keys] = await Promise.all([
    provider.viewAccount(goal.contract_id, reference), provider.viewAccessKeyList(goal.contract_id, reference),
  ]);
  if (account?.code_hash !== goal.contract_code_hash || !Array.isArray(keys?.keys) || keys.keys.length !== 0) {
    throw new Error('V14 contract code hash or keyless vault does not match the owner review');
  }
}
function validateObject(goal, object) {
  if (!exact(object, objectFields) || object.policy_id !== goal.policy_id || object.object_id !== goal.object_id || object.value !== goal.value ||
      object.value_bytes !== size(goal.value) || object.value_sha256 !== crypto.createHash('sha256').update(goal.value, 'utf8').digest('hex')) {
    throw new Error('public storage object differs from the reviewed value');
  }
  const stake = u128(object.stake_yocto, 'storage stake', true);
  if (stake > BigInt(goal.amount)) throw new Error('storage stake exceeds the reviewed maximum');
  return object;
}

/** Trusted-RPC evidence, not an independent storage-provider or availability proof. */
export async function verifyNativeStorageResult(rawGoal, result, publicKey, provider) {
  const goal = validateNativeStorageGoal(rawGoal), tx = result?.transaction, txHash = result?.transaction_outcome?.id;
  if (result?.final_execution_status !== 'FINAL' || typeof result?.status?.SuccessValue !== 'string' || !isTransactionHash(txHash) ||
      !tx || tx.hash !== txHash || tx.signer_id !== goal.owner_account_id || tx.receiver_id !== goal.contract_id ||
      (publicKey !== undefined && tx.public_key !== String(publicKey)) || !Array.isArray(tx.actions) || tx.actions.length !== 1) {
    throw new Error('storage transaction is not the reviewed successful FINAL original');
  }
  const call = tx.actions[0]?.FunctionCall;
  if (!call || call.method_name !== 'execute_native_storage' || String(call.deposit) !== '0' ||
      !equal(decodeJson(call.args, 'storage transaction arguments'), argsFor(goal))) throw new Error('signed storage call differs from review');
  if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length || result.receipts_outcome.some(r => !successful(r?.outcome?.status)) ||
      !Array.isArray(result.receipts)) throw new Error('storage receipts are failed, missing or incomplete');
  const parent = result.transaction_outcome?.outcome?.status?.SuccessReceiptId;
  if (!isTransactionHash(parent)) throw new Error('storage transaction has no action receipt');
  const executed = result.receipts_outcome.filter(r => r.id === parent && r.outcome?.executor_id === goal.contract_id &&
    r.outcome?.logs?.includes('BOUNCER public native storage written; stake reserved') && typeof r.outcome?.status?.SuccessValue === 'string');
  const receipts = result.receipts.filter(r => r.receipt_id === parent && r.predecessor_id === goal.owner_account_id && r.receiver_id === goal.contract_id);
  const actions = receipts[0]?.receipt?.Action?.actions;
  const receiptCall = actions?.[0]?.FunctionCall;
  if (executed.length !== 1 || receipts.length !== 1 || !Array.isArray(actions) || actions.length !== 1 ||
      receiptCall?.method_name !== 'execute_native_storage' || String(receiptCall.deposit) !== '0' ||
      !equal(decodeJson(receiptCall.args, 'storage receipt arguments'), argsFor(goal))) throw new Error('missing exact Bouncer storage receipt');
  if (!isTransactionHash(executed[0].block_hash)) throw new Error('storage receipt block is unavailable');
  await assertPinnedNativeStorageVault(provider, goal, { blockId: executed[0].block_hash });
  const receiptObject = validateObject(goal, decodeJson(executed[0].outcome.status.SuccessValue, 'storage receipt result'));
  const returnedObject = validateObject(goal, decodeJson(result.status.SuccessValue, 'storage final result'));
  if (!equal(receiptObject, returnedObject) || !provider || typeof provider.callFunction !== 'function') throw new Error('storage results do not match');
  await assertPinnedNativeStorageVault(provider, goal, { finality: 'final' });
  const current = await provider.callFunction(goal.contract_id, 'get_native_storage_object',
    { policy_id: goal.policy_id, object_id: goal.object_id }, { finality: 'final' });
  if (!equal(validateObject(goal, current), receiptObject)) throw new Error('current public storage object no longer matches the original');
  return { tx_hash: txHash, asset: 'NEAR', maximum_yocto: goal.amount, stake_yocto: receiptObject.stake_yocto,
    result: structuredClone(receiptObject), verification: 'trusted RPC, final Bouncer receipt and current public on-chain object; self-hosted, no independent storage or permanence proof' };
}

async function recoverUnlocked({ goal: raw, provider, journal, publicKey, update = true, log = console.log }) {
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate native storage');
  const goal = validateNativeStorageGoal(raw);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('storage recovery requires the original journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const existing = readNativeJournal(journal, goal.id), previous = existing ? structuredClone(existing) : existing;
  if (!previous || previous.fingerprint !== fingerprint(goal) || !equal(previous.storage_goal, goal) || !['pending', 'completed'].includes(previous.status)) {
    throw new Error(`${goal.id}: storage journal does not match the reviewed goal`);
  }
  if (!isTransactionHash(previous.tx_hash)) throw new Error(`${goal.id}: original hash unavailable; reconcile manually, never resend`);
  const signedBy = previous.agent_public_key || (publicKey && String(publicKey));
  if (typeof signedBy !== 'string' || !signedBy || (publicKey && signedBy !== String(publicKey))) throw new Error('original storage signing key is missing or changed');
  const chain = await provider.txStatusReceipts(previous.tx_hash, goal.owner_account_id, 'FINAL');
  const delivery = await verifyNativeStorageResult(goal, chain, signedBy, provider);
  if (delivery.tx_hash !== previous.tx_hash) throw new Error('RPC returned a different storage transaction');
  if (previous.status === 'completed' && previous.delivery && !equal(previous.delivery, delivery)) throw new Error('recorded storage delivery differs from chain');
  if (update && previous.status !== 'completed') writeConfirmedNativeJournal(journal, goal.id,
    { ...previous, status: 'completed', delivery, completed_at: new Date().toISOString() }, previous);
  log(`[storage] REUSED ${goal.id}: ${delivery.tx_hash}; no new transaction`);
  return { status: 'REUSED', delivery };
}

async function runUnlocked({ goal: raw, provider, account, publicKey, journal, execute = false, log = console.log, beforeBroadcast, beforeOriginalBroadcast }) {
  validateNativeBroadcastGuard(beforeBroadcast);
  validateNativeOriginalCheckpoint(beforeOriginalBroadcast);
  if (journal?.sharedDirectV3 === true) throw new Error('shared buyer journal does not coordinate native storage');
  const goal = validateNativeStorageGoal(raw);
  assertJournalScope(journal, goal.contract_id, goal.owner_account_id);
  if (!account || account.accountId !== goal.owner_account_id || !publicKey) throw new Error('storage agent key does not match the owner');
  if (execute && (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function')) throw new Error('storage execution requires the original journal');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' };
  await assertPinnedNativeStorageVault(provider, goal, final);
  const [version, owner, access] = await Promise.all([
    provider.callFunction(goal.contract_id, 'contract_version', {}, final),
    provider.callFunction(goal.contract_id, 'get_owner', {}, final),
    provider.viewAccessKey(goal.owner_account_id, publicKey, final),
  ]);
  if (version !== VERSION || owner !== goal.owner_account_id) throw new Error('storage requires the separate V14 testnet vault and reviewed owner');
  const permission = access?.permission?.FunctionCall;
  if (!permission || permission.receiver_id !== goal.contract_id || !equal(permission.method_names, ['execute_native_storage'])) {
    throw new Error('storage agent key must be scoped ONLY to execute_native_storage on this vault');
  }
  const previous = journal ? readNativeJournal(journal, goal.id) : undefined;
  if (previous && previous.fingerprint !== fingerprint(goal)) throw new Error('storage journal does not match the reviewed goal');
  if (previous) return recoverUnlocked({ goal, provider, journal, publicKey, update: execute, log });
  const [policy, route, allowed, verdict, reserved] = await Promise.all([
    provider.callFunction(goal.contract_id, 'get_policy', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'get_native_storage_route', { policy_id: goal.policy_id }, final),
    provider.callFunction(goal.contract_id, 'is_agent_key_allowed', { policy_id: goal.policy_id, public_key: String(publicKey) }, final),
    provider.callFunction(goal.contract_id, 'check', { policy_id: goal.policy_id, payee: goal.contract_id, amount: goal.amount }, final),
    provider.callFunction(goal.contract_id, 'native_storage_id_reserved', { policy_id: goal.policy_id, object_id: goal.object_id }, final),
  ]);
  if (!policy || policy.token !== 'native' || !equal(route, goal.route) || allowed !== true || reserved !== false) {
    throw new Error('storage policy, route, key grant or unused object ID does not match the review');
  }
  if (!Array.isArray(verdict) || verdict.length !== 2 || typeof verdict[0] !== 'boolean') throw new Error('invalid storage policy verdict');
  if (!verdict[0]) return { status: 'BLOCKED' };
  if (!execute) { log(`[storage] READY ${goal.id}: public on-chain storage, maximum ${goal.amount} yoctoNEAR (dry run)`); return { status: 'READY' }; }
  if (typeof provider.sendTransactionOnce !== 'function') throw new Error('storage execution requires a one-shot transaction transport');
  checkNativeBroadcastGuard(beforeBroadcast);
  const { txHash, signed } = await signReviewedCall({ account, publicKey, ownerId: goal.owner_account_id, contractId: goal.contract_id,
    method: 'execute_native_storage', args: argsFor(goal), gas: GAS });
  if (!isTransactionHash(txHash)) throw new Error('signer returned an invalid storage transaction hash');
  const pending = { fingerprint: fingerprint(goal), status: 'pending', storage_goal: goal, agent_public_key: String(publicKey),
    tx_hash: txHash, started_at: new Date().toISOString() };
  writeConfirmedNativeJournal(journal, goal.id, pending, null);
  if(beforeOriginalBroadcast) await retainNativeOriginalBeforeBroadcast(beforeOriginalBroadcast,
    {goalId:goal.id,kind:'storage',txHash,fingerprint:pending.fingerprint,owner:goal.owner_account_id,vault:goal.contract_id});
  try {
    checkNativeBroadcastGuard(beforeBroadcast);
    assertNativeJournalUnchanged(journal, goal.id, pending);
    const sent = await provider.sendTransactionOnce(signed, 'FINAL');
    if (sent?.transaction_outcome?.id !== txHash) throw new Error('RPC returned a different storage transaction hash');
    const chain = await provider.txStatusReceipts(txHash, goal.owner_account_id, 'FINAL');
    const delivery = await verifyNativeStorageResult(goal, chain, publicKey, provider);
    if (delivery.tx_hash !== txHash) throw new Error('RPC returned a different storage transaction');
    writeConfirmedNativeJournal(journal, goal.id, { ...pending, status: 'completed', delivery, completed_at: new Date().toISOString() }, pending);
    log(`[storage] FULFILLED ${goal.id}: ${txHash}; reserved ${delivery.stake_yocto} yoctoNEAR`);
    return { status: 'FULFILLED', delivery };
  } catch (error) {
    throw new Error(`${goal.id}: storage original unresolved (tx ${txHash}); do not resend automatically: ${error.message}`, { cause: error });
  }
}
export async function recoverNativeStorageGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => recoverUnlocked(options), options?.exclusiveJournalScope);
}
export async function runNativeStorageGoal(options) {
  return withExclusiveJournalOperation(options?.journal, () => runUnlocked(options), options?.exclusiveJournalScope);
}
