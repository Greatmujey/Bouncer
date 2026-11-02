import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { inspectSvalinProPreflight, SVALIN_TRIAL_MAX_ATOMS,
  SVALIN_TRIAL_MAX_GAS_ALLOWANCE } from '../agent/svalin-pro-preflight.mjs';
import { ReadOnlyNearRpcProvider, readPinnedJsonView } from '../agent/read-only-near-rpc.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const BLOCK = mockHash('preflight-final-block'), CODE = mockHash('preflight-v11-code');
const NOW = Date.parse('2026-11-01T19:25:00.000Z');
const AGENT = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const goal = { version: 1, id: 'trial', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: CODE,
  policy_id: 'api', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
const offer = () => ({ plans: [{ id: 'month', usd: 5, days: 30 }, { id: 'year', usd: 48, days: 365 }],
  callsPerDay: 100, near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: CIRCLE_TESTNET_USDC }, solana: null });
function state() {
  return {
    chain: 'testnet', block: BLOCK, blockTimestamp: (BigInt(NOW - 2_000) * 1_000_000n).toString(),
    vault: { block_hash: BLOCK, code_hash: CODE, amount: 300000000000000000000000n },
    ownerAccount: { block_hash: BLOCK, code_hash: mockHash('owner-code'), amount: 300000000000000000000000n },
    vaultKeys: { block_hash: BLOCK, keys: [] },
    agentKey: { block_hash: BLOCK, nonce: 1n, permission: { FunctionCall: { receiver_id: goal.vault,
      method_names: ['execute_exact_ft'], allowance: '100000000000000000000000' } } },
    views: {
      get_owner: goal.owner, contract_version: 'bouncer-agent-v11-exact-ft-testnet',
      get_policy: { token: CIRCLE_TESTNET_USDC, per_tx_cap: SVALIN_TRIAL_MAX_ATOMS, daily_cap: SVALIN_TRIAL_MAX_ATOMS },
      is_exact_ft_policy_locked: true, is_exact_ft_payee_locked: false, is_agent_key_allowed: true,
      daily_spent: '0', vault_balance: SVALIN_TRIAL_MAX_ATOMS, ft_balance_of: SVALIN_TRIAL_MAX_ATOMS,
      vault_storage: { total: '1250000000000000000000', available: '0' },
      seller_storage: { total: '1250000000000000000000', available: '0' },
      check: [true, 'ok: within cap, payee allowed, daily ok, vault funded'],
    }, offer: offer(), failures: new Set(), raw: {}, calls: [],
  };
}
function viewKey(method, args) {
  return method === 'storage_balance_of' ? (args.account_id === goal.vault ? 'vault_storage' : 'seller_storage') : method;
}
function fakeProvider(s) {
  const note = (method, args = []) => { s.calls.push([method, ...args]); if (s.failures.has(method)) throw new Error('secret_bearer_from_rpc_must_not_escape'); };
  return {
    async viewNodeStatus() { note('status'); return { chain_id: s.chain }; },
    async viewBlock(ref) { note('block', [ref]); return { header: { hash: s.block, timestamp_nanosec: s.blockTimestamp } }; },
    async viewAccount(account, ref) { note(account === goal.vault ? 'vaultAccount' : 'ownerAccount', [account, ref]); return account === goal.vault ? s.vault : s.ownerAccount; },
    async viewAccessKeyList(account, ref) { note('vaultKeys', [account, ref]); return s.vaultKeys; },
    async viewAccessKey(account, key, ref) { note('agentKey', [account, key, ref]); return s.agentKey; },
    async callFunctionRaw(account, method, args, ref) {
      const name = viewKey(method, args); note(name, [account, method, args, ref]);
      if (Object.hasOwn(s.raw, name)) return s.raw[name];
      return { block_hash: BLOCK, result: Array.from(Buffer.from(JSON.stringify(s.views[name]))) };
    },
  };
}
const seller = s => async (url, options) => {
  s.calls.push(['seller', url, options]);
  if (s.failures.has('seller')) throw new Error('secret_bearer_from_seller_must_not_escape');
  return new Response(JSON.stringify(s.offer), { status: 200 });
};
const inspect = s => inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider: fakeProvider(s), fetchImpl: seller(s), now: () => NOW });

