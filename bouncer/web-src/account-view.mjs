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

async function rpc(fetchImpl, id, method, params, signal) {
  const response = await fetchImpl(TESTNET_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
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
    const info = payload.error?.cause?.info;
    if (method === 'query' && params.request_type === 'view_account' && payload.error?.cause?.name === 'UNKNOWN_ACCOUNT' &&
        info?.requested_account_id === params.account_id && info?.block_hash === params.block_id) return null;
    throw new Error('TESTNET_RPC_UNAVAILABLE');
  }
  if (!payload.result || typeof payload.result !== 'object') throw new Error('TESTNET_RPC_INVALID');
  return payload.result;
}

/**
 * One FINAL block and two pinned read-only queries. A token contract can have
 * a ledger entry for a name that does not currently exist as a native account;
 * that balance is not evidence of ownership or spendability. NEAR's amount
 * includes its storage reserve and excludes staked balance; it is not a
 * spendable quote. A failed read is never replaced with a guessed balance.
 */
export async function readPublicTestnetAccount(accountId, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  if (!isNearAccountId(accountId)) throw new Error('INVALID_ACCOUNT_ID');
  if (typeof fetchImpl !== 'function') throw new Error('TESTNET_RPC_UNAVAILABLE');
  const finalBlock = await rpc(fetchImpl, 'bouncer-final-block', 'block', { finality: 'final' }, signal);
  const blockHash = finalBlock?.header?.hash, blockHeight = finalBlock?.header?.height;
  if (!isBlockHash(blockHash) || !Number.isSafeInteger(blockHeight) || blockHeight < 0) throw new Error('TESTNET_RPC_INVALID');
  const args = btoa(JSON.stringify({ account_id: accountId }));
  const [account, token] = await Promise.all([
    rpc(fetchImpl, 'bouncer-public-account', 'query', {
      request_type: 'view_account', block_id: blockHash, account_id: accountId,
    }, signal),
    rpc(fetchImpl, 'bouncer-public-circle', 'query', {
      request_type: 'call_function', block_id: blockHash, account_id: CIRCLE_TEST_USDC,
      method_name: 'ft_balance_of', args_base64: args,
    }, signal),
  ]);
  if (account !== null && (!isAmount(account.amount) || account.block_hash !== blockHash || account.block_height !== blockHeight)) {
    throw new Error('TESTNET_RPC_INVALID');
  }
  if (!token || token.block_hash !== blockHash || token.block_height !== blockHeight ||
      !Array.isArray(token.result) || token.result.length > 128 ||
      !token.result.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('TESTNET_RPC_INVALID');
  let circle;
  try { circle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(token.result))); }
  catch { throw new Error('TESTNET_RPC_INVALID'); }
  if (!isAmount(circle)) throw new Error('TESTNET_RPC_INVALID');
  return { exists: account !== null, near: account?.amount ?? null, circle, blockHash, blockHeight };
}
