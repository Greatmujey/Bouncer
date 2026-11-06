/**
 * Read-only, same-FINAL-block checks for the NEXT unsigned Buffer policy/key
 * stage or separately retained exact-intent stage. This is NOT a wallet runner,
 * durable journal, owner approval, order,
 * purchase or delivery. All RPC data and the clock are assumptions; current
 * state can race or change after this function returns. The caller must retain
 * the independently reviewed hashes, fence BEFORE any wallet prompt and
 * reconcile all previous originals. A matching snapshot never authorizes a send.
 */
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { verifyBufferSpendingReview } from './buffer-wallet-spending-evidence.mjs';
import { verifyBufferForwarderWalletReview } from './buffer-forwarder-wallet-plan.mjs';
import { sellerTerms } from './buffer-live-readiness.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER, buildBufferForwarder } from '../experiments/buffer-forwarder/build.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent', 'pin_buffer_exact_intent'];
const MAX = (1n << 128n) - 1n, OWNER_RESERVE = 10n ** 24n, VAULT_RESERVE = 10n ** 23n;
const VAULT_STORAGE_MARGIN = 50_000n, MIN_INTENT_WINDOW_MS = 60_000;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const localCode = value => record(value) && (value.global_contract_hash === undefined || value.global_contract_hash === null) &&
  (value.global_contract_account_id === undefined || value.global_contract_account_id === null) &&
  (value.state === undefined || value.state === 'initialized') && (value.bootstrap_nonce === undefined || value.bootstrap_nonce === null);
