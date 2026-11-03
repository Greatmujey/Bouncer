/** Local guards, fixture, and synthetic-RPC wiring tests only. These do not
 * execute nearcore, Circle, PayPerCall or a seller. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { exerciseSandboxForwarder } from '../integration/v11-sandbox-forwarder.mjs';
import { buildSandboxEscrowStandIn, FIXTURE_FORWARDER } from '../integration/fixtures/paypercall-stand-in.mjs';
import { SyntheticNearHost, readExactArtifact } from './fixtures/v11-synthetic-host.mjs';
import { createSyntheticForwarderRpc } from './fixtures/v11-forwarder-synthetic-rpc.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const file = process.env.BOUNCER_V11_WASM_PATH;
const skip = file ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned recovered artifact';
const fakeAccount = (accountId, url, sends) => ({ accountId, provider: { connection: { url } },
  signAndSendTransaction() { sends.count++; throw new Error('unexpected send'); } });
const inputs = (url, sends = { count: 0 }) => ({ rpcUrl: url, root: fakeAccount('testnet', url, sends),
  tokenOwner: fakeAccount('owner.testnet', url, sends), wasm: Buffer.from('not-V11'), storageMin: '1250000000000000000000' });

test('stand-in bytecode returns a partial amount and emits only a fixed mock-token return', async () => {
  const bytes = await buildSandboxEscrowStandIn(), h = new SyntheticNearHost(bytes);
  assert.equal(h.call('ft_on_transfer', {}).value, '40');
  const p = h.call('fixture_refund_later', {}).promises[0];
  assert.equal(p.receiver, TOKEN); assert.equal(p.actions[0].method, 'ft_transfer');
  assert.equal(p.actions[0].deposit, '1');
  assert.deepEqual(p.actions[0].args, { receiver_id: FIXTURE_FORWARDER, amount: '60', memo: 'isolated fixture refund' });
  assert.equal(h.module instanceof WebAssembly.Module, true);
});

test('forwarder harness rejects remote endpoints and unpinned V11 before signing', async () => {
  const sends = { count: 0 };
  for (const url of ['https://rpc.testnet.near.org/', 'http://localhost:3030/', 'http://127.0.0.1/',
    'http://127.0.0.1:3030/path', 'http://a:b@127.0.0.1:3030/', 'http://127.0.0.1:3030/?a=1']) {
    await assert.rejects(exerciseSandboxForwarder(inputs(url, sends)));
  }
  await assert.rejects(exerciseSandboxForwarder(inputs('http://127.0.0.1:9/', sends)), /pinned V11/);
  assert.equal(sends.count, 0);
});

test('forwarder harness rejects a wrong chain before signing even with pinned V11', { skip }, async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.method, 'status');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet', sync_info: { syncing: false } } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`, sends = { count: 0 };
    await assert.rejects(exerciseSandboxForwarder({ ...inputs(url, sends), wasm: readExactArtifact(file) }), /named local sandbox/);
    assert.equal(requests, 1); assert.equal(sends.count, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

for (const wrongPartialRefund of [false, true]) {
  test(wrongPartialRefund ? 'harness detects a synthetic FT that fails to return the partial amount' :
    'harness wiring composes V11 and forwarder bytecode through an explicitly synthetic RPC model', { skip }, async () => {
    const wasm = readExactArtifact(file), rpc = await createSyntheticForwarderRpc(wasm, { wrongPartialRefund });
    try {
      const operation = exerciseSandboxForwarder({ rpcUrl: rpc.url, root: rpc.root, tokenOwner: rpc.tokenOwner,
        wasm, storageMin: '1250000000000000000000' });
      if (wrongPartialRefund) await assert.rejects(operation, error => {
        assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(error.actual, '0'); assert.equal(error.expected, '40'); return true;
      });
      else {
        const result = await operation;
        assert.match(result.scope, /NOT Circle or PayPerCall/);
        assert.equal(result.distinct_receiver_scoped_keys, true);
        assert.equal(result.exact_intent_and_open_replays_blocked, true);
        assert.equal(result.final_vault_actual, '100'); assert.equal(result.final_vault_tracked, '100');
        assert.equal(result.conservative_spend, '100'); assert.equal(result.independent_fulfillment_verified, false);
      }
      assert.ok(rpc.state.sends > 0); assert.deepEqual(rpc.state.unexpected, []);
    } catch (error) {
      error.message += `; synthetic diagnostics: ${rpc.state.lastFailure ?? 'none'} ${rpc.state.unexpected.join('; ')}`;
      throw error;
    } finally { await rpc.close(); }
  });
}
