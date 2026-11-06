/**
 * Public, read-only readiness for a wallet-owned Buffer testnet trial. This is
 * separate from the V3 owner and never signs, creates an account, contacts the
 * seller's HTTP API or authorizes a payment. All chain data is untrusted RPC
 * data at one fresh FINAL block, and can change immediately afterwards.
 */
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { sellerTerms } from './buffer-live-readiness.mjs';
import { CIRCLE_TESTNET_CODE_HASH, V12_EXPECTED_BYTES, VAULT_NATIVE_FUNDING_YOCTO } from './keyless-vault-v12-readiness.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const U128 = (1n << 128n) - 1n, ONE = 10n ** 24n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= U128;
const registration = x => x && typeof x === 'object' && !Array.isArray(x) && uint(x.total) &&
  x.total !== '0' && uint(x.available) && BigInt(x.available) <= BigInt(x.total);

/** Testnet account IDs only; no implicit account is accepted as the owner or
 * vault, because this assessment assumes a human-controlled named owner and a
 * new, direct child without a deploy key. */
export async function inspectBufferWalletReadiness({ owner, vault, provider, now = Date.now } = {}) {
  const prefix = typeof vault === 'string' && typeof owner === 'string' && vault.endsWith(`.${owner}`)
    ? vault.slice(0, -owner.length - 1) : '';
  if (!isTestnetAccount(owner) || !isTestnetAccount(vault) || !prefix || prefix.includes('.') ||
      !provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'viewTestnetAccountPresenceAt', 'experimental_protocolConfig']
        .some(k => typeof provider[k] !== 'function') || typeof now !== 'function') throw new Error('named owner, direct-child vault and read-only testnet provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const start = now(), block = await provider.viewBlock({ finality: 'final' });
  const { hash } = assertFreshFinalBlock(block, start);
  if (!Number.isSafeInteger(block.header.height) || block.header.height < 1) throw new Error('invalid FINAL block height');
  const query = (request_type, account_id) => provider.query({ request_type, account_id, block_id: hash });
  const view = (account, method, args = {}) => readPinnedJsonView(provider, hash, account, method, args);
  const [account, keys, child, token, balance, ownerReg, vaultReg, bounds, meta, seller, sellerKeys,
    config, rules, products, sellerReg, protocol] = await Promise.all([
    query('view_account', owner), query('view_access_key_list', owner), provider.viewTestnetAccountPresenceAt(vault, hash),
    query('view_account', CIRCLE), view(CIRCLE, 'ft_balance_of', { account_id: owner }),
    view(CIRCLE, 'storage_balance_of', { account_id: owner }), view(CIRCLE, 'storage_balance_of', { account_id: vault }),
    view(CIRCLE, 'storage_balance_bounds'), view(CIRCLE, 'ft_metadata'),
    query('view_account', SELLER), query('view_access_key_list', SELLER),
    view(SELLER, 'get_config'), view(SELLER, 'get_quote_rules'), view(SELLER, 'get_products'),
    view(CIRCLE, 'storage_balance_of', { account_id: SELLER }), provider.experimental_protocolConfig({ blockId: hash }),
  ]);
  if (account?.block_hash !== hash || !uint(account.amount) || !Number.isSafeInteger(account.storage_usage) || account.storage_usage < 0 ||
      keys?.block_hash !== hash || !Array.isArray(keys.keys) || keys.keys.length > 100 ||
      child?.block_hash !== hash || typeof child.exists !== 'boolean' || token?.block_hash !== hash ||
      !uint(balance) || !uint(bounds?.min) || bounds.min === '0' || !meta ||
      seller?.block_hash !== hash || !isTransactionHash(seller.code_hash) || sellerKeys?.block_hash !== hash ||
      !Array.isArray(sellerKeys.keys) || !uint(protocol?.runtime_config?.storage_amount_per_byte)) {
    throw new Error('pinned public owner, token, vault or seller state is malformed or mixed');
  }
  if (ownerReg !== null && !registration(ownerReg)) throw new Error('invalid owner Circle registration');
  if (vaultReg !== null && !registration(vaultReg)) throw new Error('invalid vault Circle registration');
  const terms = sellerTerms(config, rules, products, sellerReg);
  const fixed = terms.fixed_products.find(p => p.sku === 'weekly-market-brief') ?? null;
  const cost = BigInt(protocol.runtime_config.storage_amount_per_byte);
  const available = BigInt(account.amount) - BigInt(account.storage_usage) * cost;
  const minimumVaultEstimate = (BigInt(V12_EXPECTED_BYTES) + 50_000n) * cost + ONE / 10n;
  const checks = {
    named_owner_has_no_local_or_global_code: hasPlainOwnerProfileAt(account, hash),
    owner_has_full_access_key: keys.keys.some(k => k?.access_key?.permission === 'FullAccess'),
    owner_circle_registered: registration(ownerReg) === true,
    reviewed_circle_code_and_metadata: token.code_hash === CIRCLE_TESTNET_CODE_HASH && meta.decimals === 6 && meta.symbol === 'USDC',
    new_direct_child_absent: child.exists === false,
    child_not_already_circle_registered: vaultReg === null,
    circle_registration_cost_bounded: BigInt(bounds.min) <= ONE / 100n,
    protocol_and_selected_features: protocol?.chain_id === 'testnet' && Number.isSafeInteger(protocol.protocol_version) &&
      protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL && selectedV11WasmFeaturesEnabled(protocol),
    owner_native_estimate: cost > 0n && available >= BigInt(VAULT_NATIVE_FUNDING_YOCTO) + BigInt(bounds.min) + ONE,
    vault_native_estimate: cost > 0n && BigInt(VAULT_NATIVE_FUNDING_YOCTO) >= minimumVaultEstimate,
    buffer_accepts_circle_and_is_registered: terms.accepts_reviewed_circle && terms.circle_registered && !terms.paused,
    fixed_product_active: fixed?.active === true,
    owner_balance_covers_fixed_price: fixed !== null && BigInt(balance) >= BigInt(fixed.price_atoms),
  };
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block, end);
  return { version: 1, network: 'testnet', owner, candidate_vault: vault,
    block_hash: hash, block_height: block.header.height, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(end).toISOString(),
    owner_native_yocto: account.amount, estimated_available_native_yocto: (available > 0n ? available : 0n).toString(),
    owner_circle_atoms: balance, circle_token: CIRCLE, circle_code_hash: token.code_hash,
    circle_registration_min_yocto: bounds.min, planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO,
    estimated_vault_minimum_yocto: minimumVaultEstimate.toString(), owner_key_count: keys.keys.length,
    seller: { ...terms, account_id: SELLER, code_hash: seller.code_hash, access_key_count: sellerKeys.keys.length },
    checks, blockers: Object.keys(checks).filter(k => !checks[k]),
    wallet_control_proven: false, wallet_approval_obtained: false, signer_present: false,
    signed: false, sent: false, vault_deployed: false, seller_contacted: false, quote_or_order_created: false,
    independently_fulfilled: false,
    scope: 'single trusted-RPC FINAL snapshot and approximate storage margins only; prices, keys, contract code and balance can change; not wallet ownership, approval, deployed-source equivalence, an executable order or a delivery' };
}
