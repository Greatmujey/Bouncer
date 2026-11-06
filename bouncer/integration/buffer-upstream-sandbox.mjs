#!/usr/bin/env node
/**
 * ISOLATED LOOPBACK TEST ONLY. The Buffer contract is compiled from a pinned
 * public source revision; Circle's account name contains a nearcore example
 * mock token in the sandbox genesis. No live Circle, actual seller, API,
 * existing owner key, public chain, real order or independent delivery occurs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildBufferForwarder, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { MOCK_FT_SHA256, SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile,
  assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const V12_SHA256 = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
const BUYER = 'buffer-buyer.testnet', VAULT = 'vault.buffer-buyer.testnet';
const PROVIDER = 'buffer-provider.testnet', AGENT = 'buffer-agent.testnet';
const PRICE = '20000000', SKU = 'weekly-market-brief', NEAR = 10n ** 24n, TGAS = 10n ** 12n;
const { transactions: tx } = nearApi;
const key = () => nearApi.KeyPair.fromRandom('ed25519');
const pub = pair => String(pair.getPublicKey());
const account = (id, provider, pair) => new nearApi.Account(id, provider, new nearApi.KeyPairSigner(pair));
const fn = (method, args = {}, deposit = 0n, gas = 100n * TGAS) => tx.functionCall(method, args, gas, deposit);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());

export function validateBufferFixture(bytes, digest) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 4 * 1024 * 1024 ||
      typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || sha(bytes) !== digest) {
    throw new Error('invalid source-built isolated Buffer fixture');
  }
  const module = new WebAssembly.Module(bytes), names = WebAssembly.Module.exports(module).map(e => e.name);
  if (['new', 'set_product', 'ft_on_transfer', 'refund', 'mark_fulfilled', 'settle', 'get_order'].some(x => !names.includes(x))) {
    throw new Error('source-built fixture is missing Buffer methods');
  }
  return { sha256: digest, bytes: bytes.length };
}

/** All signers are created by the caller on the named local sandbox. Reject
 * any alternate RPC, wrong account, unverified V12 or malformed fixture
 * before permitting a transaction. The fixture hash is NOT source attestation. */
export async function exerciseBufferSandbox({ rpcUrl, root, tokenOwner, v12, sellerWasm, sellerSha256, storageMin }) {
  const endpoint = loopbackSandboxUrl(rpcUrl);
  if (loopbackSandboxUrl(root?.provider?.connection?.url) !== endpoint ||
      loopbackSandboxUrl(tokenOwner?.provider?.connection?.url) !== endpoint || root?.accountId !== 'testnet' ||
      tokenOwner?.accountId !== 'owner.testnet' || !Buffer.isBuffer(v12) || v12.length !== 536_651 || sha(v12) !== V12_SHA256 ||
      typeof storageMin !== 'string' || !/^[1-9][0-9]{0,24}$/.test(storageMin) || BigInt(storageMin) > 10n ** 23n) {
    throw new Error('sandbox root, mock token and pinned V12 are required');
  }
  const sellerFixture = validateBufferFixture(sellerWasm, sellerSha256);
  return withSandboxOnlyFetch(endpoint, () => exercise({ endpoint, root, tokenOwner, v12, sellerWasm, sellerFixture, storageMin }));
}

