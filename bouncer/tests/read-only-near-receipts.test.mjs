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
