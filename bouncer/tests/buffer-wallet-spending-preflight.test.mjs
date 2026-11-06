import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectBufferSpendingStage } from '../agent/buffer-wallet-spending-preflight.mjs';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferForwarder, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';

// Every account, chain response, quote, code hash and key is synthetic. No
// network, owner approval, wallet, journal, order, transaction or seller used.
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const BLOCK = hash(20), OTHER = hash(21), SELLER_HASH = hash(22), NOW = 1_800_000_000_000;
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'forwarder.buyer.testnet';
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const vaultKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const forwarderKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const PLAN = buildBufferWalletSpendingPlan({ owner: OWNER, vault: VAULT, adapter: ADAPTER, policy_id: 'research',
  vault_agent_public_key: vaultKey, forwarder_agent_public_key: forwarderKey, per_tx_cap_atoms: '20000000',
  daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '250000000000000000000000',
  forwarder_agent_gas_allowance_yocto: '300000000000000000000000' });
const terms = (custom = false) => ({ owner: OWNER, vault: VAULT, adapter: ADAPTER,
  forwarder_agent_public_key: forwarderKey, vault_agent_public_key: vaultKey, policy_id: 'research',
  intent_id: 'intent-1', amount: custom ? '5000000' : '20000000', expires_at_ms: NOW + 10 * 60_000,
  native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
  api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: custom ? 'q-000000000001' : 'o-000000000001',
  sku: custom ? 'custom-brief' : 'weekly-market-brief', brief_sha256: 'a'.repeat(64) });
const artifact = await buildBufferForwarder(terms(), { nowMs: NOW });
const customArtifact = await buildBufferForwarder(terms(true), { nowMs: NOW });
const STAGES = PLAN.batches.map(batch => batch.id);
const registration = () => ({ total: '1250000000000000000000', available: '0' });

