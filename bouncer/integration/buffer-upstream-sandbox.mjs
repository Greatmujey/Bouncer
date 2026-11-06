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
import { buildBufferForwarder, checkBufferQuoteResponse, BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { buildBufferWalletSpendingPlan, assertBufferSpendingBatchMatchesReview } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferForwarderWalletPlan } from '../agent/buffer-forwarder-wallet-plan.mjs';
import { prepareBufferForwarderWalletAttempt, inspectBufferForwarderWalletAttempt } from '../agent/buffer-forwarder-wallet-evidence.mjs';
import { inspectBufferForwarderWalletStage } from '../agent/buffer-forwarder-wallet-preflight.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { assertSvalinBatchMatchesReview } from '../agent/svalin-setup-plan.mjs';
import { prepareBufferSpendingAttempt, inspectBufferSpendingAttempt } from '../agent/buffer-wallet-spending-evidence.mjs';
import { inspectBufferSpendingStage } from '../agent/buffer-wallet-spending-preflight.mjs';
import { collectBufferDeliverySnapshots, verifyBufferDeliveryEvidence } from '../agent/buffer-delivery-evidence.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';
import { MOCK_FT_SHA256, SANDBOX_SHA256, SANDBOX_CHAIN_ID, readVerifiedFile,
  assertSandboxStatus, requireFinalSuccess } from './v11-sandbox-support.mjs';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';

