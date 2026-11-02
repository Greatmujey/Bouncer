#!/usr/bin/env node
/**
 * ISOLATED TEST ONLY: compile the published PayPerCall source in CI and run it
 * with the generated V11 forwarder and the nearcore example FT. The sandbox
 * genesis deliberately uses Circle's public account name for a MOCK token.
 * No live testnet account, real Circle token, operator, API or delivery is
 * involved. The built escrow is not proof of the currently deployed code.
 *
 * A sandbox-only state patch temporarily adds a disposable key to the local
 * forwarder solely to unregister its mock-FT account and force one failed
 * payout. The key is deleted and keylessness rechecked BEFORE the payout and
 * claim. This is an artificial adversarial fault, not normal chain behavior.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { PAYPERCALL_TESTNET_ESCROW as ESCROW } from '../agent/paypercall-inspect.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { V11_SHA256, MOCK_FT_SHA256, SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile,
  assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const BUYER = 'upstream-buyer.testnet', VAULT = 'vault.upstream-buyer.testnet';
const ADAPTER = 'bridge.upstream-buyer.testnet', PROVIDER = 'upstream-provider.testnet';
const NEAR = 10n ** 24n, TGAS = 10n ** 12n, { transactions: tx } = nearApi;
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const fn = (method, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(method, args, gas, deposit);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
const escrowExports = ['new', 'register_service', 'storage_deposit', 'storage_withdraw', 'get_storage_credit',
  'ft_on_transfer', 'reject', 'claim', 'get_call', 'get_owed'];

/** Offline validation of a self-hashed, source-built fixture. A matching digest
 * does not authenticate the compiler, source or any deployed escrow contract. */
export function validateUpstreamFixture(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 4 * 1024 * 1024 ||
      typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256) || hash(bytes) !== expectedSha256 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('invalid source-built escrow fixture');
  let module;
  try { module = new WebAssembly.Module(bytes); } catch { throw new Error('invalid source-built escrow fixture'); }
  const names = WebAssembly.Module.exports(module).filter(item => item.kind === 'function').map(item => item.name);
  if (escrowExports.some(name => !names.includes(name))) throw new Error('source-built escrow fixture is missing expected methods');
  return { sha256: expectedSha256, bytes: bytes.length };
}

/** No signing before the exact loopback endpoint, pinned V11 and fixture shape
 * are validated; the named sandbox status is then checked inside the fence. */
export async function exerciseUpstreamPayPerCall({ rpcUrl, root, tokenOwner, wasm, escrowWasm, escrowSha256, storageMin,
  checkpoint = () => {} }) {
  const endpoint = loopbackSandboxUrl(rpcUrl);
  let rootEndpoint, tokenOwnerEndpoint;
  try {
    rootEndpoint = loopbackSandboxUrl(root?.provider?.connection?.url);
    tokenOwnerEndpoint = loopbackSandboxUrl(tokenOwner?.provider?.connection?.url);
  } catch { throw new Error('isolated sandbox root, mock-token owner and pinned V11 are required'); }
  if (root?.accountId !== 'testnet' || tokenOwner?.accountId !== 'owner.testnet' || rootEndpoint !== endpoint ||
      tokenOwnerEndpoint !== endpoint || !Buffer.isBuffer(wasm) || wasm.length !== 536325 || hash(wasm) !== V11_SHA256 ||
      typeof storageMin !== 'string' || !/^[1-9][0-9]{0,24}$/.test(storageMin) || BigInt(storageMin) > 10n ** 23n ||
      typeof checkpoint !== 'function') throw new Error('isolated sandbox root, mock-token owner and pinned V11 are required');
  const upstream = validateUpstreamFixture(escrowWasm, escrowSha256);
  return withSandboxOnlyFetch(endpoint, () => exercise({ endpoint, root, tokenOwner, wasm, escrowWasm, upstream, storageMin, checkpoint }));
}