test('one strict read-only pre-reservation snapshot is pinned and does not touch a journal or sign', async () => {
  const s = state(), result = await inspect(s);
  assert.equal(result.status, 'READ_ONLY_PROFILE_MATCH');
  assert.deepEqual(result.blockers, []);
  assert.equal(Object.values(result.checks).every(v => v === 'PASS'), true);
  assert.equal(result.block_hash, BLOCK); assert.equal(result.max_checkout_atoms, '5009999');
  assert.equal(result.block_timestamp, new Date(NOW - 2_000).toISOString());
  for (const flag of ['reservation_created', 'intent_pinned', 'signature_created', 'transaction_sent', 'seller_attribution_verified', 'fulfillment_verified']) {
    assert.equal(result[flag], false, flag);
  }
  const get = s.calls.find(c => c[0] === 'seller');
  assert.equal(get[1], `${SVALIN_ORIGIN}/v1/pro`); assert.equal(get[2].method, 'GET');
  assert.equal(get[2].body, undefined); assert.equal(get[2].headers.authorization, undefined); assert.equal(get[2].redirect, 'error');
  assert.equal(s.calls.filter(c => c[0] === 'seller').length, 1);
  assert.deepEqual(s.calls.find(c => c[0] === 'block')[1], { finality: 'final' });
  for (const c of s.calls.filter(c => !['status', 'block', 'seller'].includes(c[0]))) assert.deepEqual(c.at(-1), { blockId: BLOCK }, c[0]);
  const check = s.calls.find(c => c[0] === 'check');
  assert.equal(check[1], goal.vault); assert.deepEqual(check[3], { policy_id: 'api', payee: SVALIN_PAYEE, amount: '5009999' });
  const agent = s.calls.find(c => c[0] === 'agentKey'); assert.equal(agent[1], goal.owner); assert.equal(agent[2], AGENT);
  assert.match(result.scope, /no code audit, sufficient gas, backups, consent/);
});

test('profile fails closed on wrong code, keys, owner, locks, agent grant, caps, funds and registrations', async () => {
  const cases = [
    ['vault_code_matches_user_pin', s => { s.vault.code_hash = mockHash('different'); }],
    ['vault_code_matches_user_pin', s => { s.vault.block_hash = mockHash('wrong'); }],
    ['vault_has_no_access_keys', s => { s.vaultKeys.keys = [{}]; }],
    ['vault_has_no_access_keys', s => { delete s.vaultKeys.block_hash; }],
    ['owner_and_v11_version', s => { s.views.get_owner = 'someone.testnet'; }],
    ['owner_and_v11_version', s => { s.views.contract_version = 'bouncer-agent-v9'; }],
    ['restricted_agent_key', s => { s.agentKey.permission = 'FullAccess'; }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.receiver_id = 'other.testnet'; }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.method_names.push('set_policy'); }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.method_names = []; }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.allowance = null; }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.allowance = '0'; }],
    ['restricted_agent_key', s => { s.agentKey.permission.FunctionCall.allowance = (BigInt(SVALIN_TRIAL_MAX_GAS_ALLOWANCE) + 1n).toString(); }],
    ['restricted_agent_key', s => { s.agentKey.block_hash = mockHash('wrong'); }],
    ['strict_trial_caps', s => { s.views.get_policy = null; }],
    ['strict_trial_caps', s => { s.views.get_policy.token = 'other.testnet'; }],
    ['strict_trial_caps', s => { s.views.get_policy.per_tx_cap = '5010000'; }],
    ['strict_trial_caps', s => { s.views.get_policy.per_tx_cap = '5000000'; }],
    ['strict_trial_caps', s => { s.views.get_policy.daily_cap = '0'; }],
    ['strict_trial_caps', s => { s.views.get_policy.daily_cap = '5010000'; }],
    ['exact_policy_lock', s => { s.views.is_exact_ft_policy_locked = false; }],
    ['token_payee_not_previously_locked_on_vault', s => { s.views.is_exact_ft_payee_locked = true; }],
    ['agent_granted_for_policy', s => { s.views.is_agent_key_allowed = false; }],
    ['unused_daily_budget', s => { s.views.daily_spent = '1'; }],
    ['vault_tracked_balance', s => { s.views.vault_balance = '5009998'; }],
    ['vault_tracked_balance', s => { s.views.vault_balance = 5009999; }],
    ['vault_tracked_balance', s => { s.views.vault_balance = '9'.repeat(40); }],
    ['vault_token_balance', s => { s.views.ft_balance_of = '5009998'; }],
    ['vault_registered_for_token', s => { s.views.vault_storage = null; }],
    ['vault_registered_for_token', s => { s.views.vault_storage = { total: '0', available: '0' }; }],
    ['seller_registered_for_token', s => { s.views.seller_storage = { total: '1', available: '2' }; }],
    ['max_checkout_allowed_by_contract', s => { s.views.check = [false, 'blocked']; }],
    ['owner_native_balance_nonzero', s => { s.ownerAccount.amount = 0n; }],
    ['vault_native_balance_nonzero', s => { s.vault.amount = 1n; }],
  ];
  for (const [check, mutate] of cases) {
    const s = state(); mutate(s); const result = await inspect(s);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN', check);
    assert.equal(result.checks[check], 'BLOCKED', check);
    assert.ok(result.blockers.some(b => b.check === check && b.status === 'BLOCKED'), check);
  }
});

