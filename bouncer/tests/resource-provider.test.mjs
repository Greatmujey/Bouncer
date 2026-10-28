import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createResourceProvider, startConfiguredProvider, orderMemo, verifyPayment } from '../services/resource-provider.mjs';

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
    if (server) await new Promise(resolve => server.server.close(resolve));
    proto.viewNodeStatus = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provider pins a separate owner signer and contract receiver; mismatched signers do not fulfill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-owner-test-'));
  const ownerAccountId = 'owner.testnet';
  try {
    const rpcProvider = { async viewTransactionStatus(hash, signer, wait) {
      assert.equal(signer, ownerAccountId); assert.equal(wait, 'FINAL');
      const result = payment('compute', hash);
      result.transaction.signer_id = hash === 'tx-good' ? ownerAccountId : 'attacker.testnet';
      return result;
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, ownerAccountId, products, dataDir: dir });
    const order = { tx_hash: 'tx-good', resource: 'compute', input: inputs.compute };
    const result = await provider.redeem(order);
    assert.equal(result.type, 'compute');
    await assert.rejects(provider.redeem({ ...order, tx_hash: 'tx-bad' }), /trusted Bouncer owner and contract/);
    assert.equal(fs.readFileSync(path.join(dir, 'redemptions.json'), 'utf8').includes('tx-bad'), false);
    const sameAccount = payment('compute', 'tx-same');
    assert.throws(() => verifyPayment(sameAccount, { txHash: 'tx-same', contractId, ownerAccountId,
      product: products.compute, resource: 'compute', input: inputs.compute }), /owner and contract/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test('unrelated redemptions can progress while one RPC is slow; conflicting concurrent orders fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-parallel-test-'));
  let releaseSlow, slowStarted;
  const started = new Promise(resolve => { slowStarted = resolve; });
  const blocked = new Promise(resolve => { releaseSlow = resolve; });
  try {
    const rpcProvider = { async viewTransactionStatus(hash) {
      if (hash === 'tx-slow') { slowStarted(); await blocked; return payment('storage', hash); }
      return payment('compute', hash);
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    let slowFinished = false;
    const slow = provider.redeem({ tx_hash: 'tx-slow', resource: 'storage', input: inputs.storage }).then(result => { slowFinished = true; return result; });
    await started;
    await assert.rejects(provider.redeem({ tx_hash: 'tx-slow', resource: 'storage', input: { ...inputs.storage, content: 'tampered' } }), /different order/);
    const fast = await provider.redeem({ tx_hash: 'tx-fast', resource: 'compute', input: inputs.compute });
    assert.equal(fast.type, 'compute'); assert.equal(slowFinished, false);
    releaseSlow();
    assert.equal((await slow).type, 'storage');
  } finally { releaseSlow(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redemption concurrency is bounded and duplicate callers share a single payment verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cap-test-'));
  let releases = [], calls = 0;
  try {
    const rpcProvider = { async viewTransactionStatus(hash) {
      calls++;
      await new Promise(resolve => releases.push(resolve));
      return payment('compute', hash);
    } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    const order = hash => ({ tx_hash: hash, resource: 'compute', input: inputs.compute });
    const jobs = Array.from({ length: 8 }, (_, i) => provider.redeem(order(`tx-${i}`)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 8); assert.equal(releases.length, 8);
    const duplicate = provider.redeem(order('tx-0'));
    await assert.rejects(provider.redeem(order('tx-overflow')), /provider busy/);
    releases.forEach(release => release()); releases = [];
    const results = await Promise.all([...jobs, duplicate]);
    assert.deepEqual(results[0], results[8]); assert.equal(calls, 8);
    assert.ok(results.every(result => result.type === 'compute'));
  } finally { releases.forEach(release => release()); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a provider state write error poisons the instance rather than returning uncertain redemptions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-state-failure-test-'));
  let calls = 0;
  try {
    const rpcProvider = { async viewTransactionStatus(hash) { calls++; return payment('compute', hash); } };
    const provider = createResourceProvider({ rpcProvider, contractId, products, dataDir: dir });
    fs.mkdirSync(path.join(dir, 'redemptions.json')); // makes the first atomic rename fail
    const order = { tx_hash: 'tx-failed', resource: 'compute', input: inputs.compute };
    await assert.rejects(provider.redeem(order), /state persistence failed.*reconcile/);
    await assert.rejects(provider.redeem(order), /state persistence failed.*reconcile/);
    await assert.rejects(provider.redeem({ ...order, tx_hash: 'tx-other' }), /state persistence failed.*reconcile/);
    assert.equal(calls, 1);
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
