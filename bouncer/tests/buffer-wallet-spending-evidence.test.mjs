import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { prepareBufferSpendingAttempt, inspectBufferSpendingAttempt } from '../agent/buffer-wallet-spending-evidence.mjs';

// Synthetic public IDs, keys, hashes and RPC data only. No chain is contacted.
const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const vaultKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const forwarderKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const plan = () => buildBufferWalletSpendingPlan({ owner: 'buyer.testnet', vault: 'vault.buyer.testnet',
  adapter: 'buffer.buyer.testnet', policy_id: 'research', vault_agent_public_key: vaultKey,
  forwarder_agent_public_key: forwarderKey, per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000',
  vault_agent_gas_allowance_yocto: '250000000000000000000000', forwarder_agent_gas_allowance_yocto: '200000000000000000000000' });
function rpcAction(action) {
  if (action.enum === 'functionCall') return { FunctionCall: { method_name: action.functionCall.methodName,
    args: Buffer.from(action.functionCall.args).toString('base64'), gas: Number(action.functionCall.gas),
    deposit: action.functionCall.deposit.toString() } };
  const key = action.addKey, p = key.accessKey.permission.functionCall;
  return { AddKey: { public_key: String(key.publicKey), access_key: { nonce: Number(key.accessKey.nonce),
    permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: [...p.methodNames] } } } } };
}
function fixture(index = 0, omitLocal = false) {
  const p = plan(), review = structuredClone(p.review), batch = p.batches[index], trustedReviewHash = review.review_sha256;
  const trustedOriginalHash = hash(7), trustedOwnerPublicKey = ownerKey, stageId = batch.id;
  const attempt = prepareBufferSpendingAttempt({ review, trustedReviewHash, stageId, trustedOriginalHash, trustedOwnerPublicKey });
  const actions = batch.actions.map(rpcAction), root = hash(8);
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: trustedOriginalHash, signer_id: batch.signerId, public_key: ownerKey,
      receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: trustedOriginalHash, outcome: { executor_id: batch.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: omitLocal ? [] : [{ receipt_id: root, predecessor_id: batch.signerId, receiver_id: batch.receiverId,
      receipt: { Action: { signer_id: batch.signerId, signer_public_key: ownerKey, actions: structuredClone(actions),
        input_data_ids: [], output_data_receivers: [] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [] } }] };
  return { review, trustedReviewHash, trustedOriginalHash, trustedOwnerPublicKey, attempt, result };
}
const inspect = f => inspectBufferSpendingAttempt(f);

function addGasRefund(f) {
  const id = hash(9), owner = f.attempt.signer_id;
  f.result.receipts_outcome[0].outcome.receipt_ids.push(id);
  f.result.receipts.push({ receipt_id: id, predecessor_id: 'system', receiver_id: owner, receipt: { Action: {
    signer_id: owner, signer_public_key: ownerKey, gas_price: '0', input_data_ids: [], output_data_receivers: [],
    actions: [{ Transfer: { deposit: '10' } }] } } });
  f.result.receipts_outcome.push({ id, outcome: { executor_id: owner, status: { SuccessValue: '' }, receipt_ids: [] } });
}

test('retained original and canonical review bind all three policy/key batches without signing', () => {
  for (let i = 0; i < 3; i++) {
    for (const omitLocal of i ? [false, true] : [false]) {
      const f = fixture(i, omitLocal), evidence = inspect(f);
      assert.equal(f.attempt.status, 'pending');
      assert.equal(evidence.status, omitLocal ? 'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH' : 'FINAL_SPENDING_SETUP_RECEIPT_MATCH');
      assert.equal(evidence.local_receipt_body_omitted, omitLocal);
      assert.equal(evidence.tx_hash, f.trustedOriginalHash);
      assert.equal(evidence.do_not_resend, true);
      assert.equal(evidence.current_state_verified, false);
      assert.equal(evidence.owner_approval_verified, false);
      assert.equal(evidence.independent_delivery_verified, false);
      assert.doesNotMatch(JSON.stringify(evidence), /secret|signed_transaction|private_key/);
      addGasRefund(f);
      assert.equal(inspect(f).tx_hash, f.trustedOriginalHash);
    }
  }
});

test('a canonical secp256k1 owner key can be retained without widening either agent key', () => {
  const f = fixture(), secpKey = String(nearApi.KeyPair.fromRandom('secp256k1').getPublicKey());
  const attempt = prepareBufferSpendingAttempt({ review: f.review, trustedReviewHash: f.trustedReviewHash,
    stageId: f.attempt.stage_id, trustedOriginalHash: f.trustedOriginalHash, trustedOwnerPublicKey: secpKey });
  assert.equal(attempt.signer_public_key, secpKey);
  assert.notEqual(secpKey, vaultKey);
  assert.notEqual(secpKey, forwarderKey);
});

test('no missing, invented or changed original, review, owner key or attempt is accepted', () => {
  const f = fixture();
  for (const patch of [
    { trustedOriginalHash: null }, { trustedOriginalHash: hash(6) }, { trustedOriginalHash: 'invalid' },
    { trustedReviewHash: '0'.repeat(64) }, { trustedReviewHash: null }, { trustedOwnerPublicKey: vaultKey },
    { trustedOwnerPublicKey: forwarderKey }, { trustedOwnerPublicKey: 'ed25519:bad' },
    { attempt: { ...f.attempt, tx_hash: hash(6) } }, { attempt: { ...f.attempt, receiver_id: 'evil.testnet' } },
    { attempt: { ...f.attempt, extra: true } }, { attempt: null },
  ]) assert.throws(() => inspect({ ...f, ...patch }));
  const altered = structuredClone(f.review); altered.per_tx_cap_atoms = '1';
  assert.throws(() => inspect({ ...f, review: altered }), /review differs/);
  const alteredStage = structuredClone(f.review); alteredStage.stages[0].actions[1].args.payee = 'evil.testnet';
  assert.throws(() => inspect({ ...f, review: alteredStage }), /review differs/);
  assert.throws(() => prepareBufferSpendingAttempt({ review: f.review, trustedReviewHash: f.trustedReviewHash,
    trustedOriginalHash: f.trustedOriginalHash, trustedOwnerPublicKey: ownerKey, stageId: 'other' }));
});

test('rejects wrong signer, receiver, hash, action bytes, one-yocto guards and scoped key permissions', () => {
  const changes = [
    r => { r.transaction.hash = hash(6); }, r => { r.transaction_outcome.id = hash(6); },
    r => { r.transaction.signer_id = 'evil.testnet'; }, r => { r.transaction.public_key = vaultKey; },
    r => { r.transaction.receiver_id = 'evil.testnet'; }, r => { r.transaction.actions[0].FunctionCall.deposit = '0'; },
    r => { r.transaction.actions[0].FunctionCall.gas = 30000000000001; },
    r => { r.transaction.actions[1].FunctionCall.args = Buffer.from('{}').toString('base64'); },
    r => { r.transaction.actions.reverse(); }, r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    r => { r.receipts[0].predecessor_id = 'evil.testnet'; }, r => { r.receipts[0].receipt.Action.signer_public_key = vaultKey; },
    r => { r.receipts[0].receipt.Action.input_data_ids.push(hash(10)); },
    r => { r.receipts[0].receipt.Action.output_data_receivers.push({ data_id: hash(10), receiver_id: 'evil.testnet' }); },
    r => { r.transaction_outcome.outcome.status.SuccessReceiptId = hash(10); },
  ];
  for (const change of changes) { const f = fixture(); change(f.result); assert.throws(() => inspect(f)); }
  for (const change of [
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.receiver_id = 'evil.testnet'; },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.method_names.push('set_policy'); },
    r => { r.transaction.actions[0].AddKey.access_key.permission.FunctionCall.allowance = '999999999999999999999999'; },
    r => { r.transaction.actions[0].AddKey.access_key.permission = 'FullAccess'; },
    r => { r.transaction.actions[0].AddKey.public_key = forwarderKey; },
  ]) { const f = fixture(1); change(f.result); assert.throws(() => inspect(f)); }
});