test('RPC and seller failures or malformed raw views are UNKNOWN, never proof of readiness or a secret leak', async () => {
  const cases = [
    ['vaultAccount', 'vault_code_matches_user_pin'], ['vaultKeys', 'vault_has_no_access_keys'],
    ['agentKey', 'restricted_agent_key'], ['get_policy', 'strict_trial_caps'], ['vault_balance', 'vault_tracked_balance'],
    ['ft_balance_of', 'vault_token_balance'], ['seller_storage', 'seller_registered_for_token'],
    ['seller', 'public_offer_matches_reviewed_testnet_profile'],
  ];
  for (const [failure, check] of cases) {
    const s = state(); s.failures.add(failure); const result = await inspect(s);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert.equal(result.checks[check], 'UNKNOWN');
    assert.equal(JSON.stringify(result).includes('secret_bearer'), false);
  }
  for (const raw of [
    { block_hash: mockHash('wrong'), result: Array.from(Buffer.from('true')) },
    { block_hash: BLOCK, result: [] }, { block_hash: BLOCK, result: [256] },
    { block_hash: BLOCK, result: [0xff] }, { block_hash: BLOCK, result: Array(65_537).fill(1) },
    { block_hash: BLOCK, result: Array.from(Buffer.from('not-json')) },
  ]) {
    const s = state(); s.raw.is_exact_ft_policy_locked = raw; const result = await inspect(s);
    assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert.equal(result.checks.exact_policy_lock, 'UNKNOWN');
  }
  const s = state(); s.offer.near.network = 'near:mainnet'; const result = await inspect(s);
  assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert.equal(result.checks.public_offer_matches_reviewed_testnet_profile, 'UNKNOWN');
});

test('wrong network, invalid block or invalid public goal/key stop before any seller request', async () => {
  for (const mutate of [s => { s.chain = 'mainnet'; }, s => { s.block = 'not-a-hash'; },
    s => { s.blockTimestamp = undefined; }, s => { s.blockTimestamp = '1'; },
    s => { s.blockTimestamp = (BigInt(NOW - 120_001) * 1_000_000n).toString(); },
    s => { s.blockTimestamp = (BigInt(NOW + 30_001) * 1_000_000n).toString(); },
    s => { s.failures.add('status'); }, s => { s.failures.add('block'); }]) {
    const s = state(); mutate(s); await assert.rejects(inspect(s));
    assert.equal(s.calls.some(c => c[0] === 'seller'), false);
    assert.equal(s.calls.some(c => c[0] === 'get_policy'), false);
  }
  const s = state(), p = fakeProvider(s), f = seller(s);
  await assert.rejects(inspectSvalinProPreflight({ goal: { ...goal, accept_exact_amount_matching_risk: false }, agentPublicKey: AGENT, provider: p, fetchImpl: f }), /invalid/);
  await assert.rejects(inspectSvalinProPreflight({ goal, agentPublicKey: 'not-a-public-key', provider: p, fetchImpl: f }), /public key/);
  await assert.rejects(inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider: p, fetchImpl: f, now: () => NaN }), /time/);
  assert.deepEqual(s.calls, []);
});

test('preflight cannot pass if its snapshot expires while the reads are in progress', async () => {
  const s = state(), f = seller(s); let clock = NOW;
  const slow = async (...args) => { const answer = await f(...args); clock += 120_000; return answer; };
  const result = await inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider: fakeProvider(s), fetchImpl: slow, now: () => clock });
  assert.equal(result.status, 'BLOCKED_OR_UNKNOWN');
  assert.equal(result.checks.final_block_fresh_at_completion, 'BLOCKED');
  assert.equal(result.transaction_sent, false);
  let steps = 0;
  await assert.rejects(inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider: fakeProvider(state()),
    fetchImpl: f, now: () => steps++ ? NOW - 1 : NOW }), /clock.*backwards/);
});

