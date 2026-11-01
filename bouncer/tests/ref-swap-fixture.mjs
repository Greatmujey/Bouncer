import nearApi from 'near-api-js';
import { signingFixture } from './signing-fixture.mjs';
import { REF_SWAP_INPUT, REF_SWAP_OUTPUT, REF_SWAP_EXCHANGE, REF_SWAP_INPUT_MESSAGE, REF_SWAP_OUTPUT_MESSAGE,
  refSwapFtGoal, REF_SWEEP_GAS } from '../agent/ref-swap-evidence.mjs';

const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (old_owner_id, new_owner_id, amount) => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0',
  event: 'ft_transfer', data: [{ old_owner_id, new_owner_id, amount }] })}`;
const id = byte => nearApi.utils.serialize.base_encode(Buffer.alloc(32, byte));
const goal = { version: 1, id: 'guarded-swap', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  router_id: 'router.testnet', router_code_hash: id(1), policy_id: 'swap', policy_revision: 1, route_revision: 2,
  pool_id: 1845, input_amount: '100', min_output: '42' };
const ftGoal = refSwapFtGoal(goal);
const args = { policy_id: goal.policy_id, payee: goal.router_id, amount: goal.input_amount, expected_token: REF_SWAP_INPUT,
  expected_msg: REF_SWAP_INPUT_MESSAGE, expected_policy_revision: 1, expected_route_revision: 2 };
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_ft_call', args });
const key = signing.key, inputHash = signing.hash, sweepHash = id(99);
function outcome(rid, executor, status, logs = [], children = []) { return { id: rid, outcome: { executor_id: executor, status, logs, receipt_ids: children } }; }
function receipt(rid, predecessor, receiver, method, callArgs, deposit = '0') {
  return { receipt_id: rid, predecessor_id: predecessor, receiver_id: receiver, receipt: { Action: { actions: [{ FunctionCall: {
    method_name: method, args: enc(callArgs), deposit } }] } } };
}
const swapMessage = JSON.stringify({ force: 0, actions: [{ pool_id: goal.pool_id, token_in: REF_SWAP_INPUT, token_out: REF_SWAP_OUTPUT,
  amount_in: goal.input_amount, min_amount_out: goal.min_output }] });
const refArgs = { receiver_id: REF_SWAP_EXCHANGE, amount: '100', memo: 'bouncer:ref-router-v1', msg: swapMessage };
function swapResult() {
  const [init, outer, bouncerCallback, hook, inner, routerCallback, refHook, output] = Array.from({ length: 8 }, (_, i) => id(i + 10));
  return { final_execution_status: 'FINAL', status: { SuccessValue: enc('100') },
    transaction_outcome: { id: inputHash, outcome: { receipt_ids: [init] } },
    transaction: { hash: inputHash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_ft_call', args: enc(args), gas: '300000000000000', deposit: '0' } }] },
    receipts: [
      receipt(outer, goal.contract_id, REF_SWAP_INPUT, 'ft_transfer_call', { receiver_id: goal.router_id, amount: '100',
        memo: 'bouncer:guarded-ft-call', msg: REF_SWAP_INPUT_MESSAGE }, '1'),
      receipt(bouncerCallback, goal.contract_id, goal.contract_id, 'after_execute_ft_call', { policy_id: 'swap', token: REF_SWAP_INPUT,
        amount: '100', bucket: 24, policy_revision: 1 }),
      receipt(hook, REF_SWAP_INPUT, goal.router_id, 'ft_on_transfer', { sender_id: goal.contract_id, amount: '100', msg: REF_SWAP_INPUT_MESSAGE }),
      receipt(inner, goal.router_id, REF_SWAP_INPUT, 'ft_transfer_call', refArgs, '1'),
      receipt(routerCallback, goal.router_id, goal.router_id, 'after_ref_input', {}),
      receipt(refHook, REF_SWAP_INPUT, REF_SWAP_EXCHANGE, 'ft_on_transfer', { sender_id: goal.router_id, amount: '100', msg: swapMessage }),
      receipt(output, REF_SWAP_EXCHANGE, REF_SWAP_OUTPUT, 'ft_transfer', { receiver_id: goal.router_id, amount: '70', memo: null }, '1'),
    ],
    receipts_outcome: [
      outcome(init, goal.contract_id, { SuccessReceiptId: bouncerCallback }, ['BOUNCER guarded ft_transfer_call initiated; full amount reserved'], [outer, bouncerCallback]),
      outcome(outer, REF_SWAP_INPUT, { SuccessReceiptId: id(30) }, [], [hook]),
      outcome(bouncerCallback, goal.contract_id, { SuccessValue: enc('100') }, ['BOUNCER ft_transfer_call settled; used=100; unused=0']),
      outcome(hook, goal.router_id, { SuccessReceiptId: routerCallback }, [], [inner, routerCallback]),
      outcome(inner, REF_SWAP_INPUT, { SuccessReceiptId: id(31) }, [], [refHook]),
      outcome(routerCallback, goal.router_id, { SuccessValue: enc('0') }, ['BOUNCER ref-router inner input settled; used=100; output unverified']),
      outcome(refHook, REF_SWAP_EXCHANGE, { SuccessValue: enc('0') }, [], [output]),
      outcome(output, REF_SWAP_OUTPUT, { SuccessValue: '' }, [event(REF_SWAP_EXCHANGE, goal.router_id, '70')]),
    ] };
}
function sweepResult({ hash = sweepHash, publicKey = key } = {}) {
  const [init, send, hook] = Array.from({ length: 3 }, (_, i) => id(i + 40));
  return { final_execution_status: 'FINAL', status: { SuccessValue: enc('70') },
    transaction_outcome: { id: hash, outcome: { receipt_ids: [init] } },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.router_id, public_key: publicKey,
      actions: [{ FunctionCall: { method_name: 'sweep_output', args: enc({ amount: '70' }), gas: REF_SWEEP_GAS.toString(), deposit: '0' } }] },
    receipts: [receipt(send, goal.router_id, REF_SWAP_OUTPUT, 'ft_transfer_call', { receiver_id: goal.contract_id, amount: '70',
      memo: 'bouncer:ref-sweep', msg: REF_SWAP_OUTPUT_MESSAGE }, '1'),
      receipt(hook, REF_SWAP_OUTPUT, goal.contract_id, 'ft_on_transfer', { sender_id: goal.router_id, amount: '70', msg: REF_SWAP_OUTPUT_MESSAGE })],
    receipts_outcome: [outcome(init, goal.router_id, { SuccessReceiptId: send }, [], [send]),
      outcome(send, REF_SWAP_OUTPUT, { SuccessReceiptId: id(50) }, [event(goal.router_id, goal.contract_id, '70')], [hook]),
      outcome(hook, goal.contract_id, { SuccessValue: enc('0') }, ['BOUNCER deposit received'])] };
}

export { goal, ftGoal, args, signing, key, inputHash, sweepHash, refArgs, swapMessage, swapResult, sweepResult, enc, id };
