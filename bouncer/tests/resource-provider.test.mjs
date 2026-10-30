import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createResourceProvider as createProvider, startConfiguredProvider, orderMemo, verifyPayment } from '../services/resource-provider.mjs';
import { mockHash, mockGuardedPayment } from './mock-guarded-payment.mjs';
function createResourceProvider(options) {
  options.rpcProvider.viewNodeStatus ??= async () => ({ chain_id: 'testnet' });
  return createProvider(options);
}
import { canonicalDelivery } from '../agent/verify-delivery.mjs';

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
  return mockGuardedPayment({ hash: txHash, owner: contractId, contract: contractId, args });
}
function config(outcome = payment('compute', mockHash('tx-1'))) {
  return { txHash: mockHash('tx-1'), contractId, product: products.compute, resource: 'compute', input: inputs.compute, outcome };
}

test('memo commits to normalized resource input', () => {
  assert.equal(orderMemo('compute', { rounds: 5, text: 'real work' }), orderMemo('compute', inputs.compute));
  assert.notEqual(orderMemo('compute', { text: 'other work', rounds: 5 }), orderMemo('compute', inputs.compute));
  assert.throws(() => orderMemo('compute', { text: 'x', rounds: 20_001 }), /rounds/);
  assert.throws(() => orderMemo('storage', { name: '../x', content: 'x' }), /safe name/);
});

test('published compute protocol vector remains interoperable', () => {
  const input = { text: 'Bouncer protocol test', rounds: 3 };
  assert.equal(orderMemo('compute', input), 'bouncer-order-v1:compute:9a4ee52be36beeb6f4769901d9771c49076dfebf59a1e4b4bb19e09ecc24a516');
  const result = { type: 'compute', algorithm: 'sha256-iterated', rounds: 3,
    result: '0ce2813641f347d5e168547d5b4e598f0962e35d0cbc0b847c1a9bca991da1fe' };
  assert.deepEqual(canonicalDelivery({ resource: 'compute', input, result, txHash: mockHash('tx-vector') }), result);
});

test('provider requires trusted finalized execute with matching order and successful token receipt', () => {
  const c = config();
  assert.doesNotThrow(() => verifyPayment(c.outcome, c));
  const forwarded = structuredClone(c.outcome);
  forwarded.receipts_outcome.unshift({ id: 'forwarded', outcome: { executor_id: contractId, status: { SuccessReceiptId: 'next-receipt' } } });
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
    const bad = payment('compute', mockHash('tx-1'));
    mutate(bad);
    assert.throws(() => verifyPayment(bad, c));
  }
});

