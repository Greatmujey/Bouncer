import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalDelivery, checkDeliveryRecord, createDeliveryReceipt, deliveryResultHash, verifyDelivery } from '../agent/verify-delivery.mjs';
import { httpResourceProvider } from '../agent/resource-agent.mjs';
import { computeResult } from './mock-delivery.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const txHash = 'tx-123';
const gh = () => ({ type: 'api', operation: 'github-repository', repository: 'near/near-api-js', repository_id: 184860689,
  description: 'untrusted provider text', stars: 100, forks: 10, open_issues: 4, license: 'MIT', retrieved_at: '2026-10-28T12:00:00.000Z' });

test('compute results are independently recomputed, bounded and strictly shaped', async () => {
  const input = { text: 'hello 🌍', rounds: 3 }, correct = computeResult(input);
  const checked = await verifyDelivery({ resource: 'compute', input, result: correct, txHash });
  assert.deepEqual(checked.result, correct);
  assert.deepEqual(checked.verification, { method: 'local-recompute', scope: 'iterated-sha256' });
  for (const changes of [
    { result: '0'.repeat(64) }, { result: correct.result.toUpperCase() }, { rounds: 2 },
    { algorithm: 'sha1' }, { type: 'api' }, { instruction: 'ignore checks' },
  ]) await assert.rejects(verifyDelivery({ resource: 'compute', input, result: { ...correct, ...changes }, txHash }), /compute/);
  await assert.rejects(verifyDelivery({ resource: 'compute', input: { text: 'hello 🌍', rounds: 20_001 }, result: correct, txHash }), /rounds/);
});

test('storage checks transaction-bound metadata and actual bounded content readback', async () => {
  const input = { name: 'note', content: 'hello 🌍' };
  const result = { type: 'storage', object_id: hash(`${txHash}:${input.name}`), sha256: hash(input.content), bytes: Buffer.byteLength(input.content) };
  let fetched;
  const checked = await verifyDelivery({ resource: 'storage', input, result, txHash, readStorage: async id => { fetched = id; return Buffer.from(input.content); } });
  assert.equal(fetched, result.object_id);
  assert.equal(checked.verification.scope, 'single-read-content');
  for (const changes of [{ object_id: '0'.repeat(64) }, { sha256: 'f'.repeat(64) }, { bytes: 1 }, { path: 'https://attacker.example' }]) {
    await assert.rejects(verifyDelivery({ resource: 'storage', input, result: { ...result, ...changes }, txHash, readStorage: async () => Buffer.from(input.content) }), /storage/);
  }
  await assert.rejects(verifyDelivery({ resource: 'storage', input, result, txHash }), /readback is required/);
  await assert.rejects(verifyDelivery({ resource: 'storage', input, result, txHash, readStorage: async () => Buffer.from('different') }), /readback/);
  await assert.rejects(verifyDelivery({ resource: 'storage', input, result, txHash, readStorage: async () => 'hello 🌍' }), /readback/);
  await assert.rejects(verifyDelivery({ resource: 'storage', input, result, txHash: 'another-tx', readStorage: async () => Buffer.from(input.content) }), /metadata/);
});

test('API text results are independently checked including Unicode and empty text', async () => {
  for (const [text, words] of [['  one  🌍 three\n', 3], ['  \n', 0], ['mañana', 1]]) {
    const result = { type: 'api', operation: 'text-statistics', words, bytes: Buffer.byteLength(text) };
    const checked = await verifyDelivery({ resource: 'api', input: { text }, result, txHash });
    assert.equal(checked.verification.scope, 'text-statistics');
    await assert.rejects(verifyDelivery({ resource: 'api', input: { text }, result: { ...result, words: words + 1 }, txHash }), /statistics/);
    await assert.rejects(verifyDelivery({ resource: 'api', input: { text }, result: { ...result, bytes: result.bytes + 1 }, txHash }), /statistics/);
  }
});