const V12_SHA256 = '033f255c5822ff97495809f7d60fddf66f266f20c36285fe71296b66decc6d12';
const BUYER = 'buffer-buyer.testnet', VAULT = 'vault.buffer-buyer.testnet';
const PROVIDER = 'buffer-provider.testnet', AGENT = 'buffer-agent.testnet';
const PRICE = '20000000', SKU = 'weekly-market-brief', NEAR = 10n ** 24n, TGAS = 10n ** 12n;
const CUSTOM_PRICE = '5000000', CUSTOM_SKU = 'custom-brief', BRIEF = 'isolated fixture request';
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
  if (['new', 'set_product', 'set_quote_rules', 'create_quote', 'get_quote', 'ft_on_transfer', 'refund',
    'mark_fulfilled', 'settle', 'get_order'].some(x => !names.includes(x))) {
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
  // Test-only chain-label adapter. Keep the mock FT's actual code and metadata,
  // which must BLOCK the live Circle pin. Never use this adapter on testnet.
  const presenceReader = new ReadOnlyNearRpcProvider(endpoint);
  const sandboxViews = {
    async viewNodeStatus() { const status = await provider.viewNodeStatus(); assertSandboxStatus(status); return { ...status, chain_id: 'testnet' }; },
    async experimental_protocolConfig(ref) { const config = await provider.experimental_protocolConfig(ref); return { ...config, chain_id: 'testnet' }; },
    viewBlock: provider.viewBlock.bind(provider), viewAccount: provider.viewAccount.bind(provider),
    viewAccessKey: provider.viewAccessKey.bind(provider), viewAccessKeyList: provider.viewAccessKeyList.bind(provider),
    viewTestnetAccountPresenceAt: presenceReader.viewTestnetAccountPresenceAt.bind(presenceReader),
    callFunctionRaw: provider.callFunctionRaw.bind(provider),
  };
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
  let vaultAgentInstalled = false, spendingReceiptsChecked = 0, spendingPreflightsChecked = 0,
    forwarderBatchesChecked = 0, forwarderReceiptsChecked = 0, forwarderPreflightsChecked = 0;
  await must(tokenOwner, TOKEN, 'ft_transfer_call', { receiver_id: VAULT, amount: '60000000', msg: '' }, 1n, 300n * TGAS);
  await must(sellerOwner, SELLER, 'set_product', { sku: SKU, price: PRICE, max_expense: '0', active: true });
  await must(sellerOwner, SELLER, 'set_product', { sku: CUSTOM_SKU, price: CUSTOM_PRICE, max_expense: '1000000', active: true });
  await must(sellerOwner, SELLER, 'set_quote_rules', { sku: CUSTOM_SKU, min_price: CUSTOM_PRICE, max_price: '50000000',
    max_expense_bps: 5000, max_ttl_ns: 1800000000000, active: true });
  assert.equal(await balance(VAULT), '60000000'); assert.equal(await tracked(), '60000000');

  async function prepare(label, onchainId, apiId, { amount = PRICE, sku = SKU, expiryMs, precheck } = {}) {
    const adapter = `${label}.${BUYER}`, adapterKey = key(), policy = label;
    const block = await provider.viewBlock({ finality: 'final' });
    const nowMs = Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
    const terms = { owner: BUYER, vault: VAULT, adapter, forwarder_agent_public_key: pub(adapterKey),
      vault_agent_public_key: pub(vaultKey), policy_id: policy, intent_id: `buffer-${label}`, amount,
      expires_at_ms: expiryMs ?? nowMs + 60 * 60 * 1000, native_return_cap: NEAR.toString(), native_reserve: NEAR.toString(),
      api_order_id: apiId, onchain_order_id: onchainId, sku, brief_sha256: sha(Buffer.from(BRIEF)) };
    const artifact = await buildBufferForwarder(terms, { nowMs });
    if (precheck) await precheck(terms, nowMs);
    const spendingPlan = buildBufferWalletSpendingPlan({ owner: BUYER, vault: VAULT, adapter, policy_id: policy,
      vault_agent_public_key: pub(vaultKey), forwarder_agent_public_key: pub(adapterKey),
      per_tx_cap_atoms: amount, daily_cap_atoms: amount,
      vault_agent_gas_allowance_yocto: NEAR.toString(), forwarder_agent_gas_allowance_yocto: NEAR.toString() });
    for (let i = 0; i < spendingPlan.batches.length; i++) assertBufferSpendingBatchMatchesReview(spendingPlan.batches[i], spendingPlan.review.stages[i]);
    const forwarderPlan = await buildBufferForwarderWalletPlan({ terms, spendingReview: spendingPlan.review,
      trustedSpendingReviewHash: spendingPlan.review.review_sha256, trustedOwnerPublicKey: pub(buyerKey),
      registrationDepositYocto: storageMin, nowMs });
    assert.equal(forwarderPlan.review.forwarder_wasm_sha256, artifact.wasm_sha256);
    const forwarderReview = structuredClone(forwarderPlan.review);
    const applyForwarderStage = async index => {
      const b = forwarderPlan.batches[index];
      assertSvalinBatchMatchesReview(b, forwarderReview.stages[index]);
      if (label === 'reject' && index < 2) {
        const snapshot = await inspectBufferForwarderWalletStage({ review: forwarderReview,
          trustedReviewHash: forwarderReview.review_sha256, terms, spendingReview: spendingPlan.review,
          trustedSpendingReviewHash: spendingPlan.review.review_sha256, trustedOwnerPublicKey: pub(buyerKey),
          trustedSellerCodeHash: codeHash(sellerWasm), stageId: b.id, provider: sandboxViews });
        assert.equal(snapshot.status, 'BLOCKED_OR_UNKNOWN', 'mock token must not pass the real Circle code pin');
        assert.deepEqual(snapshot.blockers, [{ check: 'circle_and_seller_code_pins', status: 'BLOCKED' }]);
        assert.equal(snapshot.execution_authorized, false); forwarderPreflightsChecked++;
      }
      const result = await batch(buyer, b.receiverId, b.actions, `sandbox reviewed forwarder stage ${b.id}`);
      forwarderBatchesChecked++;
      const original = result.transaction_outcome.id;
      const evidenceInput = { review: forwarderReview, trustedReviewHash: forwarderReview.review_sha256, terms,
        spendingReview: spendingPlan.review, trustedSpendingReviewHash: spendingPlan.review.review_sha256,
        trustedOwnerPublicKey: pub(buyerKey), trustedOriginalHash: original, stageId: b.id };
      const attempt = await prepareBufferForwarderWalletAttempt(evidenceInput);
      const receiptResult = await provider.txStatusReceipts(original, BUYER, 'FINAL');
      const evidence = await inspectBufferForwarderWalletAttempt({ ...evidenceInput, attempt, result: receiptResult });
      assert.equal(evidence.status, 'FINAL_FORWARDER_SETUP_RECEIPT_MATCH');
      assert.equal(evidence.do_not_resend, true); forwarderReceiptsChecked++;
      return result;
    };
    await applyForwarderStage(0);
    assert.equal((await provider.viewAccount(adapter, { finality: 'final' })).code_hash, codeHash(artifact.wasm));
    assert.deepEqual((await provider.viewAccessKeyList(adapter, { finality: 'final' })).keys, []);
    await applyForwarderStage(1);
    // Retain the public review before these synthetic sends. This isolated
    // fixture has no durable pre-prompt journal and is NOT a live executor.
    const retained = structuredClone(spendingPlan.review), trustedReviewHash = retained.review_sha256;
    const verifiedBatch = async index => {
      const b = spendingPlan.batches[index];
      if (label === 'reject') {
        const snapshot = await inspectBufferSpendingStage({ review: retained, trustedReviewHash, trustedOwnerPublicKey: pub(buyerKey),
          stageId: b.id, forwarderTerms: terms, trustedForwarderReviewHash: artifact.review.review_sha256,
          trustedForwarderWasmSha256: artifact.wasm_sha256, trustedSellerCodeHash: codeHash(sellerWasm), provider: sandboxViews });
        assert.equal(snapshot.status, 'BLOCKED_OR_UNKNOWN', 'mock token must not pass the real Circle code pin');
        assert.deepEqual(snapshot.blockers, [{ check: 'circle_and_seller_code_pins', status: 'BLOCKED' }]);
        assert.equal(snapshot.execution_authorized, false); spendingPreflightsChecked++;
      }
      const sent = await batch(buyer, b.receiverId, b.actions, `sandbox reviewed batch ${b.id}`);
      const trustedOriginalHash = sent.transaction_outcome.id, trustedOwnerPublicKey = pub(buyerKey);
      const attempt = prepareBufferSpendingAttempt({ review: retained, trustedReviewHash, stageId: b.id,
        trustedOriginalHash, trustedOwnerPublicKey });
      const result = await provider.txStatusReceipts(trustedOriginalHash, BUYER, 'FINAL');
      const checked = inspectBufferSpendingAttempt({ review: retained, trustedReviewHash, trustedOriginalHash,
        trustedOwnerPublicKey, attempt, result });
      assert.ok(['FINAL_SPENDING_SETUP_RECEIPT_MATCH', 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH'].includes(checked.status));
      assert.equal(checked.do_not_resend, true); spendingReceiptsChecked++;
    };
    const setPolicy = { policy_id: policy, token: TOKEN, per_tx_cap: amount, daily_cap: amount };
    failure(await call(buyer, VAULT, 'set_policy', setPolicy), /exactly 1 yoctoNEAR/);
    await verifiedBatch(0);
    // Later synthetic scenarios deliberately reuse the same already scoped
    // vault key. A live plan separately requires fresh key-state preflight.
    if (!vaultAgentInstalled) {
      await verifiedBatch(1);
      vaultAgentInstalled = true;
    }
    await verifiedBatch(2);
    if (label === 'reject') {
      const snapshot = await inspectBufferSpendingStage({ review: retained, trustedReviewHash, trustedOwnerPublicKey: pub(buyerKey),
        stageId: 'pin_buffer_exact_intent', forwarderTerms: terms, trustedForwarderReviewHash: artifact.review.review_sha256,
        trustedForwarderWasmSha256: artifact.wasm_sha256, trustedSellerCodeHash: codeHash(sellerWasm),
        forwarderWalletReview: forwarderReview, trustedForwarderWalletReviewHash: forwarderReview.review_sha256,
        provider: sandboxViews });
      assert.equal(snapshot.status, 'BLOCKED_OR_UNKNOWN', 'mock token must not pass the real Circle code pin');
      assert.deepEqual(snapshot.blockers, [{ check: 'circle_and_seller_code_pins', status: 'BLOCKED' }]);
      assert.equal(snapshot.execution_authorized, false); spendingPreflightsChecked++;
    }
    await applyForwarderStage(2);
    const signer = account(BUYER, provider, adapterKey);
    const funding = await must(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: terms.intent_id }, 0n, 200n * TGAS);
    assert.equal(await balance(adapter), amount); assert.equal(await spend(policy), amount);
    return { ...terms, terms, artifact, signer, funding };
  }
  async function open(item) {
    const result = await must(item.signer, item.adapter, 'open', {}, 0n, 300n * TGAS);
    failure(await call(item.signer, item.adapter, 'open', {}, 0n, 300n * TGAS), /FORWARDER BLOCKED/);
    failure(await call(vaultAgent, VAULT, 'execute_exact_ft', { intent_id: item.intent_id }, 0n, 300n * TGAS),
      /consumed, cancelled, expired or stale/);
    return result;
  }
  async function returnTokens(item) {
    await must(item.signer, item.adapter, 'return_tokens', { amount: item.amount }, 0n, 300n * TGAS);
    assert.equal(await balance(item.adapter), '0'); assert.equal(await balance(VAULT), await tracked());
    assert.equal(await spend(item.policy_id), item.amount);
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
  const reportText = 'Isolated fixture report. '.repeat(20).trim(), digest = sha(Buffer.from(reportText));
  const fulfillmentTx = await must(sellerAgent, SELLER, 'mark_fulfilled', { order_id: delivered.onchain_order_id, report_hash: digest });
  const fulfilled = await order(delivered.onchain_order_id);
  assert.equal(fulfilled.state, 'Fulfilled'); assert.equal(fulfilled.report_hash, digest);
  const [fundingReceipts, openingReceipts, fulfillmentReceipts] = await Promise.all([
    provider.txStatusReceipts(delivered.funding.transaction_outcome.id, BUYER, 'FINAL'),
    provider.txStatusReceipts(deliveryOpen.transaction_outcome.id, BUYER, 'FINAL'),
    provider.txStatusReceipts(fulfillmentTx.transaction_outcome.id, AGENT, 'FINAL'),
  ]);
  const evidence = { terms: delivered.terms,
    pins: { vault_code_hash: codeHash(v12), token_code_hash: (await provider.viewAccount(TOKEN, { finality: 'final' })).code_hash,
      seller_code_hash: codeHash(sellerWasm), fulfillment_signer: AGENT },
    funding: { txHash: delivered.funding.transaction_outcome.id, result: fundingReceipts },
    opening: { txHash: deliveryOpen.transaction_outcome.id, result: openingReceipts },
    fulfillment: { txHash: fulfillmentTx.transaction_outcome.id, result: fulfillmentReceipts },
    privateOrder: { id: delivered.api_order_id, onchainOrderId: delivered.onchain_order_id, contractId: SELLER,
      tokenContract: TOKEN, sku: SKU, priceUnits: PRICE, state: 'DELIVERED', authorised: true,
      brief: 'isolated fixture request', report: { content: reportText, content_hash: digest } } };
  const snapshots = await collectBufferDeliverySnapshots({ ...evidence, provider });
  const correlated = await verifyBufferDeliveryEvidence({ ...evidence, snapshots });
  assert.equal(correlated.seller_payment_receipt_verified, true);
  assert.equal(correlated.report_hash_matches_onchain_commitment, true);
  assert.equal(correlated.independent_fulfillment_verified, false);
  await must(sellerAgent, SELLER, 'settle', { order_id: delivered.onchain_order_id, claims: [] }, 0n, 300n * TGAS);
  const settled = await order(delivered.onchain_order_id);
  assert.equal(settled.state, 'Settled'); assert.equal(settled.report_hash, digest);
  assert.equal(await balance(PROVIDER), PRICE); assert.equal(await balance(SELLER), '0');
  assert.equal(await balance(VAULT), '40000000'); assert.equal(await tracked(), '40000000');
  assert.equal(await spend('delivery'), PRICE);

  // Exercise the lower-price quote shape too. The API order and report below
  // are local fixtures; only the source-built contract and receipts are real
  // on this isolated chain. No live quote is created or seller contacted.
  const quoteId = 'q-000000000004', quoteApiId = '123e4567-e89b-12d3-a456-426614174004';
  const quoteBlock = await provider.viewBlock({ finality: 'final' });
  const quoteExpiryMs = Number(BigInt(quoteBlock.header.timestamp_nanosec) / 1_000_000n) + 25 * 60_000;
  const quoteTx = await must(sellerAgent, SELLER, 'create_quote', { order_id: quoteId, sku: CUSTOM_SKU,
    amount: CUSTOM_PRICE, max_expense: '1000000', expires_ns: Number(BigInt(quoteExpiryMs) * 1_000_000n) });
  const chainQuote = await view(SELLER, 'get_quote', { order_id: quoteId });
  const custom = await prepare('custom', quoteId, quoteApiId, { amount: CUSTOM_PRICE, sku: CUSTOM_SKU,
    expiryMs: quoteExpiryMs - 60_000, precheck: async (terms, nowMs) => {
      const request = { request: BRIEF, customerAccount: terms.adapter };
      const response = { orderId: quoteApiId, accessToken: 'ab'.repeat(24) };
      const privateOrder = { id: quoteApiId, onchainOrderId: quoteId, contractId: SELLER, tokenContract: TOKEN,
        sku: CUSTOM_SKU, priceUnits: CUSTOM_PRICE, state: 'AWAITING_PAYMENT', authorised: true, brief: BRIEF,
        quote: { expiresAt: new Date(quoteExpiryMs).toISOString(), quoteTx: quoteTx.transaction_outcome.id, maxExpenseUnits: '1000000' } };
      const checked = checkBufferQuoteResponse(terms, request, response, privateOrder, chainQuote, { nowMs });
      assert.equal(checked.checked, true); assert.equal(checked.execution_authorized, false);
    } });
  const customOpen = await open(custom);
  assert.equal(JSON.parse(Buffer.from(customOpen.status.SuccessValue, 'base64').toString()), CUSTOM_PRICE);
  assert.equal((await order(quoteId)).customer, custom.adapter);
  assert.equal((await view(SELLER, 'get_quote', { order_id: quoteId })).paid, true);
  await must(sellerAgent, SELLER, 'mark_fulfilled', { order_id: quoteId, report_hash: digest });
  await must(sellerAgent, SELLER, 'settle', { order_id: quoteId, claims: [] }, 0n, 300n * TGAS);
  assert.equal((await order(quoteId)).state, 'Settled');
  assert.equal(await balance(PROVIDER), '25000000'); assert.equal(await balance(SELLER), '0');
  assert.equal(await balance(VAULT), '35000000'); assert.equal(await tracked(), '35000000');
  assert.equal(await spend('custom'), CUSTOM_PRICE);
  assert.equal(spendingReceiptsChecked, 9, 'all synthetic policy and scoped-key originals must be reconciled');
  assert.equal(spendingPreflightsChecked, 4, 'sandbox views checked policy, keys and intent while the mock-Circle pin blocked');
  assert.equal(forwarderBatchesChecked, 12, 'four local scenarios executed all three reviewed forwarder batches');
  assert.equal(forwarderReceiptsChecked, 12, 'all synthetic forwarder original hashes were reconciled');
  assert.equal(forwarderPreflightsChecked, 2, 'both forwarder stage checks blocked the mock-Circle pin');
  return { scope: 'ISOLATED nearcore, source-built Buffer contract and mock FT; not Circle or a public-chain order',
    buffer_source_revision: '9bc5ef0cbdc84074e94995cb50d334fc615f9b96', source_built_sha256: sellerFixture.sha256,
    v12_sha256: V12_SHA256, unsigned_wallet_spending_plan_exercised_locally: true,
    synthetic_forwarder_wallet_batches_exercised: forwarderBatchesChecked,
    synthetic_original_forwarder_receipts_checked: forwarderReceiptsChecked,
    sandbox_forwarder_preflights_checked_with_mock_token_pin_blocked: forwarderPreflightsChecked,
    synthetic_original_spending_receipts_checked: spendingReceiptsChecked,
    sandbox_stage_preflights_checked_with_mock_token_pin_blocked: spendingPreflightsChecked,
    price_change_returned_to_forwarder: true, price_rejection_return_credited_vault: true,
    accepted_order_customer_matches_forwarder: true, later_plain_ft_refund_returned_to_vault: true,
    refund_vault_actual_and_tracked: '60000000', refund_conservative_rolling_spend: PRICE,
    next_refund_policy_intent_blocked_by_cap: true, fixture_report_sha256: digest,
    fixture_report_hash_recorded_onchain: true, separate_receipt_and_report_verifier_passed: true,
    custom_quote_checked_paid_and_settled_locally: true, custom_quote_atoms: CUSTOM_PRICE,
    local_mock_token_provider_payout: '25000000', final_vault_actual_and_tracked: '35000000', one_shot_replay_blocked: true,
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
