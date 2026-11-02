/** Read-only, testnet-only owner acquisition readiness. The Circle owner
 * snapshot and every wNEAR/Ref view share one recent FINAL block. No swap,
 * wrapping, signing or contact with a seller is performed. */
import { inspectCircleOwnerRegistration } from './circle-owner-registration.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_USDC, WRAP_TESTNET, REF_TESTNET } from '../scripts/circle-testnet-setup.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

export const ACQUISITION_INPUT_YOCTO = '10000000000000000000000'; // 0.01 test NEAR / wNEAR
export const ACQUISITION_MAX_USDC_ATOMS = '100000'; // 0.1 test USDC
export const ACQUISITION_MIN_USDC_ATOMS = '3000'; // 0.003 test USDC
export const ACQUISITION_POOLS = Object.freeze([1845, 2206]);
const MAX_STORAGE = 10n ** 22n, ONE_NEAR = 10n ** 24n, MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function registration(value) {
  if (value === null) return 'NOT_REGISTERED_AT_VIEW';
  if (record(value) && uint(value.total) && value.total !== '0' && uint(value.available) &&
      BigInt(value.available) <= BigInt(value.total)) return 'REGISTERED_AT_VIEW';
  throw new Error('token registration view is malformed');
}

/** A complete observation is deliberately required. Unknown/mixed state is not
 * permission to fund or trade; the selected quote is only an indication. */
export async function inspectCircleOwnerAcquisition({ plan, provider, now = Date.now } = {}) {
  const start = now(), base = await inspectCircleOwnerRegistration({ plan, provider, now }), hash = base.block_hash;
  if (base.circle_registration !== 'REGISTERED_AT_VIEW') throw new Error('owner Circle registration is required first');
  const v = (token, method, args = {}) => readPinnedJsonView(provider, hash, token, method, args);
  const [wrapAccount, wrapMeta, wrapBounds, ownerStorage, ownerWrap, refWrapStorage, refCircleStorage,
    ...poolViews] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: WRAP_TESTNET, block_id: hash }),
    v(WRAP_TESTNET, 'ft_metadata'), v(WRAP_TESTNET, 'storage_balance_bounds'),
    v(WRAP_TESTNET, 'storage_balance_of', { account_id: base.owner }), v(WRAP_TESTNET, 'ft_balance_of', { account_id: base.owner }),
    v(WRAP_TESTNET, 'storage_balance_of', { account_id: REF_TESTNET }),
    v(CIRCLE_TESTNET_USDC, 'storage_balance_of', { account_id: REF_TESTNET }),
    ...ACQUISITION_POOLS.map(id => Promise.all([
      v(REF_TESTNET, 'get_pool', { pool_id: id }),
      v(REF_TESTNET, 'get_return', { pool_id: id, token_in: WRAP_TESTNET,
        amount_in: ACQUISITION_INPUT_YOCTO, token_out: CIRCLE_TESTNET_USDC }),
    ]).then(([pool, quote]) => ({ id, pool, quote })).catch(() => ({ id, pool: null, quote: null }))),
  ]);
  if (wrapAccount?.block_hash !== hash || !isTransactionHash(wrapAccount.code_hash) || wrapAccount.code_hash === NO_LOCAL_CONTRACT_HASH ||
      !record(wrapMeta) || wrapMeta.symbol !== 'wNEAR' || wrapMeta.decimals !== 24 || !record(wrapBounds) ||
      !uint(wrapBounds.min) || wrapBounds.min === '0' || BigInt(wrapBounds.min) > MAX_STORAGE ||
      !(wrapBounds.max === null || (uint(wrapBounds.max) && BigInt(wrapBounds.max) >= BigInt(wrapBounds.min))) || !uint(ownerWrap) ||
      registration(refWrapStorage) !== 'REGISTERED_AT_VIEW' || registration(refCircleStorage) !== 'REGISTERED_AT_VIEW') {
    throw new Error('wNEAR identity, bounds, balance or Ref token registrations are not verified');
  }
  const ownerRegistration = registration(ownerStorage);
  const need = BigInt(ACQUISITION_INPUT_YOCTO) + (ownerRegistration === 'NOT_REGISTERED_AT_VIEW' ? BigInt(wrapBounds.min) : 0n);
  if (BigInt(base.owner_native_yocto) < ONE_NEAR + need) throw new Error('owner native reserve is too low');
  const candidates = [];
  for (const { id, pool, quote } of poolViews) {
    if (!record(pool) || pool.pool_kind !== 'SIMPLE_POOL' || !Array.isArray(pool.token_account_ids) ||
        pool.token_account_ids.length !== 2 || !pool.token_account_ids.includes(WRAP_TESTNET) ||
        !pool.token_account_ids.includes(CIRCLE_TESTNET_USDC) || !Array.isArray(pool.amounts) || pool.amounts.length !== 2 ||
        pool.amounts.some(x => !uint(x) || x === '0') || !uint(quote)) continue;
    const n = BigInt(quote), floor = n * 95n / 100n;
    if (n <= BigInt(ACQUISITION_MAX_USDC_ATOMS) && floor >= BigInt(ACQUISITION_MIN_USDC_ATOMS)) {
      candidates.push({ pool_id: id, quote_atoms: quote, min_output_atoms: floor.toString() });
    }
  }
  candidates.sort((a, b) => BigInt(a.quote_atoms) === BigInt(b.quote_atoms) ? a.pool_id - b.pool_id :
    BigInt(a.quote_atoms) > BigInt(b.quote_atoms) ? -1 : 1);
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards during acquisition views');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: base.block_timestamp_nanosec } }, end);
  return { ...base, wrap_token: WRAP_TESTNET, wrap_code_hash: wrapAccount.code_hash, wrap_symbol: wrapMeta.symbol,
    wrap_decimals: wrapMeta.decimals, wrap_storage_min_yocto: wrapBounds.min, owner_wrap_registration: ownerRegistration,
    owner_wrap_balance_yocto: ownerWrap, ref_exchange: REF_TESTNET,
    ref_wrap_registration: 'REGISTERED_AT_VIEW', ref_circle_registration: 'REGISTERED_AT_VIEW',
    acquisition_input_yocto: ACQUISITION_INPUT_YOCTO, max_usdc_atoms: ACQUISITION_MAX_USDC_ATOMS,
    candidates, selected: candidates[0] ?? null, observed_at: new Date(end).toISOString(),
    scope: 'single trusted-RPC FINAL snapshot; quote is not a reservation or execution, no private key checked' };
}
