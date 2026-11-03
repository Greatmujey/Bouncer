#!/usr/bin/env node
/** V12 pair-lock test on an ephemeral loopback-only nearcore chain.
 * No live NEAR account, seller, secret or token is used. The Circle-looking
 * token ID is an upstream example FT installed in sandbox genesis only; the
 * OutLayer-looking account is another local Bouncer receiver stand-in. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { MOCK_FT_SHA256, SANDBOX_SHA256, readVerifiedFile, requireFinalSuccess, assertSandboxStatus } from './v11-sandbox-support.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const ROOT = 'testnet', OWNER = 'v12-owner.testnet', VAULT = 'vault.v12-owner.testnet', SELLER = 'outlayer.testnet';
const NEAR = 10n ** 24n, TGAS = 10n ** 12n, NATIVE = 2n * 10n ** 22n;
const { transactions: tx, KeyPair, KeyPairSigner, Account, utils } = nearApi;
const key = () => KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new Account(id, provider, new KeyPairSigner(pair));
const fn = (method, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(method, args, gas, deposit);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash = bytes => utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());

/** Only a bounded, locally built V12 test artifact is admitted. This marker
 * detects mistakes; it is not source equivalence or independent attestation. */
export function checkV12SandboxWasm(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 4 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      !bytes.includes(Buffer.from('bouncer-agent-v12-exact-ft-testnet'))) {
    throw new Error('V12 sandbox requires a bounded WASM with the V12 marker');
  }
  return sha(bytes);
}

