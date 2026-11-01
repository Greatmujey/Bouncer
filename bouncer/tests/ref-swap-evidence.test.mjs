import test from 'node:test';
import assert from 'node:assert/strict';
import { REF_SWAP_INPUT, REF_SWAP_OUTPUT, REF_SWAP_EXCHANGE, REF_SWAP_INPUT_MESSAGE, REF_SWAP_OUTPUT_MESSAGE,
  validateRefSwapGoal, verifyRefSwapOutput, verifyRefSweep, verifyCompleteRefSwap } from '../agent/ref-swap-evidence.mjs';
import { goal, ftGoal, key, inputHash, sweepHash, refArgs, swapResult, sweepResult, enc, id } from './ref-swap-fixture.mjs';

function call(r, method) { return r.receipts.find(x => x.receipt.Action.actions[0].FunctionCall.method_name === method).receipt.Action.actions[0].FunctionCall; }
function out(r, executor) { return r.receipts_outcome.find(x => x.outcome.executor_id === executor).outcome; }

test('reviewed Ref route is testnet-only, bounded, immutable, and mapped to one pinned FT-call goal', () => {
  assert.deepEqual(validateRefSwapGoal(goal), goal);
  assert.equal(ftGoal.payee, goal.router_id); assert.equal(ftGoal.msg, REF_SWAP_INPUT_MESSAGE);
  for (const invalid of [{ ...goal, router_id: 'router.near' }, { ...goal, router_id: goal.owner_account_id },
    { ...goal, router_code_hash: 'bad' }, { ...goal, input_amount: '0' }, { ...goal, input_amount: '10000000000000000000001' },
    { ...goal, min_output: '100001' }, { ...goal, pool_id: 4 }, { ...goal, id: '../bad' }, { ...goal, extra: 1 }]) {
    assert.throws(() => validateRefSwapGoal(invalid));
  }
});

test('linked FINAL swap and actual deposit-hook sweep prove a complete bounded testnet route', () => {
  const proof = verifyCompleteRefSwap({ goal, swapResult: swapResult(), swapPublicKey: key, sweepResult: sweepResult(), sweepPublicKey: key });
  assert.equal(proof.swap.tx_hash, inputHash); assert.equal(proof.swap.output_amount, '70');
  assert.equal(proof.vault_credit.tx_hash, sweepHash); assert.equal(proof.vault_credit.credited, '70');
  assert.equal(proof.vault_credit.token, REF_SWAP_OUTPUT); assert.equal(proof.vault_credit.vault, goal.contract_id);
});

test('Ref input success, an unrelated donation, or a failed output never proves a swap', () => {
  const cases = [
    r => { r.final_execution_status = 'EXECUTED'; },
    r => { r.status.SuccessValue = enc('99'); },
    r => { r.transaction.actions[0].FunctionCall.gas = '1'; },
    r => { call(r, 'ft_on_transfer').args = enc({ sender_id: 'attacker.testnet', amount: '100', msg: REF_SWAP_INPUT_MESSAGE }); },
    r => { call(r, 'after_ref_input').args = enc({ forged: true }); },
    r => { call(r, 'after_ref_input').args = enc({}); },
    r => { call(r, 'after_ref_input').args = ' '; },
    r => { out(r, goal.router_id).status.SuccessReceiptId = id(201); },
    r => { r.receipts_outcome.find(x => x.id === id(15)).outcome.logs = []; },
    r => { r.receipts_outcome.find(x => x.id === id(15)).outcome.status.SuccessValue = enc('1'); },
    r => { call(r, 'ft_transfer_call').deposit = '0'; },
    r => { const c = r.receipts.find(x => x.predecessor_id === goal.router_id && x.receiver_id === REF_SWAP_INPUT).receipt.Action.actions[0].FunctionCall;
      c.args = enc({ ...refArgs, msg: JSON.stringify({ force: 0, actions: [{ pool_id: 2206 }] }) }); },
    r => { r.receipts.find(x => x.receiver_id === REF_SWAP_EXCHANGE).predecessor_id = 'attacker.testnet'; },
    r => { out(r, REF_SWAP_EXCHANGE).status.SuccessValue = enc('100'); },
    r => { call(r, 'ft_transfer').args = enc({ receiver_id: 'attacker.testnet', amount: '70', memo: null }); },
    r => { call(r, 'ft_transfer').args = enc({ receiver_id: goal.router_id, amount: '41', memo: null }); },
    r => { r.receipts.find(x => x.receiver_id === REF_SWAP_OUTPUT).predecessor_id = 'donor.testnet'; },
    r => { out(r, REF_SWAP_EXCHANGE).receipt_ids = []; },
    r => { out(r, REF_SWAP_OUTPUT).status = { Failure: { error: 'storage not registered' } }; },
    r => { out(r, REF_SWAP_OUTPUT).logs = []; },
    r => { out(r, REF_SWAP_OUTPUT).logs[0] = out(r, REF_SWAP_OUTPUT).logs[0].replace('"amount":"70"', '"amount":"69"'); },
    r => { out(r, REF_SWAP_OUTPUT).status = { SuccessReceiptId: id(222) }; },
    r => { r.receipts.push(structuredClone(r.receipts.at(-1))); },
    r => { r.receipts_outcome.push(structuredClone(r.receipts_outcome.at(-1))); },
  ];
  for (const [i, mutate] of cases.entries()) { const result = swapResult(); mutate(result);
    assert.throws(() => verifyRefSwapOutput(goal, result, key), undefined, `mutation ${i}`); }
});

