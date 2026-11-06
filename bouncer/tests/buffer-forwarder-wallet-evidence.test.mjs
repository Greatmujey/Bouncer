import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferForwarderWalletPlan, verifyBufferForwarderWalletReview } from '../agent/buffer-forwarder-wallet-plan.mjs';
import { prepareBufferForwarderWalletAttempt, inspectBufferForwarderWalletAttempt } from '../agent/buffer-forwarder-wallet-evidence.mjs';

// Disposable keys and fabricated RPC outcomes ONLY: no wallet, network,
// journal, real Circle token, seller, approval, payment or delivery.
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet', ADAPTER = 'buffer.buyer.testnet';
const OWNER_KEY = key(), VAULT_KEY = key(), FORWARDER_KEY = key(), NOW = 1_800_000_000_000;
const spend = buildBufferWalletSpendingPlan({ owner: OWNER, vault: VAULT, adapter: ADAPTER, policy_id: 'research',
  vault_agent_public_key: VAULT_KEY, forwarder_agent_public_key: FORWARDER_KEY, per_tx_cap_atoms: '20000000',
  daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '250000000000000000000000',
  forwarder_agent_gas_allowance_yocto: '250000000000000000000000' }).review;
const terms = { owner: OWNER, vault: VAULT, adapter: ADAPTER, vault_agent_public_key: VAULT_KEY,
  forwarder_agent_public_key: FORWARDER_KEY, policy_id: 'research', intent_id: 'buffer-job-1', amount: '20000000',
  expires_at_ms: NOW + 600_000, native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000',
  api_order_id: '123e4567-e89b-12d3-a456-426614174000', onchain_order_id: 'o-123456789abc', sku: 'weekly-market-brief',
  brief_sha256: 'a'.repeat(64) };
const plan = await buildBufferForwarderWalletPlan({ terms, spendingReview: spend, trustedSpendingReviewHash: spend.review_sha256,
  trustedOwnerPublicKey: OWNER_KEY, registrationDepositYocto: '1250000000000000000000', nowMs: NOW });
const original = hash(7), rootId = hash(8), refundId = hash(9);
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64');
function rpcAction(action) {
  if (action.enum === 'createAccount') return 'CreateAccount';
  if (action.enum === 'transfer') return { Transfer: { deposit: action.transfer.deposit.toString() } };
  if (action.enum === 'deployContract') return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
  if (action.enum === 'functionCall') return { FunctionCall: { method_name: action.functionCall.methodName,
    args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas), deposit: action.functionCall.deposit.toString() } };
  throw Error('unexpected fixture action');
}
async function fixture(index) {
  const batch = plan.batches[index], base = { review: structuredClone(plan.review), trustedReviewHash: plan.review.review_sha256,
    terms: structuredClone(terms), spendingReview: structuredClone(spend), trustedSpendingReviewHash: spend.review_sha256,
    trustedOwnerPublicKey: OWNER_KEY, trustedOriginalHash: original, stageId: batch.id };
  const attempt = await prepareBufferForwarderWalletAttempt(base), actions = batch.actions.map(rpcAction);
  const value = index === 1 ? encode({ total: '1250000000000000000000', available: '0' }) : '';
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: value },
    transaction: { hash: original, signer_id: OWNER, public_key: OWNER_KEY, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: original, outcome: { executor_id: OWNER, receipt_ids: [rootId], status: { SuccessReceiptId: rootId } } },
    receipts: [{ receipt_id: rootId, predecessor_id: OWNER, receiver_id: batch.receiverId, receipt: { Action: {
      signer_id: OWNER, signer_public_key: OWNER_KEY, input_data_ids: [], output_data_receivers: [], actions: structuredClone(actions) } } }],
    receipts_outcome: [{ id: rootId, outcome: { executor_id: batch.receiverId, status: { SuccessValue: value }, receipt_ids: [] } }] };
  return { ...base, attempt, result };
}
function addGasRefund(f) {
  f.result.receipts_outcome[0].outcome.receipt_ids = [refundId];
  f.result.receipts.push({ receipt_id: refundId, predecessor_id: 'system', receiver_id: OWNER, receipt: { Action: {
    signer_id: OWNER, signer_public_key: OWNER_KEY, gas_price: '0', input_data_ids: [], output_data_receivers: [],
    actions: [{ Transfer: { deposit: '123' } }] } } });
  f.result.receipts_outcome.push({ id: refundId, outcome: { executor_id: OWNER, status: { SuccessValue: '' }, receipt_ids: [] } });
}

test('all three original wallet batches match their retained receipt graphs, including a protocol gas refund', async () => {
  for (let i = 0; i < 3; i++) {
    const f = await fixture(i); addGasRefund(f);
    const evidence = await inspectBufferForwarderWalletAttempt(f);
    assert.equal(evidence.status, 'FINAL_FORWARDER_SETUP_RECEIPT_MATCH');
    assert.equal(evidence.stage_id, plan.batches[i].id); assert.equal(evidence.tx_hash, original);
    assert.equal(evidence.root_receipt, rootId); assert.equal(evidence.do_not_resend, true);
    for (const name of ['current_state_verified', 'deployed_code_at_execution_verified', 'token_code_at_execution_verified',
      'owner_approval_verified', 'independent_delivery_verified']) assert.equal(evidence[name], false, name);
    assert.doesNotMatch(JSON.stringify(evidence), /private_key|signature|accessToken/);
  }
});

