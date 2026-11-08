import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildAtomicNativeOracleWalletPlan, atomicNativeBatchCommitment, assertAtomicNativeBatchMatchesReview,
  verifyAtomicNativeOracleWalletReview, prepareAtomicNativeOracleWalletAttempt,
  inspectAtomicNativeOracleWalletAttempt } from '../agent/native-oracle-atomic-wallet.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const terms = { owner: 'buyer.testnet', vault: 'native.buyer.testnet', policy_id: 'price', agent_public_key: agentKey,
  per_tx_cap_yocto: '100000000000000000000000', daily_cap_yocto: '100000000000000000000000',
  vault_deposit_yocto: '100000000000000000000000', agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE };
const makePlan = () => buildAtomicNativeOracleWalletPlan({ terms, wasmBytes: wasm, trustedOwnerPublicKey: ownerKey });
function rpcAction(action) {
  if (action.enum === 'createAccount') return 'CreateAccount';
  if (action.enum === 'transfer') return { Transfer: { deposit: action.transfer.deposit.toString() } };
  if (action.enum === 'deployContract') return { DeployContract: { code: crypto.createHash('sha256').update(action.deployContract.code).digest('base64') } };
  if (action.enum === 'functionCall') return { FunctionCall: { method_name: action.functionCall.methodName,
    args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas), deposit: action.functionCall.deposit.toString() } };
  const key = action.addKey, p = key.accessKey.permission.functionCall;
  return { AddKey: { public_key: String(key.publicKey), access_key: { nonce: Number(key.accessKey.nonce),
    permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: [...p.methodNames] } } } } };
}
function fixture(index = 0, omitLocal = false) {
  const p = makePlan(), { review } = p, batch = p.batches[index];
  const anchors = { review, wasmBytes: wasm, trustedReviewHash: review.review_sha256,
    trustedOriginalHash: hash(7), trustedOwnerPublicKey: ownerKey };
  const attempt = prepareAtomicNativeOracleWalletAttempt({ ...anchors, stageId: batch.id });
  const actions = batch.actions.map(rpcAction), root = hash(8);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: anchors.trustedOriginalHash, signer_id: batch.signerId, public_key: ownerKey,
      receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: anchors.trustedOriginalHash, outcome: { executor_id: batch.signerId,
      receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: omitLocal ? [] : [{ receipt_id: root, predecessor_id: batch.signerId, receiver_id: batch.receiverId,
      receipt: { Action: { signer_id: batch.signerId, signer_public_key: ownerKey, actions: structuredClone(actions),
        input_data_ids: [], output_data_receivers: [] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [],
      logs: index === 0 ? ['BOUNCER native deposit received'] : [] } }] };
  return { ...anchors, attempt, result };
}
const inspect = f => inspectAtomicNativeOracleWalletAttempt(f);
function gasRefund(f) {
  const id = hash(9), owner = f.attempt.signer_id;
  f.result.receipts_outcome[0].outcome.receipt_ids.push(id);
  f.result.receipts.push({ receipt_id: id, predecessor_id: 'system', receiver_id: owner, receipt: { Action: {
    signer_id: owner, signer_public_key: ownerKey, gas_price: '0', input_data_ids: [], output_data_receivers: [],
    actions: [{ Transfer: { deposit: '10' } }] } } });
  f.result.receipts_outcome.push({ id, outcome: { executor_id: owner, status: { SuccessValue: '' }, receipt_ids: [] } });
}

test('combines the same nine constrained setup actions and leaves the owner-key grant separate', () => {
  const p = makePlan(), base = buildNativeOracleWalletPlan({ terms, wasmBytes: wasm });
  assert.deepEqual(p.batches.map(b => b.id), ['create_configure_fund_native_vault', 'install_native_oracle_agent']);
  assert.equal(p.batches[0].actions.length, 9); assert.equal(p.batches[1].actions.length, 1);
  assert.deepEqual(p.batches[0].actions, base.batches.slice(0, 3).flatMap(b => b.actions));
  assert.deepEqual(p.batches[1].actions, base.batches[3].actions);
  assert.equal(p.batches[0].signerId, terms.owner); assert.equal(p.batches[0].receiverId, terms.vault);
  assert.equal(p.batches[1].signerId, terms.owner); assert.equal(p.batches[1].receiverId, terms.owner);
  assert.equal(p.review.owner_public_key, ownerKey); assert.equal(p.review.base_review_sha256, base.review.review_sha256);
  assert.equal(p.review.signing_authorized, false); assert.equal(p.review.transaction_sent, false);
  assert.equal(p.review.agent_key_installed, false); assert.equal(p.review.independent_delivery_verified, false);
  assert.equal(verifyAtomicNativeOracleWalletReview({ review: p.review, wasmBytes: wasm,
    trustedReviewHash: p.review.review_sha256, trustedOwnerPublicKey: ownerKey }).vault, terms.vault);
});

test('rejects changed actions, receivers and missing owner authority in the offline plan', () => {
  const p = makePlan();
  for (let i = 0; i < 2; i++) assert.equal(assertAtomicNativeBatchMatchesReview(p.batches[i], p.review.stages[i]), true);
  const stage = p.review.stages[0];
  const changed = makePlan().batches[0]; changed.actions[4].functionCall.deposit = 0n;
  assert.notEqual(atomicNativeBatchCommitment(changed), stage.action_commitment_sha256);
  assert.throws(() => assertAtomicNativeBatchMatchesReview(changed, stage), /do not match/);
  const receiver = makePlan().batches[0]; receiver.receiverId = 'other.buyer.testnet';
  assert.throws(() => assertAtomicNativeBatchMatchesReview(receiver, stage), /do not match/);
  const short = makePlan().batches[0]; short.actions.pop(); assert.throws(() => atomicNativeBatchCommitment(short));
  assert.throws(() => buildAtomicNativeOracleWalletPlan({ terms, wasmBytes: wasm }));
  assert.throws(() => buildAtomicNativeOracleWalletPlan({ terms, wasmBytes: wasm, trustedOwnerPublicKey: agentKey }), /distinct/);
});

test('matches each original and complete FINAL receipt graph without implying current state', () => {
  for (let i = 0; i < 2; i++) for (const omit of i === 1 ? [false, true] : [false]) {
    const f = fixture(i, omit), proof = inspect(f);
    assert.equal(proof.tx_hash, hash(7));
    assert.equal(proof.status, omit ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_ATOMIC_NATIVE_SETUP_RECEIPT_MATCH');
    assert.equal(proof.local_receipt_body_omitted, omit); assert.equal(proof.do_not_resend, true);
    assert.equal(proof.current_state_verified, false); assert.equal(proof.owner_approval_verified, false);
    assert.equal(proof.independent_delivery_verified, false);
    gasRefund(f); assert.equal(inspect(f).tx_hash, hash(7));
  }
});

test('requires independently retained review, original hash, owner key and pinned artifact', () => {
  const f = fixture();
  for (const patch of [{ trustedReviewHash: '0'.repeat(64) }, { trustedOriginalHash: hash(6) },
    { trustedOriginalHash: null }, { trustedOwnerPublicKey: agentKey }, { trustedOwnerPublicKey: 'invalid' },
    { attempt: null }, { attempt: { ...f.attempt, receiver_id: 'evil.testnet' } },
    { attempt: { ...f.attempt, action_commitment_sha256: '0'.repeat(64) } }, { attempt: { ...f.attempt, extra: true } }]) {
    assert.throws(() => inspect({ ...f, ...patch }));
  }
  const review = structuredClone(f.review); review.stages[0].actions[4].args.per_tx_cap = '1';
  assert.throws(() => inspect({ ...f, review }), /review differs/);
  const changed = Buffer.from(wasm); changed[100] ^= 1; assert.throws(() => inspect({ ...f, wasmBytes: changed }));
  assert.throws(() => prepareAtomicNativeOracleWalletAttempt({ ...f, stageId: 'other' }));
});

test('rejects tampered transactions, receipt graphs, missing deposit log and key scope', () => {
  for (const change of [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.transaction.hash = hash(6); },
    r => { r.transaction.signer_id = 'evil.testnet'; }, r => { r.transaction.receiver_id = 'evil.testnet'; },
    r => { r.transaction.actions[1].Transfer.deposit = '1'; },
    r => { r.transaction.actions[2].DeployContract.code = Buffer.from(wasm).toString('base64'); },
    r => { r.transaction.actions[4].FunctionCall.deposit = '0'; },
    r => { r.receipts[0].receipt.Action.signer_public_key = agentKey; },
    r => { r.receipts[0].receipt.Action.input_data_ids.push(hash(10)); },
    r => { r.receipts[0].receipt.Action.output_data_receivers.push({ receiver_id: 'evil.testnet', data_id: hash(10) }); },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(10)]; },
    r => { r.transaction_outcome.outcome.receipt_ids.push(hash(10)); },
    r => { r.receipts.push(structuredClone(r.receipts[0])); },
    r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
    r => { r.receipts_outcome[0].outcome.logs = []; },
    r => { r.receipts = []; },
  ]) { const f = fixture(); change(f.result); assert.throws(() => inspect(f)); }
  for (const change of [
    r => { r.transaction.actions[0].AddKey.access_key.permission = 'FullAccess'; },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.method_names.push('set_policy'); },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.receiver_id = 'evil.testnet'; },
  ]) { const f = fixture(1, true); change(f.result); assert.throws(() => inspect(f)); }
});

test('FINAL failure requires state review and never grants retry permission', () => {
  const f = fixture(); f.result.status = { Failure: { ActionError: { index: 4 } } };
  f.result.receipts_outcome[0].outcome.status = structuredClone(f.result.status);
  const proof = inspect(f); assert.equal(proof.status, 'FINAL_FAILURE_NEEDS_STATE_REVIEW');
  assert.equal(proof.do_not_resend, true); assert.equal(proof.current_state_verified, false);
});
