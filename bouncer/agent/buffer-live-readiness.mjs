/** Read-only, testnet-only preflight for an independent Buffer order.
 *
 * All chain views are pinned to the same trusted-RPC FINAL block. The Ref
 * returns are indications, not executable quotes, and the seller's on-chain
 * prices are not a quote or proof of a running service. This module never
 * creates a quote/order, signs, broadcasts or authorizes a transaction.
 */
import { inspectVaultCircleFunding } from './keyless-vault-v12-circle-readiness.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTestnetAccount, isImplicitNearAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';

const MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const ONE_NEAR = 10n ** 24n;
export const BUFFER_FUNDING_SAMPLE_INPUTS = Object.freeze([
  '10000000000000000000000', // 0.01
  '1000000000000000000000000', // 1
  '2000000000000000000000000', // 2
  '4000000000000000000000000', // 4
  '6000000000000000000000000', // 6
  '7000000000000000000000000', // 7 test NEAR
]);
export const BUFFER_FUNDING_SAMPLE_POOLS = Object.freeze([1845, 2206]);

function pairs(value, name) {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`malformed Buffer ${name} view`);
  const result = new Map();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' ||
        !/^[a-z0-9-]{1,64}$/.test(pair[0]) || !obj(pair[1]) || result.has(pair[0])) {
      throw new Error(`malformed Buffer ${name} view`);
    }
    result.set(pair[0], pair[1]);
  }
  return result;
}
export function sellerTerms(config, rules, products, registration) {
  // Buffer's agent can be an implicit account, which has no network in its ID.
  // The vault inspector has already required a testnet RPC and a pinned block.
  const sellerAccount = x => isTestnetAccount(x) || isImplicitNearAccount(x);
  if (!obj(config) || !sellerAccount(config.owner) || !sellerAccount(config.agent) ||
      !sellerAccount(config.owner_payout) || !sellerAccount(config.contributor) ||
      typeof config.paused !== 'boolean' || typeof config.token_id !== 'string' ||
      !Number.isSafeInteger(config.policy_version) || config.policy_version < 0) {
    throw new Error('malformed Buffer configuration view');
  }
  const custom = pairs(rules, 'quote rules').get('custom-brief');
  if (custom !== undefined && (!uint(custom.min_price) || custom.min_price === '0' || !uint(custom.max_price) ||
      BigInt(custom.max_price) < BigInt(custom.min_price) || typeof custom.active !== 'boolean' ||
      !Number.isSafeInteger(custom.max_expense_bps) || custom.max_expense_bps < 0 || custom.max_expense_bps > 10_000)) {
    throw new Error('malformed Buffer custom quote rules');
  }
  const prices = [];
  for (const [sku, p] of pairs(products, 'products')) {
    if (!uint(p.price) || p.price === '0' || !uint(p.max_expense) || typeof p.active !== 'boolean') {
      throw new Error('malformed Buffer product view');
    }
    if (sku === 'weekly-market-brief' || sku === 'crosschain-brief') prices.push({ sku, price_atoms: p.price, active: p.active });
  }
  prices.sort((a, b) => a.sku.localeCompare(b.sku));
  if (registration !== null && (!obj(registration) || !uint(registration.total) || registration.total === '0' ||
      !uint(registration.available) || BigInt(registration.available) > BigInt(registration.total))) {
    throw new Error('malformed seller token registration');
  }
  return { token: config.token_id, accepts_reviewed_circle: config.token_id === CIRCLE, paused: config.paused,
    owner: config.owner, agent: config.agent, owner_payout: config.owner_payout, contributor: config.contributor,
    policy_version: config.policy_version, circle_registered: registration !== null,
    custom_quote: custom ? { active: custom.active, min_atoms: custom.min_price, max_atoms: custom.max_price,
      max_expense_bps: custom.max_expense_bps } : null, fixed_products: prices };
}
function checkedPool(pool) {
  return obj(pool) && pool.pool_kind === 'SIMPLE_POOL' && Array.isArray(pool.token_account_ids) &&
    pool.token_account_ids.length === 2 && new Set(pool.token_account_ids).size === 2 &&
    pool.token_account_ids.includes(WRAP) && pool.token_account_ids.includes(CIRCLE) &&
    Array.isArray(pool.amounts) && pool.amounts.length === 2 && pool.amounts.every(x => uint(x) && x !== '0');
}

