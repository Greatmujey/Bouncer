import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { validatePlan, requestFingerprint } from '../agent/procurement.mjs';
import { recoverDirectResourcePayment, recoverResourceDelivery } from '../agent/recover-direct-payment.mjs';
import { computeResult } from './mock-delivery.mjs';
import { orderMemo } from '../services/resource-provider.mjs';

const key = 'ed25519:example', hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 31));
const input = { text: 'reviewed work', rounds: 3 };
const goal = { id: 'work', resource: 'compute', policy_id: 'policy', token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100', input };
const config = { contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', provider_url: 'https://provider.example', goals: [goal] };
const plan = validatePlan({ contract_id: config.contract_id, owner_account_id: config.owner_account_id, requests: [{ id: goal.id, resource: goal.resource,
  policy_id: goal.policy_id, token: goal.token, payee: goal.payee, amount: '80', memo: orderMemo('compute', input) }] });
const request = plan.requests[0], enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
const outcome = (id, executor_id, status, logs = [], receipt_ids = []) => ({ id, outcome: { executor_id, status, logs, receipt_ids } });
const receipt = (id, predecessor_id, receiver_id, method_name, args, deposit) => ({ receipt_id: id, predecessor_id, receiver_id,
  receipt: { Action: { actions: [{ FunctionCall: { method_name, args: enc(args), deposit } }] } } });
const chain = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { id: hash, outcome: { receipt_ids: ['init'] } },
  transaction: { hash, signer_id: config.owner_account_id, receiver_id: config.contract_id, public_key: key, actions: [{ FunctionCall: {
    method_name: 'execute', deposit: '0', gas: '200000000000000', args: enc({ policy_id: request.policy_id, payee: request.payee,
      amount: request.amount, memo: request.memo, expected_token: request.token }) } }] },
  receipts_outcome: [outcome('init', config.contract_id, { SuccessReceiptId: 'callback' }, ['BOUNCER payment initiated'], ['transfer', 'callback']),
    outcome('transfer', request.token, { SuccessValue: '' }), outcome('callback', config.contract_id, { SuccessValue: '' })],
  receipts: [receipt('transfer', config.contract_id, request.token, 'ft_transfer', { receiver_id: request.payee, amount: request.amount, memo: request.memo }, '1'),
    receipt('callback', config.contract_id, config.contract_id, 'after_execute', { policy_id: request.policy_id, token: request.token, amount: request.amount, bucket: 1 }, '0')],
};
function fixture() {
  let entry = { fingerprint: requestFingerprint(request), status: 'pending', request, payment_version: 'direct-signed-v1',
    tx_hash: hash, agent_public_key: key, provider_route: { provider_id: null, provider_origin: config.provider_url } }, reads = 0;
  const journal = { get: id => id === goal.id ? entry : undefined, put(_id, value) { entry = value; } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts() { reads++; return structuredClone(chain); } };
  return { journal, provider, get entry() { return entry; }, get reads() { return reads; } };
}
const recover = (f, c = config, extra = {}) => recoverDirectResourcePayment({ config: c, requestId: goal.id, provider: f.provider, journal: f.journal, log: () => {}, ...extra });

test('resource recovery uses original goal and journal, without quoting, signing or broadcasting', async () => {
  const f = fixture();
  const check = await recover(f, config, { update: false }); assert.equal(check.settlement.tx_hash, hash); assert.equal(f.entry.status, 'pending');
  await recover(f); assert.equal(f.entry.status, 'completed'); assert.equal(f.reads, 2);
  assert.equal(f.entry.provider_route.provider_origin, config.provider_url);
});

test('resource recovery rejects a changed order, cap, quote or provider route before querying receipts', async () => {
  for (const changed of [
    { ...goal, input: { ...input, text: 'different work' } },
    { ...goal, token: 'different.testnet' }, { ...goal, payee: 'different.testnet' },
    { ...goal, max_amount: '79' }, { ...goal, quote_amount: '81' },
    { ...goal, provider_url: 'https://different.example' },
  ]) {
    const f = fixture(); await assert.rejects(recover(f, { ...config, goals: [changed] })); assert.equal(f.reads, 0); assert.equal(f.entry.status, 'pending');
  }
  const f = fixture();
  await assert.rejects(recover(f, { ...config, goals: [goal, goal] }), /exactly once/); assert.equal(f.reads, 0);
  await assert.rejects(recover(f, { ...config, provider_url: 'https://different.example' }), /provider route/); assert.equal(f.reads, 0);
});

test('key-free resource recovery verifies settlement and delivery without quotes or payments', async () => {
  const f = fixture(); let fulfillments = 0;
  const recoverDelivery = () => recoverResourceDelivery({ goal, contractId: config.contract_id, ownerAccountId: config.owner_account_id,
    providerUrl: config.provider_url, provider: f.provider, journal: f.journal, log: () => {},
    fulfill: async ({ tx_hash, input: order }, context) => { fulfillments++; assert.equal(tx_hash, hash); assert.equal(context.goalId, goal.id); return computeResult(order); } });
  const result = await recoverDelivery();
  assert.deepEqual(result.result, computeResult(input)); assert.equal(result.receipt.tx_hash, hash);
  assert.equal(f.entry.status, 'completed'); assert.equal(f.entry.delivery.status, 'verified');
  const receipt = structuredClone(f.entry.delivery.receipt);
  await recoverDelivery(); assert.deepEqual(f.entry.delivery.receipt, receipt); assert.equal(fulfillments, 2);
});

test('key-free delivery recovery rejects a changed route before querying the chain or contacting a provider', async () => {
  const f = fixture(); let fulfillments = 0;
  await assert.rejects(recoverResourceDelivery({ goal: { ...goal, provider_url: 'https://attacker.example' }, contractId: config.contract_id,
    ownerAccountId: config.owner_account_id, providerUrl: config.provider_url, provider: f.provider, journal: f.journal,
    fulfill: async () => { fulfillments++; } }), /provider route/);
  assert.equal(f.reads, 0); assert.equal(fulfillments, 0); assert.equal(f.entry.status, 'pending');
});

test('failed delivery after key-free settlement stays paid and unverified, never resent', async () => {
  const f = fixture();
  await assert.rejects(recoverResourceDelivery({ goal, contractId: config.contract_id, ownerAccountId: config.owner_account_id,
    providerUrl: config.provider_url, provider: f.provider, journal: f.journal, log: () => {},
    fulfill: async ({ input: order }) => ({ ...computeResult(order), result: '0'.repeat(64) }) }), /verification failed after confirmed payment/);
  assert.equal(f.entry.status, 'completed'); assert.equal(f.entry.tx_hash, hash); assert.equal(f.entry.delivery.status, 'unverified');
});
