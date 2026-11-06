import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectBufferForwarderWalletStage } from '../agent/buffer-forwarder-wallet-preflight.mjs';
import { buildBufferForwarderWalletPlan } from '../agent/buffer-forwarder-wallet-plan.mjs';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferForwarder, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';

// Disposable keys and entirely synthetic chain data. No RPC, token, wallet,
// seller, order, prompt, signature, send, payment or delivery is involved.
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const BLOCK = hash(20), OTHER = hash(21), SELLER_HASH = hash(22), NOW = 1_800_000_000_000;
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'forwarder.buyer.testnet';
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const ownerKey = key(), vaultKey = key(), forwarderKey = key();
const spend = buildBufferWalletSpendingPlan({ owner: OWNER, vault: VAULT, adapter: ADAPTER, policy_id: 'research',
  vault_agent_public_key: vaultKey, forwarder_agent_public_key: forwarderKey, per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000',
  vault_agent_gas_allowance_yocto: '250000000000000000000000', forwarder_agent_gas_allowance_yocto: '300000000000000000000000' }).review;
const terms = (custom = false) => ({ owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: forwarderKey,
  vault_agent_public_key: vaultKey, policy_id: 'research', intent_id: 'intent-1', amount: custom ? '5000000' : '20000000',
  expires_at_ms: NOW + 600_000, native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
  api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: custom ? 'q-000000000001' : 'o-000000000001',
  sku: custom ? 'custom-brief' : 'weekly-market-brief', brief_sha256: 'a'.repeat(64) });
const artifact = await buildBufferForwarder(terms(), { nowMs: NOW }), customArtifact = await buildBufferForwarder(terms(true), { nowMs: NOW });
const makePlan = async custom => buildBufferForwarderWalletPlan({ terms: terms(custom), spendingReview: spend,
  trustedSpendingReviewHash: spend.review_sha256, trustedOwnerPublicKey: ownerKey,
  registrationDepositYocto: '1250000000000000000000', nowMs: NOW });