function snapshot(index = 0, custom = false) {
  const a = custom ? customArtifact : artifact;
  const ownerKeys = [{ public_key: ownerKey, access_key: { permission: 'FullAccess' } }];
  if (index === 2) ownerKeys.push({ public_key: vaultKey, access_key: { permission: { FunctionCall: {
    receiver_id: VAULT, method_names: ['execute_exact_ft'], allowance: PLAN.review.stages[1].actions[0].allowance_yocto } } } });
  const account = (code_hash, amount = 8n * 10n ** 24n) => ({ block_hash: BLOCK, code_hash, amount, storage_usage: 10_000 });
  return {
    network: 'testnet', block: { header: { hash: BLOCK, height: 123, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: '10000000000000000000',
      wasm_config: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true } } },
    owner: account('11111111111111111111111111111111', 20n * 10n ** 24n),
    ownerKey: { block_hash: BLOCK, nonce: 123n, permission: 'FullAccess' }, ownerKeys: { block_hash: BLOCK, keys: ownerKeys },
    vault: account(V12_NEAR_CODE_HASH), vaultKeys: { block_hash: BLOCK, keys: [] },
    forwarder: account(nearApi.utils.serialize.base_encode(Buffer.from(a.wasm_sha256, 'hex'))),
    forwarderKeys: { block_hash: BLOCK, keys: [] }, token: account(CIRCLE_TESTNET_CODE_HASH), seller: account(SELLER_HASH),
    vaultOwner: OWNER, vaultVersion: 'bouncer-agent-v12-exact-ft-testnet',
    policy: index === 0 ? null : { token: TOKEN, per_tx_cap: '20000000', daily_cap: '20000000' },
    policyLocked: index !== 0, agentGranted: index !== 0, payeeLocked: false, intent: null, daily: '0',
    tracked: '20000000', vaultUsdc: '20000000', forwarderUsdc: '0', vaultRegistration: registration(),
    forwarderRegistration: registration(), sellerRegistration: registration(), forwarderConfig: structuredClone(a.review), forwarderOpened: false,
    sellerConfig: { owner: 'seller.testnet', agent: 'worker.testnet', owner_payout: 'seller.testnet', contributor: 'seller.testnet',
      paused: false, token_id: TOKEN, policy_version: 1 },
    sellerRules: [['custom-brief', { min_price: '5000000', max_price: '50000000', max_expense_bps: 5000, active: true }]],
    sellerProducts: [['weekly-market-brief', { price: '20000000', max_expense: '0', active: true }]], sellerOrder: null,
    quote: { sku: 'custom-brief', amount: '5000000', max_expense: '1000000', paid: false,
      expires_ns: String(BigInt(NOW + 11 * 60_000) * 1_000_000n) },
    verdict: [true, 'OK'], calls: [], failures: new Set(), raw: {}, hook: null,
  };
}
function providerFor(s) {
  let ranHook = false;
  async function note(name, args) {
    s.calls.push([name, ...args]);
    if (s.failures.has(name)) throw new Error('untrusted provider secret must never leak');
    if (!ranHook && s.hook) { ranHook = true; await s.hook(); }
  }
  const accounts = { [OWNER]: 'owner', [VAULT]: 'vault', [ADAPTER]: 'forwarder', [TOKEN]: 'token', [SELLER]: 'seller' };
  const lists = { [OWNER]: 'ownerKeys', [VAULT]: 'vaultKeys', [ADAPTER]: 'forwarderKeys' };
  const contractMethods = { get_owner: 'vaultOwner', contract_version: 'vaultVersion', get_policy: 'policy',
    is_exact_ft_policy_locked: 'policyLocked', is_agent_key_allowed: 'agentGranted', is_exact_ft_payee_locked: 'payeeLocked',
    get_exact_ft_intent: 'intent', daily_spent: 'daily', vault_balance: 'tracked', check: 'verdict',
    configuration: 'forwarderConfig', opened: 'forwarderOpened', get_config: 'sellerConfig', get_quote_rules: 'sellerRules',
    get_products: 'sellerProducts', get_order: 'sellerOrder', get_quote: 'quote' };
  const registrations = { [VAULT]: 'vaultRegistration', [ADAPTER]: 'forwarderRegistration', [SELLER]: 'sellerRegistration' };
  return {
    async viewNodeStatus() { await note('status', []); return { chain_id: s.network }; },
    async viewBlock(ref) { await note('block', [ref]); return s.block; },
    async experimental_protocolConfig(ref) { await note('protocol', [ref]); return s.protocol; },
    async viewAccount(account, ref) { const name = accounts[account]; await note(name, [account, ref]); if (!name) throw Error(); return s[name]; },
    async viewAccessKey(account, key, ref) { await note('ownerKey', [account, key, ref]); return s.ownerKey; },
    async viewAccessKeyList(account, ref) { const name = lists[account]; await note(name, [account, ref]); if (!name) throw Error(); return s[name]; },
    async callFunctionRaw(contract, method, args, ref) {
      const name = method === 'storage_balance_of' ? registrations[args.account_id] : method === 'ft_balance_of'
        ? ({ [VAULT]: 'vaultUsdc', [ADAPTER]: 'forwarderUsdc' })[args.account_id] : contractMethods[method];
      await note(name, [contract, method, args, ref]);
      const expected = method === 'storage_balance_of' || method === 'ft_balance_of' ? TOKEN :
        ['configuration', 'opened'].includes(method) ? ADAPTER : method.startsWith('get_') &&
          ['get_config', 'get_quote_rules', 'get_products', 'get_order', 'get_quote'].includes(method) ? SELLER : VAULT;
      if (!name || contract !== expected) throw Error('unexpected synthetic view');
      if (Object.hasOwn(s.raw, name)) return s.raw[name];
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(s[name]))] };
    },
  };
}
function input(s, index = 0, custom = false, extra = {}) {
  const a = custom ? customArtifact : artifact;
  return { review: structuredClone(PLAN.review), trustedReviewHash: PLAN.review.review_sha256, trustedOwnerPublicKey: ownerKey,
    stageId: STAGES[index], forwarderTerms: terms(custom), trustedForwarderReviewHash: a.review.review_sha256,
    trustedForwarderWasmSha256: a.wasm_sha256, trustedSellerCodeHash: SELLER_HASH, provider: providerFor(s), now: () => NOW, ...extra };
}

test('each stage checks exact reviewed code, scoped keys and one FINAL block without granting spending', async () => {
  for (let i = 0; i < 3; i++) {
    const s = snapshot(i), result = await inspectBufferSpendingStage(input(s, i));
    assert.equal(result.status, 'READ_ONLY_SPENDING_STAGE_PROFILE_MATCH', STAGES[i]);
    assert.deepEqual(result.blockers, []);
    assert.ok(Object.values(result.checks).every(value => value === 'PASS'));
    assert.equal(result.block_hash, BLOCK);
    for (const field of ['execution_authorized', 'owner_approval_verified', 'durable_fence_verified',
      'prior_originals_reconciled', 'deployed_source_equivalence_verified', 'receipt_consensus_verified',
      'wallet_connected', 'transaction_signed', 'transaction_sent', 'seller_contacted', 'independent_delivery_verified']) {
      assert.equal(result[field], false, field);
    }
    for (const [name, ...args] of s.calls) {
      if (['status', 'block'].includes(name)) continue;
      assert.deepEqual(args.at(-1), { blockId: BLOCK }, name);
    }
  }
});

