import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResourceProvider, orderMemo, verifyPayment } from '../services/resource-provider.mjs';

const contractId = 'bouncer.testnet';
const products = Object.fromEntries(['compute', 'storage', 'api'].map(name => [name, {
  policy_id: name, token: `${name}-token.testnet`, payee: `${name}-vendor.testnet`, amount: '123',
}]));
const inputs = {
  compute: { text: 'real work', rounds: 5 },
  storage: { name: 'note', content: 'persisted on disk' },
  api: { text: 'actual API response' },
};
function payment(resource, txHash) {
  const p = products[resource];
  const args = { ...p, expected_token: p.token, memo: orderMemo(resource, inputs[resource]) };
  delete args.token;
  return {
    final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: {
      hash: txHash, signer_id: contractId, receiver_id: contractId,
      actions: [{ FunctionCall: { method_name: 'execute', deposit: '0', args: Buffer.from(JSON.stringify(args)).toString('base64') } }],
    },
    receipts_outcome: [{ outcome: { executor_id: p.token, status: { SuccessValue: '' } } }],
  };
}
function config(outcome = payment('compute', 'tx-1')) {
  return { txHash: 'tx-1', contractId, product: products.compute, resource: 'compute', input: inputs.compute, outcome };
}

test('memo commits to normalized resource input', () => {
  assert.equal(orderMemo('compute', { rounds: 5, text: 'real work' }), orderMemo('compute', inputs.compute));
  assert.notEqual(orderMemo('compute', { text: 'other work', rounds: 5 }), orderMemo('compute', inputs.compute));
  assert.throws(() => orderMemo('compute', { text: 'x', rounds: 20_001 }), /rounds/);
  assert.throws(() => orderMemo('storage', { name: '../x', content: 'x' }), /safe name/);
});

test('provider requires trusted finalized execute with matching order and successful token receipt', () => {
  const c = config();
  assert.doesNotThrow(() => verifyPayment(c.outcome, c));
  const forwarded = structuredClone(c.outcome);
  forwarded.receipts_outcome.unshift({ outcome: { executor_id: contractId, status: { SuccessReceiptId: 'next-receipt' } } });
  assert.doesNotThrow(() => verifyPayment(forwarded, c));
  assert.throws(() => verifyPayment(c.outcome, { ...c, input: { text: 'changed', rounds: 5 } }), /does not match/);
  for (const mutate of [
    x => { x.final_execution_status = 'EXECUTED_OPTIMISTIC'; },
    x => { delete x.final_execution_status; },
    x => { x.status = { SuccessValue: null }; },
    x => { x.status = { Failure: {} }; },
    x => { x.transaction.signer_id = 'attacker.testnet'; },
    x => { x.transaction.receiver_id = 'attacker.testnet'; },
    x => { x.transaction.actions[0].FunctionCall.deposit = '1'; },
    x => { x.receipts_outcome[0].outcome.status = { Failure: {} }; },
    x => { x.receipts_outcome[0].outcome.executor_id = 'fake-token.testnet'; },
    x => { x.receipts_outcome[0].outcome.status = 'Unknown'; },
  ]) {
    const bad = payment('compute', 'tx-1');
    mutate(bad);
    assert.throws(() => verifyPayment(bad, c));
  }
});

test('real local compute, disk storage and data API require payment, survive restart, and reject replay tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-provider-test-'));
  let calls = 0;
  const rpcProvider = { async viewTransactionStatus(hash, id, wait) {
    assert.equal(id, contractId); assert.equal(wait, 'FINAL'); calls++;
    const resource = hash.split('-')[1];
    if (!products[resource]) throw new Error('unknown transaction');
    return payment(resource, hash);
  } };
  const options = { rpcProvider, contractId, products, dataDir: dir };
  try {
    const provider = createResourceProvider(options);
    const compute = await provider.redeem({ tx_hash: 'tx-compute', resource: 'compute', input: inputs.compute });
    let expected = Buffer.from(inputs.compute.text);
    for (let i = 0; i < inputs.compute.rounds; i++) expected = crypto.createHash('sha256').update(expected).digest();
    assert.equal(compute.result, expected.toString('hex'));
    const store = await provider.redeem({ tx_hash: 'tx-storage', resource: 'storage', input: inputs.storage });
    assert.equal(fs.readFileSync(path.join(dir, 'objects', store.object_id), 'utf8'), inputs.storage.content);
    const api = await provider.redeem({ tx_hash: 'tx-api', resource: 'api', input: inputs.api });
    assert.equal(api.words, 3);
    assert.equal(calls, 3);
    const restarted = createResourceProvider(options);
    assert.deepEqual(await restarted.redeem({ tx_hash: 'tx-storage', resource: 'storage', input: inputs.storage }), store);
    assert.equal(calls, 3, 'a completed order is not charged or fulfilled again');
    await assert.rejects(restarted.redeem({ tx_hash: 'tx-storage', resource: 'storage', input: { ...inputs.storage, content: 'tampered' } }), /different order/);
    await assert.rejects(restarted.redeem({ tx_hash: 'tx-compute', resource: 'api', input: inputs.api }), /different order/);
    assert.equal(fs.readdirSync(path.join(dir, 'objects')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending redemptions are never fulfilled twice after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pending-test-'));
  try {
    const memo = orderMemo('compute', inputs.compute);
    fs.writeFileSync(path.join(dir, 'redemptions.json'), JSON.stringify({ version: 1, redemptions: { 'tx-compute': { status: 'pending', memo, resource: 'compute' } } }));
    const provider = createResourceProvider({ rpcProvider: { viewTransactionStatus: () => { throw new Error('must not call'); } }, contractId, products, dataDir: dir });
    await assert.rejects(provider.redeem({ tx_hash: 'tx-compute', resource: 'compute', input: inputs.compute }), /manual reconciliation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent redemptions for one payment produce one object and one RPC verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-concurrent-test-'));
  let calls = 0;
  try {
    const rpcProvider = { async viewTransactionStatus(hash) { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return payment('storage', hash); } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    const order = { tx_hash: 'tx-storage', resource: 'storage', input: inputs.storage };
    const [a, b] = await Promise.all([provider.redeem(order), provider.redeem(order)]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'objects')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