test('unknown, incomplete or extra receipts never become success or permission to retry', () => {
  for (const change of [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.status = { Unknown: null }; },
    r => { r.receipts = []; }, r => { r.receipts_outcome = []; },
    r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[0])); },
    r => { r.receipts.push(structuredClone(r.receipts[0])); },
    r => { r.receipts_outcome[0].outcome.receipt_ids = [hash(9)]; },
    r => { r.transaction_outcome.outcome.receipt_ids.push(hash(9)); },
    r => { r.status.SuccessValue = Buffer.from('false').toString('base64'); },
    r => { r.receipts_outcome[0].outcome.status = { SuccessReceiptId: hash(9) }; },
  ]) { const f = fixture(); change(f.result); assert.throws(() => inspect(f)); }
  for (const change of [
    r => { r.receipts[1].predecessor_id = 'seller.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].Transfer.deposit = '0'; },
    r => { r.receipts[1].receipt.Action.signer_public_key = vaultKey; },
    r => { r.receipts_outcome[1].outcome.status.SuccessValue = 'YQ=='; },
    r => { r.receipts[1].receipt.Action.input_data_ids.push(hash(10)); },
  ]) { const f = fixture(); addGasRefund(f); change(f.result); assert.throws(() => inspect(f)); }
});

test('a FINAL failure is a stop requiring state review, not success or automatic retry', () => {
  const f = fixture();
  f.result.status = { Failure: { ActionError: { index: 0 } } };
  f.result.receipts_outcome[0].outcome.status = structuredClone(f.result.status);
  const outcome = inspect(f);
  assert.equal(outcome.status, 'FINAL_FAILURE_NEEDS_STATE_REVIEW');
  assert.equal(outcome.do_not_resend, true);
  assert.equal(outcome.current_state_verified, false);
});