test('receipt recovery remains possible after expiry but never asserts the intent is fresh', async () => {
  const f = await fixture(2);
  await assert.rejects(verifyBufferForwarderWalletReview({ ...f, nowMs: terms.expires_at_ms + 10_000 }), /differs/);
  const evidence = await inspectBufferForwarderWalletAttempt(f);
  assert.equal(evidence.status, 'FINAL_FORWARDER_SETUP_RECEIPT_MATCH');
  assert.equal(evidence.current_state_verified, false); assert.equal(evidence.do_not_resend, true);
});

test('independent review, owner, stage and original hash cannot be replaced or edited', async () => {
  for (const mutate of [
    f => { f.trustedReviewHash = '0'.repeat(64); }, f => { f.trustedSpendingReviewHash = '0'.repeat(64); },
    f => { f.trustedOriginalHash = hash(12); }, f => { f.trustedOwnerPublicKey = key(); },
    f => { f.attempt.signer_id = 'thief.testnet'; }, f => { f.attempt.stage_id = 'unknown'; },
    f => { f.attempt.action_commitment_sha256 = '0'.repeat(64); }, f => { f.attempt.extra = true; },
    f => { f.review.stages[2].actions[0].deposit_yocto = '0'; }, f => { f.terms.amount = '1'; },
  ]) {
    const f = await fixture(2); mutate(f); await assert.rejects(inspectBufferForwarderWalletAttempt(f));
  }
});

test('deploy matches the RPC code digest and exact actions, not raw bytes or a different transfer', async () => {
  for (const mutate of [
    f => { f.result.transaction.actions[1].Transfer.deposit = '3000000000000000000000001'; },
    f => { f.result.receipts[0].receipt.Action.actions[1].Transfer.deposit = '1'; },
    f => { f.result.transaction.actions[2].DeployContract.code = Buffer.from(plan.batches[0].actions[2].deployContract.code).toString('base64'); },
    f => { f.result.receipts[0].receipt.Action.actions[2].DeployContract.code = Buffer.alloc(32, 1).toString('base64'); },
    f => { f.result.transaction.public_key = key(); }, f => { f.result.receipts[0].predecessor_id = 'thief.testnet'; },
    f => { f.result.transaction_outcome.outcome.receipt_ids = [hash(10)]; },
    f => { f.result.receipts[0].receipt.Action.input_data_ids = [hash(11)]; },
  ]) {
    const f = await fixture(0); mutate(f); await assert.rejects(inspectBufferForwarderWalletAttempt(f));
  }
});

test('registration requires the reviewed fresh balance and rejects token-origin or incomplete refunds', async () => {
  for (const mutate of [
    f => { f.result.status.SuccessValue = f.result.receipts_outcome[0].outcome.status.SuccessValue = encode({ total: '1', available: '0' }); },
    f => { f.result.status.SuccessValue = f.result.receipts_outcome[0].outcome.status.SuccessValue = encode({ total: '1250000000000000000000', available: '1' }); },
    f => { f.result.status.SuccessValue = f.result.receipts_outcome[0].outcome.status.SuccessValue = '!!!'; },
    f => { addGasRefund(f); f.result.receipts[1].predecessor_id = plan.batches[1].receiverId; },
    f => { addGasRefund(f); f.result.receipts.pop(); },
    f => { addGasRefund(f); f.result.receipts_outcome.pop(); },
    f => { addGasRefund(f); f.result.receipts_outcome[0].outcome.receipt_ids = []; },
  ]) {
    const f = await fixture(1); mutate(f); await assert.rejects(inspectBufferForwarderWalletAttempt(f));
  }
});

test('unknown, missing, unlinked and failed receipts never authorize a retry', async () => {
  for (const mutate of [
    f => { f.result.final_execution_status = 'EXECUTED'; }, f => { f.result.receipts = []; },
    f => { f.result.receipts.push(structuredClone(f.result.receipts[0])); },
    f => { f.result.receipts_outcome.push(structuredClone(f.result.receipts_outcome[0])); },
    f => { f.result.receipts_outcome[0].outcome.executor_id = 'other.testnet'; },
    f => { f.result.receipts_outcome[0].outcome.status = { SuccessReceiptId: hash(10) }; },
    f => { f.result.status = { SuccessValue: 'eA==' }; },
  ]) {
    const f = await fixture(2); mutate(f); await assert.rejects(inspectBufferForwarderWalletAttempt(f));
  }
  const failed = await fixture(2); failed.result.status = { Failure: { error: 'synthetic' } };
  failed.result.receipts_outcome[0].outcome.status = { Failure: { error: 'synthetic' } };
  const evidence = await inspectBufferForwarderWalletAttempt(failed);
  assert.equal(evidence.status, 'FINAL_FAILURE_NEEDS_STATE_REVIEW'); assert.equal(evidence.do_not_resend, true);
});

test('review, transaction and attempt are snapshotted before async rebuilding', async () => {
  const f = await fixture(2), inspecting = inspectBufferForwarderWalletAttempt(f);
  f.review.owner = 'thief.testnet'; f.attempt.tx_hash = hash(11); f.result.transaction.signer_id = 'thief.testnet';
  const evidence = await inspecting;
  assert.equal(evidence.status, 'FINAL_FORWARDER_SETUP_RECEIPT_MATCH'); assert.equal(evidence.tx_hash, original);
});
