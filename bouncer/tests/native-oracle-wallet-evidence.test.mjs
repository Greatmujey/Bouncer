import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { prepareNativeOracleWalletAttempt, verifyNativeOracleWalletReview, inspectNativeOracleWalletAttempt } from '../agent/native-oracle-wallet-evidence.mjs';

const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const agentKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const makePlan = () => buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: 'buyer.testnet', vault: 'native.buyer.testnet',
  policy_id: 'price', agent_public_key: agentKey, per_tx_cap_yocto: '100000000000000000000000',
  daily_cap_yocto: '100000000000000000000000', vault_deposit_yocto: '100000000000000000000000',
  agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
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
  const p = makePlan(), review = p.review, batch = p.batches[index], trustedReviewHash = review.review_sha256;
  const trustedOriginalHash = hash(7), trustedOwnerPublicKey = ownerKey, stageId = batch.id;
  const anchors = { review, wasmBytes: wasm, trustedReviewHash, trustedOriginalHash, trustedOwnerPublicKey };
  const attempt = prepareNativeOracleWalletAttempt({ ...anchors, stageId });
  const actions = batch.actions.map(rpcAction), root = hash(8);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: trustedOriginalHash, signer_id: batch.signerId, public_key: ownerKey,
      receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: trustedOriginalHash, outcome: { executor_id: batch.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: omitLocal ? [] : [{ receipt_id: root, predecessor_id: batch.signerId, receiver_id: batch.receiverId,
      receipt: { Action: { signer_id: batch.signerId, signer_public_key: ownerKey, actions: structuredClone(actions), input_data_ids: [], output_data_receivers: [] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [],
      logs: index === 2 ? ['BOUNCER native deposit received'] : [] } }] };
  return { ...anchors, attempt, result };
}
const inspect = f => inspectNativeOracleWalletAttempt(f);
function gasRefund(f) {
  const id = hash(9), owner = f.attempt.signer_id;
  f.result.receipts_outcome[0].outcome.receipt_ids.push(id);
  f.result.receipts.push({ receipt_id: id, predecessor_id: 'system', receiver_id: owner, receipt: { Action: {
    signer_id: owner, signer_public_key: ownerKey, gas_price: '0', input_data_ids: [], output_data_receivers: [],
    actions: [{ Transfer: { deposit: '10' } }] } } });
  f.result.receipts_outcome.push({ id, outcome: { executor_id: owner, status: { SuccessValue: '' }, receipt_ids: [] } });
}

test('matches each original, exact action graph and optional protocol gas refund without implying current state', () => {
  for (let i = 0; i < 4; i++) for (const omit of i === 3 ? [false, true] : [false]) {
    const f = fixture(i, omit), proof = inspect(f), identity = verifyNativeOracleWalletReview(f);
    assert.equal(identity.owner_public_key, ownerKey); assert.equal(proof.tx_hash, hash(7));
    assert.equal(proof.status, omit ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_NATIVE_SETUP_RECEIPT_MATCH');
    assert.equal(proof.local_receipt_body_omitted, omit); assert.equal(proof.do_not_resend, true);
    assert.equal(proof.current_state_verified, false); assert.equal(proof.owner_approval_verified, false);
    assert.equal(proof.independent_delivery_verified, false); gasRefund(f); assert.equal(inspect(f).tx_hash, hash(7));
  }
});

test('requires independently retained original, review, owner key and exact artifact', () => {
  const f = fixture();
  for (const patch of [{ trustedReviewHash: '0'.repeat(64) }, { trustedOriginalHash: hash(6) },
    { trustedOriginalHash: null }, { trustedOwnerPublicKey: agentKey }, { trustedOwnerPublicKey: 'invalid' },
    { attempt: null }, { attempt: { ...f.attempt, receiver_id: 'evil.testnet' } }, { attempt: { ...f.attempt, extra: true } }]) {
    assert.throws(() => inspect({ ...f, ...patch }));
  }
  const review = structuredClone(f.review); review.stages[1].actions[1].args.payee = 'evil.testnet';
  assert.throws(() => inspect({ ...f, review }), /review differs/);
  const changed = Buffer.from(wasm); changed[100] ^= 1; assert.throws(() => inspect({ ...f, wasmBytes: changed }));
  assert.throws(() => prepareNativeOracleWalletAttempt({ ...f, stageId: 'other' }));
});

test('rejects changed actions, receipts, key scope and incomplete result graphs', () => {
  for (const change of [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.transaction.hash = hash(6); },
    r => { r.transaction.signer_id = 'evil.testnet'; }, r => { r.transaction.receiver_id = 'evil.testnet'; },
    r => { r.transaction.actions[1].Transfer.deposit = '1'; }, r => { r.transaction.actions[2].DeployContract.code = Buffer.from(wasm).toString('base64'); },
    r => { r.receipts[0].receipt.Action.signer_public_key = agentKey; }, r => { r.receipts[0].receipt.Action.input_data_ids.push(hash(10)); },
    r => { r.receipts[0].receipt.Action.output_data_receivers.push({ receiver_id: 'evil.testnet', data_id: hash(10) }); },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(10)]; }, r => { r.transaction_outcome.outcome.receipt_ids.push(hash(10)); },
    r => { r.receipts.push(structuredClone(r.receipts[0])); }, r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
  ]) { const f = fixture(); change(f.result); assert.throws(() => inspect(f)); }
  for (const change of [
    r => { r.transaction.actions[0].AddKey.access_key.permission = 'FullAccess'; },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.method_names.push('set_policy'); },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.receiver_id = 'evil.testnet'; },
  ]) { const f = fixture(3, true); change(f.result); assert.throws(() => inspect(f)); }
  const deposit = fixture(2); deposit.result.receipts_outcome[0].outcome.logs = []; assert.throws(() => inspect(deposit));
  const missingBody = fixture(1, true); assert.throws(() => inspect(missingBody));
});

test('FINAL failure remains a stop for state review; never success or retry permission', () => {
  const f = fixture(); f.result.status = { Failure: { ActionError: { index: 0 } } };
  f.result.receipts_outcome[0].outcome.status = structuredClone(f.result.status);
  const proof = inspect(f); assert.equal(proof.status, 'FINAL_FAILURE_NEEDS_STATE_REVIEW');
  assert.equal(proof.do_not_resend, true); assert.equal(proof.current_state_verified, false);
});