const PLAN = await makePlan(false), CUSTOM_PLAN = await makePlan(true);
const STAGES = ['create_buffer_forwarder', 'register_buffer_forwarder_circle'];
const registration = () => ({ total: '1250000000000000000000', available: '0' });
function snapshot(index = 0, custom = false) {
  const a = custom ? customArtifact : artifact, p = custom ? CUSTOM_PLAN : PLAN;
  const account = (code_hash, amount = 8n * 10n ** 24n) => ({ block_hash: BLOCK, code_hash, amount, storage_usage: 10_000 });
  return {
    network: 'testnet', block: { header: { hash: BLOCK, height: 123, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: '10000000000000000000',
      wasm_config: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true } } },
    owner: account('11111111111111111111111111111111', 20n * 10n ** 24n),
    ownerKey: { block_hash: BLOCK, nonce: 123n, permission: 'FullAccess' },
    ownerKeys: { block_hash: BLOCK, keys: [{ public_key: ownerKey, access_key: { permission: 'FullAccess', nonce: 123 } }] },
    vault: account(V12_NEAR_CODE_HASH), vaultKeys: { block_hash: BLOCK, keys: [] },
    forwarderPresence: index === 0 ? { block_hash: BLOCK, exists: false } :
      { block_hash: BLOCK, exists: true, account: account(p.review.forwarder_wasm_near_hash, 3n * 10n ** 24n) },
    forwarderKeys: { block_hash: BLOCK, keys: [] }, token: account(CIRCLE_TESTNET_CODE_HASH), seller: account(SELLER_HASH),
    bounds: { min: '1250000000000000000000', max: '1250000000000000000000' }, metadata: { symbol: 'USDC', decimals: 6 },
    vaultRegistration: registration(), forwarderRegistration: null, sellerRegistration: registration(),
    vaultUsdc: '20000000', forwarderUsdc: '0', tracked: '20000000',
    vaultOwner: OWNER, vaultVersion: 'bouncer-agent-v12-exact-ft-testnet',
    policy: null, policyLocked: false, agentGranted: false, payeeLocked: false, intent: null, daily: '0',
    forwarderConfig: structuredClone(a.review), forwarderOpened: false,
    sellerConfig: { owner: 'seller.testnet', agent: 'worker.testnet', owner_payout: 'seller.testnet', contributor: 'seller.testnet',
      paused: false, token_id: TOKEN, policy_version: 1 },
    sellerRules: [['custom-brief', { min_price: '5000000', max_price: '50000000', max_expense_bps: 5000, active: true }]],
    sellerProducts: [['weekly-market-brief', { price: '20000000', max_expense: '0', active: true }]], sellerOrder: null,
    quote: { sku: 'custom-brief', amount: '5000000', max_expense: '1000000', paid: false,
      expires_ns: String(BigInt(NOW + 660_000) * 1_000_000n) },
    calls: [], failures: new Set(), raw: {}, hook: null,
  };
}
function providerFor(s) {
  let ranHook = false;
  async function note(name, args) {
    s.calls.push([name, ...args]);
    if (s.failures.has(name)) throw Error('untrusted RPC secret must not leak');
    if (!ranHook && s.hook) { ranHook = true; await s.hook(); }
  }
  const accounts = { [OWNER]: 'owner', [VAULT]: 'vault', [TOKEN]: 'token', [SELLER]: 'seller' };
  const lists = { [OWNER]: 'ownerKeys', [VAULT]: 'vaultKeys', [ADAPTER]: 'forwarderKeys' };
  const methods = { storage_balance_bounds: 'bounds', ft_metadata: 'metadata', get_owner: 'vaultOwner', contract_version: 'vaultVersion',
    get_policy: 'policy', is_exact_ft_policy_locked: 'policyLocked', is_agent_key_allowed: 'agentGranted',
    is_exact_ft_payee_locked: 'payeeLocked', get_exact_ft_intent: 'intent', daily_spent: 'daily', vault_balance: 'tracked',
    configuration: 'forwarderConfig', opened: 'forwarderOpened', get_config: 'sellerConfig', get_quote_rules: 'sellerRules',
    get_products: 'sellerProducts', get_order: 'sellerOrder', get_quote: 'quote' };
  const registrations = { [VAULT]: 'vaultRegistration', [ADAPTER]: 'forwarderRegistration', [SELLER]: 'sellerRegistration' };
  return {
    async viewNodeStatus() { await note('status', []); return { chain_id: s.network }; },
    async viewBlock(ref) { await note('block', [ref]); return s.block; },
    async experimental_protocolConfig(ref) { await note('protocol', [ref]); return s.protocol; },
    async viewAccount(id, ref) { const name = accounts[id]; await note(name, [id, ref]); if (!name) throw Error(); return s[name]; },
    async viewAccessKey(id, k, ref) { await note('ownerKey', [id, k, ref]); return s.ownerKey; },
    async viewAccessKeyList(id, ref) { const name = lists[id]; await note(name, [id, ref]); if (!name) throw Error(); return s[name]; },
    async viewTestnetAccountPresenceAt(id, block) { await note('forwarderPresence', [id, block]); return s.forwarderPresence; },
    async callFunctionRaw(contract, method, args, ref) {
      const name = method === 'storage_balance_of' ? registrations[args.account_id] : method === 'ft_balance_of'
        ? ({ [VAULT]: 'vaultUsdc', [ADAPTER]: 'forwarderUsdc' })[args.account_id] : methods[method];
      await note(name, [contract, method, args, ref]);
      const expected = ['storage_balance_of', 'ft_balance_of', 'storage_balance_bounds', 'ft_metadata'].includes(method) ? TOKEN :
        ['configuration', 'opened'].includes(method) ? ADAPTER : ['get_config', 'get_quote_rules', 'get_products', 'get_order', 'get_quote'].includes(method) ? SELLER : VAULT;
      if (!name || contract !== expected) throw Error();
      if (Object.hasOwn(s.raw, name)) return s.raw[name];
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(s[name]))] };
    },
  };
}
function input(s, index = 0, custom = false, extra = {}) {
  const plan = custom ? CUSTOM_PLAN : PLAN;
  return { review: structuredClone(plan.review), trustedReviewHash: plan.review.review_sha256, terms: terms(custom),
    spendingReview: structuredClone(spend), trustedSpendingReviewHash: spend.review_sha256, trustedOwnerPublicKey: ownerKey,
    trustedSellerCodeHash: SELLER_HASH, stageId: STAGES[index], provider: providerFor(s), now: () => NOW, ...extra };
}

