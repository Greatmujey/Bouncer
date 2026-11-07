import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';

const site = 'https://site.example.test', id = 'a'.repeat(32), hash = 'b'.repeat(64);
const useServer = async fn => {
  const seen = [], bridge = { pending: () => [id], take: (job, token) => { seen.push(['take', job, token]); return token === 't'.repeat(100) ? { id: job } : null; },
    submit: (job, h, input, token) => { seen.push(['submit', job, h, input.toString(), token]); return token === 't'.repeat(100); },
    takeForBrowser: job => ({ job_id: job }), submitEncrypted: envelope => envelope.accept === true };
  const server = createReadOnlyPreviewService({ bridge, siteOrigin: site,
    inspectReadiness: async () => ({ public_balance: '40' }), makeReview: async () => ({ signed: false }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, seen); } finally { await new Promise(resolve => server.close(resolve)); }
};

test('preview exposes only fixed read-only work and an unsigned review', async () => useServer(async base => {
  const pending = await fetch(`${base}/api/read-only/pending`, { headers: { origin: site, 'x-bouncer-preview': 'read-only' } });
  assert.deepEqual(await pending.json(), { jobs: [id] });
  assert.equal((await fetch(`${base}/api/read-only/pending`, { headers: { origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/read-only/review`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/api/read-only/review`, { method: 'POST', headers: { origin: site, 'x-bouncer-preview': 'read-only' }, body: 'bad' })).status, 403);
  const start = await fetch(`${base}/api/read-only/review`, { method: 'POST', headers: { origin: site, 'x-bouncer-preview': 'read-only' } });
  assert.equal(start.status, 202);
  const task = (await start.json()).task_id; assert.match(task, /^[a-f0-9]{32}$/);
  const result = await (await fetch(`${base}/api/read-only/review/${task}`, { headers: { origin: site, 'x-bouncer-preview': 'read-only' } })).json();
  assert.deepEqual(result, { state: 'complete', snapshot: { public_balance: '40' }, review: { signed: false } });
  assert.equal((await fetch(`${base}/api/wallet/send`, { method: 'POST' })).status, 404);
}));

test('internal callbacks require the bridge to accept authorization', async () => useServer(async (base, seen) => {
  const headers = { authorization: `Bearer ${'t'.repeat(100)}` };
  assert.equal((await fetch(`${base}/internal/read-only-jobs/${id}`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/internal/read-only-jobs/${id}`, { headers })).json(), { id });
  assert.equal((await fetch(`${base}/internal/read-only-results/${id}/${hash}`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/internal/read-only-results/${id}/${hash}`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal(seen.at(-1)[3], '{}');
}));
