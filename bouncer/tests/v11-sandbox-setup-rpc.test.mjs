import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { SandboxSetupRpc, withSandboxOnlyFetch } from '../integration/v11-sandbox-setup-rpc.mjs';
import { SANDBOX_CHAIN_ID } from '../integration/v11-sandbox-support.mjs';

// This loopback mock tests only the adapter fence/fault machinery. It is not a
// nearcore test, a network attestation, or any evidence about Circle/testnet.
async function mockSandbox() {
  const state = { status: { chain_id: SANDBOX_CHAIN_ID, sync_info: { syncing: false }, other: 'unchanged' },
    protocol: { chain_id: SANDBOX_CHAIN_ID, protocol_version: 88, other: 'unchanged' }, requests: [] };
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      state.requests.push(body.method);
      const result = body.method === 'status' ? state.status : body.method === 'EXPERIMENTAL_protocol_config' ? state.protocol :
        body.method === 'send_tx' ? { transaction_outcome: { id: 'simulated-response-only' } } : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

async function signedTestTransaction() {
  const owner = nearApi.KeyPair.fromRandom('ed25519');
  const transaction = nearApi.transactions.createTransaction('owner.testnet', owner.getPublicKey(), 'owner.testnet', 1n,
    [nearApi.transactions.functionCall('test', {}, 1n, 0n)], Buffer.alloc(32, 1));
  return (await new nearApi.KeyPairSigner(owner).signTransaction(transaction))[1];
}

test('sandbox setup adapter rejects remote, non-HTTP and mutable endpoints', () => {
  for (const value of ['https://rpc.testnet.near.org', 'http://rpc.testnet.near.org:3030',
    'http://localhost:3030', 'https://127.0.0.1:3030', 'http://127.0.0.2:3030',
    'http://127.0.0.1', 'http://user:pass@127.0.0.1:3030',
    'http://127.0.0.1:3030/anything', 'http://127.0.0.1:3030/?q=1', 'bad']) {
    assert.throws(() => new SandboxSetupRpc(value), /loopback HTTP URL/);
  }
  const provider = new SandboxSetupRpc('http://127.0.0.1:3030');
  assert.throws(() => { provider.connection.url = 'https://rpc.testnet.near.org/'; }, TypeError);
  assert.throws(() => { provider.connection = { url: 'https://rpc.testnet.near.org/' }; }, TypeError);
});

test('test-only identity alias accepts only a ready named sandbox and protocol 88', async () => {
  const mock = await mockSandbox();
  try {
    const provider = new SandboxSetupRpc(mock.url);
    const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 3));
    const status = await provider.viewNodeStatus();
    const protocol = await provider.experimental_protocolConfig({ blockId: hash });
    assert.deepEqual(status, { ...mock.state.status, chain_id: 'testnet' });
    assert.deepEqual(protocol, { ...mock.state.protocol, chain_id: 'testnet' });
    assert.equal(mock.state.status.chain_id, SANDBOX_CHAIN_ID, 'the response fixture is not mutated');
    assert.equal(mock.state.protocol.chain_id, SANDBOX_CHAIN_ID);
    for (const invalid of [null, 'testnet', 'mainnet', 'some-other-sandbox']) {
      mock.state.status.chain_id = invalid;
      await assert.rejects(provider.viewNodeStatus(), /refusing to use an RPC/);
    }
    mock.state.status.chain_id = SANDBOX_CHAIN_ID;
    mock.state.status.sync_info.syncing = true;
    await assert.rejects(provider.viewNodeStatus(), /refusing to use an RPC/);
    mock.state.status.sync_info.syncing = false;
    for (const invalid of [null, 'testnet', 'mainnet', 'some-other-sandbox']) {
      mock.state.protocol.chain_id = invalid;
      await assert.rejects(provider.experimental_protocolConfig({ blockId: hash }), /named protocol-88 sandbox/);
    }
    mock.state.protocol.chain_id = SANDBOX_CHAIN_ID;
    mock.state.protocol.protocol_version = 87;
    await assert.rejects(provider.experimental_protocolConfig({ blockId: hash }), /named protocol-88 sandbox/);
  } finally { await mock.close(); }
});

test('sandbox fetch fence blocks other hosts and redirects, and restores global fetch', async () => {
  let targetRequests = 0;
  const target = http.createServer((_req, res) => { targetRequests++; res.end('unexpected'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` }); res.end();
  });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  const url = `http://127.0.0.1:${redirect.address().port}`, original = globalThis.fetch;
  try {
    await withSandboxOnlyFetch(url, async () => {
      assert.throws(() => fetch('https://rpc.testnet.near.org/'), /non-local/);
      assert.throws(() => fetch(`http://127.0.0.1:${target.address().port}/`), /non-local/);
      await assert.rejects(fetch(url, { redirect: 'follow' }));
      await assert.rejects(withSandboxOnlyFetch(url, async () => {}), /fence is unavailable/);
    });
    assert.equal(targetRequests, 0, 'redirects cannot escape the exact loopback endpoint');
    assert.equal(globalThis.fetch, original);
    await assert.rejects(withSandboxOnlyFetch(url, async () => { throw new Error('test failure'); }), /test failure/);
    assert.equal(globalThis.fetch, original, 'fetch is restored after failure');
  } finally {
    redirect.closeAllConnections(); target.closeAllConnections(); redirect.close(); target.close();
    await Promise.all([once(redirect, 'close'), once(target, 'close')]);
  }
});

test('test-only lost acknowledgement happens after one guarded local transport call', async () => {
  const mock = await mockSandbox();
  try {
    const provider = new SandboxSetupRpc(mock.url), signed = await signedTestTransaction();
    let guards = 0;
    provider.loseNextAcknowledgementForTest();
    assert.throws(() => provider.loseNextAcknowledgementForTest(), /already armed/);
    await assert.rejects(provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => { guards++; } }), /simulated lost acknowledgement/);
    assert.equal(guards, 1);
    assert.equal(provider.transportCalls, 1);
    assert.equal(mock.state.requests.filter(method => method === 'send_tx').length, 1);
    // The adapter does not initiate recovery or another send by itself.
    mock.state.status.chain_id = 'testnet';
    await assert.rejects(provider.sendTransactionOnce(signed, 'FINAL', { beforeSubmit: () => { guards++; } }), /refusing to use an RPC/);
    assert.equal(guards, 1);
    assert.equal(mock.state.requests.filter(method => method === 'send_tx').length, 1);
  } finally { await mock.close(); }
});