async function exercise({ endpoint, root, tokenOwner, wasm, escrowWasm, upstream, storageMin, checkpoint }) {
  const provider = new nearApi.providers.JsonRpcProvider({ url: endpoint });
  assertSandboxStatus(await provider.status());
  const buyerKey = key(), sellerKey = key(), vaultKey = key(), bridgeKey = key(), faultKey = key();
  const buyer = account(BUYER, provider, buyerKey), seller = account(PROVIDER, provider, sellerKey);
  const vaultAgent = account(BUYER, provider, vaultKey), bridgeAgent = account(BUYER, provider, bridgeKey);
  const call = (signer, receiverId, method, args = {}, deposit = 0n, gas = 100n * TGAS) =>
    signer.signAndSendTransaction({ receiverId, actions: [fn(method, args, deposit, gas)], waitUntil: 'FINAL', throwOnFailure: false });
  const must = async (signer, receiverId, method, args = {}, deposit = 0n, gas = 100n * TGAS) => {
    const result = await call(signer, receiverId, method, args, deposit, gas); requireFinalSuccess(result, method); return result;
  };
  const batch = async (signer, receiverId, actions, label) => {
    const result = await signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(result, label); return result;
  };
  const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
  const ft = id => view(TOKEN, 'ft_balance_of', { account_id: id });
  const tracked = () => view(VAULT, 'vault_balance', { token: TOKEN });
  const spent = () => view(VAULT, 'daily_spent', { policy_id: 'upstream' });
  const owed = () => view(ESCROW, 'get_owed', { account_id: ADAPTER, token: TOKEN });
  const credit = () => view(ESCROW, 'get_storage_credit', { account_id: ADAPTER });
  const expectFailure = (result, pattern) => {
    assert.equal(result?.final_execution_status, 'FINAL'); assert.ok(result?.status?.Failure);
    assert.match(JSON.stringify(result.status.Failure), pattern);
  };

  await batch(root, BUYER, [tx.createAccount(), tx.transfer(100n * NEAR),
    tx.addKey(buyerKey.getPublicKey(), tx.fullAccessKey())], 'create isolated buyer');
  await batch(root, PROVIDER, [tx.createAccount(), tx.transfer(100n * NEAR),
    tx.addKey(sellerKey.getPublicKey(), tx.fullAccessKey())], 'create isolated provider account');
  await batch(root, ESCROW, [tx.createAccount(), tx.transfer(10n * NEAR), tx.deployContract(escrowWasm), fn('new')],
    'deploy source-built escrow in isolated sandbox');
  await batch(buyer, VAULT, [tx.createAccount(), tx.transfer(8n * NEAR), tx.deployContract(wasm), fn('new', { owner: BUYER })],
    'create keyless V11 vault');
  const block = await provider.viewBlock({ finality: 'final' }), nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  const artifact = await buildExperimentalForwarder({ owner: BUYER, vault: VAULT, adapter: ADAPTER,
    vault_agent_public_key: pub(vaultKey), forwarder_agent_public_key: pub(bridgeKey), policy_id: 'upstream', intent_id: 'pc-1',
    amount: '100', service_id: 0, request: 'wrap.testnet', expires_at_ms: nowMs + 60 * 60 * 1000,
    native_return_cap: NEAR.toString(), native_reserve: NEAR.toString() }, { nowMs });
  await batch(buyer, ADAPTER, [tx.createAccount(), tx.transfer(3n * NEAR), tx.deployContract(artifact.wasm)],
    'create keyless experimental forwarder');
  assert.equal((await provider.viewAccount(ADAPTER, { finality: 'final' })).code_hash, codeHash(artifact.wasm));
  assert.equal((await provider.viewAccount(ESCROW, { finality: 'final' })).code_hash, codeHash(escrowWasm));
  for (const id of [VAULT, ADAPTER, ESCROW]) {
    assert.deepEqual((await provider.viewAccessKeyList(id, { finality: 'final' })).keys, []);
    await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(storageMin), 50n * TGAS);
  }
  await batch(buyer, BUYER, [tx.addKey(vaultKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_exact_ft'], NEAR)),
    tx.addKey(bridgeKey.getPublicKey(), tx.functionCallAccessKey(ADAPTER, ['open', 'return_tokens', 'claim'], NEAR))],
    'install separate scoped keys');
  const policy = { policy_id: 'upstream', token: TOKEN, per_tx_cap: '100', daily_cap: '100' };
  expectFailure(await call(buyer, VAULT, 'set_policy', policy), /exactly 1 yoctoNEAR/);
  await must(buyer, VAULT, 'set_policy', policy, 1n);
  await must(buyer, VAULT, 'allow_payee', { policy_id: 'upstream', payee: ADAPTER }, 1n);
  await must(buyer, VAULT, 'grant_agent_key', { policy_id: 'upstream', public_key: pub(vaultKey) }, 1n);
  await must(buyer, VAULT, 'lock_ft_policy_to_intents', { policy_id: 'upstream' }, 1n);
  await must(tokenOwner, TOKEN, 'ft_transfer_call', { receiver_id: VAULT, amount: '100', msg: '' }, 1n, 300n * TGAS);
  await must(buyer, VAULT, 'set_exact_ft_intent', { intent_id: 'pc-1', policy_id: 'upstream', expected_token: TOKEN,
    payee: ADAPTER, amount: '100', memo: artifact.review.intent_memo, review_hash: artifact.review.review_sha256,
    expires_at_ms: String(artifact.review.expires_at_ms), agent_public_key: pub(vaultKey) }, 1n);

  // Real upstream source, but a fake local seller and no HTTP server/delivery.
  await must(seller, ESCROW, 'register_service', { name: 'isolated fixture only', endpoint: 'sandbox-only',
    operator: PROVIDER, token: TOKEN, price: '60', timeout_secs: 60, referrer_bps: 0 }, 2n * 10n ** 22n);
  const service = await view(ESCROW, 'get_service', { service_id: 0 });
  assert.equal(service.provider, PROVIDER); assert.equal(service.token, TOKEN); assert.equal(service.price, '60');
  const prepaid = 2n * 10n ** 22n;
  await must(buyer, ESCROW, 'storage_deposit', { account_id: ADAPTER }, prepaid);
  assert.equal(await credit(), prepaid.toString());

  const toAdapter = await must(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: 'pc-1' }, 0n, 250n * TGAS);
  const opened = await must(bridgeAgent, ADAPTER, 'open', {}, 0n, 300n * TGAS);
  assert.equal(await ft(ADAPTER), '40'); assert.equal(await ft(ESCROW), '60');
  const order = await view(ESCROW, 'get_call', { call_id: 0 });
  assert.equal(order.payer, ADAPTER); assert.equal(order.token, TOKEN); assert.equal(order.amount, '60');
  assert.equal(order.request_hash, artifact.review.request_hash); assert.equal(order.status, 'Open');
  assert.equal(await credit(), (10n ** 22n).toString());
  expectFailure(await call(bridgeAgent, ADAPTER, 'open', {}, 0n, 300n * TGAS), /FORWARDER BLOCKED/);
  const partial = await must(bridgeAgent, ADAPTER, 'return_tokens', { amount: '40' }, 0n, 300n * TGAS);
  assert.equal(await ft(VAULT), '40'); assert.equal(await tracked(), '40'); assert.equal(await spent(), '100');

  // Artificial isolated-chain fault: insert a temporary key, unregister only
  // the empty mock-token account, then delete the key before testing payout.
  await provider.sendJsonRpc('sandbox_patch_state', { records: [{ AccessKey: { account_id: ADAPTER,
    public_key: pub(faultKey), access_key: { nonce: 0, permission: 'FullAccess' } } }] });
  const fault = account(ADAPTER, provider, faultKey);
  assert.equal((await provider.viewAccessKeyList(ADAPTER, { finality: 'final' })).keys.length, 1);
  await must(fault, TOKEN, 'storage_unregister', { force: false }, 1n, 100n * TGAS);
  assert.equal(await view(TOKEN, 'storage_balance_of', { account_id: ADAPTER }), null);
  await batch(fault, ADAPTER, [tx.deleteKey(faultKey.getPublicKey())], 'remove isolated fault key');
  assert.deepEqual((await provider.viewAccessKeyList(ADAPTER, { finality: 'final' })).keys, []);
  const rejected = await call(seller, ESCROW, 'reject', { call_id: 0, reason: 'isolated simulated rejection' }, 0n, 250n * TGAS);
  assert.ok(requireFinalSuccess(rejected, 'reject with induced FT payout failure', { allowReceiptFailure: true }) >= 1);
  assert.equal((await view(ESCROW, 'get_call', { call_id: 0 })).status, 'Refunded');
  assert.equal(await owed(), '60'); assert.equal(await tracked(), '40');

  await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: ADAPTER, registration_only: true }, BigInt(storageMin), 50n * TGAS);
  const claim = await must(bridgeAgent, ADAPTER, 'claim', {}, 0n, 120n * TGAS);
  assert.equal(await owed(), '0'); assert.equal(await ft(ADAPTER), '60');
  const returnLate = await must(bridgeAgent, ADAPTER, 'return_tokens', { amount: '60' }, 0n, 300n * TGAS);
  assert.equal(await ft(ADAPTER), '0'); assert.equal(await ft(VAULT), '100');
  assert.equal(await tracked(), '100'); assert.equal(await spent(), '100');
  expectFailure(await call(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: 'pc-1' }, 0n, 250n * TGAS),
    /consumed, cancelled, expired or stale/);
  expectFailure(await call(buyer, ADAPTER, 'withdraw_storage', {}, 0n), /FORWARDER BLOCKED/);
  await must(buyer, ADAPTER, 'withdraw_storage', {}, 1n);
  assert.equal(await credit(), '0');
  await must(buyer, ADAPTER, 'return_native', { amount: (10n ** 22n).toString() }, 1n);
  assert.deepEqual((await provider.viewAccessKeyList(ADAPTER, { finality: 'final' })).keys, []);
  checkpoint('source-built PayPerCall rejection, forced payout failure, owed claim and V11 ledger return checked');
  return { scope: 'ISOLATED nearcore with PayPerCall compiled from pinned source and an example mock FT; NOT Circle, deployed escrow or seller delivery',
    source_revision: '9159811bc6443ce29ae3c32482d0808f094caa87', source_built_escrow_sha256: upstream.sha256,
    forwarder_sha256: artifact.wasm_sha256, keyless_after_deliberate_fault: true,
    artificial_temporary_sandbox_key_for_mock_ft_unregistration: true, real_circle_or_real_testnet_used: false,
    upstream_storage_credit_checked: true, source_rejection_recorded: true, failed_mock_ft_payout_recorded_as_owed: true,
    forwarder_claim_paid_owed_to_forwarder: true, forwarded_refund_credited_vault: true,
    final_vault_actual: '100', final_vault_tracked: '100', conservative_spend: '100',
    partial_refund: '40', claimed_late_refund: '60', owner_native_storage_return_checked: true,
    seller_contacted: false, independent_fulfillment_verified: false,
    local_hashes: { to_forwarder: toAdapter.transaction_outcome.id, opened: opened.transaction_outcome.id,
      partial_return: partial.transaction_outcome.id, rejection: rejected.transaction_outcome.id,
      claim: claim.transaction_outcome.id, late_return: returnLate.transaction_outcome.id } };
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  const wasm = readVerifiedFile(process.env.BOUNCER_V11_WASM_PATH, V11_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const mockFt = readVerifiedFile(process.env.BOUNCER_MOCK_FT_WASM_PATH, MOCK_FT_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const escrowSha = process.env.BOUNCER_PAYPERCALL_FIXTURE_SHA256;
  const escrowWasm = readVerifiedFile(process.env.BOUNCER_PAYPERCALL_FIXTURE_WASM, escrowSha, { maxBytes: 4 * 1024 * 1024 });
  validateUpstreamFixture(escrowWasm, escrowSha); readVerifiedFile(binary, SANDBOX_SHA256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-upstream-escrow-sandbox-'));
  const tokenKey = key(), ownerKey = key(); let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider } = sandbox, root = account('testnet', provider, sandbox.rootKey), token = account(TOKEN, provider, tokenKey);
    const tokenOwner = account('owner.testnet', provider, ownerKey);
    const batch = async (signer, receiverId, actions, label) => {
      const r = await signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
      requireFinalSuccess(r, label); return r;
    };
    await batch(root, 'owner.testnet', [tx.createAccount(), tx.transfer(100n * NEAR),
      tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())], 'create isolated token owner');
    await batch(token, TOKEN, [tx.deployContract(mockFt), fn('new_default_meta', { owner_id: 'owner.testnet',
      total_supply: '30000000' }, 0n, 50n * TGAS)], 'deploy example mock FT');
    const bounds = await provider.callFunction(TOKEN, 'storage_balance_bounds', {}, { finality: 'final' });
    const result = await exerciseUpstreamPayPerCall({ rpcUrl: sandbox.rpcUrl, root, tokenOwner, wasm, escrowWasm,
      escrowSha256: escrowSha, storageMin: bounds.min, checkpoint: message => console.error(`Sandbox checkpoint: ${message}`) });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({ ...result, chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText,
      protocol_version: sandbox.protocol, mock_ft_sha256: MOCK_FT_SHA256, v11_sha256: V11_SHA256 }, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Upstream PayPerCall sandbox FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
}