test('real near-api-js provider serializes every query against one final block and decodes native bigint amounts', async () => {
  const s = state(), requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body); requests.push(rpc); let result;
      if (rpc.method === 'status') result = { chain_id: 'testnet' };
      else if (rpc.method === 'block') { assert.deepEqual(rpc.params, { finality: 'final' }); result = { header: { hash: BLOCK, timestamp_nanosec: s.blockTimestamp } }; }
      else if (rpc.method === 'query') {
        const p = rpc.params; assert.equal(p.block_id, BLOCK); assert.equal(p.finality, undefined);
        if (p.request_type === 'view_account') {
          const a = p.account_id === goal.vault ? s.vault : s.ownerAccount;
          result = { ...a, amount: a.amount.toString(), locked: '0', storage_usage: 10, storage_paid_at: 0, block_height: 100 };
        } else if (p.request_type === 'view_access_key_list') result = { ...s.vaultKeys, block_height: 100 };
        else if (p.request_type === 'view_access_key') result = { ...s.agentKey, nonce: Number(s.agentKey.nonce), block_height: 100 };
        else if (p.request_type === 'call_function') {
          const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
          const name = viewKey(p.method_name, args);
          assert.ok(Object.hasOwn(s.views, name), name);
          result = { block_hash: BLOCK, block_height: 100, logs: [], result: Array.from(Buffer.from(JSON.stringify(s.views[name]))) };
        } else throw new Error('unexpected RPC query');
      } else throw new Error('unexpected RPC method');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const provider = new ReadOnlyNearRpcProvider(`http://127.0.0.1:${server.address().port}`);
    const result = await inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider, fetchImpl: seller(s), now: () => NOW });
    assert.equal(result.status, 'READ_ONLY_PROFILE_MATCH', JSON.stringify(result.blockers));
    assert.equal(result.checks.owner_native_balance_nonzero, 'PASS');
    assert.equal(result.checks.vault_native_balance_nonzero, 'PASS');
    assert.deepEqual(new Set(requests.map(r => r.method)), new Set(['status', 'block', 'query']));
    assert.equal(requests.filter(r => r.method === 'query').length, 16);
    assert.ok(requests.every(r => !/broadcast|send|tx/i.test(r.method)));
  } finally { server.close(); await once(server, 'close'); }
});

test('read-only RPC transport denies mutation methods, redirects, malformed and oversized responses', async () => {
  let calls = 0, options;
  const fetchImpl = async (_url, opts) => {
    calls++; options = opts;
    const request = JSON.parse(opts.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { chain_id: 'testnet' } }));
  };
  const p = new ReadOnlyNearRpcProvider('http://127.0.0.1:1234', { fetchImpl });
  await assert.rejects(p.sendJsonRpc('send_tx', { signed_tx_base64: 'secret' }), /denied/);
  await assert.rejects(p.sendJsonRpc('broadcast_tx_commit', []), /denied/);
  await assert.rejects(p.sendJsonRpc('query', { request_type: 'change_function' }), /denied/);
  assert.equal(calls, 0);
  assert.deepEqual(await p.viewNodeStatus(), { chain_id: 'testnet' });
  assert.equal(calls, 1); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  for (const response of [
    () => new Response('redirect', { status: 302 }),
    () => new Response('x'.repeat(512 * 1024 + 1)),
    () => new Response('{invalid'),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: {} })),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-read-only', error: { data: 'secret' } })),
  ]) {
    const provider = new ReadOnlyNearRpcProvider('http://127.0.0.1:1234', { fetchImpl: async () => response() });
    await assert.rejects(provider.viewNodeStatus());
  }
  assert.throws(() => new ReadOnlyNearRpcProvider('https://user:password@example.test'), /credentials/);
  assert.throws(() => new ReadOnlyNearRpcProvider('http://example.test'), /HTTPS/);
  assert.throws(() => new ReadOnlyNearRpcProvider('http://127.0.0.1:1234', { timeoutMs: 30_001 }), /transport/);
});

