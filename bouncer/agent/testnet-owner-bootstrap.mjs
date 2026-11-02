/** One helper request for a newly generated, TESTNET-ONLY owner identity.
 * No key generation or signing is done here; the caller must already hold and
 * back up the corresponding private key outside the repository. A durable
 * attempt fence MUST be recorded before the single helper POST. An ambiguous
 * response is reconciled by FINAL views, never by repeating the POST. */
import nearApi from 'near-api-js';
import { setTimeout as delay } from 'node:timers/promises';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';

export const OWNER_HELPER_URL = 'https://helper.testnet.near.org/account';
const U128_MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= U128_MAX;

/** The public plan contains no secret and accepts only a unique new Bouncer
 * testnet owner, never an existing user-selected wallet or a mainnet ID. */
export function validateOwnerBootstrapPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).sort().join(',') !==
      'account_id,network,public_key,purpose,version' || plan.version !== 1 || plan.network !== 'testnet' ||
      plan.purpose !== 'new-bouncer-testnet-owner' ||
      typeof plan.account_id !== 'string' || !/^bouncer-owner-[a-f0-9]{24}\.testnet$/.test(plan.account_id)) {
    throw new Error('invalid public testnet-owner plan');
  }
  try {
    const key = nearApi.utils.PublicKey.from(plan.public_key);
    if (key.keyType !== 0 || String(key) !== plan.public_key || !plan.public_key.startsWith('ed25519:')) throw Error();
  } catch { throw new Error('invalid public testnet-owner key'); }
  return { ...plan };
}

async function snapshot(provider, plan, now) {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('owner bootstrap requires testnet');
  const block = await provider.viewBlock({ finality: 'final' });
  const fresh = assertFreshFinalBlock(block, now());
  const presence = await provider.viewTestnetAccountPresenceAt(plan.account_id, fresh.hash);
  if (presence?.block_hash !== fresh.hash || typeof presence.exists !== 'boolean') throw new Error('owner presence is unknown');
  return { fresh, presence };
}
async function verifyNewOwner(provider, plan, fresh, presence) {
  const a = presence.account;
  if (!hasPlainOwnerProfileAt(a, fresh.hash) || !uint(a.amount) || a.amount === '0' || !uint(a.locked) || a.locked !== '0') {
    throw new Error('new owner does not have the expected funded plain-account profile');
  }
  const result = await provider.query({ request_type: 'view_access_key_list', account_id: plan.account_id, block_id: fresh.hash });
  if (result?.block_hash !== fresh.hash || !Array.isArray(result.keys) || result.keys.length !== 1 ||
      result.keys[0]?.public_key !== plan.public_key || result.keys[0]?.access_key?.permission !== 'FullAccess') {
    throw new Error('new owner key list differs; stop and inspect, do not retry the helper');
  }
  return { block_hash: fresh.hash, block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    native_balance_yocto: a.amount, owner_key_count: 1, expected_full_access_public_key: plan.public_key };
}

/** persistAttempt MUST durably preserve the public plan and execution identity
 * before returning true. This function makes AT MOST ONE POST, even if the
 * helper times out, rejects the request, or the account view stays unknown. */
export async function requestTestnetOwnerOnce({ plan: raw, provider, persistAttempt, fetchImpl = globalThis.fetch,
  now = Date.now, pause = delay, maxViews = 20 } = {}) {
  const plan = validateOwnerBootstrapPlan(raw);
  if (!provider || ['viewNodeStatus', 'viewBlock', 'viewTestnetAccountPresenceAt', 'query'].some(k => typeof provider[k] !== 'function') ||
      typeof persistAttempt !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof pause !== 'function' || !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 30) {
    throw new Error('guarded one-shot bootstrap dependencies are required');
  }
  const before = await snapshot(provider, plan, now);
  if (before.presence.exists) throw new Error('owner name already exists at FINAL; do not use or retry');
  if (await persistAttempt({ ...plan, before_block_hash: before.fresh.hash }) !== true) {
    throw new Error('durable owner-bootstrap attempt fence was not established');
  }
  let acknowledgement = 'UNKNOWN';
  try {
    const response = await fetchImpl(OWNER_HELPER_URL, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ newAccountId: plan.account_id, newAccountPublicKey: plan.public_key }),
      signal: AbortSignal.timeout(60_000) });
    if (response?.ok === true) acknowledgement = 'ACKNOWLEDGED';
    try { await response?.body?.cancel(); } catch { /* untrusted body is never printed */ }
  } catch { /* The helper may have acted despite a lost response. Never resend. */ }

  let latestError = 'owner has not been verified';
  for (let i = 0; i < maxViews; i++) {
    try {
      const after = await snapshot(provider, plan, now);
      if (after.presence.exists) {
        // A mismatched key/profile is a hard stop, not a reason to retry.
        const proof = await verifyNewOwner(provider, plan, after.fresh, after.presence);
        return { status: 'OWNER_OBSERVED_AT_FINAL', network: 'testnet', account_id: plan.account_id,
          helper_acknowledgement: acknowledgement, ...proof, private_key_checked_by_runner: false,
          owner_backup_checked_by_runner: false, circle_usdc_funded: false, vault_deployed: false,
          signed: false, seller_contacted: false, do_not_repeat_helper_request: true,
          scope: 'one public helper request and trusted-RPC views; this is not a receipt proof or evidence of backup export' };
      }
    } catch (error) {
      if (/expected funded plain-account profile|owner key list differs/.test(error?.message ?? '')) throw error;
      latestError = 'a fresh matching FINAL view is unavailable';
    }
    if (i + 1 < maxViews) await pause(1000);
  }
  throw new Error(`original helper request for ${plan.account_id} remains unresolved (${latestError}); retain the fence and reconcile, never resend`);
}