async function exercise({ endpoint, root, tokenOwner, v12, sellerWasm, sellerFixture, storageMin }) {
  const provider = new nearApi.providers.JsonRpcProvider({ url: endpoint });
  assertSandboxStatus(await provider.status());
  const buyerKey = key(), providerKey = key(), sellerAgentKey = key(), vaultKey = key();
  const buyer = account(BUYER, provider, buyerKey), sellerOwner = account(PROVIDER, provider, providerKey);
  const sellerAgent = account(AGENT, provider, sellerAgentKey), vaultAgent = account(BUYER, provider, vaultKey);
  const call = (signer, receiverId, method, args = {}, deposit = 0n, gas = 100n * TGAS) =>
    signer.signAndSendTransaction({ receiverId, actions: [fn(method, args, deposit, gas)], waitUntil: 'FINAL', throwOnFailure: false });
  const must = async (signer, receiverId, method, args = {}, deposit = 0n, gas = 100n * TGAS) => {
    const r = await call(signer, receiverId, method, args, deposit, gas); requireFinalSuccess(r, method); return r;
  };
  const batch = async (signer, receiverId, actions, label) => {
    const r = await signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
    requireFinalSuccess(r, label); return r;
  };
  const failure = (r, pattern) => {
    assert.equal(r?.final_execution_status, 'FINAL'); assert.ok(r?.status?.Failure); assert.match(JSON.stringify(r.status.Failure), pattern);
  };
  const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
  const balance = id => view(TOKEN, 'ft_balance_of', { account_id: id });
  const tracked = () => view(VAULT, 'vault_balance', { token: TOKEN });
  const order = id => view(SELLER, 'get_order', { order_id: id });
  const spend = policy_id => view(VAULT, 'daily_spent', { policy_id });

  for (const [id, pair] of [[BUYER, buyerKey], [PROVIDER, providerKey], [AGENT, sellerAgentKey]]) {
    await batch(root, id, [tx.createAccount(), tx.transfer(100n * NEAR), tx.addKey(pair.getPublicKey(), tx.fullAccessKey())],
      'create disposable sandbox account');
  }
  await batch(root, SELLER, [tx.createAccount(), tx.transfer(10n * NEAR), tx.deployContract(sellerWasm), fn('new', {
    owner: PROVIDER, agent: AGENT, token_id: TOKEN, owner_payout: PROVIDER, contributor: PROVIDER,
    contributor_bps: 0, purchase_approval_above: '0', order_ttl_ns: 86_400_000_000_000,
  })], 'deploy source-built Buffer fixture');
  await batch(buyer, VAULT, [tx.createAccount(), tx.transfer(8n * NEAR), tx.deployContract(v12), fn('new', { owner: BUYER })],
    'create keyless V12 sandbox vault');
  assert.equal((await provider.viewAccount(SELLER, { finality: 'final' })).code_hash, codeHash(sellerWasm));
  assert.equal((await provider.viewAccount(VAULT, { finality: 'final' })).code_hash, codeHash(v12));
  for (const id of [VAULT, SELLER, PROVIDER]) {
    if (id !== PROVIDER) assert.deepEqual((await provider.viewAccessKeyList(id, { finality: 'final' })).keys, []);
    await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: id, registration_only: true }, BigInt(storageMin), 50n * TGAS);
  }
  await batch(buyer, BUYER, [tx.addKey(vaultKey.getPublicKey(), tx.functionCallAccessKey(VAULT, ['execute_exact_ft'], NEAR))],
    'install scoped vault agent key');
  await must(tokenOwner, TOKEN, 'ft_transfer_call', { receiver_id: VAULT, amount: '60000000', msg: '' }, 1n, 300n * TGAS);
  await must(sellerOwner, SELLER, 'set_product', { sku: SKU, price: PRICE, max_expense: '0', active: true });
  assert.equal(await balance(VAULT), '60000000'); assert.equal(await tracked(), '60000000');

  async function prepare(label, onchainId, apiId) {
    const adapter = `${label}.${BUYER}`, adapterKey = key(), policy = label;
    const block = await provider.viewBlock({ finality: 'final' });
    const nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
    const terms = { owner: BUYER, vault: VAULT, adapter, forwarder_agent_public_key: pub(adapterKey),
      vault_agent_public_key: pub(vaultKey), policy_id: policy, intent_id: `buffer-${label}`, amount: PRICE,
      expires_at_ms: nowMs + 60 * 60 * 1000, native_return_cap: NEAR.toString(), native_reserve: NEAR.toString(),
      api_order_id: apiId, onchain_order_id: onchainId, sku: SKU, brief_sha256: sha(Buffer.from('isolated fixture request')) };
    const artifact = await buildBufferForwarder(terms, { nowMs });
    await batch(buyer, adapter, [tx.createAccount(), tx.transfer(3n * NEAR), tx.deployContract(artifact.wasm)],
      'create keyless fixed-order forwarder');
    assert.equal((await provider.viewAccount(adapter, { finality: 'final' })).code_hash, codeHash(artifact.wasm));
    assert.deepEqual((await provider.viewAccessKeyList(adapter, { finality: 'final' })).keys, []);
    await must(tokenOwner, TOKEN, 'storage_deposit', { account_id: adapter, registration_only: true }, BigInt(storageMin), 50n * TGAS);
    await batch(buyer, BUYER, [tx.addKey(adapterKey.getPublicKey(), tx.functionCallAccessKey(adapter, ['open', 'return_tokens'], NEAR))],
      'install distinct scoped forwarder agent key');
    const setPolicy = { policy_id: policy, token: TOKEN, per_tx_cap: PRICE, daily_cap: PRICE };
    failure(await call(buyer, VAULT, 'set_policy', setPolicy), /exactly 1 yoctoNEAR/);
    await must(buyer, VAULT, 'set_policy', setPolicy, 1n);
    await must(buyer, VAULT, 'allow_payee', { policy_id: policy, payee: adapter }, 1n);
    await must(buyer, VAULT, 'grant_agent_key', { policy_id: policy, public_key: pub(vaultKey) }, 1n);
    await must(buyer, VAULT, 'lock_ft_policy_to_intents', { policy_id: policy }, 1n);
    await must(buyer, VAULT, 'set_exact_ft_intent', { intent_id: terms.intent_id, policy_id: policy,
      expected_token: TOKEN, payee: adapter, amount: PRICE, memo: artifact.review.intent_memo,
      review_hash: artifact.review.review_sha256, expires_at_ms: String(terms.expires_at_ms), agent_public_key: pub(vaultKey) }, 1n);
    const signer = account(BUYER, provider, adapterKey);
    const funding = await must(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: terms.intent_id }, 0n, 300n * TGAS);
    assert.equal(await balance(adapter), PRICE); assert.equal(await spend(policy), PRICE);
    return { ...terms, artifact, signer, funding };
  }
  async function open(item) {
    const result = await must(item.signer, item.adapter, 'open', {}, 0n, 300n * TGAS);
    failure(await call(item.signer, item.adapter, 'open', {}, 0n, 300n * TGAS), /FORWARDER BLOCKED/);
    failure(await call(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: item.intent_id }, 0n, 300n * TGAS),
      /consumed, cancelled, expired or stale/);
    return result;
  }
  async function returnTokens(item) {
    await must(item.signer, item.adapter, 'return_tokens', { amount: PRICE }, 0n, 300n * TGAS);
    assert.equal(await balance(item.adapter), '0'); assert.equal(await balance(VAULT), await tracked());
    assert.equal(await spend(item.policy_id), PRICE);
  }

  // A changed product price returns the complete payment to the forwarder,
  // never to a new payee. This is an actual local receiver and mock token.
  const reject = await prepare('reject', 'o-000000000001', '123e4567-e89b-12d3-a456-426614174001');
  await must(sellerOwner, SELLER, 'set_product', { sku: SKU, price: '21000000', max_expense: '0', active: true });
  const rejected = await open(reject);
  assert.equal(JSON.parse(Buffer.from(rejected.status.SuccessValue, 'base64').toString()), '0');
  assert.equal(await order(reject.onchain_order_id), null); assert.equal(await balance(reject.adapter), PRICE);
  await returnTokens(reject); assert.equal(await tracked(), '60000000');
  await must(sellerOwner, SELLER, 'set_product', { sku: SKU, price: PRICE, max_expense: '0', active: true });

  // The source-built contract accepts the exact payment, then its owner
  // refunds by plain ft_transfer to the adapter. The fixed adapter returns
  // those units through V12's receiver hook, restoring tracked balances.
  const refund = await prepare('refund', 'o-000000000002', '123e4567-e89b-12d3-a456-426614174002');
  const refundOpen = await open(refund), paid = await order(refund.onchain_order_id);
  assert.equal(JSON.parse(Buffer.from(refundOpen.status.SuccessValue, 'base64').toString()), PRICE);
  assert.equal(paid.state, 'Paid'); assert.equal(paid.customer, refund.adapter); assert.equal(paid.gross, PRICE);
  assert.equal(await balance(SELLER), PRICE); assert.equal(await tracked(), '40000000');
  await must(sellerOwner, SELLER, 'refund', { order_id: refund.onchain_order_id }, 0n, 300n * TGAS);
  assert.equal((await order(refund.onchain_order_id)).state, 'Refunded');
  assert.equal(await balance(refund.adapter), PRICE); assert.equal(await tracked(), '40000000');
  await returnTokens(refund); assert.equal(await tracked(), '60000000');
  await must(buyer, VAULT, 'set_exact_ft_intent', { intent_id: 'blocked-refund-probe', policy_id: 'refund',
    expected_token: TOKEN, payee: refund.adapter, amount: '1', memo: 'sandbox:refund-cap-probe',
    review_hash: '0'.repeat(64), expires_at_ms: String(refund.expires_at_ms), agent_public_key: pub(vaultKey) }, 1n);
  failure(await call(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: 'blocked-refund-probe' }, 0n, 300n * TGAS),
    /daily cap exceeded/);
  assert.equal(await spend('refund'), PRICE); assert.equal(await tracked(), '60000000');

  // Separate order: a fixture report is hashed locally, recorded by the
  // source-built contract and settled to the synthetic provider. This is not
  // a report obtained over HTTP or independent provider delivery.
  const delivered = await prepare('delivery', 'o-000000000003', '123e4567-e89b-12d3-a456-426614174003');
  const deliveryOpen = await open(delivered);
  assert.equal(JSON.parse(Buffer.from(deliveryOpen.status.SuccessValue, 'base64').toString()), PRICE);
  assert.equal((await order(delivered.onchain_order_id)).customer, delivered.adapter);
  const fixtureReport = Buffer.from('Isolated fixture report. '.repeat(20)), digest = sha(fixtureReport);
  await must(sellerAgent, SELLER, 'mark_fulfilled', { order_id: delivered.onchain_order_id, report_hash: digest });
  const fulfilled = await order(delivered.onchain_order_id);
  assert.equal(fulfilled.state, 'Fulfilled'); assert.equal(fulfilled.report_hash, digest);
  await must(sellerAgent, SELLER, 'settle', { order_id: delivered.onchain_order_id, claims: [] }, 0n, 300n * TGAS);
  const settled = await order(delivered.onchain_order_id);
  assert.equal(settled.state, 'Settled'); assert.equal(settled.report_hash, digest);
  assert.equal(await balance(PROVIDER), PRICE); assert.equal(await balance(SELLER), '0');
  assert.equal(await balance(VAULT), '40000000'); assert.equal(await tracked(), '40000000');
  assert.equal(await spend('delivery'), PRICE);
  return { scope: 'ISOLATED nearcore, source-built Buffer contract and mock FT; not Circle or a public-chain order',
    buffer_source_revision: '9bc5ef0cbdc84074e94995cb50d334fc615f9b96', source_built_sha256: sellerFixture.sha256,
    v12_sha256: V12_SHA256, price_change_returned_to_forwarder: true, price_rejection_return_credited_vault: true,
    accepted_order_customer_matches_forwarder: true, later_plain_ft_refund_returned_to_vault: true,
    refund_vault_actual_and_tracked: '60000000', refund_conservative_rolling_spend: PRICE,
    next_refund_policy_intent_blocked_by_cap: true, fixture_report_sha256: digest,
    fixture_report_hash_recorded_onchain: true, local_mock_token_provider_payout: PRICE,
    final_vault_actual_and_tracked: '40000000', one_shot_replay_blocked: true,
    real_circle_or_real_testnet_used: false, independent_provider_delivery_verified: false, seller_contacted: false };
}

