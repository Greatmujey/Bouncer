import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
const hash = mockHash('original'), owner = 'test-owner.testnet', id = 'bouncer-read-only-receipts';
const ok = result => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });

test('only a fixed FINAL testnet receipt lookup is made; no broadcast path is enabled', async () => {
  const requests = [];
  const p = new ReadOnlyNearReceiptProvider('https://rpc.testnet.near.org', { fetchImpl: async (url, options) => {
    requests.push({ url, options }); return ok({ final_execution_status: 'FINAL' });
  } });
  assert.deepEqual(await p.txStatusReceipts(hash, owner, 'FINAL'), { final_execution_status: 'FINAL' });
  assert.equal(requests.length, 1); assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), { jsonrpc: '2.0', id, method: 'EXPERIMENTAL_tx_status',
    params: { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' } });
  assert.equal(typeof p.sendTransactionOnce, 'undefined');
  await assert.rejects(p.sendJsonRpc('send_tx', {}), /read-only RPC method denied/);
  for (const bad of [[hash, 'owner.near', 'FINAL'], ['wrong', owner, 'FINAL'], [hash, owner, 'EXECUTED']]) {
    await assert.rejects(p.txStatusReceipts(...bad), /original testnet hash and FINAL/);
  }
  assert.equal(requests.length, 1);
});

test('implicit receipt sender requires explicit opt-in and an independently checked testnet RPC', async () => {
  const implicit = '26f36567c9a7bd63f340c0c48621ee1257ee28c68211736226caf4efefb8dd84';
  const requests = [];
  const p = new ReadOnlyNearReceiptProvider('https://rpc.testnet.near.org', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return body.method === 'status' ? new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } })) :
      ok({ final_execution_status: 'FINAL' });
  } });
  await assert.rejects(p.txStatusReceipts(hash, implicit), /original testnet hash/);
  await assert.rejects(p.txStatusReceipts(hash, implicit.toUpperCase(), 'FINAL', { allowImplicitTestnet: true }), /original testnet hash/);
  assert.equal(requests.length, 0);
  assert.deepEqual(await p.txStatusReceipts(hash, implicit, 'FINAL', { allowImplicitTestnet: true }), { final_execution_status: 'FINAL' });
  assert.deepEqual(requests.map(x => x.method), ['status', 'EXPERIMENTAL_tx_status']);
  assert.equal(requests[1].params.sender_account_id, implicit);
  await assert.rejects(p.txStatusReceipts(hash, implicit, 'FINAL', { allowImplicitTestnet: true, extra: true }), /invalid receipt lookup options/);
  const mainnetRequests = [];
  const mainnet = new ReadOnlyNearReceiptProvider('https://rpc.mainnet.near.org', { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); mainnetRequests.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'mainnet' } }));
  } });
  await assert.rejects(mainnet.txStatusReceipts(hash, implicit, 'FINAL', { allowImplicitTestnet: true }), /testnet RPC/);
  assert.deepEqual(mainnetRequests, ['status']);
});

test('HTTP failures, errors, mismatched request IDs and malformed results are rejected', async () => {
  for (const response of [
    () => new Response('{}', { status: 503 }),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'unknown' } })),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: {} })),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id, result: [] })),
    () => new Response('{'),
  ]) {
    const p = new ReadOnlyNearReceiptProvider('https://rpc.testnet.near.org', { fetchImpl: async () => response() });
    await assert.rejects(p.txStatusReceipts(hash, owner));
  }
});
