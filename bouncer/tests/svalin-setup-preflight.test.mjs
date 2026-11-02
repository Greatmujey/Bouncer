import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';
import { inspectSvalinSetupPrerequisites } from '../agent/svalin-setup-preflight.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';

const OWNER = 'owner.testnet', VAULT = 'trial.owner.testnet', NOW = 1_800_000_000_000;
const BLOCK = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 12));
const OTHER_BLOCK = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 13));
const REG = '1250000000000000000000', COST = '10000000000000000000';
const names = ['new', 'contract_version', 'get_owner', 'get_policy', 'set_policy', 'allow_payee', 'grant_agent_key',
  'is_agent_key_allowed', 'lock_ft_policy_to_intents', 'is_exact_ft_policy_locked', 'is_exact_ft_payee_locked',
  'set_exact_ft_intent', 'get_exact_ft_intent', 'execute_exact_ft', 'after_exact_ft_transfer', 'ft_on_transfer',
  'vault_balance', 'daily_spent', 'check', 'withdraw'];
function leb(value) { const out = []; do { let n = value & 127; value >>>= 7; if (value) n |= 128; out.push(n); } while (value); return out; }
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
function stubWasm() {
  const exports = names.flatMap(name => { const b = [...Buffer.from(name)]; return [...leb(b.length), ...b, 0, 0]; });
  return Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, ...section(1, [1, 0x60, 0, 0]), ...section(3, [1, 0]),
    ...section(7, [...leb(names.length), ...exports]), ...section(10, [1, 2, 0, 0x0b]),
    ...section(0, [1, 0x78, ...Buffer.from('bouncer-agent-v11-exact-ft-testnet')])]);
}
function fixture() {
  const wasm = stubWasm(), ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const plan = buildUnsignedSvalinTrialSetup({ goal: { version: 1, id: 'trial', owner: OWNER, vault: VAULT,
    policy_id: 'svalin', vault_code_hash: nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(wasm).digest()),
    accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true }, wasmBytes: wasm,
    agentPublicKey: agentKey, initialVaultFundingYocto: '7000000000000000000000000',
    agentGasAllowanceYocto: '100000000000000000000000', vaultTokenStorageDepositYocto: REG });
  const state = {
    network: 'testnet', block: { header: { hash: BLOCK, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: COST,
      wasm_config: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true } } },
    owner: { block_hash: BLOCK, code_hash: '11111111111111111111111111111111', amount: 20n * 10n ** 24n, storage_usage: 10_000 },
    ownerKey: { block_hash: BLOCK, nonce: 5n, permission: 'FullAccess' },
    keys: { block_hash: BLOCK, keys: [{ public_key: ownerKey, access_key: { permission: 'FullAccess' } }] },
    presence: { exists: false, block_hash: BLOCK },
    bounds: { min: REG, max: REG }, ownerRegistration: { total: REG, available: '0' },
    vaultRegistration: null, sellerRegistration: { total: REG, available: '0' }, ownerUsdc: '5009999',
    failures: new Set(), calls: [],
  };
  const keyByAccount = { [OWNER]: 'ownerRegistration', [VAULT]: 'vaultRegistration', [SVALIN_PAYEE]: 'sellerRegistration' };
  const check = (name, args) => { state.calls.push([name, ...args]); if (state.failures.has(name)) throw Error('secret_RPC_text'); };
  const provider = {
    async viewNodeStatus() { check('status', []); return { chain_id: state.network }; },
    async viewBlock(q) { check('block', [q]); return state.block; },
    async experimental_protocolConfig(q) { check('protocol', [q]); return state.protocol; },
    async viewAccount(a, q) { check('owner', [a, q]); return state.owner; },
    async viewAccessKey(a, key, q) { check('ownerKey', [a, key, q]); return state.ownerKey; },
    async viewAccessKeyList(a, q) { check('keys', [a, q]); return state.keys; },
    async viewTestnetAccountPresenceAt(a, block) { check('presence', [a, block]); return state.presence; },
    async callFunctionRaw(token, method, args, q) {
      const name = method === 'storage_balance_bounds' ? 'bounds' : method === 'ft_balance_of' ? 'ownerUsdc' : keyByAccount[args.account_id];
      check(name, [token, method, args, q]);
      if (!name || token !== TOKEN) throw Error('unexpected view');
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(state[name]))] };
    },
  };
  return { state, provider, plan, ownerKey, agentKey, args: { plan, trustedReviewHash: plan.review.review_sha256,
    ownerPublicKey: ownerKey, provider, now: () => NOW } };
}

