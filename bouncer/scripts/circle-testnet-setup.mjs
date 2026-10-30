/**
 * Read-only quote selection for the OPTIONAL testnet demo's OWNER setup swap.
 * It never signs, broadcasts or authorizes an agent to trade. Circle's NEAR
 * testnet USDC address is explicitly pinned; testnet USDC has no real value.
 */
export const CIRCLE_TESTNET_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
export const WRAP_TESTNET = 'wrap.testnet';
export const REF_TESTNET = 'ref-finance-101.testnet';
export const OWNER_SETUP_INPUT = 10n ** 22n; // 0.01 testnet wNEAR; never mainnet
export const OWNER_SETUP_MAX_OUTPUT = 100_000n; // at most 0.1 testnet USDC
export const DEMO_RESOURCE_PRICE = 1000n; // 0.001 testnet USDC, six decimals
const POOLS = [1845, 2206]; // reviewed testnet wNEAR/Circle-USDC pools only
const MAX = (1n << 128n) - 1n;
const u128 = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) <= MAX;

/** Return a bounded exact-input setup quote, or fail without any transaction. */
export async function selectOwnerSetupQuote(provider) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.callFunction !== 'function') throw new Error('invalid testnet quote provider');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const final = { finality: 'final' }, candidates = [];
  for (const pool_id of POOLS) {
    try {
      const pool = await provider.callFunction(REF_TESTNET, 'get_pool', { pool_id }, final);
      if (pool?.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(pool.token_account_ids) || pool.token_account_ids.length !== 2 ||
          !pool.token_account_ids.includes(WRAP_TESTNET) || !pool.token_account_ids.includes(CIRCLE_TESTNET_USDC) ||
          !Array.isArray(pool.amounts) || pool.amounts.length !== 2 || pool.amounts.some(n => !u128(n) || n === '0')) continue;
      const quote = await provider.callFunction(REF_TESTNET, 'get_return', {
        pool_id, token_in: WRAP_TESTNET, amount_in: OWNER_SETUP_INPUT.toString(), token_out: CIRCLE_TESTNET_USDC,
      }, final);
      if (!u128(quote)) continue;
      const output = BigInt(quote), minOut = output * 95n / 100n;
      if (output > OWNER_SETUP_MAX_OUTPUT || minOut < 3n * DEMO_RESOURCE_PRICE) continue;
      candidates.push({ pool_id, quote: output, minOut });
    } catch { /* A failed read-only quote does not trigger a transaction. */ }
  }
  candidates.sort((a, b) => a.quote === b.quote ? a.pool_id - b.pool_id : a.quote > b.quote ? -1 : 1);
  const chosen = candidates[0];
  if (!chosen) throw new Error('no bounded owner-setup Ref quote for Circle testnet USDC');
  return { pool_id: chosen.pool_id, quoted_output: chosen.quote.toString(), min_output: chosen.minOut.toString(),
    input_amount: OWNER_SETUP_INPUT.toString(), msg: JSON.stringify({ force: 0, actions: [{ pool_id: chosen.pool_id,
      token_in: WRAP_TESTNET, token_out: CIRCLE_TESTNET_USDC, amount_in: OWNER_SETUP_INPUT.toString(), min_amount_out: chosen.minOut.toString() }] }) };
}
