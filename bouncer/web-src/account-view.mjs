// Public account lookup only. A typed ID is not a wallet, proof of ownership,
// or permission to sign. Never use this result to authorize an action.
export const TESTNET_RPC = 'https://test.rpc.fastnear.com';
export const CIRCLE_TEST_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

export function isNearAccountId(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

const isAmount = value => typeof value === 'string' && /^(0|[1-9]\d{0,38})$/.test(value);
const isBlockHash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/** Format without rounding up; the ≈ makes a truncated fractional value clear. */
export function formatPublicAmount(value, decimals, maxFraction = decimals) {
  if (!isAmount(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 24 ||
      !Number.isInteger(maxFraction) || maxFraction < 0 || maxFraction > decimals) throw new Error('Invalid amount');
  const digits = value.padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  const visible = fraction.slice(0, maxFraction).replace(/0+$/, '');
  const truncated = /[1-9]/.test(fraction.slice(maxFraction));
  return `${truncated ? '≈' : ''}${whole}${visible ? `.${visible}` : ''}`;
}

async function rpc(fetchImpl, id, params, signal) {
  const response = await fetchImpl(TESTNET_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'query', params }),
  });
  if (!response.ok) throw new Error('TESTNET_RPC_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 16_384) throw new Error('TESTNET_RPC_INVALID');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('TESTNET_RPC_INVALID'); }
  if (payload?.jsonrpc !== '2.0' || payload.id !== id || typeof payload !== 'object') throw new Error('TESTNET_RPC_INVALID');
  if (payload.error) {
    // This indicates that the native account itself was not found at this
    // testnet node. It says nothing about mainnet or token-contract ledgers.
    if (params.request_type === 'view_account' && payload.error?.cause?.name === 'UNKNOWN_ACCOUNT') return null;
    throw new Error('TESTNET_RPC_UNAVAILABLE');
  }
  if (!payload.result || typeof payload.result !== 'object') throw new Error('TESTNET_RPC_INVALID');
  return payload.result;
}

/**
 * Two read-only queries at one FINAL block. NEAR's amount includes the portion
 * reserved for storage and excludes staked balance; it is not a spendable quote.
 * An RPC failure is an error, never a zero or a historical/fabricated balance.
 */
export async function readPublicTestnetAccount(accountId, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  if (!isNearAccountId(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  if (typeof fetchImpl !== 'function') throw new Error('TESTNET_RPC_UNAVAILABLE');
  const account = await rpc(fetchImpl, 'bouncer-public-account', {
    request_type: 'view_account', finality: 'final', account_id: accountId,
  }, signal);
  if (account === null) return { exists: false };
  if (!isAmount(account.amount) || !isBlockHash(account.block_hash) ||
      !Number.isSafeInteger(account.block_height) || account.block_height < 0) throw new Error('TESTNET_RPC_INVALID');
  const args = btoa(JSON.stringify({ account_id: accountId }));
  const token = await rpc(fetchImpl, 'bouncer-public-circle', {
    request_type: 'call_function', block_id: account.block_hash, account_id: CIRCLE_TEST_USDC,
    method_name: 'ft_balance_of', args_base64: args,
  }, signal);
  if (!token || token.block_hash !== account.block_hash || token.block_height !== account.block_height ||
      !Array.isArray(token.result) || token.result.length > 128 ||
      !token.result.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('TESTNET_RPC_INVALID');
  let circle;
  try { circle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(token.result))); }
  catch { throw new Error('TESTNET_RPC_INVALID'); }
  if (!isAmount(circle)) throw new Error('TESTNET_RPC_INVALID');
  return { exists: true, near: account.amount, circle, blockHash: account.block_hash, blockHeight: account.block_height };
}
