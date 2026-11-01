/** Read-only testnet seller registration and bounded Ref swap indications.
 * These are views, not an authorization, execution, balance or price promise. */
import { CIRCLE_TESTNET_USDC, REF_TESTNET, WRAP_TESTNET } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from './svalin-pro-readiness.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';

const POOLS = [1845, 2206];
const TEST_INPUTS = [1n, 5n, 10n, 15n, 20n].map(near => (near * 10n ** 24n).toString());
const MAX_U128 = (1n << 128n) - 1n;
const isU128 = value => typeof value === 'string' && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) <= MAX_U128;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Never signs, reserves, wraps, swaps, transfers or assumes a wallet balance.
 * Unexpected or unavailable views remain unknown and must not be interpreted
 * as a seller refusal or a quote to trade. */
export async function inspectSvalinLiquidity(provider, { now = Date.now } = {}) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.viewBlock !== 'function' ||
      typeof provider.callFunctionRaw !== 'function' || typeof now !== 'function') {
    throw new Error('read-only testnet provider and local clock required');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const block = await provider.viewBlock({ finality: 'final' }), start = now();
  const fresh = assertFreshFinalBlock(block, start);
  const snapshot = { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
  const view = (contract, method, args) => readPinnedJsonView(provider, fresh.hash, contract, method, args);
  let sellerRegistration = 'UNKNOWN';
  try {
    const value = await view(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: SVALIN_PAYEE });
    if (value === null) sellerRegistration = 'NOT_REGISTERED_AT_VIEW';
    else if (record(value) && isU128(value.total) && BigInt(value.total) > 0n && isU128(value.available) &&
        BigInt(value.available) <= BigInt(value.total)) {
      sellerRegistration = 'REGISTERED_AT_VIEW';
    }
  } catch { /* Network and contract failures do not prove absence. */ }

  const pools = [];
  for (const poolId of POOLS) {
    let pool;
    try { pool = await view(REF_TESTNET, 'get_pool', { pool_id: poolId }); }
    catch { pools.push({ pool_id: poolId, status: 'UNAVAILABLE', quotes: [] }); continue; }
    if (!record(pool) || pool.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(pool.token_account_ids) ||
        pool.token_account_ids.length !== 2 || !pool.token_account_ids.includes(WRAP_TESTNET) ||
        !pool.token_account_ids.includes(CIRCLE_TESTNET_USDC) || !Array.isArray(pool.amounts) ||
        pool.amounts.length !== 2 || !pool.amounts.every(value => isU128(value) && BigInt(value) > 0n)) {
      pools.push({ pool_id: poolId, status: 'UNREVIEWED_POOL', quotes: [] }); continue;
    }
    const quotes = [];
    for (const input of TEST_INPUTS) {
      try {
        const output = await view(REF_TESTNET, 'get_return', {
          pool_id: poolId, token_in: WRAP_TESTNET, amount_in: input, token_out: CIRCLE_TESTNET_USDC,
        });
        if (!isU128(output)) throw new Error('invalid view');
        quotes.push({ wrap_input_yocto: input, usdc_output_atoms: output });
      } catch { quotes.push({ wrap_input_yocto: input, usdc_output_atoms: null }); }
    }
    pools.push({ pool_id: poolId, status: 'READ_ONLY_INDICATION', quotes });
  }
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards during liquidity views');
  assertFreshFinalBlock(snapshot, end);
  return { chain: 'testnet', block_hash: fresh.hash, block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    observed_at: new Date(end).toISOString(), seller_usdc_storage: sellerRegistration, pools,
    wallet_balance_checked: false, signed: false, sent: false,
    scope: 'point-in-time trusted-RPC views; not funding, a tradable quote, seller acceptance or delivery' };
}