test('pre-creation snapshot checks owner, absence, storage, registration and funds without an executor', async () => {
  const f = fixture(), result = await inspectSvalinSetupPrerequisites(f.args);
  assert.equal(result.status, 'READ_ONLY_PREREQUISITES_INDICATED');
  assert.deepEqual(result.blockers, []); assert.equal(Object.values(result.checks).every(x => x === 'PASS'), true);
  assert.equal(result.review_sha256, f.plan.review.review_sha256); assert.equal(result.network, 'testnet');
  assert.equal(result.reviewed_token_registration_yocto, REG); assert.equal(result.required_test_usdc_atoms, '5009999');
  assert.equal(result.observed_protocol_version, 88);
  assert.deepEqual(result.observed_v11_selected_wasm_features, { global_contract_host_fns: true,
    reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true });
  assert.equal(result.checks.v11_selected_wasm_features_enabled, 'PASS');
  assert.equal(result.observed_owner_nonce, '5');
  assert.equal(result.v11_minimum_protocol_version, 88);
  assert.equal(result.runtime_linking_and_all_host_imports_verified, false);
  assert.equal(result.observed_token_registration_min_yocto, REG);
  assert.equal(result.observed_owner_test_usdc_atoms, '5009999'); assert.equal(result.missing_test_usdc_atoms, '0');
  assert.ok(BigInt(result.estimated_vault_minimum_yocto) < 7n * 10n ** 24n);
  for (const flag of ['artifact_independently_reviewed', 'deployed_circle_code_verified', 'owner_approval_verified',
    'backup_verified', 'setup_or_funding_verified', 'execution_authorized', 'transaction_signed', 'transaction_sent', 'seller_contacted']) {
    assert.equal(result[flag], false, flag);
  }
  assert.equal(result.estimates_are_not_storage_or_gas_guarantees, true);
  assert.equal(f.state.calls.length, 12);
  for (const [name, ...args] of f.state.calls) {
    if (['status', 'block'].includes(name)) continue;
    if (name === 'presence') assert.equal(args.at(-1), BLOCK);
    else assert.deepEqual(args.at(-1), { blockId: BLOCK }, name);
  }
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('pre-creation readiness fails closed on wrong authority, occupied accounts, registration and balances', async () => {
  const cases = [
    ['testnet_protocol_and_storage_cost', s => { s.protocol.chain_id = 'mainnet'; }],
    ['testnet_protocol_and_storage_cost', s => { s.protocol.runtime_config.storage_amount_per_byte = '0'; }],
    ['v11_protocol_floor', s => { s.protocol.protocol_version = 87; }],
    ['v11_protocol_floor', s => { s.protocol.protocol_version = '88'; }],
    ['v11_protocol_floor', s => { delete s.protocol.protocol_version; }],
    ['v11_protocol_floor', s => { s.protocol.protocol_version = 88.5; }],
    ['v11_selected_wasm_features_enabled', s => { s.protocol.runtime_config.wasm_config.global_contract_host_fns = false; }],
    ['v11_selected_wasm_features_enabled', s => { s.protocol.runtime_config.wasm_config.reftypes_bulk_memory = false; }],
    ['v11_selected_wasm_features_enabled', s => { s.protocol.runtime_config.wasm_config.gas_key_host_fns = 'true'; }],
    ['v11_selected_wasm_features_enabled', s => { delete s.protocol.runtime_config.wasm_config.universal_accounts; }],
    ['v11_selected_wasm_features_enabled', s => { s.protocol.runtime_config.wasm_config = null; }],
    ['owner_full_access_key', s => { s.ownerKey.permission = { FunctionCall: {} }; }],
    ['owner_full_access_key', s => { s.ownerKey.block_hash = OTHER_BLOCK; }],
    ['owner_has_no_contract_code', s => { s.owner.code_hash = OTHER_BLOCK; }],
    ['owner_has_no_contract_code', s => { delete s.owner.code_hash; }],
    ['owner_has_no_contract_code', s => { s.owner.global_contract_hash = OTHER_BLOCK; }],
    ['owner_has_no_contract_code', s => { s.owner.global_contract_account_id = 'contract.testnet'; }],
    ['owner_has_no_contract_code', s => { s.owner.state = 'uninitialized'; }],
    ['owner_has_no_contract_code', s => { s.owner.block_hash = OTHER_BLOCK; }],
    ['owner_nonce_safely_represented', s => { s.ownerKey.nonce = -1n; }],
    ['owner_nonce_safely_represented', s => { s.ownerKey.nonce = BigInt(Number.MAX_SAFE_INTEGER); }],
    ['owner_nonce_safely_represented', s => { s.ownerKey.nonce = 2.5; }],
    ['owner_nonce_safely_represented', s => { delete s.ownerKey.nonce; }],
    ['agent_key_not_already_on_owner', (s, f) => { s.keys.keys.push({ public_key: f.agentKey, access_key: { permission: 'FullAccess' } }); }],
    ['agent_key_not_already_on_owner', s => { s.keys.keys = []; }],
    ['agent_key_not_already_on_owner', s => { s.keys.keys.push(s.keys.keys[0]); }],
    ['agent_key_not_already_on_owner', s => { s.keys.block_hash = OTHER_BLOCK; }],
    ['new_direct_child_absent', s => { s.presence.exists = true; }],
    ['new_direct_child_absent', s => { s.presence.block_hash = OTHER_BLOCK; }],
    ['circle_registration_min_matches_review', s => { s.bounds.min = '1'; }],
    ['circle_registration_min_matches_review', s => { s.bounds.max = '1'; }],
    ['circle_registration_min_matches_review', s => { delete s.bounds.max; }],
    ['owner_registered_for_circle', s => { s.ownerRegistration = null; }],
    ['vault_not_already_registered_for_circle', s => { s.vaultRegistration = { total: REG, available: '0' }; }],
    ['seller_registered_for_circle', s => { s.sellerRegistration = null; }],
    ['seller_registered_for_circle', s => { s.sellerRegistration.available = '9999999999999999999999'; }],
    ['owner_test_usdc_covers_funding', s => { s.ownerUsdc = '5009998'; }],
    ['owner_test_usdc_covers_funding', s => { s.ownerUsdc = 5009999; }],
    ['owner_native_estimate', s => { s.owner.amount = 1n; }],
    ['owner_native_estimate', s => { s.owner.storage_usage = -1; }],
    ['owner_native_estimate', s => { s.owner.block_hash = OTHER_BLOCK; }],
    ['vault_native_estimate', s => { s.protocol.runtime_config.storage_amount_per_byte = '900000000000000000000000'; }],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture(); mutate(f.state, f);
    const result = await inspectSvalinSetupPrerequisites(f.args);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', name);
    assert.equal(result.checks[name], 'BLOCKED', name);
    assert.ok(result.blockers.some(x => x.check === name && x.status === 'BLOCKED'), name);
  }
});

test('view failures are unknown, sanitized and cannot authorize anything', async () => {
  for (const [failure, check] of [['presence', 'new_direct_child_absent'], ['bounds', 'circle_registration_min_matches_review'],
    ['ownerUsdc', 'owner_test_usdc_covers_funding'], ['sellerRegistration', 'seller_registered_for_circle'],
    ['protocol', 'testnet_protocol_and_storage_cost'], ['protocol', 'v11_protocol_floor'],
    ['protocol', 'v11_selected_wasm_features_enabled'], ['keys', 'agent_key_not_already_on_owner'],
    ['owner', 'owner_has_no_contract_code']]) {
    const f = fixture(); f.state.failures.add(failure);
    const result = await inspectSvalinSetupPrerequisites(f.args);
    assert.equal(result.checks[check], 'UNKNOWN', check); assert.equal(result.execution_authorized, false);
    assert.doesNotMatch(JSON.stringify(result), /secret_RPC_text/);
  }
});

test('wrong chain, old block, invalid review or reuse of owner key stop before state queries', async () => {
  let f = fixture(); f.state.network = 'mainnet';
  await assert.rejects(inspectSvalinSetupPrerequisites(f.args), /testnet/);
  assert.deepEqual(f.state.calls.map(x => x[0]), ['status']);
  f = fixture(); f.state.block.header.timestamp_nanosec = String(BigInt(NOW - 120_001) * 1_000_000n);
  await assert.rejects(inspectSvalinSetupPrerequisites(f.args), /stale/);
  assert.deepEqual(f.state.calls.map(x => x[0]), ['status', 'block']);
  f = fixture();
  await assert.rejects(inspectSvalinSetupPrerequisites({ ...f.args, trustedReviewHash: '0'.repeat(64) }), /retained|differs/);
  await assert.rejects(inspectSvalinSetupPrerequisites({ ...f.args, ownerPublicKey: f.agentKey }), /differ/);
  assert.equal(f.state.calls.length, 0);
});

test('snapshot expiry and changed plan objects cannot turn a read into permission', async () => {
  const f = fixture(); let count = 0;
  const result = await inspectSvalinSetupPrerequisites({ ...f.args, now: () => count++ === 0 ? NOW : NOW + 120_001 });
  assert.equal(result.checks.final_block_fresh_at_completion, 'BLOCKED');
  assert.equal(result.execution_authorized, false);
  const g = fixture(), oldStatus = g.provider.viewNodeStatus;
  g.provider.viewNodeStatus = async () => { g.plan.review.goal.vault = 'evil.owner.testnet'; return oldStatus(); };
  const snap = await inspectSvalinSetupPrerequisites(g.args);
  assert.equal(snap.vault, VAULT); assert.equal(snap.execution_authorized, false);
});

test('read-only transport distinguishes structured pinned UNKNOWN_ACCOUNT from unavailable or wrong-block errors', async () => {
  const calls = []; let response;
  const fetchImpl = async (_url, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    return new Response(JSON.stringify(typeof response === 'function' ? response(input) : response),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const p = new ReadOnlyNearRpcProvider('http://127.0.0.1:9999', { fetchImpl });
  response = input => ({ jsonrpc: '2.0', id: input.id, error: { cause: { name: 'UNKNOWN_ACCOUNT',
    info: { requested_account_id: VAULT, block_hash: BLOCK, block_height: 99 } } } });
  assert.deepEqual(await p.viewTestnetAccountPresenceAt(VAULT, BLOCK), { exists: false, block_hash: BLOCK });
  assert.deepEqual(calls[0].params, { request_type: 'view_account', account_id: VAULT, block_id: BLOCK });
  for (const error of [
    { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'other.testnet', block_hash: BLOCK } } },
    { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: VAULT, block_hash: OTHER_BLOCK } } },
    { cause: { name: 'UNKNOWN_BLOCK', info: { requested_account_id: VAULT, block_hash: BLOCK } } },
    { data: `account ${VAULT} does not exist while viewing` },
    { cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: VAULT } } },
  ]) {
    response = input => ({ jsonrpc: '2.0', id: input.id, error });
    await assert.rejects(p.viewTestnetAccountPresenceAt(VAULT, BLOCK), /invalid pinned/);
  }
  response = input => ({ jsonrpc: '2.0', id: input.id, result: { block_hash: BLOCK, amount: '1' } });
  assert.equal((await p.viewTestnetAccountPresenceAt(VAULT, BLOCK)).exists, true);
  response = input => ({ jsonrpc: '2.0', id: input.id, result: { block_hash: OTHER_BLOCK } });
  await assert.rejects(p.viewTestnetAccountPresenceAt(VAULT, BLOCK), /invalid pinned/);
  await assert.rejects(p.viewTestnetAccountPresenceAt('victim.near', BLOCK), /invalid pinned/);
  response = input => ({ jsonrpc: '2.0', id: input.id, result: { chain_id: 'testnet' } });
  await p.experimental_protocolConfig({ blockId: BLOCK });
  assert.equal(calls.at(-1).method, 'EXPERIMENTAL_protocol_config');
  assert.deepEqual(calls.at(-1).params, { block_id: BLOCK });
  for (const [method, params] of [['send_tx', {}], ['broadcast_tx_commit', []],
    ['EXPERIMENTAL_protocol_config', { finality: 'final' }],
    ['EXPERIMENTAL_protocol_config', { block_id: BLOCK, extra: 'mutation' }]]) {
    await assert.rejects(p.sendJsonRpc(method, params), /denied/);
  }
});