test('configured provider accepts owner-pinned implicit token IDs only after the RPC reports testnet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-token-test-'));
  const proto = nearApi.providers.JsonRpcProvider.prototype, original = proto.viewNodeStatus;
  const config = { contract_id: contractId, owner_account_id: 'owner.testnet', data_dir: path.join(dir, 'data'), port: 0,
    products: Object.fromEntries(Object.entries(products).map(([key, product]) => [key, { ...product, token: 'a'.repeat(64) }])) };
  let server;
  try {
    proto.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
    await assert.rejects(startConfiguredProvider(config), /provider RPC must report.*testnet/);
    assert.equal(fs.existsSync(config.data_dir), false);
    proto.viewNodeStatus = async () => ({ chain_id: 'testnet' });
    server = await startConfiguredProvider(config);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    if (server) await server.close();
    proto.viewNodeStatus = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider pins a separate owner signer and contract receiver; mismatched signers do not fulfill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-owner-test-'));
  const ownerAccountId = 'owner.testnet';
  try {
    const rpcProvider = { async txStatusReceipts(hash, signer, wait) {
      assert.equal(signer, ownerAccountId); assert.equal(wait, 'FINAL');
      const result = payment('compute', hash);
      result.transaction.signer_id = hash === mockHash('tx-good') ? ownerAccountId : 'attacker.testnet';
      return result;
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, ownerAccountId, products, dataDir: dir });
    const order = { tx_hash: mockHash('tx-good'), resource: 'compute', input: inputs.compute };
    const result = await provider.redeem(order);
    assert.equal(result.type, 'compute');
    await assert.rejects(provider.redeem({ ...order, tx_hash: mockHash('tx-bad') }), /owner, contract or agent key mismatch/);
    assert.equal(fs.readFileSync(path.join(dir, 'redemptions.json'), 'utf8').includes(mockHash('tx-bad')), false);
    const sameAccount = payment('compute', mockHash('tx-same'));
    assert.throws(() => verifyPayment(sameAccount, { txHash: mockHash('tx-same'), contractId, ownerAccountId,
      product: products.compute, resource: 'compute', input: inputs.compute }), /owner, contract or agent key mismatch/);
    await provider.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real local compute, disk storage and data API require payment, survive restart, and reject replay tampering', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-provider-test-'));
  let calls = 0;
  const rpcProvider = { async txStatusReceipts(hash, id, wait) {
    assert.equal(id, contractId); assert.equal(wait, 'FINAL'); calls++;
    const resource = ['compute', 'storage', 'api'].find(name => hash === mockHash(`tx-${name}`));
    if (!products[resource]) throw new Error('unknown transaction');
    return payment(resource, hash);
  } };
  const options = { rpcProvider, contractId, products, dataDir: dir };
  try {
    const provider = createResourceProvider(options);
    const compute = await provider.redeem({ tx_hash: mockHash('tx-compute'), resource: 'compute', input: inputs.compute });
    let expected = Buffer.from(inputs.compute.text);
    for (let i = 0; i < inputs.compute.rounds; i++) expected = crypto.createHash('sha256').update(expected).digest();
    assert.equal(compute.result, expected.toString('hex'));
    const store = await provider.redeem({ tx_hash: mockHash('tx-storage'), resource: 'storage', input: inputs.storage });
    assert.equal(fs.readFileSync(path.join(dir, 'objects', store.object_id), 'utf8'), inputs.storage.content);
    const api = await provider.redeem({ tx_hash: mockHash('tx-api'), resource: 'api', input: inputs.api });
    assert.equal(api.words, 3);
    assert.equal(calls, 3);
    await provider.close();
    const restarted = createResourceProvider(options);
    assert.deepEqual(await restarted.redeem({ tx_hash: mockHash('tx-storage'), resource: 'storage', input: inputs.storage }), store);
    assert.equal(calls, 3, 'a completed order is not charged or fulfilled again');
    await assert.rejects(restarted.redeem({ tx_hash: mockHash('tx-storage'), resource: 'storage', input: { ...inputs.storage, content: 'tampered' } }), /different order/);
    await assert.rejects(restarted.redeem({ tx_hash: mockHash('tx-compute'), resource: 'api', input: inputs.api }), /different order/);
    assert.equal(fs.readdirSync(path.join(dir, 'objects')).length, 1);
    await restarted.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pending redemptions are never fulfilled twice after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pending-test-'));
  try {
    const memo = orderMemo('compute', inputs.compute);
    fs.writeFileSync(path.join(dir, 'redemptions.json'), JSON.stringify({ version: 2, network: 'testnet', contract_id: contractId, owner_account_id: contractId, redemptions: { [mockHash('tx-compute')]: { status: 'pending', memo, resource: 'compute' } } }));
    const provider = createResourceProvider({ rpcProvider: { txStatusReceipts: () => { throw new Error('must not call'); } }, contractId, products, dataDir: dir });
    await assert.rejects(provider.redeem({ tx_hash: mockHash('tx-compute'), resource: 'compute', input: inputs.compute }), /manual reconciliation/);
    await provider.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unrelated redemptions can progress while one RPC is slow; conflicting concurrent orders fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-parallel-test-'));
  let releaseSlow, slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const blocked = new Promise(resolve => { releaseSlow = resolve; });
  try {
    const rpcProvider = { async txStatusReceipts(hash) {
      if (hash === mockHash('tx-slow')) { slowStarted(); await blocked; return payment('storage', hash); }
      return payment('compute', hash);
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    let slowFinished = false;
    const slow = provider.redeem({ tx_hash: mockHash('tx-slow'), resource: 'storage', input: inputs.storage }).then(result => { slowFinished = true; return result; });
    await started;
    await assert.rejects(provider.redeem({ tx_hash: mockHash('tx-slow'), resource: 'storage', input: { ...inputs.storage, content: 'tampered' } }), /different order/);
    const fast = await provider.redeem({ tx_hash: mockHash('tx-fast'), resource: 'compute', input: inputs.compute });
    assert.equal(fast.type, 'compute'); assert.equal(slowFinished, false);
    releaseSlow();
    assert.equal((await slow).type, 'storage');
    await provider.close();
  } finally { releaseSlow(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redemption concurrency is bounded and duplicate callers share a single payment verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cap-test-'));
  let releases = [], calls = 0;
  try {
    const rpcProvider = { async txStatusReceipts(hash) {
      calls++;
      await new Promise(resolve => releases.push(resolve));
      return payment('compute', hash);
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    const order = hash => ({ tx_hash: mockHash(hash), resource: 'compute', input: inputs.compute });
    const jobs = Array.from({ length: 8 }, (_, i) => provider.redeem(order(`tx-${i}`)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 8); assert.equal(releases.length, 8);
    const duplicate = provider.redeem(order('tx-0'));
    await assert.rejects(provider.redeem(order('tx-overflow')), /provider busy/);
    releases.forEach(release => release()); releases = [];
    const results = await Promise.all([...jobs, duplicate]);
    assert.deepEqual(results[0], results[8]); assert.equal(calls, 8);
    assert.ok(results.every(result => result.type === 'compute'));
    await provider.close();
  } finally { releases.forEach(release => release()); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a provider state write error poisons the instance rather than returning uncertain redemptions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-state-failure-test-'));
  let calls = 0;
  try {
    const rpcProvider = { async txStatusReceipts(hash) { calls++; return payment('compute', hash); } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    fs.mkdirSync(path.join(dir, 'redemptions.json')); // makes the first atomic rename fail
    const order = { tx_hash: mockHash('tx-failed'), resource: 'compute', input: inputs.compute };
    await assert.rejects(provider.redeem(order), /state persistence failed.*reconcile/);
    await assert.rejects(provider.redeem(order), /state persistence failed.*reconcile/);
    await assert.rejects(provider.redeem({ ...order, tx_hash: mockHash('tx-other') }), /state persistence failed.*reconcile/);
    assert.equal(calls, 1);
    await provider.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent redemptions for one payment produce one object and one RPC verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-concurrent-test-'));
  let calls = 0;
  try {
    const rpcProvider = { async txStatusReceipts(hash) { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return payment('storage', hash); } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    const order = { tx_hash: mockHash('tx-storage'), resource: 'storage', input: inputs.storage };
    const [a, b] = await Promise.all([provider.redeem(order), provider.redeem(order)]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'objects')).length, 1);
    await provider.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
