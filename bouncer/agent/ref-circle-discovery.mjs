/** Read-only discovery of direct and two-hop wNEAR -> Circle-test-USDC paths.
 * This is a bounded search at one trusted-RPC FINAL block, not a trade builder,
 * a reservation, an audit of the intermediate tokens, or spending authority. */
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTestnetAccount, isImplicitNearAccount } from '../shared/account-id.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';

const SAMPLE = '7000000000000000000000000'; // 7 test NEAR, before gas, reserve or slippage
const DCL = 'dclv2.ref-dev.testnet'; // testnet Rhea concentrated-liquidity deployment
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
    while (true) { const i = next++; if (i >= items.length) return; result[i] = await fn(items[i], i); }
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
  // This inventory is discovery only: the other token may be a valueless
  // unaudited mock and a pool's existence says nothing about executable price.
  const circlePairs = pools.filter(p => p.tokens.includes(CIRCLE)).map(p => {
    const i = p.tokens.indexOf(CIRCLE);
    return { pool_id: p.id, other_token: p.tokens[1 - i], circle_reserve_atoms: p.amounts[i] };
  });
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
  // Also inspect the four standard DCL fee tiers. A zero/failed quote does not
  // establish that an amount can be filled, and splitting trades is not tested.
  const dcl = await mapLimit([100, 400, 2000, 10000], 4, async fee => {
    const id = `${[CIRCLE, WRAP].sort().join('|')}|${fee}`;
    const result = { pool_id: id, status: 'unavailable', circle_reserve_atoms: null, outputs: [] };
    try {
      const pool = await readPinnedJsonView(provider, hash, DCL, 'get_pool', { pool_id: id });
      if (pool === null) return { ...result, status: 'absent' };
      if (!obj(pool) || pool.pool_id !== id || pool.token_x !== CIRCLE || pool.token_y !== WRAP ||
          pool.fee !== fee || !uint(pool.total_x)) return { ...result, status: 'invalid' };
      result.status = 'observed'; result.circle_reserve_atoms = pool.total_x;
      for (const input of ['1000000000000000000000000', SAMPLE]) {
        let amount = null;
        try {
          const q = await readPinnedJsonView(provider, hash, DCL, 'quote', { pool_ids: [id], input_token: WRAP,
            output_token: CIRCLE, input_amount: input, tag: null });
          if (obj(q) && uint(q.amount)) amount = q.amount;
        } catch { /* one failed view is not a zero or an executable quote */ }
        result.outputs.push({ input_yocto: input, output_atoms: amount });
      }
    } catch { /* unknown pool status */ }
    return result;
  });
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, end);
  return { version: 1, network: 'testnet', block_hash: hash, block_height: block.header.height,
    observed_at: new Date(end).toISOString(), pools_total: total, pools_scanned: limit,
    failed_page_offsets: missing.slice(0, 20), failed_page_count: missing.length,
    enumeration_complete: limit === total && missing.length === 0, simple_pools_valid: pools.length,
    circle_pair_count: circlePairs.length, circle_pairs_truncated: circlePairs.length > 30, circle_pairs: circlePairs.slice(0, 30),
    direct_paths_observed: directCount, total_direct_and_two_hop_paths_observed: directCount + pairCount,
    representative_paths_pre_ranked: routes.length, paths_quoted: selected.length,
    paths_truncated: directCount + pairCount > selected.length,
    input_token: WRAP, output_token: CIRCLE, sample_input_yocto: SAMPLE, top_indicative_paths: quotations.slice(0, 10),
    dcl_contract: DCL, dcl_direct_fee_tiers: dcl,
    signed: false, sent: false, execution_authorized: false, owner_funds_or_history_checked: false,
    scope: 'single trusted FINAL RPC block; simple pools and at most 20 pre-ranked paths plus four direct DCL tiers, no token/code audit or executable quote; split routes, actual settlement, gas, storage and slippage not checked' };
}

// Three disjoint, previously observed Ref testnet routes. This diagnostic
// searches a 0.01-NEAR allocation grid with constant-product estimates, then
// asks the *same* FINAL snapshot for independent returns on the selected legs.
// It is deliberately not an exhaustive router or a swap transaction builder.
const SPLIT_ROUTES = [
  { ids: [17, 2527], tokens: [WRAP, 'ref.fakes.testnet', CIRCLE] },
  { ids: [1845], tokens: [WRAP, CIRCLE] },
  { ids: [2206], tokens: [WRAP, CIRCLE] },
];
const SPLIT_STEP = 10n ** 22n; // 0.01 test NEAR
const SPLIT_BUDGETS = [100, 200, 300, 400, 450, 500, 700, 800];

