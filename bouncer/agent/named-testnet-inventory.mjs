/** Public-only Circle and NEAR views for one user-named testnet account.
 * No helper, credential, signature, transaction or seller request is used.
 * Every view is pinned to a fresh FINAL block reported by the selected RPC. */
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;
const attempt = async f => { try { return { ok: true, value: await f() }; } catch { return { ok: false }; } };

/** Unknown RPC outcomes remain UNKNOWN, not proof an account is absent. A
 * Circle FT balance can exist even when the recipient NEAR account does not. */
export async function inspectNamedTestnetAccount({ provider, accountId, now = Date.now }) {
  if (!isTestnetAccount(accountId) || !provider || typeof now !== 'function' ||
      ['viewNodeStatus', 'viewBlock', 'viewTestnetAccountPresenceAt', 'query', 'callFunctionRaw']
        .some(name => typeof provider[name] !== 'function')) throw new Error('valid testnet account and read-only provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const start = now(), block = await provider.viewBlock({ finality: 'final' });
  const fresh = assertFreshFinalBlock(block, start), hash = fresh.hash;
  const [presence, balance, registration, tokenAccount] = await Promise.all([
    attempt(() => provider.viewTestnetAccountPresenceAt(accountId, hash)),
    attempt(() => readPinnedJsonView(provider, hash, CIRCLE, 'ft_balance_of', { account_id: accountId })),
    attempt(() => readPinnedJsonView(provider, hash, CIRCLE, 'storage_balance_of', { account_id: accountId })),
    attempt(() => provider.query({ request_type: 'view_account', account_id: CIRCLE, block_id: hash })),
  ]);
  let accountStatus = 'UNKNOWN', native = null, keys = null;
  const p = presence.value;
  if (presence.ok && p?.block_hash === hash && p.exists === false) accountStatus = 'ABSENT_AT_FINAL';
  if (presence.ok && p?.block_hash === hash && p.exists === true && record(p.account) && p.account.block_hash === hash &&
      uint(p.account.amount) && uint(p.account.locked) && isTransactionHash(p.account.code_hash)) {
    accountStatus = 'PRESENT_AT_FINAL';
    native = { balance_yocto: p.account.amount, locked_yocto: p.account.locked, code_hash: p.account.code_hash };
    const result = await attempt(() => provider.query({ request_type: 'view_access_key_list', account_id: accountId, block_id: hash }));
    const value = result.value;
    if (result.ok && value?.block_hash === hash && Array.isArray(value.keys) && value.keys.length <= 1000) {
      let full = 0, valid = true;
      for (const entry of value.keys) {
        const permission = entry?.access_key?.permission;
        if (permission === 'FullAccess') full++;
        else if (!record(permission?.FunctionCall) || typeof permission.FunctionCall.receiver_id !== 'string' ||
                 !Array.isArray(permission.FunctionCall.method_names)) { valid = false; break; }
      }
      if (valid) keys = { count: value.keys.length, full_access_count: full };
    }
  }
  let circleRegistration = 'UNKNOWN';
  if (registration.ok && registration.value === null) circleRegistration = 'NOT_REGISTERED_AT_VIEW';
  const r = registration.value;
  if (registration.ok && record(r) && uint(r.total) && r.total !== '0' && uint(r.available) && BigInt(r.available) <= BigInt(r.total)) {
    circleRegistration = 'REGISTERED_AT_VIEW';
  }
  const t = tokenAccount.value;
  const codeHash = tokenAccount.ok && t?.block_hash === hash && isTransactionHash(t.code_hash) ? t.code_hash : null;
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: block.header.timestamp_nanosec } }, end);
  return { chain: 'testnet', account_id: accountId, block_hash: hash, block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    observed_at: new Date(end).toISOString(), account_status: accountStatus, native, access_keys: keys,
    circle_token: CIRCLE, circle_code_hash: codeHash,
    circle_balance_atoms: balance.ok && uint(balance.value) ? balance.value : null, circle_registration: circleRegistration,
    private_key_custody: 'NOT_CHECKED', signed: false, sent: false,
    scope: 'trusted-RPC pinned FINAL views, not proof of key custody; unknown is not absence; no account creation, transaction or seller contact' };
}
