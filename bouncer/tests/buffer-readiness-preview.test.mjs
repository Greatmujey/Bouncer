import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBufferReadinessPreview } from '../web-src/buffer-readiness-preview.mjs';
const relay = 'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
const ids = ['a'.repeat(32), 'b'.repeat(32)], task = 'c'.repeat(32);
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('browser coordinates fixed read-only jobs without wallet or transaction calls', async () => {
  const pending = new Set(ids), finished = new Set(), calls = [], progress = [];
  const fake = async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    if (url === '/api/read-only/config') return json({ relay_url: relay });
    if (url === '/api/read-only/review') return json({ task_id: task });
    if (url === '/api/read-only/pending') return json({ jobs: [...pending] });
    if (url.startsWith('/api/read-only/jobs/')) {
      const id = url.split('/').pop(); pending.delete(id); return json({ job_id: id, signed: 'public-read-only-job' });
    }
    if (url === relay) { assert.equal(options.credentials, 'omit'); return json({ version: 1, job_id: JSON.parse(options.body).job_id }); }
    if (url === '/api/read-only/results') { finished.add(JSON.parse(options.body).job_id); return json({ accepted: true }); }
    if (url === `/api/read-only/review/${task}`) return finished.size === ids.length
      ? json({ state: 'complete', snapshot: { signed: false, sent: false }, review: { signing_or_broadcast_authorized: false } })
      : json({ state: 'checking' });
    throw Error(`unexpected URL ${url}`);
  };
  const result = await fetchBufferReadinessPreview({ fetch: fake, onProgress: p => progress.push(p) });
  assert.equal(result.state, 'complete'); assert.equal(result.snapshot.sent, false);
  assert.equal(finished.size, 2); assert.ok(progress.length > 0);
  assert.ok(calls.every(([url]) => url.startsWith('/api/read-only/') || url === relay));
});

test('browser refuses an unpinned relay URL before sending any job', async () => {
  const calls = [];
  await assert.rejects(fetchBufferReadinessPreview({ fetch: async url => { calls.push(url); return json({ relay_url: 'https://attacker.test/api/read' }); } }), /READ_ONLY_UNAVAILABLE/);
  assert.deepEqual(calls, ['/api/read-only/config']);
});

test('browser stops if the relay returns an envelope for another job', async () => {
  const fake = async url => {
    if (url === '/api/read-only/config') return json({ relay_url: relay });
    if (url === '/api/read-only/review') return json({ task_id: task });
    if (url === '/api/read-only/pending') return json({ jobs: [ids[0]] });
    if (url.startsWith('/api/read-only/jobs/')) return json({ job_id: ids[0] });
    if (url === relay) return json({ version: 1, job_id: ids[1] });
    if (url.startsWith('/api/read-only/review/')) return json({ state: 'checking' });
    throw Error('unexpected request');
  };
  await assert.rejects(fetchBufferReadinessPreview({ fetch: fake }), /READ_ONLY_UNAVAILABLE/);
});

test('setup request pumps the same pinned read-only relay while the backend is waiting', async () => {
  const { withReadOnlyRelay } = await import('../web-src/buffer-readiness-preview.mjs');
  const pending = new Set(ids), completed = new Set(); let finish;
  const operation = new Promise(resolve => { finish = resolve; });
  const fake = async (url, options={}) => {
    if (url === '/api/read-only/config') return json({relay_url:relay});
    if (url === '/api/read-only/pending') return json({jobs:[...pending]});
    if (url.startsWith('/api/read-only/jobs/')) { const id=url.split('/').pop(); pending.delete(id); return json({job_id:id}); }
    if (url === relay) { assert.equal(options.credentials,'omit'); return json({version:1,job_id:JSON.parse(options.body).job_id}); }
    if (url === '/api/read-only/results') {
      completed.add(JSON.parse(options.body).job_id); if (completed.size === 2) finish({status:'synthetic completed'});
      return json({accepted:true});
    }
    throw Error('unexpected request');
  };
  assert.deepEqual(await withReadOnlyRelay({fetch:fake,work:()=>operation}),{status:'synthetic completed'});
  assert.equal(completed.size,2);
});

test('invalid relay or malformed pending work never causes a setup retry', async () => {
  const { withReadOnlyRelay } = await import('../web-src/buffer-readiness-preview.mjs');
  let started=0;
  await assert.rejects(withReadOnlyRelay({fetch:async()=>json({relay_url:'https://attacker.test'}),work:()=>{started++;}}),/READ_ONLY_UNAVAILABLE/);
  assert.equal(started,0);
  const fake = async url => url === '/api/read-only/config' ? json({relay_url:relay}) : json({jobs:['not-a-job']});
  await assert.rejects(withReadOnlyRelay({fetch:fake,work:()=>{started++; return new Promise(()=>{});}}),/SETUP_RESULT_UNKNOWN/);
  assert.equal(started,1);
  const disconnected = async url => { if (url === '/api/read-only/config') return json({relay_url:relay}); throw Error('network lost'); };
  await assert.rejects(withReadOnlyRelay({fetch:disconnected,work:()=>{started++; return new Promise(()=>{});}}),/SETUP_RESULT_UNKNOWN/);
  assert.equal(started,2);
});