test('fresh same-block deployment and registration profiles never authorize a wallet or payment', async () => {
  for (let i = 0; i < 2; i++) {
    const s = snapshot(i), result = await inspectBufferForwarderWalletStage(input(s, i));
    assert.equal(result.status, 'READ_ONLY_FORWARDER_STAGE_PROFILE_MATCH'); assert.deepEqual(result.blockers, []);
    assert.ok(Object.values(result.checks).every(x => x === 'PASS')); assert.equal(result.block_hash, BLOCK);
    for (const field of ['execution_authorized', 'owner_approval_verified', 'durable_fence_verified', 'prior_originals_reconciled',
      'deployed_source_equivalence_verified', 'receipt_consensus_verified', 'wallet_connected', 'transaction_signed',
      'transaction_sent', 'seller_contacted', 'private_order_verified', 'independent_delivery_verified']) assert.equal(result[field], false, field);
    for (const [name, ...args] of s.calls) {
      if (['status', 'block'].includes(name)) continue;
      assert.deepEqual(args.at(-1), name === 'forwarderPresence' ? BLOCK : { blockId: BLOCK }, name);
    }
  }
});

test('retained review, code, owner and stage are checked before any RPC', async () => {
  for (const patch of [
    { trustedReviewHash: '0'.repeat(64) }, { trustedSpendingReviewHash: '0'.repeat(64) },
    { trustedOwnerPublicKey: vaultKey }, { trustedSellerCodeHash: 'invalid' }, { stageId: 'pin_buffer_exact_intent' },
    { terms: { ...terms(), adapter: 'evil.buyer.testnet' } }, { terms: { ...terms(), expires_at_ms: NOW } },
  ]) {
    const s = snapshot(); await assert.rejects(inspectBufferForwarderWalletStage(input(s, 0, false, patch)));
    assert.deepEqual(s.calls, []);
  }
  const s = snapshot(), args = input(s); args.review.stages[0].actions[1].deposit_yocto = '1';
  await assert.rejects(inspectBufferForwarderWalletStage(args)); assert.deepEqual(s.calls, []);
});

test('drift in account, code, native cost, registration, funding, policy or seller blocks', async () => {
  const cases = [
    [0, 'plain_owner', s => { s.owner.code_hash = OTHER; }],
    [0, 'owner_full_access_and_safe_nonce', s => { s.ownerKey.permission = { FunctionCall: {} }; }],
    [0, 'owner_full_access_and_safe_nonce', s => { s.ownerKey.nonce = BigInt(Number.MAX_SAFE_INTEGER); }],
    [0, 'agent_keys_not_installed', s => { s.ownerKeys.keys.push({ public_key: vaultKey, access_key: { permission: 'FullAccess' } }); }],
    [0, 'agent_keys_not_installed', s => { s.ownerKeys.keys[0].access_key.nonce = 124; }],
    [0, 'owner_native_estimate', s => { s.owner.amount = 0n; }],
    [0, 'forwarder_funding_estimate', s => { s.protocol.runtime_config.storage_amount_per_byte = String(10n ** 23n); }],
    [0, 'vault_code_and_no_keys', s => { s.vault.code_hash = OTHER; }],
    [0, 'vault_code_and_no_keys', s => { s.vaultKeys.keys.push({ public_key: ownerKey }); }],
    [0, 'vault_owner_and_version', s => { s.vaultOwner = 'evil.testnet'; }],
    [0, 'vault_native_estimate', s => { s.vault.amount = 0n; }],
    [0, 'new_forwarder_absent', s => { s.forwarderPresence.exists = true; }],
    [0, 'new_forwarder_absent', s => { s.forwarderPresence.block_hash = OTHER; }],
    [1, 'forwarder_code_and_no_keys', s => { s.forwarderPresence.account.code_hash = OTHER; }],
    [1, 'forwarder_code_and_no_keys', s => { s.forwarderKeys.keys.push({ public_key: ownerKey }); }],
    [1, 'forwarder_native_estimate', s => { s.forwarderPresence.account.amount = 0n; }],
    [1, 'forwarder_configuration_unopened', s => { s.forwarderConfig.owner = 'evil.testnet'; }],
    [1, 'forwarder_configuration_unopened', s => { s.forwarderOpened = true; }],
    [0, 'circle_and_seller_code_pins', s => { s.token.code_hash = OTHER; }],
    [0, 'circle_and_seller_code_pins', s => { s.seller.code_hash = OTHER; }],
    [0, 'circle_and_seller_code_pins', s => { s.metadata.decimals = 18; }],
    [0, 'circle_registration_cost_exact', s => { s.bounds.min = '1'; }],
    [0, 'circle_registration_cost_exact', s => { s.bounds.max = '1'; }],
    [0, 'circle_registrations_expected', s => { s.forwarderRegistration = registration(); }],
    [0, 'vault_tracked_and_actual_funding', s => { s.vaultUsdc = '19999999'; }],
    [0, 'vault_tracked_and_actual_funding', s => { s.forwarderUsdc = '1'; }],
    [0, 'policy_and_intent_absent', s => { s.policy = {}; }],
    [0, 'policy_and_intent_absent', s => { s.intent = {}; }],
    [0, 'policy_and_intent_absent', s => { s.daily = '1'; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerConfig.paused = true; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerProducts[0][1].price = '21000000'; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerOrder = {}; }],
    [0, 'testnet_protocol_and_selected_features', s => { s.protocol.runtime_config.wasm_config.universal_accounts = false; }],
  ];
  for (const [i, check, mutate] of cases) {
    const s = snapshot(i); mutate(s); const result = await inspectBufferForwarderWalletStage(input(s, i));
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', check); assert.equal(result.checks[check], 'BLOCKED', check);
    assert.equal(result.execution_authorized, false);
  }
});

