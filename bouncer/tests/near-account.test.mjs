import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { MonotonicAccount, PaymentRpcProvider } from '../agent/near-account.mjs';

const key1 = nearApi.KeyPair.fromRandom('ed25519').getPublicKey();
const key2 = nearApi.KeyPair.fromRandom('ed25519').getPublicKey();

test('nonce selection advances locally when the optimistic RPC view is stale', async () => {
  let observed = 100, sends = 0;
  const provider = {
    async viewAccessKey() { return { nonce: observed }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil() { sends++; throw new Error('must not send'); },
  };
  const account = new MonotonicAccount('bouncer.testnet', provider);
  const one = await account.createTransaction('target.testnet', [], key1);
  const two = await account.createTransaction('target.testnet', [], key1);
  assert.ok(two.nonce > one.nonce);
  assert.equal(two.nonce, one.nonce + 1n);
  const otherKey = await account.createTransaction('target.testnet', [], key2);
  assert.equal(otherKey.nonce, one.nonce, 'nonce tracking is per public key');
  observed = 200;
  const current = await account.createTransaction('target.testnet', [], key1);
  assert.ok(current.nonce > 200n, 'a newer RPC nonce takes precedence');
  assert.equal(sends, 0, 'nonce selection never signs, sends or retries a payment');
});

test('sequential signed calls use distinct nonces and a send failure is never retried', async () => {
  const sent = [];
  const provider = {
    async viewAccessKey() { return { nonce: 100 }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil(signed, wait) {
      sent.push({ nonce: signed.transaction.nonce, wait });
      if (sent.length === 3) throw new Error('ambiguous timeout');
      return { status: { SuccessValue: '' } };
    },
  };
  const key = nearApi.KeyPair.fromRandom('ed25519');
  const account = new MonotonicAccount('bouncer.testnet', provider, new nearApi.KeyPairSigner(key));
  const call = () => account.callFunctionRaw({ contractId: 'bouncer.testnet', methodName: 'execute', args: {}, gas: 1n, deposit: 0n, waitUntil: 'FINAL' });
  await call(); await call();
  await assert.rejects(call(), /ambiguous timeout/);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(item => item.wait === 'FINAL'));
  assert.deepEqual(sent.map(item => item.nonce), [sent[0].nonce, sent[0].nonce + 1n, sent[0].nonce + 2n]);
});

test('RPC failures and nonce overflow are surfaced without sending', async () => {
  let sends = 0;
  const provider = {
    async viewAccessKey() { return { nonce: ((1n << 64n) - 1n).toString() }; },
    async viewBlock() { return { header: { hash: '11111111111111111111111111111111' } }; },
    async sendTransactionUntil() { sends++; },
  };
  const account = new MonotonicAccount('bouncer.testnet', provider);
  await assert.rejects(account.createTransaction('target.testnet', [], key1), /nonce outside U64/);
  provider.viewAccessKey = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(account.createTransaction('target.testnet', [], key1), /RPC unavailable/);
  assert.equal(sends, 0);
});

test('built-in payment RPC submits once on HTTP 503 rather than retrying an ambiguous send', async () => {
  const requests = [], server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.statusCode = 503; res.end('unavailable after possible admission');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const provider = new PaymentRpcProvider(`http://127.0.0.1:${server.address().port}`);
    const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair);
    const tx = nearApi.transactions.createTransaction('owner.testnet', pair.getPublicKey(), 'bouncer.testnet', 1n,
      [nearApi.transactions.functionCall('execute', {}, 1n, 0n)], Buffer.alloc(32, 2));
    const [, signed] = await signer.signTransaction(tx);
    await assert.rejects(provider.sendTransactionUntil(signed, 'FINAL'));
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'send_tx');
    assert.equal(requests[0].params.wait_until, 'FINAL');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('receipt lookup is read-only and bounded, even when the RPC never answers', async () => {
  const requests = [], server = http.createServer(async req => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    // Deliberately never send a response; the client must abort its own read.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const provider = new PaymentRpcProvider(`http://127.0.0.1:${server.address().port}`, { receiptTimeoutMs: 80 });
    await assert.rejects(provider.txStatusReceipts('hash', 'owner.testnet', 'FINAL'), /timed out|aborted/i);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'EXPERIMENTAL_tx_status');
    assert.equal(requests[0].params.wait_until, 'FINAL');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('bounded one-shot submission aborts a stalled RPC without retrying or leaking signed bytes to errors', async () => {
  const requests = [], server = http.createServer(async req => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    // Do not answer: the sender must abort without a second request.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const provider = new PaymentRpcProvider(`http://127.0.0.1:${server.address().port}`, { sendTimeoutMs: 100 });
    const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair);
    const tx = nearApi.transactions.createTransaction('owner.testnet', pair.getPublicKey(), 'bouncer.testnet', 1n,
      [nearApi.transactions.functionCall('execute', {}, 1n, 0n)], Buffer.alloc(32, 2));
    const [, signed] = await signer.signTransaction(tx);
    await assert.rejects(provider.sendTransactionOnce(signed, 'FINAL'), /timed out|aborted/i);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'send_tx');
    assert.equal(requests[0].params.wait_until, 'FINAL');
    assert.equal(requests[0].params.signed_tx_base64, Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'));
    await assert.rejects(provider.sendTransactionOnce(signed, 'NONE'), /requires FINAL/);
    assert.equal(requests.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('bounded one-shot submission accepts a single response but never retries RPC errors or redirects', async () => {
  let count = 0, mode = 'ok';
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    count++;
    if (mode === 'redirect') { res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/other` }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mode === 'error' ? { jsonrpc: '2.0', id: 'x', error: { message: 'unavailable' } } :
      { jsonrpc: '2.0', id: 'x', result: { final_execution_status: 'FINAL' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const provider = new PaymentRpcProvider(`http://127.0.0.1:${server.address().port}`, { sendTimeoutMs: 1000 });
    const pair = nearApi.KeyPair.fromRandom('ed25519');
    const tx = nearApi.transactions.createTransaction('owner.testnet', pair.getPublicKey(), 'bouncer.testnet', 1n,
      [nearApi.transactions.functionCall('execute', {}, 1n, 0n)], Buffer.alloc(32, 2));
    const [, signed] = await new nearApi.KeyPairSigner(pair).signTransaction(tx);
    assert.equal((await provider.sendTransactionOnce(signed)).final_execution_status, 'FINAL'); assert.equal(count, 1);
    mode = 'error'; await assert.rejects(provider.sendTransactionOnce(signed), /remains unresolved/); assert.equal(count, 2);
    mode = 'redirect'; await assert.rejects(provider.sendTransactionOnce(signed)); assert.equal(count, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
