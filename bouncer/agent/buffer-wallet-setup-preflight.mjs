/**
 * Read-only, same-FINAL-block checks for one reviewed Buffer vault setup stage.
 * Independently retained earlier original hashes are compared to supplied
 * receipt graphs before any RPC call. This has NO wallet, signer, prompt,
 * durable journal, seller HTTP client, transaction sender or authorization.
 *
 * RPC data and the local clock are trusted, and all state can change after a
 * read. A passing snapshot cannot rule out unrecorded earlier prompts,
 * concurrent transactions, rollback, a mutable seller upgrade or hidden vault
 * policy state. Never resend an ambiguous original or treat this as consent.
 */
import { verifyBufferWalletSetupReview, inspectBufferWalletSetupAttempt } from './buffer-wallet-setup-evidence.mjs';
import { BUFFER_FIXED_PRICE_ATOMS, BUFFER_FIXED_PRODUCT_SKU } from './buffer-wallet-setup-plan.mjs';
import { CIRCLE_TESTNET_CODE_HASH, V12_EXPECTED_BYTES, VAULT_NATIVE_FUNDING_YOCTO } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { MIN_V11_TESTNET_PROTOCOL, selectedV11WasmFeaturesEnabled } from './svalin-setup-preflight.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { sellerTerms } from './buffer-live-readiness.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle', 'verify_funded_vault'];
const MAX = (1n << 128n) - 1n, ONE = 10n ** 24n, MARGIN = 50_000n;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (x, names) => obj(x) && Object.keys(x).length === names.length && names.every(n => Object.hasOwn(x, n));
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
function exactOwnerKey(keys, access, hash, publicKey) {
  const nonce = pinnedAccessKeyNonce(access?.nonce), rows = keys?.keys;
  return access?.block_hash === hash && access.permission === 'FullAccess' && nonce !== null && keys?.block_hash === hash &&
    Array.isArray(rows) && rows.length <= 10_000 && rows.every(k => obj(k) && typeof k.public_key === 'string' && obj(k.access_key)) &&
    new Set(rows.map(k => k.public_key)).size === rows.length && rows.some(k => k.public_key === publicKey &&
      k.access_key.permission === 'FullAccess' && pinnedAccessKeyNonce(k.access_key.nonce) === nonce);
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

/** The setup review, snapshot, WASM, owner key, seller hash and prior original
 * hashes must be retained independently. Every preceding stage must have its
 * own matching receipt-inclusive FINAL result; no earlier attempt is retried.
 * `verify_funded_vault` is a read-only post-funding snapshot, not a prompt. */
export async function inspectBufferWalletSetupStage({ review: rawReview, snapshot: rawSnapshot, wasmBytes: rawWasm,
  trustedReviewHash, trustedOwnerPublicKey, trustedSellerCodeHash, stageId, priorOriginals: rawPriorOriginals,
  provider, now = Date.now } = {}) {
  // Copy caller-owned data before the first await, including bytes and receipt
  // results, so concurrent mutation cannot change what the stage checks.
  const review = structuredClone(rawReview), snapshot = structuredClone(rawSnapshot);
  const wasmBytes = rawWasm instanceof Uint8Array ? Buffer.from(rawWasm) : rawWasm;
  const priorOriginals = structuredClone(rawPriorOriginals);
  const identity = verifyBufferWalletSetupReview({ review, snapshot, wasmBytes, trustedReviewHash, trustedOwnerPublicKey });
  const index = STAGES.indexOf(stageId);
  if (index < 0 || !isTransactionHash(trustedSellerCodeHash) || trustedSellerCodeHash !== review.seller_code_hash_observed ||
      !Array.isArray(priorOriginals) || priorOriginals.length !== index || typeof now !== 'function' || !provider ||
      ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList', 'viewTestnetAccountPresenceAt',
        'callFunctionRaw', 'experimental_protocolConfig'].some(name => typeof provider[name] !== 'function')) {
    throw new Error('reviewed setup stage, seller pin, preceding originals and read-only testnet provider required');
  }
  const hashes = new Set();
  for (let i = 0; i < index; i++) {
    const previous = priorOriginals[i];
    if (!keysAre(previous, ['trustedOriginalHash', 'attempt', 'result']) ||
        !isTransactionHash(previous.trustedOriginalHash) || hashes.has(previous.trustedOriginalHash) ||
        previous.attempt?.stage_id !== STAGES[i]) throw new Error('preceding setup original is missing, duplicated or out of order; stop and reconcile');
    hashes.add(previous.trustedOriginalHash);
    const proof = inspectBufferWalletSetupAttempt({ review, snapshot, wasmBytes, trustedReviewHash, trustedOwnerPublicKey,
      trustedOriginalHash: previous.trustedOriginalHash, attempt: previous.attempt, result: previous.result });
    if (proof.status !== (i === 2 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH')) {
      throw new Error('preceding setup original did not match; stop and reconcile');
    }
  }
  const start = now();
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isFinite(new Date(start).getTime())) throw new Error('invalid local time');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('testnet RPC required');
  const block = await provider.viewBlock({ finality: 'final' }), { hash } = assertFreshFinalBlock(block, now());
  if (!Number.isSafeInteger(block?.header?.height) || block.header.height < 1) throw new Error('invalid FINAL height');
  const at = () => ({ blockId: hash }), view = (account, method, args = {}) => readPinnedJsonView(provider, hash, account, method, args);
  const tasks = {
    protocol: () => provider.experimental_protocolConfig(at()),
    owner: () => provider.viewAccount(identity.owner, at()),
    owner_key: () => provider.viewAccessKey(identity.owner, trustedOwnerPublicKey, at()),
    owner_keys: () => provider.viewAccessKeyList(identity.owner, at()),
    vault_presence: () => provider.viewTestnetAccountPresenceAt(identity.vault, hash),
    token: () => provider.viewAccount(TOKEN, at()), seller: () => provider.viewAccount(SELLER, at()),
    bounds: () => view(TOKEN, 'storage_balance_bounds'), metadata: () => view(TOKEN, 'ft_metadata'),
    owner_registration: () => view(TOKEN, 'storage_balance_of', { account_id: identity.owner }),
    vault_registration: () => view(TOKEN, 'storage_balance_of', { account_id: identity.vault }),
    seller_registration: () => view(TOKEN, 'storage_balance_of', { account_id: SELLER }),
    owner_tokens: () => view(TOKEN, 'ft_balance_of', { account_id: identity.owner }),
    vault_tokens: () => view(TOKEN, 'ft_balance_of', { account_id: identity.vault }),
    seller_config: () => view(SELLER, 'get_config'), seller_rules: () => view(SELLER, 'get_quote_rules'),
    seller_products: () => view(SELLER, 'get_products'),
  };
  if (index > 0) {
    tasks.vault_keys = () => provider.viewAccessKeyList(identity.vault, at());
    tasks.vault_owner = () => view(identity.vault, 'get_owner');
    tasks.vault_version = () => view(identity.vault, 'contract_version');
    tasks.tracked = () => view(identity.vault, 'vault_balance', { token: TOKEN });
  }
  const names = Object.keys(tasks), results = await bounded(names.map(name => tasks[name]));
  const reads = Object.fromEntries(names.map((name, i) => [name, results[i]])), checks = {};
  const atBlock = name => reads[name].available && reads[name].value?.block_hash === hash;
  const put = (name, dependencies, predicate) => {
    if (dependencies.some(dep => !reads[dep]?.available)) { checks[name] = 'UNKNOWN'; return; }
    try { checks[name] = predicate() ? 'PASS' : 'BLOCKED'; } catch { checks[name] = 'BLOCKED'; }
  };
  const cost = amount(reads.protocol.value?.runtime_config?.storage_amount_per_byte);
  put('testnet_protocol_and_selected_features', ['protocol'], () => reads.protocol.value?.chain_id === 'testnet' &&
    Number.isSafeInteger(reads.protocol.value.protocol_version) && reads.protocol.value.protocol_version >= MIN_V11_TESTNET_PROTOCOL &&
    cost !== null && cost > 0n && selectedV11WasmFeaturesEnabled(reads.protocol.value));
  put('plain_owner', ['owner'], () => hasPlainOwnerProfileAt(reads.owner.value, hash));
  put('exact_owner_full_access_and_safe_nonce', ['owner_key', 'owner_keys'], () =>
    exactOwnerKey(reads.owner_keys.value, reads.owner_key.value, hash, trustedOwnerPublicKey));
  const registration = amount(review.stages[1].actions[0].deposit_yocto);
  const remaining = index === 0 ? BigInt(VAULT_NATIVE_FUNDING_YOCTO) + registration : index === 1 ? registration : 0n;
  put('owner_native_estimate', ['owner', 'protocol'], () => available(reads.owner.value, hash, cost, ONE + remaining));
  put('planned_vault_native_estimate', ['protocol'], () => cost !== null && cost > 0n &&
    BigInt(VAULT_NATIVE_FUNDING_YOCTO) >= (BigInt(V12_EXPECTED_BYTES) + MARGIN) * cost + ONE / 10n);
  if (index === 0) {
    put('new_vault_absent', ['vault_presence'], () => atBlock('vault_presence') && reads.vault_presence.value.exists === false);
  } else {
    put('vault_code_and_no_keys', ['vault_presence', 'vault_keys'], () => atBlock('vault_presence') &&
      reads.vault_presence.value.exists === true && reads.vault_presence.value.account?.block_hash === hash &&
      localCode(reads.vault_presence.value.account) && reads.vault_presence.value.account.code_hash === V12_NEAR_CODE_HASH &&
      atBlock('vault_keys') && Array.isArray(reads.vault_keys.value.keys) && reads.vault_keys.value.keys.length === 0);
    put('vault_native_estimate', ['vault_presence', 'protocol'], () =>
      available(reads.vault_presence.value.account, hash, cost, ONE / 10n, MARGIN));
    put('vault_owner_and_version', ['vault_owner', 'vault_version'], () => reads.vault_owner.value === identity.owner &&
      reads.vault_version.value === 'bouncer-agent-v12-exact-ft-testnet');
  }
  put('circle_and_seller_code_pins', ['token', 'seller', 'metadata'], () => atBlock('token') &&
    reads.token.value.code_hash === CIRCLE_TESTNET_CODE_HASH && reads.metadata.value?.decimals === 6 && reads.metadata.value?.symbol === 'USDC' &&
    atBlock('seller') && reads.seller.value.code_hash === trustedSellerCodeHash);
  put('circle_registration_cost_exact', ['bounds'], () => {
    const min = amount(reads.bounds.value?.min), max = reads.bounds.value?.max;
    return min !== null && min > 0n && min === registration && (max === null || (amount(max) !== null && amount(max) >= min));
  });
  put('circle_registrations_expected', ['owner_registration', 'vault_registration', 'seller_registration'], () =>
    registered(reads.owner_registration.value) && registered(reads.seller_registration.value) && (index < 2 ?
      reads.vault_registration.value === null : keysAre(reads.vault_registration.value, ['total', 'available']) &&
      amount(reads.vault_registration.value.total) === registration && reads.vault_registration.value.available === '0'));
  put('owner_token_funding', ['owner_tokens'], () => amount(reads.owner_tokens.value) !== null &&
    (index === 3 || amount(reads.owner_tokens.value) >= BigInt(BUFFER_FIXED_PRICE_ATOMS)));
  put('vault_token_funding_expected', index === 0 ? ['vault_tokens'] : ['vault_tokens', 'tracked'], () => {
    const expected = index === 3 ? BUFFER_FIXED_PRICE_ATOMS : '0';
    return reads.vault_tokens.value === expected && (index === 0 || reads.tracked.value === expected);
  });
  put('seller_active_and_price_matches', ['seller_config', 'seller_rules', 'seller_products', 'seller_registration'], () => {
    const seller = sellerTerms(reads.seller_config.value, reads.seller_rules.value, reads.seller_products.value, reads.seller_registration.value);
    return seller.accepts_reviewed_circle && seller.circle_registered && !seller.paused &&
      seller.fixed_products.some(p => p.sku === BUFFER_FIXED_PRODUCT_SKU && p.active && p.price_atoms === BUFFER_FIXED_PRICE_ATOMS);
  });
  const end = now();
  if (!Number.isSafeInteger(end) || end < start || !Number.isFinite(new Date(end).getTime())) throw new Error('local clock moved backwards or is invalid');
  try { assertFreshFinalBlock(block, end); checks.final_block_fresh_at_completion = 'PASS'; }
  catch { checks.final_block_fresh_at_completion = 'BLOCKED'; }
  const blockers = Object.entries(checks).filter(([, status]) => status !== 'PASS').map(([check, status]) => ({ check, status }));
  return { status: blockers.length ? 'BLOCKED_OR_UNKNOWN' : 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH', stage_id: stageId,
    network: 'testnet', block_hash: hash, block_height: block.header.height, checked_at: new Date(end).toISOString(),
    owner: identity.owner, vault: identity.vault, seller: SELLER, review_sha256: trustedReviewHash,
    seller_code_hash: trustedSellerCodeHash, prior_receipt_graphs_matched: index, checks, blockers,
    execution_authorized: false, owner_approval_verified: false, durable_fence_verified: false,
    unrecorded_prior_prompts_ruled_out: false, receipt_consensus_verified: false, deployed_source_equivalence_verified: false,
    all_payees_and_agents_enumerated: false, wallet_connected: false, transaction_signed: false, transaction_sent: false,
    seller_contacted: false, seller_payment_verified: false, independent_delivery_verified: false,
    estimates_are_not_storage_or_gas_guarantees: true,
    scope: 'trusted-RPC original receipt matches and same-block views only; no durable journal, prompt, approval, payment or delivery' };
}
