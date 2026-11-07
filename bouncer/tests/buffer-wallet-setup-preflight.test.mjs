import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBufferWalletSetupStage } from '../agent/buffer-wallet-setup-preflight.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';
import { wasm, OWNER, VAULT, AMOUNT, NOW, KEY, hash, fixture } from './buffer-wallet-setup-fixture.mjs';

// All receipts, chain data and keys are synthetic. A public, exact V12 artifact
// is used only to recreate the constrained unsigned review; nothing is sent.
const artifactTest = (name, fn) => test(name, { skip: !wasm && 'reviewed V12 fixture not supplied' }, fn);
const BLOCK = hash(20), OTHER = hash(21), SELLER_HASH = hash(5), ONE = 10n ** 24n;
const STAGES = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle', 'verify_funded_vault'];
const registered = () => ({ total: '1250000000000000000000', available: '0' });
const originals = wasm ? [0, 1, 2].map(i => {
  const f = fixture(i, 30 + i);
  return { trustedOriginalHash: f.trustedOriginalHash, attempt: f.attempt, result: f.result };
}) : [];
const base = wasm ? fixture(0, 30) : null;
function state(index = 0) {
  const account = (code_hash, amount, storage_usage = 1000) => ({ block_hash: BLOCK, code_hash, amount, storage_usage });
  const vault = account(V12_NEAR_CODE_HASH, 6n * ONE, 537_651);
  return {
    network: 'testnet', block: { header: { hash: BLOCK, height: 123, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: '10000000000000000000',
      wasm_config: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true } } },
    owner: account('11111111111111111111111111111111', 20n * ONE),
    ownerKey: { block_hash: BLOCK, nonce: 123, permission: 'FullAccess' },
    ownerKeys: { block_hash: BLOCK, keys: [{ public_key: KEY, access_key: { permission: 'FullAccess', nonce: 123 } }] },
    vaultPresence: index === 0 ? { block_hash: BLOCK, exists: false } : { block_hash: BLOCK, exists: true, account: vault },
    vaultKeys: { block_hash: BLOCK, keys: [] }, token: account(CIRCLE_TESTNET_CODE_HASH, ONE), seller: account(SELLER_HASH, ONE),
    bounds: { min: '1250000000000000000000', max: '1250000000000000000000' }, metadata: { symbol: 'USDC', decimals: 6 },
    ownerRegistration: registered(), vaultRegistration: index < 2 ? null : registered(), sellerRegistration: registered(),
    ownerTokens: index === 3 ? '0' : AMOUNT, vaultTokens: index === 3 ? AMOUNT : '0', tracked: index === 3 ? AMOUNT : '0',
    vaultOwner: OWNER, vaultVersion: 'bouncer-agent-v12-exact-ft-testnet',
    sellerConfig: { owner: 'seller.testnet', agent: 'worker.testnet', owner_payout: 'seller.testnet', contributor: 'seller.testnet',
      paused: false, token_id: TOKEN, policy_version: 1 },
    sellerRules: [['custom-brief', { min_price: '5000000', max_price: '50000000', max_expense_bps: 5000, active: true }]],
    sellerProducts: [['weekly-market-brief', { price: AMOUNT, max_expense: '0', active: true }]],
    calls: [], failures: new Set(), raw: {}, hook: null,
  };
}
function providerFor(s) {
  let ranHook = false;
  async function note(name, args) {
    s.calls.push([name, ...args]);
    if (s.failures.has(name)) throw new Error('untrusted provider detail must not leak');
    if (!ranHook && s.hook) { ranHook = true; await s.hook(); }
  }
  const accounts = { [OWNER]: 'owner', [TOKEN]: 'token', [SELLER]: 'seller' };
  const lists = { [OWNER]: 'ownerKeys', [VAULT]: 'vaultKeys' };
  const methods = { storage_balance_bounds: 'bounds', ft_metadata: 'metadata', get_owner: 'vaultOwner',
    contract_version: 'vaultVersion', vault_balance: 'tracked', get_config: 'sellerConfig', get_quote_rules: 'sellerRules', get_products: 'sellerProducts' };
  const registrations = { [OWNER]: 'ownerRegistration', [VAULT]: 'vaultRegistration', [SELLER]: 'sellerRegistration' };
  return {
    async viewNodeStatus() { await note('status', []); return { chain_id: s.network }; },
    async viewBlock(ref) { await note('block', [ref]); return s.block; },
    async experimental_protocolConfig(ref) { await note('protocol', [ref]); return s.protocol; },
    async viewAccount(id, ref) { const name = accounts[id]; await note(name, [id, ref]); if (!name) throw Error(); return s[name]; },
    async viewAccessKey(id, key, ref) { await note('ownerKey', [id, key, ref]); return s.ownerKey; },
    async viewAccessKeyList(id, ref) { const name = lists[id]; await note(name, [id, ref]); if (!name) throw Error(); return s[name]; },
    async viewTestnetAccountPresenceAt(id, block) { await note('vaultPresence', [id, block]); return s.vaultPresence; },
    async callFunctionRaw(contract, method, args, ref) {
      const name = method === 'storage_balance_of' ? registrations[args.account_id] : method === 'ft_balance_of'
        ? ({ [OWNER]: 'ownerTokens', [VAULT]: 'vaultTokens' })[args.account_id] : methods[method];
      await note(name, [contract, method, args, ref]);
      const expected = ['storage_balance_of', 'ft_balance_of', 'storage_balance_bounds', 'ft_metadata'].includes(method) ? TOKEN :
        ['get_config', 'get_quote_rules', 'get_products'].includes(method) ? SELLER : VAULT;
      if (!name || contract !== expected) throw Error();
      if (Object.hasOwn(s.raw, name)) return s.raw[name];
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(s[name]))] };
    },
  };
}
function input(s, index = 0, extra = {}) {
  return { review: structuredClone(base.review), snapshot: structuredClone(base.snapshot), wasmBytes: wasm,
    trustedReviewHash: base.trustedReviewHash, trustedOwnerPublicKey: KEY, trustedSellerCodeHash: SELLER_HASH,
    stageId: STAGES[index], priorOriginals: structuredClone(originals.slice(0, index)), provider: providerFor(s), now: () => NOW, ...extra };
}

