import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchPublicRepository, normalizeRepository } from '../services/github-data.mjs';
import { createResourceProvider, normalizeOrder, orderMemo } from '../services/resource-provider.mjs';
import { mockHash, mockGuardedPayment } from './mock-guarded-payment.mjs';

const data = () => ({ private: false, full_name: 'near/near-api-js', id: 12345, description: 'A public repository',
  stargazers_count: 123, forks_count: 40, open_issues_count: 8, license: { spdx_id: 'MIT' } });
const ok = obj => new Response(JSON.stringify(obj), { status: 200 });

test('public data requests accept repository identifiers, never arbitrary URLs or paths', () => {
  assert.equal(normalizeRepository('near/near-api-js'), 'near/near-api-js');
  for (const bad of ['https://evil.example/', '../private', 'foo/..', 'foo/.', 'foo/a/b', 'foo/repo?token=x', 'foo/repo#x',
    'foo/%2e%2e', '-foo/repo', 'foo-/repo', 'foo/repo\\x', 'foo/repo\n', 'föö/repo', 'foo/' + 'x'.repeat(101)]) {
    assert.throws(() => normalizeRepository(bad), /repository/);
  }
  assert.deepEqual(normalizeOrder('api', { repo: 'near/near-api-js' }), { repo: 'near/near-api-js' });
  assert.throws(() => normalizeOrder('api', { text: 'x', repo: 'near/near-api-js' }), /api needs/);
  assert.notEqual(orderMemo('api', { repo: 'near/near-api-js' }), orderMemo('api', { repo: 'near/nearcore' }));
});

test('GitHub data uses a fixed HTTPS origin, no credential, and validates the response', async () => {
  let request;
  const result = await fetchPublicRepository('near/near-api-js', async (url, options) => { request = { url, options }; return ok(data()); });
  assert.equal(request.url, 'https://api.github.com/repos/near/near-api-js');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.options.headers.cookie, undefined);
  assert.equal(result.type, 'api');
  assert.equal(result.operation, 'github-repository');
  assert.equal(result.repository, 'near/near-api-js');
  assert.equal(result.repository_id, 12345);
  assert.equal(result.stars, 123);
  assert.equal(result.license, 'MIT');
  assert.ok(Number.isFinite(Date.parse(result.retrieved_at)));
});

test('GitHub redirects, transport errors, spoofed/private data and large responses fail closed', async () => {
  const cases = [
    [async () => { throw new Error('hostile endpoint and secret'); }, /request failed or timed out/],
    [async () => new Response('', { status: 301 }), /HTTP 301/],
    [async () => new Response('unavailable secret', { status: 503 }), /HTTP 503/],
    [async () => new Response('not JSON'), /invalid JSON/],
    [async () => new Response('x'.repeat(65_537)), /too large/],
    [async () => ok({ ...data(), private: true }), /unexpected public/],
    [async () => ok({ ...data(), full_name: 'attacker/repo' }), /unexpected public/],
    [async () => ok({ ...data(), id: 0 }), /unexpected public/],
    [async () => ok({ ...data(), stargazers_count: -1 }), /unexpected public/],
    [async () => ok({ ...data(), forks_count: 1.2 }), /unexpected public/],
    [async () => ok({ ...data(), description: 'x'.repeat(2049) }), /unexpected public/],
  ];
  for (const [fetchImpl, message] of cases) {
    await assert.rejects(fetchPublicRepository('near/near-api-js', fetchImpl), error => message.test(error.message) && !error.message.includes('secret'));
  }
});

test('payment-bound public data is retryable after a read outage and replay uses the saved result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-public-data-test-'));
  const contractId = 'bouncer.testnet';
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(name => [name, {
    policy_id: name, token: `${name}-token.testnet`, payee: `${name}-vendor.testnet`, amount: '123',
  }]));
  const input = { repo: 'near/near-api-js' }, txHash = mockHash('tx-api');
  const args = { policy_id: 'api', expected_token: products.api.token, payee: products.api.payee, amount: '123', memo: orderMemo('api', input) };
  let rpcCalls = 0, fetchCalls = 0;
  const rpcProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash, id, wait) {
    rpcCalls++; assert.equal(id, contractId); assert.equal(wait, 'FINAL');
    return mockGuardedPayment({ hash, owner: contractId, contract: contractId, args });
  } };
  const options = { rpcProvider, contractId, products, dataDir: dir, dataFetch: async () => ++fetchCalls === 1 ? new Response('unavailable', { status: 503 }) : ok(data()) };
  try {
    const provider = createResourceProvider(options);
    const order = { tx_hash: txHash, resource: 'api', input };
    await assert.rejects(provider.redeem(order), /HTTP 503/);
    assert.equal(fs.existsSync(path.join(dir, 'redemptions.json')), false, 'read-only failure can be safely retried');
    const result = await provider.redeem(order);
    assert.equal(result.repository, 'near/near-api-js');
    assert.equal(rpcCalls, 2);
    assert.equal(fetchCalls, 2);
    await provider.close();
    const restarted = createResourceProvider(options);
    assert.deepEqual(await restarted.redeem(order), result);
    assert.equal(fetchCalls, 2, 'completed data is replayed, not fetched or paid again');
    await assert.rejects(restarted.redeem({ ...order, input: { repo: 'near/nearcore' } }), /different order/);
    await restarted.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