test('failed or mixed-block presence and views remain UNKNOWN or BLOCKED', async () => {
  for (const [field, check] of [['forwarderPresence', 'new_forwarder_absent'], ['vaultOwner', 'vault_owner_and_version'],
    ['forwarderRegistration', 'circle_registrations_expected'], ['sellerConfig', 'seller_active_and_price_matches']]) {
    const s = snapshot(); s.failures.add(field); const result = await inspectBufferForwarderWalletStage(input(s));
    assert.equal(result.checks[check], 'UNKNOWN'); assert.doesNotMatch(JSON.stringify(result), /untrusted RPC secret/);
  }
  const s = snapshot(); s.raw.vaultOwner = { block_hash: OTHER, result: [...Buffer.from(JSON.stringify(OWNER))] };
  assert.equal((await inspectBufferForwarderWalletStage(input(s))).checks.vault_owner_and_version, 'UNKNOWN');
});

test('custom quote must remain unpaid, exact and longer-lived than the intent', async () => {
  for (let i = 0; i < 2; i++) assert.equal((await inspectBufferForwarderWalletStage(input(snapshot(i, true), i, true))).status,
    'READ_ONLY_FORWARDER_STAGE_PROFILE_MATCH');
  for (const mutate of [
    s => { s.quote.paid = true; }, s => { s.quote.amount = '5000001'; },
    s => { s.quote.max_expense = '2500001'; }, s => { s.quote.expires_ns = String(BigInt(NOW + 609_999) * 1_000_000n); },
  ]) {
    const s = snapshot(0, true); mutate(s);
    assert.equal((await inspectBufferForwarderWalletStage(input(s, 0, true))).checks.unpaid_quote_matches_and_covers_intent, 'BLOCKED');
  }
});

test('wrong network, stale blocks, short expiry and mutation during reads fail safely', async () => {
  const wrong = snapshot(); wrong.network = 'mainnet'; await assert.rejects(inspectBufferForwarderWalletStage(input(wrong)), /testnet/);
  const stale = snapshot(); stale.block.header.timestamp_nanosec = String(BigInt(NOW - 120_001) * 1_000_000n);
  await assert.rejects(inspectBufferForwarderWalletStage(input(stale)), /stale/);
  const timing = snapshot(); let calls = 0;
  const result = await inspectBufferForwarderWalletStage(input(timing, 0, false, { now: () => ++calls < 3 ? NOW : NOW + 550_001 }));
  assert.equal(result.checks.final_block_fresh_at_completion, 'BLOCKED'); assert.equal(result.checks.intent_window_remaining, 'BLOCKED');
  const s = snapshot(), args = input(s); s.hook = () => { args.terms.adapter = 'evil.buyer.testnet'; args.review.owner = 'evil.testnet'; };
  const safe = await inspectBufferForwarderWalletStage(args); assert.equal(safe.adapter, ADAPTER);
  assert.equal(safe.status, 'READ_ONLY_FORWARDER_STAGE_PROFILE_MATCH');
});