function amount(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= MAX ? value : null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) return null;
  const n = BigInt(value); return n <= MAX ? n : null;
}
function registered(value) {
  const total = amount(value?.total), available = amount(value?.available);
  return record(value) && total !== null && total > 0n && available !== null && available <= total;
}
function keyList(value, hash, identity, index, review) {
  const keys = value?.keys;
  if (value?.block_hash !== hash || !Array.isArray(keys) || keys.length > 10_000 ||
      !keys.every(k => record(k) && typeof k.public_key === 'string' && record(k.access_key)) ||
      new Set(keys.map(k => k.public_key)).size !== keys.length ||
      !keys.some(k => k.public_key === identity.owner_public_key && k.access_key.permission === 'FullAccess')) return false;
  const vault = keys.find(k => k.public_key === identity.vault_agent_public_key);
  const forwarder = keys.find(k => k.public_key === identity.forwarder_agent_public_key);
  if ((index < 3 && forwarder !== undefined) || (index < 2 && vault !== undefined)) return false;
  if (index < 2) return true;
  const exactPermission = (item, receiver, methods, allowance) => {
    const wrapper = item?.access_key?.permission, permission = wrapper?.FunctionCall;
    return keysAre(wrapper, ['FunctionCall']) && keysAre(permission, ['allowance', 'receiver_id', 'method_names']) &&
      permission.receiver_id === receiver && isDeepStrictEqual(permission.method_names, methods) &&
      amount(permission.allowance) === amount(allowance);
  };
  if (!exactPermission(vault, identity.vault, ['execute_exact_ft'], review.stages[1].actions[0].allowance_yocto)) return false;
  return index < 3 || exactPermission(forwarder, identity.adapter, ['open', 'return_tokens'],
    review.stages[2].actions[0].allowance_yocto);
}
function available(account, hash, cost, reserve, margin = 0n) {
  const n = amount(account?.amount);
  return account?.block_hash === hash && n !== null && Number.isSafeInteger(account.storage_usage) &&
    account.storage_usage >= 0 && cost !== null && cost > 0n &&
    n >= (BigInt(account.storage_usage) + margin) * cost + reserve;
}
function quoteMatches(quote, terms) {
  const ns = quote?.expires_ns;
  if (!record(quote) || quote.sku !== terms.sku || quote.amount !== terms.amount || quote.paid !== false ||
      amount(quote.max_expense) === null || amount(quote.max_expense) > amount(terms.amount) ||
      !((typeof ns === 'number' && Number.isFinite(ns) && Number.isInteger(ns) && ns > 0) ||
        (typeof ns === 'string' && /^[1-9][0-9]{0,19}$/.test(ns)))) return false;
  // Seller's u64 may arrive as an inexact JSON number. The ten-second safety
  // margin dominates that rounding, but this still trusts the RPC and clock.
  const nanos = BigInt(ns);
  if (nanos <= 0n || nanos > (1n << 64n) - 1n) return false;
  return nanos / 1_000_000n >= BigInt(terms.expires_at_ms + 10_000);
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

/** Only public data is accepted. A separately retained forwarder review hash,
 * WASM SHA-256, seller code hash and owner key are mandatory trust anchors;
 * rebuilding/pinning code is not an audit or source-equivalence proof. This
 * routine does not inspect a durable journal or any earlier transaction. */
export async function inspectBufferSpendingStage({ review: rawReview, trustedReviewHash, trustedOwnerPublicKey, stageId,
  forwarderTerms: rawForwarderTerms, trustedForwarderReviewHash, trustedForwarderWasmSha256, trustedSellerCodeHash,
  forwarderWalletReview: rawForwarderWalletReview, trustedForwarderWalletReviewHash, provider, now = Date.now } = {}) {
  // Snapshot public inputs before the first await so caller mutation cannot
  // change which plan is being assessed midway through a pinned read.
  const review = structuredClone(rawReview), terms = structuredClone(rawForwarderTerms),
    forwarderWalletReview = structuredClone(rawForwarderWalletReview);
  const identity = verifyBufferSpendingReview({ review, trustedReviewHash, trustedOwnerPublicKey });
  const index = STAGES.indexOf(stageId);
  if (index < 0 || typeof trustedForwarderReviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(trustedForwarderReviewHash) ||
      typeof trustedForwarderWasmSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(trustedForwarderWasmSha256) ||
      !isTransactionHash(trustedSellerCodeHash) || typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList', 'callFunctionRaw',
        'experimental_protocolConfig'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('reviewed stage, retained code hashes and read-only testnet provider required');
  }
  const started = now();
  if (!Number.isSafeInteger(started) || started < 1) throw new Error('invalid local time');
  let artifact;
  try { artifact = await buildBufferForwarder(terms, { nowMs: started }); }
  catch { throw new Error('unexpired reviewed Buffer forwarder terms required'); }
  if (artifact.review.review_sha256 !== trustedForwarderReviewHash || artifact.wasm_sha256 !== trustedForwarderWasmSha256 ||
      terms.owner !== identity.owner || terms.vault !== identity.vault || terms.adapter !== identity.adapter ||
      terms.policy_id !== review.policy_id || terms.vault_agent_public_key !== identity.vault_agent_public_key ||
      terms.forwarder_agent_public_key !== identity.forwarder_agent_public_key || amount(terms.amount) > amount(review.per_tx_cap_atoms) ||
      amount(terms.amount) > amount(review.daily_cap_atoms)) throw new Error('forwarder differs from independently retained spending review or code');
  if (index === 3) {
    const retained = await verifyBufferForwarderWalletReview({ review: forwarderWalletReview,
      trustedReviewHash: trustedForwarderWalletReviewHash, terms, spendingReview: review,
      trustedSpendingReviewHash: trustedReviewHash, trustedOwnerPublicKey, nowMs: started });
    if (retained.review.forwarder_review_sha256 !== trustedForwarderReviewHash ||
        retained.review.forwarder_wasm_sha256 !== trustedForwarderWasmSha256 ||
        retained.review.stages[2].id !== stageId) throw new Error('intent stage differs from retained forwarder review');
  }
  const expectedForwarderCodeHash = nearApi.utils.serialize.base_encode(Buffer.from(artifact.wasm_sha256, 'hex'));
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const block = await provider.viewBlock({ finality: 'final' });
  const { hash } = assertFreshFinalBlock(block, now());
  if (!Number.isSafeInteger(block?.header?.height) || block.header.height < 1) throw new Error('invalid FINAL height');
  const at = () => ({ blockId: hash });
  const view = (contract, method, args = {}) => readPinnedJsonView(provider, hash, contract, method, args);
  const policy = { policy_id: review.policy_id };
  const tasks = {
    protocol: () => provider.experimental_protocolConfig(at()),
    owner: () => provider.viewAccount(identity.owner, at()),
    owner_key: () => provider.viewAccessKey(identity.owner, identity.owner_public_key, at()),
    owner_keys: () => provider.viewAccessKeyList(identity.owner, at()),
    vault: () => provider.viewAccount(identity.vault, at()),
    vault_keys: () => provider.viewAccessKeyList(identity.vault, at()),
    forwarder: () => provider.viewAccount(identity.adapter, at()),
    forwarder_keys: () => provider.viewAccessKeyList(identity.adapter, at()),
    token: () => provider.viewAccount(CIRCLE, at()),
    seller: () => provider.viewAccount(SELLER, at()),
    vault_owner: () => view(identity.vault, 'get_owner'),
    vault_version: () => view(identity.vault, 'contract_version'),
    policy: () => view(identity.vault, 'get_policy', policy),
    policy_locked: () => view(identity.vault, 'is_exact_ft_policy_locked', policy),
    agent_granted: () => view(identity.vault, 'is_agent_key_allowed', { ...policy, public_key: identity.vault_agent_public_key }),
    payee_locked: () => view(identity.vault, 'is_exact_ft_payee_locked', { token: CIRCLE, payee: identity.adapter }),
    intent: () => view(identity.vault, 'get_exact_ft_intent', { intent_id: terms.intent_id }),
    daily: () => view(identity.vault, 'daily_spent', policy),
    tracked: () => view(identity.vault, 'vault_balance', { token: CIRCLE }),
    vault_usdc: () => view(CIRCLE, 'ft_balance_of', { account_id: identity.vault }),
    forwarder_usdc: () => view(CIRCLE, 'ft_balance_of', { account_id: identity.adapter }),
    vault_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: identity.vault }),
    forwarder_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: identity.adapter }),
    seller_registration: () => view(CIRCLE, 'storage_balance_of', { account_id: SELLER }),
    forwarder_config: () => view(identity.adapter, 'configuration'),
    forwarder_opened: () => view(identity.adapter, 'opened'),
    seller_config: () => view(SELLER, 'get_config'),
    seller_rules: () => view(SELLER, 'get_quote_rules'),
    seller_products: () => view(SELLER, 'get_products'),
    seller_order: () => view(SELLER, 'get_order', { order_id: terms.onchain_order_id }),
  };
  if (index > 0) tasks.verdict = () => view(identity.vault, 'check', { ...policy, payee: identity.adapter, amount: terms.amount });
  if (terms.sku === 'custom-brief') tasks.quote = () => view(SELLER, 'get_quote', { order_id: terms.onchain_order_id });
  const names = Object.keys(tasks), results = await bounded(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, results[i]])), checks = {};
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === hash;
  const put = (name, dependencies, predicate) => {
    if (dependencies.some(dep => !reads[dep]?.available)) { checks[name] = 'UNKNOWN'; return; }
    try { checks[name] = predicate() ? 'PASS' : 'BLOCKED'; } catch { checks[name] = 'BLOCKED'; }
  };
  const protocol = reads.protocol.value, cost = amount(protocol?.runtime_config?.storage_amount_per_byte);
  put('testnet_protocol_and_selected_features', ['protocol'], () => protocol?.chain_id === 'testnet' &&
    Number.isSafeInteger(protocol.protocol_version) && protocol.protocol_version >= MIN_V11_TESTNET_PROTOCOL &&
    cost !== null && cost > 0n && selectedV11WasmFeaturesEnabled(protocol));
  put('plain_owner', ['owner'], () => hasPlainOwnerProfileAt(reads.owner.value, hash));
  put('owner_full_access_and_safe_nonce', ['owner_key'], () => atBlock('owner_key') &&
    reads.owner_key.value.permission === 'FullAccess' && pinnedAccessKeyNonce(reads.owner_key.value.nonce) !== null);
  put('exact_owner_key_state', ['owner_keys'], () => keyList(reads.owner_keys.value, hash, identity, index, review));
  put('owner_native_estimate', ['owner', 'protocol'], () => available(reads.owner.value, hash, cost, OWNER_RESERVE));
  put('vault_code_and_no_keys', ['vault', 'vault_keys'], () => atBlock('vault') && localCode(reads.vault.value) &&
    reads.vault.value.code_hash === V12_NEAR_CODE_HASH && atBlock('vault_keys') &&
    Array.isArray(reads.vault_keys.value.keys) && reads.vault_keys.value.keys.length === 0);
  put('vault_native_estimate', ['vault', 'protocol'], () => available(reads.vault.value, hash, cost, VAULT_RESERVE, VAULT_STORAGE_MARGIN));
  put('vault_owner_and_version', ['vault_owner', 'vault_version'], () => reads.vault_owner.value === identity.owner &&
    reads.vault_version.value === 'bouncer-agent-v12-exact-ft-testnet');
  put('forwarder_code_and_no_keys', ['forwarder', 'forwarder_keys'], () => atBlock('forwarder') &&
    localCode(reads.forwarder.value) && reads.forwarder.value.code_hash === expectedForwarderCodeHash && atBlock('forwarder_keys') &&
    Array.isArray(reads.forwarder_keys.value.keys) && reads.forwarder_keys.value.keys.length === 0);
  put('forwarder_native_estimate', ['forwarder', 'protocol'], () =>
    available(reads.forwarder.value, hash, cost, amount(terms.native_reserve)));
  put('forwarder_configuration_unopened', ['forwarder_config', 'forwarder_opened'], () =>
    isDeepStrictEqual(reads.forwarder_config.value, artifact.review) && reads.forwarder_opened.value === false);
  put('circle_and_seller_code_pins', ['token', 'seller'], () => atBlock('token') && reads.token.value.code_hash === CIRCLE_TESTNET_CODE_HASH &&
    atBlock('seller') && reads.seller.value.code_hash === trustedSellerCodeHash);
  put('all_circle_registrations', ['vault_registration', 'forwarder_registration', 'seller_registration'], () =>
    registered(reads.vault_registration.value) && registered(reads.forwarder_registration.value) && registered(reads.seller_registration.value));
  put('vault_tracked_and_actual_funding', ['tracked', 'vault_usdc', 'forwarder_usdc'], () =>
    amount(reads.tracked.value) !== null && reads.tracked.value === reads.vault_usdc.value &&
    amount(reads.tracked.value) >= amount(terms.amount) && reads.forwarder_usdc.value === '0');
  put('unconsumed_intent_payee_and_budget', ['intent', 'payee_locked', 'daily'], () =>
    reads.intent.value === null && reads.payee_locked.value === false && reads.daily.value === '0');
  if (index === 0) {
    put('policy_not_yet_configured', ['policy', 'policy_locked', 'agent_granted'], () =>
      reads.policy.value === null && reads.policy_locked.value === false && reads.agent_granted.value === false);
  } else {
    put('exact_policy_locked_and_granted', ['policy', 'policy_locked', 'agent_granted'], () =>
      isDeepStrictEqual(reads.policy.value, { token: CIRCLE, per_tx_cap: review.per_tx_cap_atoms, daily_cap: review.daily_cap_atoms }) &&
      reads.policy_locked.value === true && reads.agent_granted.value === true);
    put('expected_payee_allowed', ['verdict'], () => Array.isArray(reads.verdict.value) &&
      reads.verdict.value.length === 2 && reads.verdict.value[0] === true && typeof reads.verdict.value[1] === 'string');
  }
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
      return quoteMatches(reads.quote.value, terms) && seller.custom_quote?.active === true &&
        amount(reads.quote.value.max_expense) * 10_000n <= amount(terms.amount) * BigInt(seller.custom_quote.max_expense_bps);
    });
  const finished = now();
  if (!Number.isSafeInteger(finished) || finished < started) throw new Error('local clock moved backwards');
  try { assertFreshFinalBlock(block, finished); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  checks.intent_window_remaining = terms.expires_at_ms - finished >= MIN_INTENT_WINDOW_MS ? 'PASS' : 'BLOCKED';
  const blockers = Object.entries(checks).filter(([, status]) => status !== 'PASS').map(([check, status]) => ({ check, status }));
  return { status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : index === 3 ? 'READ_ONLY_INTENT_STAGE_PROFILE_MATCH' : 'READ_ONLY_SPENDING_STAGE_PROFILE_MATCH', stage_id: stageId,
    network: 'testnet', block_hash: hash, block_height: block.header.height, checked_at: new Date(finished).toISOString(),
    owner: identity.owner, vault: identity.vault, adapter: identity.adapter, seller: SELLER,
    review_sha256: trustedReviewHash, forwarder_review_sha256: trustedForwarderReviewHash,
    forwarder_wallet_review_sha256: index === 3 ? trustedForwarderWalletReviewHash : null,
    forwarder_wasm_sha256: trustedForwarderWasmSha256, seller_code_hash: trustedSellerCodeHash,
    checks, blockers, execution_authorized: false, owner_approval_verified: false, durable_fence_verified: false,
    prior_originals_reconciled: false, deployed_source_equivalence_verified: false, receipt_consensus_verified: false,
    wallet_connected: false, transaction_signed: false, transaction_sent: false, seller_contacted: false,
    independent_delivery_verified: false, estimates_are_not_storage_or_gas_guarantees: true,
    scope: 'trusted-RPC, local-clock and same-block views only; prices, code, balances, keys and chain state can race; no journal, approval or payment' };
}
