// Guard tests only. These do not run nearcore or simulate the escrow scenario.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { exerciseSandboxEscrowBoundary } from '../integration/v11-sandbox-escrow-boundary.mjs';
import { readExactArtifact } from './fixtures/v11-synthetic-host.mjs';

const artifact = () => readExactArtifact(process.env.BOUNCER_V11_WASM_PATH);
const fakeAccount = (accountId, url, sends) => ({ accountId, provider: { connection: { url } },
  signAndSendTransaction() { sends.count++; throw new Error('unexpected send'); } });
const inputs = (url, sends = { count: 0 }) => ({ rpcUrl: url, root: fakeAccount('testnet', url, sends),
  tokenOwner: fakeAccount('owner.testnet', url, sends), wasm: Buffer.from('not-V11'), storageMin: '1250000000000000000000' });

test('escrow boundary harness rejects remote or credentialed RPCs and never signs', async () => {
  const sends = { count: 0 };
  for (const url of ['https://rpc.testnet.near.org/', 'http://localhost:3030/', 'http://127.0.0.1/',
    'http://127.0.0.1:3030/path', 'http://a:b@127.0.0.1:3030/', 'http://127.0.0.1:3030/?a=1']) {
    await assert.rejects(exerciseSandboxEscrowBoundary(inputs(url, sends)));
  }
  assert.equal(sends.count, 0);
});

test('escrow boundary harness rejects an unpinned artifact before network or signing', async () => {
  const sends = { count: 0 };
  await assert.rejects(exerciseSandboxEscrowBoundary(inputs('http://127.0.0.1:9/', sends)), /pinned V11/);
  assert.equal(sends.count, 0);
});

test('even with exact bytecode, wrong accounts and storage bounds fail before network or signing',
  { skip: process.env.BOUNCER_V11_WASM_PATH ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned recovered artifact' }, async () => {
    const sends = { count: 0 }, base = { ...inputs('http://127.0.0.1:9/', sends), wasm: artifact() };
    const variants = [{ ...base, root: fakeAccount('elsewhere.testnet', base.rpcUrl, sends) },
      { ...base, tokenOwner: fakeAccount('wrong.testnet', base.rpcUrl, sends) },
      { ...base, root: fakeAccount('testnet', 'http://127.0.0.1:10/', sends) },
      { ...base, storageMin: '0' }, { ...base, storageMin: '100000000000000000000001' },
      { ...base, checkpoint: 'not a function' }];
    for (const value of variants) await assert.rejects(exerciseSandboxEscrowBoundary(value), /sandbox/);
    assert.equal(sends.count, 0);
  });

test('even with exact bytecode, a non-sandbox chain is rejected before signing',
  { skip: process.env.BOUNCER_V11_WASM_PATH ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned recovered artifact' }, async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.method, 'status');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet', sync_info: { syncing: false } } }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/`, sends = { count: 0 };
      await assert.rejects(exerciseSandboxEscrowBoundary({ ...inputs(url, sends), wasm: artifact() }), /named local sandbox/);
      assert.equal(requests, 1); assert.equal(sends.count, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