async function exercise({ sandbox, wasm, mockFt, ownerKey, tokenKey }) {
  const endpoint = loopbackSandboxUrl(sandbox.rpcUrl);
  return withSandboxOnlyFetch(endpoint, async () => {
    const provider = sandbox.provider;
    assertSandboxStatus(await provider.status());
    const root = account(ROOT, provider, sandbox.rootKey), owner = account(OWNER, provider, ownerKey);
    const token = account(TOKEN, provider, tokenKey), fundingKey = key(), projectKey = key(), exactKey = key();
    const funding = account(OWNER, provider, fundingKey), project = account(OWNER, provider, projectKey);
    const exact = account(OWNER, provider, exactKey);
    const send = (signer, receiverId, actions) => signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
    const must = async (signer, receiverId, actions, label) => {
      const result = await send(signer, receiverId, actions); requireFinalSuccess(result, label); return result;
    };
    const call = (signer, receiver, method, args = {}, deposit = 0n, gas = 100n * TGAS) =>
      must(signer, receiver, [fn(method, args, deposit, gas)], method);
    const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
    const failed = (result, pattern, label) => {
      assert.equal(result?.final_execution_status, 'FINAL', `${label}: not FINAL`);
      assert.ok(result?.status?.Failure, `${label}: expected failure`);
      assert.match(JSON.stringify(result.status.Failure), pattern, `${label}: wrong failure`);
    };

    await must(root, OWNER, [tx.createAccount(), tx.transfer(25n * NEAR), tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())], 'create disposable owner');
    await must(owner, VAULT, [tx.createAccount(), tx.transfer(8n * NEAR), tx.deployContract(wasm), fn('new', { owner: OWNER })], 'create disposable keyless V12');
    await must(root, SELLER, [tx.createAccount(), tx.transfer(8n * NEAR), tx.deployContract(wasm), fn('new', { owner: ROOT })], 'create local receiver stand-in');
    await must(token, TOKEN, [tx.deployContract(mockFt), fn('new_default_meta', { owner_id: ROOT, total_supply: '1000000' }, 0n, 50n * TGAS)], 'deploy example mock FT');
    assert.equal(await view(VAULT, 'contract_version'), 'bouncer-agent-v12-exact-ft-testnet');
    assert.equal((await provider.query({ request_type: 'view_account', account_id: VAULT, finality: 'final' })).code_hash, codeHash(wasm));
    assert.deepEqual((await provider.viewAccessKeyList(VAULT, { finality: 'final' })).keys, []);
    const probePolicy = { policy_id: 'unauthorized', token: TOKEN, per_tx_cap: '1', daily_cap: '1' };
    const noDeposit = await send(owner, VAULT, [fn('set_policy', probePolicy)]);
    failed(noDeposit, /owner-only method requires exactly 1 yoctoNEAR/, 'zero-yocto policy change');
    const nonOwner = await send(root, VAULT, [fn('set_policy', probePolicy, 1n)]);
    failed(nonOwner, /caller is not owner/, 'non-owner policy change');
    assert.equal(await view(VAULT, 'get_policy', { policy_id: 'unauthorized' }), null);
    const storage = BigInt((await view(TOKEN, 'storage_balance_bounds')).min);
    assert.ok(storage > 0n && storage <= NEAR / 10n);
    for (const id of [VAULT, SELLER]) await call(root, TOKEN, 'storage_deposit', { account_id: id, registration_only: true }, storage, 50n * TGAS);
    await call(root, TOKEN, 'ft_transfer_call', { receiver_id: VAULT, amount: '1000', msg: '' }, 1n, 300n * TGAS);
    assert.equal(await view(VAULT, 'vault_balance', { token: TOKEN }), '1000');

    const configure = [
      fn('deposit_native', {}, NATIVE, 10n * TGAS),
      fn('set_policy', { policy_id: 'fund', token: TOKEN, per_tx_cap: '300', daily_cap: '300' }, 1n),
      fn('allow_payee', { policy_id: 'fund', payee: SELLER }, 1n),
      fn('grant_agent_key', { policy_id: 'fund', public_key: pub(fundingKey) }, 1n),
      fn('set_ft_call_message', { policy_id: 'fund', payee: SELLER, msg: '{"action":"deposit_balance"}' }, 1n),
      fn('set_policy', { policy_id: 'project-usd', token: TOKEN, per_tx_cap: '300', daily_cap: '300' }, 1n),
      fn('allow_payee', { policy_id: 'project-usd', payee: SELLER }, 1n),
      fn('grant_agent_key', { policy_id: 'project-usd', public_key: pub(projectKey) }, 1n),
      fn('set_policy', { policy_id: 'project-native', token: 'native', per_tx_cap: NATIVE.toString(), daily_cap: NATIVE.toString() }, 1n),
      fn('allow_payee', { policy_id: 'project-native', payee: SELLER }, 1n),
      fn('grant_agent_key', { policy_id: 'project-native', public_key: pub(projectKey) }, 1n),
      fn('set_policy', { policy_id: 'exact', token: TOKEN, per_tx_cap: '100', daily_cap: '200' }, 1n),
      fn('allow_payee', { policy_id: 'exact', payee: SELLER }, 1n),
      fn('grant_agent_key', { policy_id: 'exact', public_key: pub(exactKey) }, 1n),
      fn('lock_ft_policy_to_intents', { policy_id: 'exact' }, 1n),
    ];
    // Keep each transaction below the protocol's 300 Tgas limit.
    for (let i = 0; i < configure.length; i += 2) await must(owner, VAULT, configure.slice(i, i + 2), 'configure local policies');
    await must(owner, OWNER, [
      tx.addKey(fundingKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_ft_call'], NEAR)),
      tx.addKey(projectKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_outlayer_project'], NEAR)),
      tx.addKey(exactKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_exact_ft'], NEAR)),
    ], 'install disposable method-restricted keys');
    const config = { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64),
      usd_policy_id: 'project-usd', token: TOKEN, attached_usd: '30', input_data: '{"operation":"burn"}',
      max_instructions: 100_000_000, max_memory_mb: 256, max_execution_seconds: 60 };
    await call(owner, VAULT, 'set_outlayer_project', { native_policy_id: 'project-native', project: config }, 1n);
    const reviewed = await view(VAULT, 'get_outlayer_project', { native_policy_id: 'project-native' });
    assert.equal(reviewed.active, true);
    await call(funding, VAULT, 'execute_ft_call', { policy_id: 'fund', payee: SELLER, amount: '300', expected_token: TOKEN,
      expected_msg: '{"action":"deposit_balance"}', expected_policy_revision: 1, expected_route_revision: 1 }, 0n, 300n * TGAS);
    assert.equal(await view(VAULT, 'outlayer_prepaid_balance', { token: TOKEN }), '300');
    assert.equal(await view(TOKEN, 'ft_balance_of', { account_id: SELLER }), '300');

    const block = await provider.viewBlock({ finality: 'final' });
    const expires = (BigInt(block.header.timestamp_nanosec) / 1_000_000n + 600_000n).toString();
    await call(owner, VAULT, 'set_exact_ft_intent', { intent_id: 'local-reservation', policy_id: 'exact', expected_token: TOKEN,
      payee: SELLER, amount: '100', memo: 'local-pair-lock', review_hash: 'b'.repeat(64), expires_at_ms: expires,
      agent_public_key: pub(exactKey) }, 1n);
    const afterLock = await view(VAULT, 'get_outlayer_project', { native_policy_id: 'project-native' });
    assert.equal(afterLock.active, false, 'later pair lock must invalidate old route');
    assert.equal(await view(VAULT, 'is_exact_ft_payee_locked', { token: TOKEN, payee: SELLER }), true);
    const rejection = await send(project, VAULT, [fn('execute_outlayer_project', { native_policy_id: 'project-native', amount: NATIVE.toString(), expected_route: reviewed }, 0n, 300n * TGAS)]);
    failed(rejection, /OutLayer project route changed since review/, 'stale project');
    assert.ok(!rejection.receipts_outcome.some(r => r.outcome?.executor_id === SELLER), 'no provider request must be sent');
    assert.equal(await view(VAULT, 'outlayer_prepaid_balance', { token: TOKEN }), '300');
    assert.equal(await view(VAULT, 'vault_balance', { token: 'native' }), NATIVE.toString());
    assert.equal(await view(VAULT, 'daily_spent', { policy_id: 'project-usd' }), '0');
    assert.equal(await view(VAULT, 'daily_spent', { policy_id: 'project-native' }), '0');

    await call(exact, VAULT, 'execute_exact_ft', { intent_id: 'local-reservation' }, 0n, 300n * TGAS);
    assert.equal(await view(TOKEN, 'ft_balance_of', { account_id: SELLER }), '400');
    assert.equal(await view(VAULT, 'vault_balance', { token: TOKEN }), '600');
    assert.equal(await view(VAULT, 'daily_spent', { policy_id: 'exact' }), '100');
    assert.equal((await view(VAULT, 'get_exact_ft_intent', { intent_id: 'local-reservation' })).consumed, true);
    const replay = await send(exact, VAULT, [fn('execute_exact_ft', { intent_id: 'local-reservation' }, 0n, 300n * TGAS)]);
    failed(replay, /intent.*(consumed|inactive|used|stale)/i, 'exact-intent replay');
    return { scope: 'isolated nearcore only; synthetic FT, balances and receiver, not Circle, OutLayer, testnet, audit or delivery',
      v12_sha256: sha(wasm), mock_ft_sha256: MOCK_FT_SHA256, keys_ephemeral: true, live_seller_contacted: false,
      owner_policy_guard_rejects_zero_yocto_and_non_owner: true,
      prepaid_before_lock: '300', stale_project_rejected: true, provider_call_emitted: false,
      native_and_prepaid_unchanged_on_rejection: true, exact_intent_settled_locally: true, replay_rejected: true };
  });
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  readVerifiedFile(binary, SANDBOX_SHA256);
  const mockFt = readVerifiedFile(process.env.BOUNCER_MOCK_FT_WASM_PATH, MOCK_FT_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const file = process.env.BOUNCER_V12_WASM_PATH;
  if (!file || !fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('local V12 WASM path required');
  const wasm = fs.readFileSync(file); checkV12SandboxWasm(wasm);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v12-sandbox-'));
  const ownerKey = key(), tokenKey = key(); let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const result = await exercise({ sandbox, wasm, mockFt, ownerKey, tokenKey });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('V12 sandbox FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
}
