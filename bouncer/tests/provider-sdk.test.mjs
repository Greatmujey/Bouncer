import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentExpectation, verifyProviderPayment, readAndVerifyProviderPayment } from '../packages/provider-sdk/index.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const expectation = { tx_hash: mockHash('seller-order'), contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  policy_id: 'data', token: 'a'.repeat(64), payee: 'merchant.testnet', amount: '1000', memo: 'seller-order:unique-challenge' };
const args = { policy_id: expectation.policy_id, expected_token: expectation.token, payee: expectation.payee,
  amount: expectation.amount, memo: expectation.memo };
const chain = () => mockGuardedPayment({ hash: expectation.tx_hash, owner: expectation.owner_account_id,
  contract: expectation.contract_id, args });
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');

test('seller pins an exact valid testnet order and verifies the full receipt chain', () => {
  assert.deepEqual(validatePaymentExpectation(expectation), expectation);
  const proof = verifyProviderPayment(chain(), expectation);
  assert.equal(proof.tx_hash, expectation.tx_hash);
  assert.equal(proof.token, expectation.token);
  assert.equal(proof.payee, expectation.payee);
  assert.equal(proof.amount, expectation.amount);
  assert.match(proof.verification, /delivery not established/);
});

test('independent seller expectation cannot contain mainnet, zero, overflow or buyer-controlled extra fields', () => {
  for (const changes of [{ tx_hash: 'fake-hash' }, { owner_account_id: 'alice.near' }, { contract_id: 'bouncer.near' },
    { payee: 'merchant.near' }, { token: 'native' }, { amount: '0' }, { amount: '01' }, { amount: '-1' },
    { amount: ((1n << 128n)).toString() }, { memo: '' }, { memo: 'x'.repeat(257) }, { policy_id: ' ' },
    { policy_id: 'x'.repeat(129) }, { extra: true }]) assert.throws(() => validatePaymentExpectation({ ...expectation, ...changes }));
  const { memo, ...missing } = expectation;
  assert.throws(() => validatePaymentExpectation(missing));
});

test('seller rejects substituted order, partial evidence, wrong transfer/callback or unbound receipts', () => {
  for (const changes of [{ tx_hash: mockHash('different') }, { owner_account_id: 'attacker.testnet' },
    { contract_id: 'other.testnet' }, { payee: 'other.testnet' }, { token: 'b'.repeat(64) },
    { policy_id: 'other' }, { amount: '1001' }, { memo: 'another-order' }]) {
    assert.throws(() => verifyProviderPayment(chain(), { ...expectation, ...changes }));
  }
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    r => { r.transaction.public_key = 'invalid-key'; },
    r => { r.transaction.actions[0].FunctionCall.gas = '1'; },
    r => { r.transaction.actions[0].FunctionCall.args = 'bad*base64'; },
    r => { r.transaction_outcome.outcome.receipt_ids = ['unrelated']; },
    r => { r.receipts_outcome[0].outcome.receipt_ids = ['callback']; },
    r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.args = enc({ receiver_id: 'attacker.testnet', amount: '1000', memo: expectation.memo }); },
    r => { r.receipts[1].receipt.Action.actions[0].FunctionCall.args = enc({ policy_id: 'data', token: expectation.token, amount: '1', bucket: 24 }); },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[2].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome[1])); },
    r => { delete r.receipts; },
  ];
  for (const mutate of mutations) { const value = chain(); mutate(value); assert.throws(() => verifyProviderPayment(value, expectation)); }
});

test('RPC adapter requests FINAL receipt-inclusive evidence and refuses a non-testnet chain', async () => {
  let reads = 0;
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash, owner, status) {
    reads++; assert.equal(hash, expectation.tx_hash); assert.equal(owner, expectation.owner_account_id); assert.equal(status, 'FINAL'); return chain();
  } };
  assert.equal((await readAndVerifyProviderPayment({ provider, expectation })).tx_hash, expectation.tx_hash);
  assert.equal(reads, 1);
  provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(readAndVerifyProviderPayment({ provider, expectation }), /testnet/);
  assert.equal(reads, 1);
  await assert.rejects(readAndVerifyProviderPayment({ provider: { viewNodeStatus: provider.viewNodeStatus }, expectation }), /receipt-inclusive/);
});