test('a sweep must match the verified output and prove the actual vault hook, not a balance change', () => {
  const cases = [
    r => { r.final_execution_status = 'EXECUTED'; },
    r => { r.transaction.signer_id = 'attacker.testnet'; },
    r => { r.transaction.receiver_id = 'other.testnet'; },
    r => { r.transaction.public_key = 'ed25519:wrong'; },
    r => { r.transaction.actions[0].FunctionCall.deposit = '1'; },
    r => { r.transaction.actions[0].FunctionCall.args = enc({ amount: '69' }); },
    r => { r.status.SuccessValue = enc('69'); },
    r => { call(r, 'ft_transfer_call').args = enc({ receiver_id: 'attacker.testnet', amount: '70', memo: 'bouncer:ref-sweep', msg: REF_SWAP_OUTPUT_MESSAGE }); },
    r => { out(r, goal.router_id).receipt_ids = []; },
    r => { out(r, REF_SWAP_OUTPUT).logs = []; },
    r => { out(r, REF_SWAP_OUTPUT).logs[0] = out(r, REF_SWAP_OUTPUT).logs[0].replace('"amount":"70"', '"amount":"71"'); },
    r => { call(r, 'ft_on_transfer').args = enc({ sender_id: 'donor.testnet', amount: '70', msg: REF_SWAP_OUTPUT_MESSAGE }); },
    r => { out(r, goal.contract_id).logs = []; },
    r => { out(r, goal.contract_id).status.SuccessValue = enc('1'); },
    r => { out(r, goal.contract_id).status = { Failure: { error: 'deposit refused' } }; },
    r => { r.receipts[1].receiver_id = 'other.testnet'; },
    r => { r.receipts.push(structuredClone(r.receipts[0])); },
  ];
  for (const [i, mutate] of cases.entries()) { const result = sweepResult(); mutate(result);
    assert.throws(() => verifyRefSweep(goal, '70', result, key), undefined, `mutation ${i}`); }
  assert.throws(() => verifyRefSweep(goal, '41', sweepResult(), key), /minimum/);
  assert.throws(() => verifyRefSweep(goal, '71', sweepResult(), key), /sweep/);
});

test('each half is explicitly insufficient to claim complete vault delivery', () => {
  const output = verifyRefSwapOutput(goal, swapResult(), key);
  assert.match(output.verification, /vault credit is not yet established/);
  assert.throws(() => verifyCompleteRefSwap({ goal, swapResult: swapResult(), swapPublicKey: key, sweepResult: null, sweepPublicKey: key }));
  const changed = sweepResult(); changed.transaction.actions[0].FunctionCall.args = enc({ amount: '71' });
  assert.throws(() => verifyCompleteRefSwap({ goal, swapResult: swapResult(), swapPublicKey: key, sweepResult: changed, sweepPublicKey: key }));
});