artifactTest('each setup stage and funded snapshot match one pinned FINAL block and the required earlier originals', async () => {
  for (let i = 0; i < STAGES.length; i++) {
    const s = state(i), proof = await inspectBufferWalletSetupStage(input(s, i));
    assert.equal(proof.status, 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH', STAGES[i]); assert.deepEqual(proof.blockers, []);
    assert.equal(proof.prior_receipt_graphs_matched, i); assert.equal(proof.block_hash, BLOCK);
    for (const field of ['execution_authorized', 'owner_approval_verified', 'durable_fence_verified', 'unrecorded_prior_prompts_ruled_out',
      'receipt_consensus_verified', 'deployed_source_equivalence_verified', 'all_payees_and_agents_enumerated',
      'wallet_connected', 'transaction_signed', 'transaction_sent', 'seller_contacted', 'seller_payment_verified', 'independent_delivery_verified']) {
      assert.equal(proof[field], false, field);
    }
    for (const [name, ...args] of s.calls) {
      if (['status', 'block'].includes(name)) continue;
      if (name === 'vaultPresence') assert.equal(args.at(-1), BLOCK);
      else assert.deepEqual(args.at(-1), { blockId: BLOCK }, name);
    }
  }
});

artifactTest('requires the exact ordered original receipt graphs and all trust anchors before any RPC', async () => {
  const cases = [
    args => { args.trustedReviewHash = '0'.repeat(64); }, args => { args.trustedOwnerPublicKey = 'invalid'; },
    args => { args.trustedSellerCodeHash = OTHER; }, args => { args.stageId = 'invented'; },
    args => { args.priorOriginals = []; }, args => { args.priorOriginals.reverse(); },
    args => { args.priorOriginals[1].trustedOriginalHash = args.priorOriginals[0].trustedOriginalHash; },
    args => { args.priorOriginals[0].attempt.stage_id = STAGES[1]; },
    args => { args.priorOriginals[0].result.status = { Failure: { ActionError: {} } }; },
    args => { args.priorOriginals[0].result.transaction.hash = OTHER; },
    args => { args.priorOriginals[0].extra = 'unexpected'; },
  ];
  for (const change of cases) {
    const s = state(2), args = input(s, 2); change(args);
    await assert.rejects(inspectBufferWalletSetupStage(args)); assert.deepEqual(s.calls, []);
  }
});

artifactTest('stage-specific code, key, balance, registration, native reserve and seller drift block', async () => {
  const cases = [
    [0, 'plain_owner', s => { s.owner.code_hash = OTHER; }],
    [0, 'exact_owner_full_access_and_safe_nonce', s => { s.ownerKey.permission = { FunctionCall: {} }; }],
    [0, 'exact_owner_full_access_and_safe_nonce', s => { s.ownerKey.nonce = Number.MAX_SAFE_INTEGER; }],
    [0, 'exact_owner_full_access_and_safe_nonce', s => { s.ownerKeys.keys.push(structuredClone(s.ownerKeys.keys[0])); }],
    [0, 'owner_native_estimate', s => { s.owner.amount = '1'; }],
    [0, 'new_vault_absent', s => { s.vaultPresence.exists = true; }],
    [1, 'vault_code_and_no_keys', s => { s.vaultPresence.account.code_hash = OTHER; }],
    [1, 'vault_code_and_no_keys', s => { s.vaultPresence.account.global_contract_account_id = 'other.testnet'; }],
    [1, 'vault_code_and_no_keys', s => { s.vaultKeys.keys.push({ public_key: KEY }); }],
    [1, 'vault_native_estimate', s => { s.vaultPresence.account.amount = '1'; }],
    [1, 'vault_owner_and_version', s => { s.vaultOwner = 'evil.testnet'; }],
    [1, 'vault_owner_and_version', s => { s.vaultVersion = 'other'; }],
    [2, 'circle_and_seller_code_pins', s => { s.token.code_hash = OTHER; }],
    [2, 'circle_and_seller_code_pins', s => { s.seller.code_hash = OTHER; }],
    [2, 'circle_and_seller_code_pins', s => { s.metadata.decimals = 18; }],
    [2, 'circle_registration_cost_exact', s => { s.bounds.min = '2'; }],
    [2, 'circle_registrations_expected', s => { s.vaultRegistration = null; }],
    [1, 'circle_registrations_expected', s => { s.vaultRegistration = registered(); }],
    [2, 'owner_token_funding', s => { s.ownerTokens = '19999999'; }],
    [2, 'vault_token_funding_expected', s => { s.vaultTokens = '1'; }],
    [3, 'vault_token_funding_expected', s => { s.tracked = '19999999'; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerConfig.paused = true; }],
    [0, 'seller_active_and_price_matches', s => { s.sellerProducts[0][1].price = '21000000'; }],
    [0, 'testnet_protocol_and_selected_features', s => { s.protocol.runtime_config.wasm_config.universal_accounts = false; }],
  ];
  for (const [index, check, change] of cases) {
    const s = state(index); change(s); const result = await inspectBufferWalletSetupStage(input(s, index));
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', check); assert.equal(result.checks[check], 'BLOCKED', check);
    assert.equal(result.execution_authorized, false);
  }
});

artifactTest('unavailable or mixed-block RPC views are unknown, not evidence or retries', async () => {
  const s = state(2); s.failures.add('ownerKey'); s.raw.ownerTokens = { block_hash: OTHER, result: [49] };
  const result = await inspectBufferWalletSetupStage(input(s, 2));
  assert.equal(result.status, 'BLOCKED_OR_UNKNOWN');
  assert.equal(result.checks.exact_owner_full_access_and_safe_nonce, 'UNKNOWN');
  assert.equal(result.checks.owner_token_funding, 'UNKNOWN');
  assert(!JSON.stringify(result).includes('untrusted provider detail'));
  const badNetwork = state(); badNetwork.network = 'mainnet';
  await assert.rejects(inspectBufferWalletSetupStage(input(badNetwork)), /testnet RPC/);
  const stale = state(); stale.block.header.timestamp_nanosec = String(BigInt(NOW - 121_000) * 1_000_000n);
  await assert.rejects(inspectBufferWalletSetupStage(input(stale)), /stale/);
  let clocks = 0;
  const elapsed = await inspectBufferWalletSetupStage(input(state(), 0, { now: () => clocks++ < 2 ? NOW : NOW + 121_000 }));
  assert.equal(elapsed.checks.final_block_fresh_at_completion, 'BLOCKED');
  assert.equal(elapsed.status, 'BLOCKED_OR_UNKNOWN');
});

artifactTest('copies reviews, bytes and preceding receipts before awaiting an RPC', async () => {
  const s = state(2), args = input(s, 2), bytes = Buffer.from(wasm); args.wasmBytes = bytes;
  s.hook = () => { args.review.owner = 'evil.testnet'; args.snapshot.candidate_vault = 'evil.testnet';
    args.priorOriginals[0].result.transaction.hash = OTHER; bytes[100] ^= 1; };
  const result = await inspectBufferWalletSetupStage(args);
  assert.equal(result.status, 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH'); assert.equal(result.owner, OWNER);
});