/** Fixed-route, same-block research only; does not inspect balances or sign. */
export async function inspectRefCircleSplits({ provider, now = Date.now } = {}) {
  if (!provider || ['viewNodeStatus', 'viewBlock', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('read-only testnet provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const block = await provider.viewBlock({ finality: 'final' });
  const start = now(), { hash } = assertFreshFinalBlock(block, start);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const view = (method, args) => readPinnedJsonView(provider, hash, REF, method, args);
  const ids = SPLIT_ROUTES.flatMap(r => r.ids);
  if (new Set(ids).size !== ids.length) throw new Error('split routes must not share a pool');
  const pools = await mapLimit(ids, 4, async id => {
    const result = simplePool(await view('get_pool', { pool_id: id }), id);
    if (!result) throw new Error(`pool ${id} is unavailable or not a valid simple pool`);
    return result;
  });
  const byId = new Map(pools.map(p => [p.id, p]));
  const routes = SPLIT_ROUTES.map(route => {
    const legs = route.ids.map(id => byId.get(id));
    for (let i = 0; i < legs.length; i++) {
      if (!legs[i].tokens.includes(route.tokens[i]) || !legs[i].tokens.includes(route.tokens[i + 1])) {
        throw new Error(`pool ${legs[i].id} tokens differ from the reviewed research path`);
      }
    }
    return { ...route, legs };
  });
  const maximum = SPLIT_BUDGETS.at(-1);
  // Estimate every path at every allocation size. BigInt arithmetic avoids
  // precision loss; Ref's actual returns are separately checked below.
  const estimated = routes.map(r => Array.from({ length: maximum + 1 }, (_, units) => {
    let n = BigInt(units) * SPLIT_STEP;
    for (let i = 0; i < r.legs.length; i++) n = rough(r.legs[i], r.tokens[i], n);
    return n;
  }));
  let dp = Array.from({ length: maximum + 1 }, (_, n) => n === 0 ? { value: 0n, allocation: [] } : null);
  for (let index = 0; index < routes.length; index++) {
    const next = Array(maximum + 1).fill(null);
    for (let total = 0; total <= maximum; total++) {
      for (let units = 0; units <= total; units++) {
        const prior = dp[total - units];
        if (!prior) continue;
        const value = prior.value + estimated[index][units];
        if (!next[total] || value > next[total].value) next[total] = { value, allocation: [...prior.allocation, units] };
      }
    }
    dp = next;
  }
  const scenarios = await mapLimit(SPLIT_BUDGETS, 2, async units => {
    const selected = dp[units];
    const legs = await mapLimit(routes, 3, async (route, index) => {
      const input = BigInt(selected.allocation[index]) * SPLIT_STEP;
      let output = input, usable = true;
      if (input !== 0n) {
        try {
          for (let i = 0; i < route.ids.length; i++) {
            const value = await view('get_return', { pool_id: route.ids[i], token_in: route.tokens[i],
              amount_in: output.toString(), token_out: route.tokens[i + 1] });
            if (!uint(value) || value === '0') throw new Error('unavailable return');
            output = BigInt(value);
          }
        } catch { usable = false; }
      }
      return { pool_ids: route.ids, input_yocto: input.toString(), output_atoms: usable ? output.toString() : null };
    });
    const complete = legs.every(l => l.output_atoms !== null);
    return { input_yocto: (BigInt(units) * SPLIT_STEP).toString(), estimate_atoms: selected.value.toString(), legs,
      observed_sum_atoms: complete ? legs.reduce((sum, l) => sum + BigInt(l.output_atoms), 0n).toString() : null,
      quote_complete: complete };
  });
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, end);
  return { version: 1, network: 'testnet', block_hash: hash, block_height: block.header.height,
    observed_at: new Date(end).toISOString(), step_yocto: SPLIT_STEP.toString(),
    routes: routes.map(r => ({ pool_ids: r.ids, tokens: r.tokens })), scenarios,
    signed: false, sent: false, execution_authorized: false,
    scope: 'fixed disjoint simple pools and 0.01-NEAR allocation grid; estimates choose allocations and same-block views quote each leg independently; not an executable quote or exhaustive route search; balances, storage, deployment costs, slippage, intermediate-token safety and settlement are unverified' };
}