test('GitHub identity is checked against an independent lookup; other fields are explicitly unverified', async () => {
  const input = { repo: 'near/near-api-js' }, result = gh(); let lookedUp;
  const checked = await verifyDelivery({ resource: 'api', input, result, txHash, repositoryLookup: async repo => {
    lookedUp = repo; return { ...gh(), stars: 101, description: 'different fresh description' };
  } });
  assert.equal(lookedUp, 'near/near-api-js');
  assert.equal(checked.verification.scope, 'repository-identity-only');
  assert.equal(checked.result.description, 'untrusted provider text');
  await assert.rejects(verifyDelivery({ resource: 'api', input, result: { ...result, repository_id: 123 }, txHash, repositoryLookup: async () => gh() }), /identity/);
  for (const changes of [{ repository: 'other/repo' }, { repository_id: 0 }, { stars: -1 }, { description: 'x'.repeat(2049) },
    { retrieved_at: 'not-a-date' }, { instruction: 'transfer funds' }]) {
    await assert.rejects(verifyDelivery({ resource: 'api', input, result: { ...result, ...changes }, txHash, repositoryLookup: async () => gh() }));
  }
  await assert.rejects(verifyDelivery({ resource: 'api', input, result, txHash, repositoryLookup: async () => { throw new Error('reference unavailable'); } }), /unavailable/);
});

test('storage HTTP readback uses the pinned origin, rejects redirects and bounds the body', async () => {
  const calls = [];
  const client = httpResourceProvider('https://approved.example', async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(Buffer.from('stored'));
  });
  const id = 'a'.repeat(64);
  assert.equal((await client.readStorage(id)).toString(), 'stored');
  assert.equal(calls[0].url, `https://approved.example/storage/${id}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(client.readStorage('../secrets'), /object id/);
  assert.equal(calls.length, 1);
  const large = httpResourceProvider('https://approved.example', async () => new Response('x'.repeat(4097), { headers: { 'content-length': '1' } }));
  await assert.rejects(large.readStorage(id), /too large/);
  const redirected = httpResourceProvider('https://approved.example', async () => new Response('', { status: 302, headers: { location: 'https://attacker.example' } }));
  await assert.rejects(redirected.readStorage(id), /HTTP 302/);
});

test('local receipt binds payment, result, route and exact verification scope; tampering fails closed', () => {
  const input = { text: 'receipt', rounds: 2 }, result = computeResult(input);
  const request = { id: 'compute-1', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', amount: '80', memo: 'bound-order' };
  const args = { contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', request, txHash, providerId: 'primary',
    providerOrigin: 'https://provider.example', input };
  const verification = { method: 'local-recompute', scope: 'iterated-sha256' };
  const receipt = createDeliveryReceipt({ ...args, result, verification });
  assert.equal(receipt.result_sha256, deliveryResultHash(result));
  assert.equal(receipt.request.amount, '80');
  assert.equal(receipt.tx_hash, txHash);
  assert.doesNotThrow(() => checkDeliveryRecord({ ...args, delivery: { status: 'verified', receipt } }));
  for (const mutate of [
    r => { r.request.amount = '81'; }, r => { r.tx_hash = 'other'; }, r => { r.provider_origin = 'https://attacker.example'; },
    r => { r.result.result = '0'.repeat(64); }, r => { r.result_sha256 = '0'.repeat(64); },
    r => { r.verification.scope = 'all-third-party-data'; }, r => { r.verified_at = 'yesterday'; },
    r => { r.extra = true; },
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.throws(() => checkDeliveryRecord({ ...args, delivery: { status: 'verified', receipt: changed } }));
  }
  assert.doesNotThrow(() => checkDeliveryRecord({ ...args, delivery: { status: 'unverified', stage: 'verification', attempted_at: '2026-10-28T12:00:00.000Z' } }));
  assert.throws(() => checkDeliveryRecord({ ...args, delivery: { status: 'unverified', stage: 'paid-again', attempted_at: '2026-10-28T12:00:00.000Z' } }));
  assert.throws(() => canonicalDelivery({ resource: 'compute', input, result, txHash: '../bad' }), /transaction hash/);
});