/** One current public snapshot, not permission to sign. */
export async function inspectBufferLiveReadiness({ plan, provider, now = Date.now, inspectVault = inspectVaultCircleFunding } = {}) {
  if (!provider || ['viewBlock', 'query', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function' || typeof inspectVault !== 'function') throw new Error('read-only provider and clock required');
  const start = now();
  const base = await inspectVault({ plan, provider, now });
  const hash = base?.block_hash;
  if (base?.network !== 'testnet' || base?.circle_token !== CIRCLE || !isTransactionHash(hash) ||
      !uint(base.owner_native_yocto) || !uint(base.owner_circle_atoms) || !uint(base.vault_actual_circle_atoms) ||
      !uint(base.vault_tracked_circle_atoms) || base.signed !== false || base.sent !== false) {
    throw new Error('pinned testnet vault state required');
  }
  const block = await provider.viewBlock({ blockId: hash });
  if (block?.header?.hash !== hash || !Number.isSafeInteger(block.header.height) || block.header.height < 1 ||
      block.header.timestamp_nanosec !== base.block_timestamp_nanosec) throw new Error('pinned block differs');
  assertFreshFinalBlock(block, now());
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const view = (account, method, args) => readPinnedJsonView(provider, hash, account, method, args);
  const [sellerAccount, sellerKeys, config, rules, products, registration, pools] = await Promise.all([
    query('view_account', SELLER), query('view_access_key_list', SELLER),
    view(SELLER, 'get_config', {}), view(SELLER, 'get_quote_rules', {}), view(SELLER, 'get_products', {}),
    view(CIRCLE, 'storage_balance_of', { account_id: SELLER }),
    Promise.all(BUFFER_FUNDING_SAMPLE_POOLS.map(async id => {
      try { return { id, pool: await view(REF, 'get_pool', { pool_id: id }) }; }
      catch { return { id, pool: null }; }
    })),
  ]);
  if (sellerAccount?.block_hash !== hash || !isTransactionHash(sellerAccount.code_hash) ||
      sellerKeys?.block_hash !== hash || !Array.isArray(sellerKeys.keys)) throw new Error('seller account view differs');
  const seller = { account_id: SELLER, code_hash: sellerAccount.code_hash, access_key_count: sellerKeys.keys.length,
    ...sellerTerms(config, rules, products, registration) };
  const samples = [];
  for (const { id, pool } of pools) {
    if (!checkedPool(pool)) { samples.push({ pool_id: id, status: 'POOL_UNAVAILABLE_OR_DIFFERENT', quotes: [] }); continue; }
    const quotes = await Promise.all(BUFFER_FUNDING_SAMPLE_INPUTS.map(async input => {
      try {
        const output = await view(REF, 'get_return', { pool_id: id, token_in: WRAP, amount_in: input, token_out: CIRCLE });
        if (!uint(output)) throw new Error('invalid quote');
        return { input_yocto: input, output_atoms: output };
      } catch { return { input_yocto: input, output_atoms: null }; }
    }));
    samples.push({ pool_id: id, status: quotes.every(q => q.output_atoms !== null) ? 'INDICATIVE_ONLY' : 'INCOMPLETE', quotes });
  }
  const min = seller.custom_quote?.active && seller.accepts_reviewed_circle && !seller.paused ?
    BigInt(seller.custom_quote.min_atoms) : null;
  const held = BigInt(base.vault_tracked_circle_atoms);
  const needed = min === null ? null : (min > held ? min - held : 0n);
  const candidates = needed === null || !seller.circle_registered || base.vault_actual_circle_atoms !== base.vault_tracked_circle_atoms ? [] :
    samples.flatMap(p => p.quotes.map(q => ({ ...q, pool_id: p.pool_id })))
    .filter(q => q.output_atoms !== null && BigInt(q.output_atoms) >= needed &&
      BigInt(base.owner_native_yocto) >= BigInt(q.input_yocto) + ONE_NEAR)
    .sort((a, b) => BigInt(a.input_yocto) === BigInt(b.input_yocto) ? a.pool_id - b.pool_id :
      BigInt(a.input_yocto) < BigInt(b.input_yocto) ? -1 : 1);
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, end);
  return { version: 1, network: 'testnet', block_hash: hash, block_height: block.header.height,
    block_timestamp_nanosec: block.header.timestamp_nanosec, observed_at: new Date(end).toISOString(),
    owner: base.owner, vault: base.vault, owner_key_nonce: base.owner_key_nonce, owner_native_yocto: base.owner_native_yocto,
    owner_circle_atoms: base.owner_circle_atoms, vault_circle_actual_atoms: base.vault_actual_circle_atoms,
    vault_circle_tracked_atoms: base.vault_tracked_circle_atoms, vault_balances_match: base.vault_actual_circle_atoms === base.vault_tracked_circle_atoms,
    vault_native_available_estimate: base.vault_estimated_available_yocto, seller, indicative_ref_pools: samples,
    minimum_custom_shortfall_atoms: needed === null ? null : needed.toString(),
    first_sample_covering_minimum_before_other_costs: candidates[0] ?? null,
    signed: false, sent: false, seller_contacted: false, quote_created: false, payment_authorized: false,
    prior_original_transaction_histories: 'NOT_CHECKED', independent_delivery_verified: false,
    scope: 'trusted-RPC same-block views only; testnet prices are not reserved; a custom quote may cost more, other storage/gas costs apply, no custody, audit, live fulfillment or historical transaction outcome is established' };
}