test('actual setup CLI uses only pinned read RPCs and reports missing funds without creating state', () => {
  const f = fixture(), cli = fileURLToPath(new URL('../agent/svalin-setup-preflight.mjs', import.meta.url));
  const preload = fileURLToPath(new URL('./fixtures/mock-svalin-setup-preflight-cli.mjs', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svalin-setup-preflight-'));
  try {
    const goal = path.join(dir, 'goal.json'), wasm = path.join(dir, 'stub.wasm');
    const config = path.join(dir, 'config.json'), log = path.join(dir, 'requests.log');
    fs.writeFileSync(goal, JSON.stringify(f.plan.review.goal));
    fs.writeFileSync(wasm, f.plan.batches[0].actions[2].deployContract.code);
    const run = flags => {
      fs.writeFileSync(log, ''); fs.writeFileSync(config, JSON.stringify({ goal: f.plan.review.goal,
        ownerKey: f.ownerKey, block: BLOCK, log, ...flags }));
      return spawnSync(process.execPath, [cli, '--goal', goal, '--wasm', wasm, '--owner-public-key', f.ownerKey,
        '--agent-public-key', f.agentKey, '--vault-funding-yocto', '7000000000000000000000000',
        '--agent-allowance-yocto', '100000000000000000000000', '--vault-token-storage-yocto', REG,
        '--rpc', 'http://127.0.0.1:9999'], { encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, BOUNCER_SETUP_PREFLIGHT_CONFIG: config } });
    };
    let r = run({}); assert.equal(r.status, 0, r.stderr);
    let result = JSON.parse(r.stdout); assert.equal(result.status, 'READ_ONLY_PREREQUISITES_INDICATED');
    assert.equal(result.transaction_sent, false); assert.equal(result.setup_or_funding_verified, false);
    let requests = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(requests.length, 12);
    assert.ok(requests.every(x => /^(status|block|EXPERIMENTAL_protocol_config|query:(view_account|view_access_key|view_access_key_list|call_function))$/.test(x)));
    r = run({ lowBalance: true }); assert.equal(r.status, 2, r.stderr);
    result = JSON.parse(r.stdout); assert.equal(result.checks.owner_test_usdc_covers_funding, 'BLOCKED');
    assert.equal(result.observed_owner_test_usdc_atoms, '10'); assert.equal(result.missing_test_usdc_atoms, '5009989');
    r = run({ occupied: true }); assert.equal(r.status, 2, r.stderr);
    result = JSON.parse(r.stdout); assert.equal(result.checks.new_direct_child_absent, 'BLOCKED');
    r = run({ missingFeature: true }); assert.equal(r.status, 2, r.stderr);
    result = JSON.parse(r.stdout); assert.equal(result.checks.v11_selected_wasm_features_enabled, 'BLOCKED');
    assert.equal(result.observed_v11_selected_wasm_features.universal_accounts, null);
    r = run({ ownerContract: true }); assert.equal(r.status, 2, r.stderr);
    result = JSON.parse(r.stdout); assert.equal(result.checks.owner_has_no_contract_code, 'BLOCKED');
    r = run({ mainnet: true }); assert.equal(r.status, 1); assert.match(r.stderr, /testnet/);
    requests = fs.readFileSync(log, 'utf8').trim().split('\n'); assert.deepEqual(requests, ['status']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'goal.json', 'requests.log', 'stub.wasm']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI help and invalid options fail without network or mutation', () => {
  const cli = fileURLToPath(new URL('../agent/svalin-setup-preflight.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
  let r = run(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /no signing, transaction, funding/i);
  for (const args of [[], ['--execute'], ['--private-key', 'secret-value']]) {
    r = run(args); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /secret-value|fetch|connect/i);
  }
});