test('raw-view failures and invalid JSON cannot echo untrusted RPC data', async () => {
  for (const provider of [
    { async callFunctionRaw() { throw new Error('secret_RPC_error_text'); } },
    { async callFunctionRaw() { return { block_hash: BLOCK, result: [...Buffer.from('secret_RPC_error_text')] }; } },
  ]) {
    await assert.rejects(readPinnedJsonView(provider, BLOCK, goal.vault, 'get_policy', {}), error => {
      assert.match(error.message, /^view unavailable$|^invalid view$/);
      assert.doesNotMatch(error.message, /secret/); return true;
    });
  }
});

test('snapshot views use a bounded concurrency of four', async () => {
  const s = state(), p = fakeProvider(s), f = seller(s); let active = 0, max = 0;
  for (const name of ['viewAccount', 'viewAccessKeyList', 'viewAccessKey', 'callFunctionRaw']) {
    const original = p[name];
    p[name] = async (...args) => { active++; max = Math.max(max, active); try {
      await new Promise(resolve => setTimeout(resolve, 2)); return await original(...args);
    } finally { active--; } };
  }
  const fetchImpl = async (...args) => { active++; max = Math.max(max, active); try {
    await new Promise(resolve => setTimeout(resolve, 2)); return await f(...args);
  } finally { active--; } };
  const result = await inspectSvalinProPreflight({ goal, agentPublicKey: AGENT, provider: p, fetchImpl, now: () => NOW });
  assert.equal(result.status, 'READ_ONLY_PROFILE_MATCH'); assert.equal(max, 4);
});

test('actual preflight CLI reports a match or blockers without signing, journal files or external mutations', () => {
  const cli = fileURLToPath(new URL('../agent/svalin-pro-preflight.mjs', import.meta.url));
  const preload = fileURLToPath(new URL('./fixtures/mock-svalin-preflight-cli.mjs', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-preflight-'));
  try {
    const goalFile = path.join(dir, 'goal.json'), configFile = path.join(dir, 'fixture.json'), log = path.join(dir, 'requests.log');
    fs.writeFileSync(goalFile, JSON.stringify(goal));
    const run = flags => {
      fs.writeFileSync(log, ''); fs.writeFileSync(configFile, JSON.stringify({ goal, block: BLOCK, log, ...flags }));
      return spawnSync(process.execPath, [cli, '--goal', goalFile, '--public-key', AGENT, '--rpc', 'http://127.0.0.1:9999'], {
        encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, BOUNCER_PREFLIGHT_TEST_CONFIG: configFile } });
    };
    let got = run({}); assert.equal(got.status, 0, got.stderr);
    let result = JSON.parse(got.stdout); assert.equal(result.status, 'READ_ONLY_PROFILE_MATCH');
    assert.equal(result.reservation_created, false); assert.equal(result.signature_created, false); assert.equal(result.transaction_sent, false);
    let requests = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(requests.filter(x => x === 'seller-get').length, 1);
    assert.equal(requests.filter(x => x.startsWith('query:')).length, 16);
    assert.ok(requests.every(x => /^(status|block|seller-get|query:(view_account|view_access_key_list|view_access_key|call_function))$/.test(x)));
    got = run({ lowBalance: true }); assert.equal(got.status, 2, got.stderr);
    result = JSON.parse(got.stdout); assert.equal(result.status, 'BLOCKED_OR_UNKNOWN'); assert.equal(result.checks.vault_tracked_balance, 'BLOCKED');
    got = run({ mainnet: true }); assert.equal(got.status, 1); assert.match(got.stderr, /testnet/);
    requests = fs.readFileSync(log, 'utf8').trim().split('\n'); assert.deepEqual(requests, ['status']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['fixture.json', 'goal.json', 'requests.log']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI help is offline and invalid arguments fail before any network request', () => {
  const cli = fileURLToPath(new URL('../agent/svalin-pro-preflight.mjs', import.meta.url));
  for (const [args, code] of [[['--help'], 0], [[], 1], [['--execute'], 1], [['--goal', 'x', '--public-key', 'x', '--goal', 'y'], 1]]) {
    const got = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NEAR_TESTNET_RPC: 'http://not-loopback.example' } });
    assert.equal(got.status, code, got.stderr);
    assert.doesNotMatch(got.stderr, /network|fetch|connect/i);
    if (code === 0) assert.match(got.stdout, /no reservation, signing or transaction/i);
  }
});
