/**
 * Public, read-only historical-owner snapshot. This checks no private keys and
 * never signs, sends, funds, restores, or reactivates any historical operation.
 * Every view is pinned to one fresh FINAL block from the selected trusted RPC.
 */
import { PRIOR_OWNER } from './multiagency-readiness.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';

const MAX = (1n << 128n) - 1n;
const u128 = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch { return { ok: false }; } };

export async function inspectHistoricalOwner(provider, { now = Date.now } = {}) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('read-only testnet provider and clock required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const start = now(), block = await provider.viewBlock({ finality: 'final' }), fresh = assertFreshFinalBlock(block, start);
  const pinned = { block_id: fresh.hash }, query = request_type => provider.query({ request_type, account_id: PRIOR_OWNER, ...pinned });
  const [account, keys, tokenBalance, registration] = await Promise.all([
    attempt(() => query('view_account')), attempt(() => query('view_access_key_list')),
    attempt(() => readPinnedJsonView(provider, fresh.hash, CIRCLE_TESTNET_USDC, 'ft_balance_of', { account_id: PRIOR_OWNER })),
    attempt(() => readPinnedJsonView(provider, fresh.hash, CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: PRIOR_OWNER })),
  ]);
  let ownerAccount = null, keySummary = null, balance = null, tokenRegistration = 'UNKNOWN';
  const a = account.value;
  if (account.ok && record(a) && a.block_hash === fresh.hash && u128(a.amount) && u128(a.locked) && isTransactionHash(a.code_hash)) {
    ownerAccount = { native_balance_yocto: a.amount, locked_yocto: a.locked, code_hash: a.code_hash };
  }
  const k = keys.value;
  if (keys.ok && record(k) && k.block_hash === fresh.hash && Array.isArray(k.keys) && k.keys.length <= 1000) {
    let full = 0, valid = true;
    for (const item of k.keys) {
      const permission = item?.access_key?.permission;
      if (permission === 'FullAccess') full++;
      else if (!record(permission) || !record(permission.FunctionCall) || typeof permission.FunctionCall.receiver_id !== 'string' ||
               !Array.isArray(permission.FunctionCall.method_names)) { valid = false; break; }
    }
    if (valid) keySummary = { key_count: k.keys.length, full_access_key_count: full };
  }
  if (tokenBalance.ok && u128(tokenBalance.value)) balance = tokenBalance.value;
  const r = registration.value;
  if (registration.ok && r === null) tokenRegistration = 'NOT_REGISTERED_AT_VIEW';
  else if (registration.ok && record(r) && u128(r.total) && r.total !== '0' && u128(r.available) && BigInt(r.available) <= BigInt(r.total)) {
    tokenRegistration = 'REGISTERED_AT_VIEW';
  }
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards during owner views');
  assertFreshFinalBlock({ header: { hash: fresh.hash, timestamp_nanosec: block.header.timestamp_nanosec } }, end);
  return { account_id: PRIOR_OWNER, chain: 'testnet', block_hash: fresh.hash,
    block_timestamp: new Date(fresh.timestamp_ms).toISOString(), observed_at: new Date(end).toISOString(),
    account: ownerAccount, access_keys: keySummary, circle_registration: tokenRegistration, circle_balance_atoms: balance,
    owner_private_key_available: 'NOT_CHECKED', private_key_recovered: false, signed: false, sent: false,
    scope: 'trusted-RPC public views only; unknown is not absence, a key list does not prove custody, and no prior operation is resumed' };
}
