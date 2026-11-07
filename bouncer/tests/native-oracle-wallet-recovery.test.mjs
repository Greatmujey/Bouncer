import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildNativeOracleRevocationPlan, verifyNativeOracleRevocationReview, prepareNativeOracleRevocationAttempt,
  inspectNativeOracleRevocationAttempt } from '../agent/native-oracle-wallet-recovery.mjs';
import { assertSvalinBatchMatchesReview } from '../agent/svalin-setup-plan.mjs';
import { inspectNativeOracleRecoveryConnectorCompatibility } from '../agent/buffer-wallet-connector-compat.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const ownerKey = key(), agentKey = key(), hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const setupReview = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: 'buyer.testnet', vault: 'native.buyer.testnet',
  policy_id: 'price', agent_public_key: agentKey, per_tx_cap_yocto: '100000000000000000000000',
  daily_cap_yocto: '100000000000000000000000', vault_deposit_yocto: '100000000000000000000000',
  agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } }).review;
const args = { setupReview, wasmBytes: wasm, trustedSetupReviewHash: setupReview.review_sha256, trustedOwnerPublicKey: ownerKey };
const makePlan = (expectedAccessKeyPresent = true) => buildNativeOracleRevocationPlan({ ...args, expectedAccessKeyPresent });
const bound = review => ({ ...args, recoveryReview: review, trustedRecoveryReviewHash: review.review_sha256 });
function rpcAction(action) {
  if (action.enum === 'deleteKey') return { DeleteKey: { public_key: String(action.deleteKey.publicKey) } };
  if (action.enum === 'functionCall') return { FunctionCall: { method_name: action.functionCall.methodName,
    args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas), deposit: action.functionCall.deposit.toString() } };
  throw Error('unexpected action');
}
function fixture(index, omit = false) {
  const plan = makePlan(), batch = plan.batches[index], trustedOriginalHash = hash(7), anchors = bound(plan.review);
  const attempt = prepareNativeOracleRevocationAttempt({ ...anchors, trustedOriginalHash, stageId: batch.id });
  const actions = batch.actions.map(rpcAction), root = hash(8);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: trustedOriginalHash, signer_id: batch.signerId, public_key: ownerKey,
      receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: trustedOriginalHash, outcome: { executor_id: batch.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: omit ? [] : [{ receipt_id: root, predecessor_id: batch.signerId, receiver_id: batch.receiverId,
      receipt: { Action: { signer_id: batch.signerId, signer_public_key: ownerKey, actions: structuredClone(actions), input_data_ids: [], output_data_receivers: [] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [], logs: [] } }] };
  return { ...anchors, trustedOriginalHash, attempt, result };
}

test('unsigned recovery binds the original setup and removes the exact agent key before its one-yocto grant', () => {
  const plan = makePlan();
  assert.deepEqual(plan.batches.map(b => b.id), ['remove_native_oracle_access_key', 'revoke_native_oracle_vault_grant']);
  assert.deepEqual(plan.review.stages[0].actions, [{ type: 'delete_key', public_key: agentKey }]);
  assert.deepEqual(plan.review.stages[1].actions[0].args, { policy_id: 'price', public_key: agentKey });
  assert.equal(plan.review.stages[1].actions[0].deposit_yocto, '1');
  assert.equal(plan.review.signing_authorized, false); assert.equal(plan.review.onchain_revocation_verified, false);
  assert.equal(verifyNativeOracleRevocationReview(bound(plan.review)).owner_public_key, ownerKey);
  for (let i = 0; i < plan.batches.length; i++) {
    assert.equal(assertSvalinBatchMatchesReview(plan.batches[i], plan.review.stages[i]), true);
    const compatibility = inspectNativeOracleRecoveryConnectorCompatibility({ batch: plan.batches[i], retainedStage: plan.review.stages[i] });
    assert.deepEqual(compatibility.action_types, [i === 0 ? 'DeleteKey' : 'FunctionCall']);
    assert.equal(compatibility.actual_wallet_or_phone_tested, false); assert.equal(compatibility.transaction_sent, false);
  }
  const alreadyAbsent = makePlan(false);
  assert.deepEqual(alreadyAbsent.batches.map(b => b.id), ['revoke_native_oracle_vault_grant']);
  assert.equal(alreadyAbsent.review.expected_access_key_present, false);
  assert.notEqual(alreadyAbsent.review.review_sha256, plan.review.review_sha256);
});

test('recovery plan rejects changed setup, owner key, review, stage and action', () => {
  assert.throws(() => buildNativeOracleRevocationPlan({ ...args, expectedAccessKeyPresent: 'false' }));
  assert.throws(() => buildNativeOracleRevocationPlan({ ...args, expectedAccessKeyPresent: true, trustedOwnerPublicKey: agentKey }), /distinct/);
  assert.throws(() => buildNativeOracleRevocationPlan({ ...args, expectedAccessKeyPresent: true, trustedSetupReviewHash: '0'.repeat(64) }));
  const plan = makePlan(), changed = structuredClone(plan.review); changed.agent_public_key = key();
  assert.throws(() => verifyNativeOracleRevocationReview({ ...bound(plan.review), recoveryReview: changed }), /differs/);
  assert.throws(() => verifyNativeOracleRevocationReview({ ...bound(plan.review), trustedRecoveryReviewHash: '0'.repeat(64) }), /digest/);
  const altered = makePlan(); altered.batches[0].actions[0].deleteKey.publicKey = nearApi.utils.PublicKey.from(key());
  assert.throws(() => assertSvalinBatchMatchesReview(altered.batches[0], altered.review.stages[0]));
  assert.throws(() => inspectNativeOracleRecoveryConnectorCompatibility({ batch: altered.batches[0], retainedStage: altered.review.stages[0] }));
});

test('original recovery receipt matches bind exact DeleteKey and 1-yocto revoke but never imply current state', () => {
  for (const [index, omit] of [[0, false], [0, true], [1, false]]) {
    const f = fixture(index, omit), p = inspectNativeOracleRevocationAttempt(f);
    assert.equal(p.status, omit ? 'FINAL_LOCAL_DELETE_KEY_OUTCOME_MATCH' : 'FINAL_NATIVE_RECOVERY_RECEIPT_MATCH');
    assert.equal(p.do_not_resend, true); assert.equal(p.local_receipt_body_omitted, omit);
    assert.equal(p.onchain_revocation_verified, false); assert.equal(p.current_state_verified, false);
  }
  const noBody = fixture(1, true); assert.throws(() => inspectNativeOracleRevocationAttempt(noBody));
  const failure = fixture(0, true); failure.result.status = { Failure: { ActionError: {} } };
  failure.result.receipts_outcome[0].outcome.status = structuredClone(failure.result.status);
  assert.equal(inspectNativeOracleRevocationAttempt(failure).status, 'FINAL_FAILURE_NEEDS_STATE_REVIEW');
});

test('receipt verifier fails closed on hash, signer, action, deposit, receipt and graph mutations', () => {
  for (const change of [
    f => { f.trustedOriginalHash = hash(9); }, f => { f.attempt.signer_public_key = agentKey; },
    f => { f.result.transaction.actions[0].DeleteKey.public_key = key(); },
    f => { f.result.transaction_outcome.outcome.receipt_ids.push(hash(10)); },
    f => { f.result.receipts_outcome[0].outcome.receipt_ids.push(hash(10)); },
    f => { f.result.final_execution_status = 'EXECUTED'; },
  ]) { const f = fixture(0); change(f); assert.throws(() => inspectNativeOracleRevocationAttempt(f)); }
  for (const change of [
    f => { f.result.transaction.actions[0].FunctionCall.deposit = '0'; },
    f => { f.result.transaction.actions[0].FunctionCall.method_name = 'grant_agent_key'; },
    f => { f.result.transaction.receiver_id = 'other.testnet'; },
    f => { f.result.receipts[0].receipt.Action.signer_public_key = agentKey; },
  ]) { const f = fixture(1); change(f); assert.throws(() => inspectNativeOracleRevocationAttempt(f)); }
});
