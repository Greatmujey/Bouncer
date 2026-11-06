/** Read-only discovery of direct and two-hop wNEAR -> Circle-test-USDC paths.
 * This is a bounded search at one trusted-RPC FINAL block, not a trade builder,
 * a reservation, an audit of the intermediate tokens, or spending authority. */
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTestnetAccount, isImplicitNearAccount } from '../shared/account-id.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';

const SAMPLE = '7000000000000000000000000'; // 7 test NEAR, before gas, reserve or slippage
const MAX_POOLS = 10_000, PAGE = 50, MAX_PATHS = 20, MAX_AMOUNT = (1n << 128n) - 1n;
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) <= MAX_AMOUNT;
const account = value => isTestnetAccount(value) || isImplicitNearAccount(value);
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function simplePool(pool, id) {
  if (!obj(pool) || pool.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(pool.token_account_ids) ||
      pool.token_account_ids.length !== 2 || !pool.token_account_ids.every(account) ||
      pool.token_account_ids[0] === pool.token_account_ids[1] || !Array.isArray(pool.amounts) ||
      pool.amounts.length !== 2 || pool.amounts.some(v => !uint(v) || v === '0') ||
      !Number.isInteger(pool.total_fee) || pool.total_fee < 0 || pool.total_fee >= 10_000) return null;
  return { id, tokens: pool.token_account_ids, amounts: pool.amounts, fee: pool.total_fee };
}
function rough(pool, tokenIn, amount) {
  const i = pool.tokens.indexOf(tokenIn);
  if (i < 0) return 0n;
  const input = amount * BigInt(10_000 - pool.fee) / 10_000n;
  const x = BigInt(pool.amounts[i]), y = BigInt(pool.amounts[1 - i]);
  return y * input / (x + input);
}
function sortedRoutes(pools) {
  const direct = [], via = new Map(), out = new Map(), input = BigInt(SAMPLE);
  for (const p of pools) {
    const hasWrap = p.tokens.includes(WRAP), hasCircle = p.tokens.includes(CIRCLE);
    if (hasWrap && hasCircle) direct.push({ pools: [p], tokens: [WRAP, CIRCLE], rough: rough(p, WRAP, input) });
    else if (hasWrap) {
      const middle = p.tokens.find(t => t !== WRAP);
      const list = via.get(middle) || []; list.push(p); via.set(middle, list);
    } else if (hasCircle) {
      const middle = p.tokens.find(t => t !== CIRCLE);
      const list = out.get(middle) || []; list.push(p); out.set(middle, list);
    }
  }
  // For the rough pre-rank keep only the best first leg and best second leg
  // per intermediate token. This avoids a quadratic product of untrusted pool
  // lists. Actual Ref returns can differ, so this is not exhaustive routing.
  const routes = [...direct]; let pairCount = 0;
  for (const [middle, firsts] of via) {
    const seconds = out.get(middle) || [];
    pairCount += firsts.length * seconds.length;
    if (!seconds.length) continue;
    let first = firsts[0], firstOut = rough(first, WRAP, input);
    for (const candidate of firsts.slice(1)) {
      const value = rough(candidate, WRAP, input);
      if (value > firstOut) { first = candidate; firstOut = value; }
    }
    let second = seconds[0], result = rough(second, middle, firstOut);
    for (const candidate of seconds.slice(1)) {
      const value = rough(candidate, middle, firstOut);
      if (value > result) { second = candidate; result = value; }
    }
    routes.push({ pools: [first, second], tokens: [WRAP, middle, CIRCLE], rough: result });
  }
  routes.sort((a, b) => a.rough === b.rough ? a.pools[0].id - b.pools[0].id : a.rough > b.rough ? -1 : 1);
  return { routes, directCount: direct.length, pairCount };
}
async function mapLimit(items, concurrency, fn) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; result[i] = await fn(items[i]); }
  }));
  return result;
}

/** All failures or gaps are labeled; no result here authorizes a swap. */
export async function inspectRefCirclePaths({ provider, now = Date.now } = {}) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('read-only testnet provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const block = await provider.viewBlock({ finality: 'final' });
  const start = now(), { hash } = assertFreshFinalBlock(block, start);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const view = (method, args) => readPinnedJsonView(provider, hash, REF, method, args);
  const total = await view('get_number_of_pools', {});
  if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000) throw new Error('invalid pool count');
  const limit = Math.min(total, MAX_POOLS), offsets = Array.from({ length: Math.ceil(limit / PAGE) }, (_, i) => i * PAGE);
  const pages = await mapLimit(offsets, 5, async offset => {
    const length = Math.min(PAGE, limit - offset);
    try {
      const data = await view('get_pools', { from_index: offset, limit: length });
      if (!Array.isArray(data) || data.length !== length) throw new Error('incomplete page');
      return { offset, data };
    } catch { return { offset, data: null }; }
  });
  const pools = [], missing = [];
  for (const page of pages) {
    if (!page.data) { missing.push(page.offset); continue; }
    page.data.forEach((p, i) => { const pool = simplePool(p, page.offset + i); if (pool) pools.push(pool); });
  }
  const { routes, directCount, pairCount } = sortedRoutes(pools);
  const selected = routes.slice(0, MAX_PATHS);
  const quotations = await mapLimit(selected, 5, async route => {
    try {
      let amount = SAMPLE;
      for (let i = 0; i < route.pools.length; i++) {
        amount = await view('get_return', { pool_id: route.pools[i].id, token_in: route.tokens[i],
          amount_in: amount, token_out: route.tokens[i + 1] });
        if (!uint(amount) || amount === '0') throw new Error('quote unavailable');
      }
      return { pool_ids: route.pools.map(p => p.id), tokens: route.tokens, output_atoms: amount };
    } catch { return { pool_ids: route.pools.map(p => p.id), tokens: route.tokens, output_atoms: null }; }
  });
  quotations.sort((a, b) => a.output_atoms === null ? 1 : b.output_atoms === null ? -1 :
    BigInt(a.output_atoms) === BigInt(b.output_atoms) ? a.pool_ids[0] - b.pool_ids[0] : BigInt(a.output_atoms) > BigInt(b.output_atoms) ? -1 : 1);
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, end);
  return { version: 1, network: 'testnet', block_hash: hash, block_height: block.header.height,
    observed_at: new Date(end).toISOString(), pools_total: total, pools_scanned: limit,
    failed_page_offsets: missing.slice(0, 20), failed_page_count: missing.length,
    enumeration_complete: limit === total && missing.length === 0, simple_pools_valid: pools.length,
    direct_paths_observed: directCount, total_direct_and_two_hop_paths_observed: directCount + pairCount,
    representative_paths_pre_ranked: routes.length, paths_quoted: selected.length,
    paths_truncated: directCount + pairCount > selected.length,
    input_token: WRAP, output_token: CIRCLE, sample_input_yocto: SAMPLE, top_indicative_paths: quotations.slice(0, 10),
    signed: false, sent: false, execution_authorized: false, owner_funds_or_history_checked: false,
    scope: 'single trusted FINAL RPC block; only simple pools and at most 20 pre-ranked paths, no token/code audit or executable quote; actual settlement, gas, storage and slippage not checked' };
}
