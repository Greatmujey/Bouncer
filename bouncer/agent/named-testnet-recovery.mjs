/** One helper request to create the user-requested, previously uncreated
 * TESTNET account for the Circle balance already registered to its name.
 * The corresponding secret stays local. An attempt fence is mandatory before
 * the request; an ambiguous outcome is reconciled by views, never retried. */
import nearApi from 'near-api-js';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectNamedTestnetAccount } from './named-testnet-inventory.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';

const NAME = 'greatmujey.testnet';
const TOKEN_HASH = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z';
const ATOMS = '40000000';
const HELPER = 'https://helper.testnet.near.org/account';
const fields = ['version', 'purpose', 'network', 'account_id', 'public_key', 'circle_token', 'circle_code_hash', 'observed_circle_atoms'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function validateNamedRecoveryPlan(value) {
  if (!record(value) || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k)) ||
      value.version !== 1 || value.purpose !== 'user-requested-uncreated-testnet-account-recovery' ||
      value.network !== 'testnet' || value.account_id !== NAME || value.circle_token !== CIRCLE_TESTNET_USDC ||
      value.circle_code_hash !== TOKEN_HASH || value.observed_circle_atoms !== ATOMS) throw new Error('invalid fixed testnet recovery plan');
  try {
    const key = nearApi.utils.PublicKey.from(value.public_key);
    if (key.keyType !== 0 || String(key) !== value.public_key) throw Error();
  } catch { throw new Error('invalid recovery public key'); }
  return { ...value };
}
function expectedCircle(view, plan) {
  return view?.circle_token === plan.circle_token && view.circle_code_hash === plan.circle_code_hash &&
    view.circle_balance_atoms === plan.observed_circle_atoms && view.circle_registration === 'REGISTERED_AT_VIEW';
}
async function beforeRequest(provider, plan, now) {
  const view = await inspectNamedTestnetAccount({ provider, accountId: plan.account_id, now });
  if (view.account_status !== 'ABSENT_AT_FINAL' || !expectedCircle(view, plan)) {
    throw new Error('the named account is not provably absent or the registered test-USDC balance differs; no helper request');
  }
  return view;
}

/** Only a code-free account with the exact public key and the original Circle
 * balance counts as success. RPC errors and wrong-block responses are unknown. */
async function verifyPresent(provider, view, plan) {
  if (!expectedCircle(view, plan)) throw new Error('created account Circle state differs; stop and reconcile');
  let presence, keys;
  try {
    [presence, keys] = await Promise.all([
      provider.viewTestnetAccountPresenceAt(plan.account_id, view.block_hash),
      provider.query({ request_type: 'view_access_key_list', account_id: plan.account_id, block_id: view.block_hash }),
    ]);
  } catch { return null; }
  if (presence?.block_hash !== view.block_hash || presence.exists !== true || keys?.block_hash !== view.block_hash) return null;
  const a = presence.account;
  if (!hasPlainOwnerProfileAt(a, view.block_hash) || typeof a.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(a.amount) ||
      BigInt(a.amount) > (1n << 128n) - 1n || a.locked !== '0' || !Array.isArray(keys.keys) || keys.keys.length !== 1 ||
      keys.keys[0]?.public_key !== plan.public_key || keys.keys[0]?.access_key?.permission !== 'FullAccess') {
    throw new Error('created account profile or public key differs; stop and reconcile');
  }
  return { block_hash: view.block_hash, block_timestamp: view.block_timestamp, native_balance_yocto: a.amount,
    full_access_public_key: plan.public_key, circle_balance_atoms: view.circle_balance_atoms,
    circle_registration: view.circle_registration, circle_code_hash: view.circle_code_hash };
}

/** persistAttempt must confirm the durable public fence before the sole POST.
 * This function signs no transaction and never receives the private key. */
export async function recoverNamedTestnetOnce({ plan: raw, provider, persistAttempt, fetchImpl = globalThis.fetch,
  now = Date.now, pause = delay, maxViews = 20 } = {}) {
  const plan = validateNamedRecoveryPlan(raw);
  if (!provider || typeof persistAttempt !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof pause !== 'function' || !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 30) {
    throw new Error('guarded named-account recovery dependencies required');
  }
  const before = await beforeRequest(provider, plan, now);
  if (await persistAttempt({ account_id: plan.account_id, public_key: plan.public_key,
      circle_balance_atoms: plan.observed_circle_atoms, before_block_hash: before.block_hash }) !== true) {
    throw new Error('durable named-account attempt fence was not established; no helper request');
  }
  // The fence may have taken time. Recheck immediately before the one POST;
  // another account creation can still race between this view and the helper.
  await beforeRequest(provider, plan, now);
  let acknowledgement = 'UNKNOWN';
  try {
    const response = await fetchImpl(HELPER, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ newAccountId: plan.account_id, newAccountPublicKey: plan.public_key }),
      signal: AbortSignal.timeout(60_000) });
    if (response?.ok === true) acknowledgement = 'ACKNOWLEDGED';
    try { await response?.body?.cancel(); } catch { /* untrusted body is not logged */ }
  } catch { /* It may have acted despite a lost response: never repeat the POST. */ }

  for (let i = 0; i < maxViews; i++) {
    let view;
    try { view = await inspectNamedTestnetAccount({ provider, accountId: plan.account_id, now }); } catch { /* unknown */ }
    if (view?.account_status === 'PRESENT_AT_FINAL') {
      const verified = await verifyPresent(provider, view, plan);
      if (verified) {
        // Do not report an old snapshot as a current recovery after slow reads.
        const millis = Date.parse(view.block_timestamp);
        assertFreshFinalBlock({ header: { hash: view.block_hash, timestamp_nanosec: String(BigInt(millis) * 1_000_000n) } }, now());
        return { status: 'NAMED_TESTNET_ACCOUNT_OBSERVED_AT_FINAL', account_id: plan.account_id,
        network: 'testnet', helper_acknowledgement: acknowledgement, ...verified,
        private_key_sent_to_runner: false, off_device_backup_verified: false, signed: false, sent: false,
        seller_contacted: false, do_not_repeat_helper_request: true,
        scope: 'single helper request and trusted-RPC FINAL views; not receipt proof, backup verification, vault funding or provider delivery' };
      }
    }
    if (i + 1 < maxViews) await pause(1000);
  }
  throw new Error(`original helper request for ${plan.account_id} is unresolved; retain the fence and reconcile, never retry`);
}