async function main() {
  const binary = process.env.BOUNCER_SANDBOX_BIN;
  const v12 = readVerifiedFile(process.env.BOUNCER_V12_WASM_PATH, V12_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const mockFt = readVerifiedFile(process.env.BOUNCER_MOCK_FT_WASM_PATH, MOCK_FT_SHA256, { maxBytes: 4 * 1024 * 1024 });
  const sellerSha256 = process.env.BOUNCER_BUFFER_FIXTURE_SHA256;
  const sellerWasm = readVerifiedFile(process.env.BOUNCER_BUFFER_FIXTURE_WASM, sellerSha256, { maxBytes: 4 * 1024 * 1024 });
  validateBufferFixture(sellerWasm, sellerSha256); readVerifiedFile(binary, SANDBOX_SHA256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-buffer-sandbox-'));
  const tokenKey = key(), ownerKey = key(); let sandbox;
  try {
    sandbox = await startSandbox(binary, directory, pub(tokenKey));
    const { provider } = sandbox, root = account('testnet', provider, sandbox.rootKey), token = account(TOKEN, provider, tokenKey);
    const tokenOwner = account('owner.testnet', provider, ownerKey);
    await withSandboxOnlyFetch(sandbox.rpcUrl, async () => {
      assertSandboxStatus(await provider.status());
      const batch = async (signer, receiverId, actions, label) => {
        const r = await signer.signAndSendTransaction({ receiverId, actions, waitUntil: 'FINAL', throwOnFailure: false });
        requireFinalSuccess(r, label); return r;
      };
      await batch(root, 'owner.testnet', [tx.createAccount(), tx.transfer(100n * NEAR),
        tx.addKey(ownerKey.getPublicKey(), tx.fullAccessKey())], 'create isolated token owner');
      await batch(token, TOKEN, [tx.deployContract(mockFt), fn('new_default_meta', {
        owner_id: 'owner.testnet', total_supply: '100000000' }, 0n, 50n * TGAS)], 'deploy example mock FT');
    });
    const bounds = await provider.callFunction(TOKEN, 'storage_balance_bounds', {}, { finality: 'final' });
    const result = await exerciseBufferSandbox({ rpcUrl: sandbox.rpcUrl, root, tokenOwner, v12, sellerWasm, sellerSha256, storageMin: bounds.min });
    assertSandboxStatus(await provider.status());
    console.log(JSON.stringify({ ...result, chain_id: SANDBOX_CHAIN_ID, nearcore_version: sandbox.versionText,
      protocol_version: sandbox.protocol, mock_ft_sha256: MOCK_FT_SHA256 }, null, 2));
  } finally {
    if (sandbox) await stopSandboxChild(sandbox.child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('Buffer isolated sandbox FAILED:', error?.stack ?? String(error)); process.exitCode = 1; });
}
