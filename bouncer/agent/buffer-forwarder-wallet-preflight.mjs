/**
 * Fresh same-FINAL-block checks for the next UNSIGNED Buffer forwarder create
 * or Circle-registration stage. No wallet, signature, RPC write, HTTP order,
 * prompt reservation or payment occurs here. A PASS is not authorization:
 * retained originals, independently durable fencing, separate owner approval,
 * actual wallet support and fresh rechecks remain mandatory. This trusts the
 * RPC and local clock; code/state/price may change immediately after reading.
 */
import { isDeepStrictEqual } from 'node:util';
import { verifyBufferForwarderWalletReview } from './buffer-forwarder-wallet-plan.mjs';
import { buildBufferForwarder, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { sellerTerms } from './buffer-live-readiness.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_buffer_forwarder', 'register_buffer_forwarder_circle'];
const MAX = (1n << 128n) - 1n, ONE = 10n ** 24n, MARGIN = 50_000n, MIN_WINDOW_MS = 60_000;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function amount(x) {
  if (typeof x === 'bigint') return x >= 0n && x <= MAX ? x : null;
  if (typeof x !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(x)) return null;
  const n = BigInt(x); return n <= MAX ? n : null;
}
const registered = x => obj(x) && amount(x.total) !== null && amount(x.total) > 0n &&
  amount(x.available) !== null && amount(x.available) <= amount(x.total);
const localCode = x => obj(x) && (x.global_contract_hash === undefined || x.global_contract_hash === null) &&
  (x.global_contract_account_id === undefined || x.global_contract_account_id === null) &&
  (x.state === undefined || x.state === 'initialized') && (x.bootstrap_nonce === undefined || x.bootstrap_nonce === null);
function available(account, hash, cost, reserve, margin = 0n) {
  const n = amount(account?.amount);
  return account?.block_hash === hash && n !== null && Number.isSafeInteger(account.storage_usage) &&
    account.storage_usage >= 0 && cost !== null && cost > 0n && n >= (BigInt(account.storage_usage) + margin) * cost + reserve;
}
function ownerKeys(value, ownerAccess, hash, ownerKey, vaultKey, forwarderKey) {
  const keys = value?.keys, nonce = pinnedAccessKeyNonce(ownerAccess?.nonce);
  return value?.block_hash === hash && ownerAccess?.block_hash === hash && ownerAccess.permission === 'FullAccess' && nonce !== null &&
    Array.isArray(keys) && keys.length <= 10_000 &&
    keys.every(k => obj(k) && typeof k.public_key === 'string' && obj(k.access_key)) &&
    new Set(keys.map(k => k.public_key)).size === keys.length &&
    keys.some(k => k.public_key === ownerKey && k.access_key.permission === 'FullAccess' && pinnedAccessKeyNonce(k.access_key.nonce) === nonce) &&
    !keys.some(k => k.public_key === vaultKey || k.public_key === forwarderKey);
}
function quoteMatches(quote, terms, seller) {
  const nanos = quote?.expires_ns;
  if (!obj(quote) || quote.sku !== terms.sku || quote.amount !== terms.amount || quote.paid !== false ||
      amount(quote.max_expense) === null || amount(quote.max_expense) > amount(terms.amount) ||
      !((typeof nanos === 'number' && Number.isFinite(nanos) && Number.isInteger(nanos) && nanos > 0) ||
        (typeof nanos === 'string' && /^[1-9][0-9]{0,19}$/.test(nanos))) || seller.custom_quote?.active !== true ||
      amount(quote.max_expense) * 10_000n > amount(terms.amount) * BigInt(seller.custom_quote.max_expense_bps)) return false;
  const ns = BigInt(nanos);
  return ns <= (1n << 64n) - 1n && ns / 1_000_000n >= BigInt(terms.expires_at_ms + 10_000);
}
async function bounded(tasks, limit = 4) {
  const results = Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = { available: true, value: await tasks[i]() }; }
      catch { results[i] = { available: false }; }
    }
  }));
  return results;
}

/** All review/code/key hashes must be independently retained by the caller;
 * private order responses and bearer tokens must NOT be passed here. */