test('all required trust anchors and matching forwarder terms are checked before any RPC', async () => {
  for (const patch of [
    { trustedReviewHash: '0'.repeat(64) }, { trustedOwnerPublicKey: vaultKey }, { stageId: 'invented' },
    { trustedForwarderReviewHash: '0'.repeat(64) }, { trustedForwarderWasmSha256: '0'.repeat(64) },
    { trustedSellerCodeHash: 'invalid' }, { forwarderTerms: { ...terms(), adapter: 'evil.buyer.testnet' } },
    { forwarderTerms: { ...terms(), amount: '20000001' } }, { forwarderTerms: { ...terms(), expires_at_ms: NOW - 1 } },
  ]) {
    const s = snapshot(), args = input(s, 0, false, patch);
    await assert.rejects(inspectBufferSpendingStage(args));
    assert.deepEqual(s.calls, []);
  }
});

test('code, key, policy, balance, registration and seller drift each block the named check', async () => {
  const cases = [
    [0, 'plain_owner', s => { s.owner.code_hash = OTHER; }],
    [0, 'owner_full_access_and_safe_nonce', s => { s.ownerKey.permission = { FunctionCall: {} }; }],
    [0, 'owner_full_access_and_safe_nonce', s => { s.ownerKey.nonce = BigInt(Number.MAX_SAFE_INTEGER); }],
    [0, 'exact_owner_key_state', s => { s.ownerKeys.keys.push({ public_key: vaultKey, access_key: { permission: 'FullAccess' } }); }],
    [2, 'exact_owner_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.method_names.push('set_policy'); }],
    [2, 'exact_owner_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.allowance = null; }],
    [2, 'exact_owner_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FullAccess = true; }],
    [2, 'exact_owner_key_state', s => { s.ownerKeys.keys[1].access_key.permission.FunctionCall.unexpected = true; }],
    [2, 'exact_owner_key_state', s => { s.ownerKeys.keys.push(structuredClone(s.ownerKeys.keys[0])); }],
    [0, 'owner_native_estimate', s => { s.owner.amount = 0n; }],
    [0, 'vault_code_and_no_keys', s => { s.vault.code_hash = OTHER; }],
    [0, 'vault_code_and_no_keys', s => { s.vault.global_contract_account_id = 'other.testnet'; }],
    [0, 'vault_code_and_no_keys', s => { s.vaultKeys.keys.push({ public_key: ownerKey }); }],
    [0, 'vault_owner_and_version', s => { s.vaultOwner = 'evil.testnet'; }],
    [0, 'vault_native_estimate', s => { s.vault.amount = 0n; }],
    [0, 'forwarder_code_and_no_keys', s => { s.forwarder.code_hash = OTHER; }],
    [0, 'forwarder_code_and_no_keys', s => { s.forwarderKeys.keys.push({ public_key: ownerKey }); }],
    [0, 'forwarder_native_estimate', s => { s.forwarder.amount = 0n; }],
    [0, 'forwarder_configuration_unopened', s => { s.forwarderConfig.owner = 'evil.testnet'; }],
    [0, 'forwarder_configuration_unopened', s => { s.forwarderOpened = true; }],
    [0, 'circle_and_seller_code_pins', s => { s.token.code_hash = OTHER; }],
    [0, 'circle_and_seller_code_pins', s => { s.seller.code_hash = OTHER; }],
    [0, 'all_circle_registrations', s => { s.forwarderRegistration = null; }],
    [0, 'vault_tracked_and_actual_funding', s => { s.vaultUsdc = '19999999'; }],
    [0, 'vault_tracked_and_actual_funding', s => { s.forwarderUsdc = '1'; }],
    [0, 'unconsumed_intent_payee_and_budget', s => { s.intent = {}; }],
    [0, 'unconsumed_intent_payee_and_budget', s => { s.payeeLocked = true; }],
    [0, 'unconsumed_intent_payee_and_budget', s => { s.daily = '1'; }],
    [0, 'policy_not_yet_configured', s => { s.policy = {}; }],
    [0, 'policy_not_yet_configured', s => { s.policyLocked = true; }],
    [1, 'exact_policy_locked_and_granted', s => { s.policy.per_tx_cap = '20000001'; }],
    [1, 'expected_payee_allowed', s => { s.verdict = [false, 'blocked']; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerConfig.paused = true; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerProducts[0][1].price = '21000000'; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerOrder = {}; }],
    [0, 'testnet_protocol_and_selected_features', s => { s.protocol.runtime_config.wasm_config.universal_accounts = false; }],
  ];
  for (const [i, check, change] of cases) {
    const s = snapshot(i); change(s);
    const result = await inspectBufferSpendingStage(input(s, i));
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', check);
    assert.equal(result.checks[check], 'BLOCKED', check);
    assert.equal(result.execution_authorized, false);
  }
});

test('mixed blocks and unavailable views are blocked or unknown, never guessed', async () => {
  for (const [field, check] of [['vault', 'vault_code_and_no_keys'], ['ownerKey', 'owner_full_access_and_safe_nonce'],
    ['forwarderKeys', 'forwarder_code_and_no_keys'], ['seller', 'circle_and_seller_code_pins']]) {
    const s = snapshot(); s[field].block_hash = OTHER;
    const result = await inspectBufferSpendingStage(input(s));
    assert.equal(result.checks[check], 'BLOCKED');
  }
  for (const [field, check] of [['vaultVersion', 'vault_owner_and_version'], ['forwarderConfig', 'forwarder_configuration_unopened'],
    ['sellerConfig', 'seller_active_and_price_matches'], ['vaultUsdc', 'vault_tracked_and_actual_funding']]) {
    const s = snapshot(); s.failures.add(field);
    const result = await inspectBufferSpendingStage(input(s));
    assert.equal(result.checks[check], 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(result), /untrusted provider secret/);
  }
  const s = snapshot(); s.raw.vaultOwner = { block_hash: OTHER, result: [...Buffer.from(JSON.stringify(OWNER))] };
  assert.equal((await inspectBufferSpendingStage(input(s))).checks.vault_owner_and_version, 'UNKNOWN');
});

test('custom quote must be unpaid, match the exact price, and outlive the intent by ten seconds', async () => {
  const good = snapshot(0, true);
  assert.equal((await inspectBufferSpendingStage(input(good, 0, true))).status, 'READ_ONLY_SPENDING_STAGE_PROFILE_MATCH');
  for (const change of [
    s => { s.quote.paid = true; }, s => { s.quote.amount = '5000001'; }, s => { s.quote.sku = 'weekly-market-brief'; },
    s => { s.quote.max_expense = '5000001'; }, s => { s.quote.max_expense = '2500001'; },
    s => { s.quote.expires_ns = String(BigInt(NOW + 10 * 60_000 + 9_999) * 1_000_000n); },
    s => { s.quote.expires_ns = '0'; },
  ]) {
    const s = snapshot(0, true); change(s);
    assert.equal((await inspectBufferSpendingStage(input(s, 0, true))).checks.unpaid_quote_matches_and_covers_intent, 'BLOCKED');
  }
});

test('stale or wrong-network RPC is rejected, and a clock that goes stale during reads blocks', async () => {
  const wrong = snapshot(); wrong.network = 'mainnet';
  await assert.rejects(inspectBufferSpendingStage(input(wrong)), /testnet/);
  const stale = snapshot(); stale.block.header.timestamp_nanosec = String(BigInt(NOW - 120_001) * 1_000_000n);
  await assert.rejects(inspectBufferSpendingStage(input(stale)), /stale/);
  const s = snapshot(); let calls = 0;
  const result = await inspectBufferSpendingStage(input(s, 0, false, { now: () => ++calls < 3 ? NOW : NOW + 121_000 }));
  assert.equal(result.checks.final_block_fresh_at_completion, 'BLOCKED');
  assert.equal(result.execution_authorized, false);
});

test('review and terms are snapshotted before async reads so later mutation cannot widen the check', async () => {
  const s = snapshot(), args = input(s);
  s.hook = () => { args.review.per_tx_cap_atoms = '1'; args.forwarderTerms.adapter = 'evil.buyer.testnet'; };
  const result = await inspectBufferSpendingStage(args);
  assert.equal(result.status, 'READ_ONLY_SPENDING_STAGE_PROFILE_MATCH');
  assert.equal(result.adapter, ADAPTER);
  assert.equal(result.review_sha256, PLAN.review.review_sha256);
});