export async function inspectBufferForwarderWalletStage({ review: rawReview, trustedReviewHash, terms: rawTerms,
  spendingReview: rawSpendingReview, trustedSpendingReviewHash, trustedOwnerPublicKey, trustedSellerCodeHash,
  stageId, provider, now = Date.now } = {}) {
  const review = structuredClone(rawReview), terms = structuredClone(rawTerms), spendingReview = structuredClone(rawSpendingReview);
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(trustedSellerCodeHash) || typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList', 'viewTestnetAccountPresenceAt',
        'callFunctionRaw', 'experimental_protocolConfig'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('reviewed forwarder stage, retained seller hash and read-only testnet provider required');
  }
  const start = now();
  if (!Number.isSafeInteger(start) || start < 1) throw new Error('invalid local time');
  const plan = await verifyBufferForwarderWalletReview({ review, trustedReviewHash, terms, spendingReview,
    trustedSpendingReviewHash, trustedOwnerPublicKey, nowMs: start });
  const artifact = await buildBufferForwarder(terms, { nowMs: start });
  if (artifact.review.review_sha256 !== review.forwarder_review_sha256 || artifact.wasm_sha256 !== review.forwarder_wasm_sha256 ||
      plan.review.stages[index].id !== stageId) throw new Error('forwarder bytecode differs from retained review');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const block = await provider.viewBlock({ finality: 'final' }), { hash } = assertFreshFinalBlock(block, now());
  if (!Number.isSafeInteger(block?.header?.height) || block.header.height < 1) throw new Error('invalid FINAL height');
  const at = () => ({ blockId: hash }), view = (account, method, args = {}) => readPinnedJsonView(provider, hash, account, method, args);
  const p = { policy_id: terms.policy_id };
  const tasks = {
    protocol: () => provider.experimental_protocolConfig(at()),
    owner: () => provider.viewAccount(terms.owner, at()),
    owner_key: () => provider.viewAccessKey(terms.owner, trustedOwnerPublicKey, at()),
    owner_keys: () => provider.viewAccessKeyList(terms.owner, at()),
    vault: () => provider.viewAccount(terms.vault, at()),
    vault_keys: () => provider.viewAccessKeyList(terms.vault, at()),
    forwarder_presence: () => provider.viewTestnetAccountPresenceAt(terms.adapter, hash),
    token: () => provider.viewAccount(CIRCLE, at()), seller: () => provider.viewAccount(SELLER, at()),
    bounds: () => view(CIRCLE, 'storage_balance_bounds'), metadata: () => view(CIRCLE, 'ft_metadata'),
    vault_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: terms.vault }),
    forwarder_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: terms.adapter }),
    seller_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: SELLER }),
    vault_usdc: () => view(CIRCLE, 'ft_balance_of', { account_id: terms.vault }),
    forwarder_usdc: () => view(CIRCLE, 'ft_balance_of', { account_id: terms.adapter }),
    vault_owner: () => view(terms.vault, 'get_owner'), vault_version: () => view(terms.vault, 'contract_version'),
    tracked: () => view(terms.vault, 'vault_balance', { token: CIRCLE }), policy: () => view(terms.vault, 'get_policy', p),
    policy_locked: () => view(terms.vault, 'is_exact_ft_policy_locked', p),
    agent_granted: () => view(terms.vault, 'is_agent_key_allowed', { ...p, public_key: terms.vault_agent_public_key }),
    payee_locked: () => view(terms.vault, 'is_exact_ft_payee_locked', { token: CIRCLE, payee: terms.adapter }),
    intent: () => view(terms.vault, 'get_exact_ft_intent', { intent_id: terms.intent_id }),
    daily: () => view(terms.vault, 'daily_spent', p),
    seller_config: () => view(SELLER, 'get_config'), seller_rules: () => view(SELLER, 'get_quote_rules'),
    seller_products: () => view(SELLER, 'get_products'), seller_order: () => view(SELLER, 'get_order', { order_id: terms.onchain_order_id }),
  };
  if (index === 1) {
    tasks.forwarder_keys = () => provider.viewAccessKeyList(terms.adapter, at());
    tasks.forwarder_config = () => view(terms.adapter, 'configuration');
    tasks.forwarder_opened = () => view(terms.adapter, 'opened');
  }
  if (terms.sku === 'custom-brief') tasks.quote = () => view(SELLER, 'get_quote', { order_id: terms.onchain_order_id });
  const names = Object.keys(tasks), results = await bounded(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, results[i]])), checks = {};
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === hash;
  const put = (name, deps, predicate) => {
    if (deps.some(dep => !reads[dep]?.available)) { checks[name] = 'UNKNOWN'; return; }
    try { checks[name] = predicate() ? 'PASS' : 'BLOCKED'; } catch { checks[name] = 'BLOCKED'; }
  };
  const cost = amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte);
  put('testnet_protocol_and_selected_features', ['protocol'], () => reads.protocol.value?.chain_id === 'testnet' &&
    Number.isSafeInteger(reads.protocol.value.protocol_version) && reads.protocol.value.protocol_version >= MIN_V11_TESTNET_PROTOCOL &&
    cost !== null && cost > 0n && selectedV11WasmFeaturesEnabled(reads.protocol.value));
  put('plain_owner', ['owner'], () => hasPlainOwnerProfileAt(reads.owner.value, hash));
  put('owner_full_access_and_safe_nonce', ['owner_key'], () => atBlock('owner_key') &&
    reads.owner_key.value.permission === 'FullAccess' && pinnedAccessKeyNonce(reads.owner_key.value.nonce) !== null);
  put('agent_keys_not_installed', ['owner_keys', 'owner_key'], () => ownerKeys(reads.owner_keys.value, reads.owner_key.value,
    hash, trustedOwnerPublicKey, terms.vault_agent_public_key, terms.forwarder_agent_public_key));
  const needed = index === 0 ? amount(review.native_funding_yocto) : amount(review.registration_deposit_yocto);
  put('owner_native_estimate', ['owner', 'protocol'], () => needed !== null && available(reads.owner.value, hash, cost, ONE + needed));
  put('forwarder_funding_estimate', ['protocol'], () => cost !== null && cost > 0n &&
    amount(review.native_funding_yocto) >= (BigInt(review.forwarder_wasm_bytes) + MARGIN) * cost + amount(terms.native_reserve));
  put('vault_code_and_no_keys', ['vault', 'vault_keys'], () => atBlock('vault') && localCode(reads.vault.value) &&
    reads.vault.value.code_hash === V12_NEAR_CODE_HASH && atBlock('vault_keys') &&
    Array.isArray(reads.vault_keys.value.keys) && reads.vault_keys.value.keys.length === 0);
  put('vault_native_estimate', ['vault', 'protocol'], () => available(reads.vault.value, hash, cost, ONE / 10n, MARGIN));
  put('vault_owner_and_version', ['vault_owner', 'vault_version'], () => reads.vault_owner.value === terms.owner &&
    reads.vault_version.value === 'bouncer-agent-v12-exact-ft-testnet');
  if (index === 0) {
    put('new_forwarder_absent', ['forwarder_presence'], () => atBlock('forwarder_presence') && reads.forwarder_presence.value.exists === false);
  } else {
    put('forwarder_code_and_no_keys', ['forwarder_presence', 'forwarder_keys'], () => atBlock('forwarder_presence') &&
      reads.forwarder_presence.value.exists === true && reads.forwarder_presence.value.account?.block_hash === hash &&
      localCode(reads.forwarder_presence.value.account) && reads.forwarder_presence.value.account.code_hash === review.forwarder_wasm_near_hash &&
      atBlock('forwarder_keys') && Array.isArray(reads.forwarder_keys.value.keys) && reads.forwarder_keys.value.keys.length === 0);
    put('forwarder_native_estimate', ['forwarder_presence', 'protocol'], () =>
      available(reads.forwarder_presence.value.account, hash, cost, amount(terms.native_reserve)));
    put('forwarder_configuration_unopened', ['forwarder_config', 'forwarder_opened'], () =>
      isDeepStrictEqual(reads.forwarder_config.value, artifact.review) && reads.forwarder_opened.value === false);
  }
  put('circle_and_seller_code_pins', ['token', 'seller', 'metadata'], () => atBlock('token') &&
    reads.token.value.code_hash === CIRCLE_TESTNET_CODE_HASH && reads.metadata.value?.decimals === 6 && reads.metadata.value?.symbol === 'USDC' &&
    atBlock('seller') && reads.seller.value.code_hash === trustedSellerCodeHash);
  put('circle_registration_cost_exact', ['bounds'], () => {
    const min = amount(reads.bounds.value?.min), max = reads.bounds.value?.max;
    return min !== null && min > 0n && min === amount(review.registration_deposit_yocto) &&
      (max === null || (amount(max) !== null && amount(max) >= min));
  });
  put('circle_registrations_expected', ['vault_registration', 'forwarder_registration', 'seller_registration'], () =>
    registered(reads.vault_registration.value) && reads.forwarder_registration.value === null && registered(reads.seller_registration.value));
  put('vault_tracked_and_actual_funding', ['tracked', 'vault_usdc', 'forwarder_usdc'], () =>
    amount(reads.tracked.value) !== null && reads.tracked.value === reads.vault_usdc.value &&
    amount(reads.tracked.value) >= amount(terms.amount) && reads.forwarder_usdc.value === '0');
  put('policy_and_intent_absent', ['policy', 'policy_locked', 'agent_granted', 'payee_locked', 'intent', 'daily'], () =>
    reads.policy.value === null && reads.policy_locked.value === false && reads.agent_granted.value === false &&
    reads.payee_locked.value === false && reads.intent.value === null && reads.daily.value === '0');
  put('seller_active_and_price_matches', ['seller_config', 'seller_rules', 'seller_products', 'seller_registration', 'seller_order'], () => {
    const seller = sellerTerms(reads.seller_config.value, reads.seller_rules.value, reads.seller_products.value, reads.seller_registration.value);
    if (!seller.accepts_reviewed_circle || !seller.circle_registered || seller.paused || reads.seller_order.value !== null) return false;
    if (terms.sku === 'custom-brief') return seller.custom_quote?.active === true &&
      amount(terms.amount) >= amount(seller.custom_quote.min_atoms) && amount(terms.amount) <= amount(seller.custom_quote.max_atoms);
    return seller.fixed_products.some(p => p.sku === terms.sku && p.active && p.price_atoms === terms.amount);
  });
  if (terms.sku === 'custom-brief') put('unpaid_quote_matches_and_covers_intent',
    ['quote', 'seller_config', 'seller_rules', 'seller_products', 'seller_registration'], () => {
      const seller = sellerTerms(reads.seller_config.value, reads.seller_rules.value, reads.seller_products.value, reads.seller_registration.value);
      return quoteMatches(reads.quote.value, terms, seller);
    });
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  try { assertFreshFinalBlock(block, end); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  checks.intent_window_remaining = terms.expires_at_ms - end >= MIN_WINDOW_MS ? 'PASS' : 'BLOCKED';
  const blockers = Object.entries(checks).filter(([, status]) => status !== 'PASS').map(([check, status]) => ({ check, status }));
  return { status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_FORWARDER_STAGE_PROFILE_MATCH', stage_id: stageId,
    network: 'testnet', block_hash: hash, block_height: block.header.height, checked_at: new Date(end).toISOString(),
    owner: terms.owner, vault: terms.vault, adapter: terms.adapter, seller: SELLER,
    review_sha256: trustedReviewHash, spending_review_sha256: trustedSpendingReviewHash, seller_code_hash: trustedSellerCodeHash,
    checks, blockers, execution_authorized: false, owner_approval_verified: false, durable_fence_verified: false,
    prior_originals_reconciled: false, deployed_source_equivalence_verified: false, receipt_consensus_verified: false,
    wallet_connected: false, transaction_signed: false, transaction_sent: false, seller_contacted: false,
    private_order_verified: false, independent_delivery_verified: false, estimates_are_not_storage_or_gas_guarantees: true,
    scope: 'trusted-RPC same-block views and local-clock estimates only; no journal, approval, verified private order or payment' };
}
