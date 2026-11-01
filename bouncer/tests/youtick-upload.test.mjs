import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { requestYoutickUploadIntent, heartbeatYoutickUpload, uploadYoutickSource } from '../agent/youtick-upload.mjs';
import { openVerifiedYoutickSource, inspectYoutickSource } from '../agent/youtick-session.mjs';
import { fixture, open, settledVideo, now } from './helpers/youtick-fixture.mjs';

const URL = 'https://origin.livepeer.com/tus/one?token=SECRET-UPLOAD-CAPABILITY';
const LEASE = '12345678-abcd-4123-8123-123456789abc';
const CHUNK = 32 * 1024 * 1024, HEARTBEAT = 300_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const canon = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])));

/** Simulates a provider at the hardcoded hosts; no external request is made.
 * The synthetic payment/receipts are not an on-chain or independent proof. */
function fakeProvider(context, opts = {}) {
  let received = Buffer.alloc(0), intentExists = false, failPatch = opts.failPatch ?? null, headOverride = null;
  const calls = [], signatures = [], clock = opts.clock ?? (() => now);
  const sourceSize = Number(context.job.expected_source_bytes);
  function verifySigned(request, route, version) {
    const parsed = JSON.parse(request.body), { body, envelope } = parsed;
    assert.equal(request.redirect, 'manual'); assert.equal(request.cache, 'no-store');
    assert.equal(request.headers.Origin, 'https://public-testnet.youtick.net');
    assert.equal(envelope.route, route); assert.equal(envelope.version, version);
    assert.equal(envelope.body_sha256, digest(canon(body)));
    assert.equal(envelope.origin, request.headers.Origin); assert.equal(envelope.account_id, context.goal.contract_id);
    assert.equal(envelope.resource, `job:${context.job.job_id}:1`);
    const pub = nearApi.utils.PublicKey.fromString(envelope.session_public_key), sig = request.headers['X-Youtick-Signature'];
    assert.ok(pub.verify(Buffer.from(Object.values(envelope).join('\n')), Buffer.from(sig, 'base64')));
    signatures.push(sig);
    return { body, envelope };
  }
  return {
    calls, signatures, get received() { return received; },
    overrideHead(offset) { headOverride = offset; },
    async fetch(url, request) {
      calls.push({ url, method: request.method });
      assert.equal(request.redirect, 'manual'); assert.ok(request.signal instanceof AbortSignal);
      if (url === 'https://bridge-public-testnet.youtick.net/v1/upload-intents') {
        const { body, envelope } = verifySigned(request, '/v1/upload-intents', '3');
        assert.equal(context.journal.get('session').control.last_nonce, envelope.device_nonce); // durable before POST
        if (body.recovery === 'reconcile') {
          return intentExists ? json({ job_id: body.job_id, generation: 1, state: opts.reconcileState ?? 'UPLOAD_READY' }) : json({ error: 'not_ready' }, 409);
        }
        if (body.recovery === 'resume' && !intentExists) return json({ error: 'not_ready' }, 409);
        const created = !intentExists; intentExists = true;
        const value = { schema: 'youtick.livepeer-upload-intent.v2', job_id: body.job_id, generation: 1,
          expected_source_bytes: body.expected_source_bytes, source_type: body.source_type, chunk_bytes: CHUNK,
          tus_endpoint: URL, lease_id: LEASE, lease_expires_at_ms: String(clock() + 1_800_000), heartbeat_interval_ms: HEARTBEAT, created };
        return opts.intentResponse ? opts.intentResponse(value, body) : json(value, created ? 201 : 200);
      }
      if (url === 'https://bridge-public-testnet.youtick.net/v1/upload-heartbeats') {
        const { body, envelope } = verifySigned(request, '/v1/upload-heartbeats', '2');
        assert.equal(context.journal.get('session').heartbeat.nonce, envelope.device_nonce);
        assert.equal(body.lease_id, LEASE);
        return json({ schema: 'youtick.livepeer-upload-lease.v1', job_id: body.job_id, generation: 1,
          lease_id: body.lease_id, expires_at_ms: String(clock() + 1_800_000), heartbeat_interval_ms: HEARTBEAT });
      }
      assert.equal(url, URL);
      assert.equal(request.headers['Tus-Resumable'], '1.0.0');
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Tus-Resumable': '1.0.0',
        'Upload-Length': String(sourceSize), 'Upload-Offset': String(headOverride ?? received.length) } });
      assert.equal(request.method, 'PATCH');
      const start = Number(request.headers['Upload-Offset']); assert.equal(start, received.length);
      assert.equal(request.headers['Content-Type'], 'application/offset+octet-stream');
      assert.equal(request.headers['Content-Length'], String(request.body.length));
      const pending = context.journal.get('session').upload.pending_patch;
      assert.equal(pending.start, String(start)); assert.equal(pending.end, String(start + request.body.length));
      assert.equal(pending.sha256, digest(request.body)); // durable before PATCH
      if (failPatch !== null) {
        const count = failPatch === 'all' ? request.body.length : failPatch === 'partial' ? Math.floor(request.body.length / 2) : 0;
        received = Buffer.concat([received, request.body.subarray(0, count)]); failPatch = null;
        throw new Error(`transport leaked ${URL}`);
      }
      received = Buffer.concat([received, request.body]);
      opts.afterPatch?.(received.length);
      return new Response(null, { status: 204, headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(received.length) } });
    },
  };
}
function setup(f) {
  const journal = open(f), ctx = settledVideo(journal, f), clock = () => now;
  const provider = fakeProvider(ctx, { clock });
  return { ...ctx, clock, fetchImpl: provider.fetch.bind(provider), provider };
}

test('pins and signs the initial control POST, journals the capability encrypted, and refuses another initial request', async () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f);
    const result = await requestYoutickUploadIntent(ctx);
    assert.equal(result.status, 'UPLOAD_READY'); assert.equal(result.recovered, false);
    assert.equal(ctx.provider.calls.length, 1); assert.equal(ctx.journal.get('session').upload.tus_endpoint, URL);
    assert.ok(!JSON.stringify(result).includes(URL)); assert.ok(!JSON.stringify(result).includes(ctx.provider.signatures[0]));
    const disk = fs.readFileSync(f.file, 'utf8');
    for (const secret of [URL, ctx.provider.signatures[0], ctx.journal.get('session').session.private_key]) assert.ok(!disk.includes(secret));
    await assert.rejects(requestYoutickUploadIntent(ctx), /already pending/); assert.equal(ctx.provider.calls.length, 1);
    const status = await requestYoutickUploadIntent({ ...ctx, recovery: 'reconcile' });
    assert.deepEqual({ status: status.status, state: status.state }, { status: 'PROVIDER_STATUS', state: 'UPLOAD_READY' });
    const resume = await requestYoutickUploadIntent({ ...ctx, recovery: 'resume' });
    assert.equal(resume.recovered, true); assert.equal(ctx.journal.get('session').upload.acknowledged_offset, '0');
    assert.equal(new Set(ctx.provider.signatures).size, 3);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('invalid payment, job or changed source blocks all provider traffic', async () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f);
    const job = { ...ctx.job, creator_id: 'attacker.testnet' };
    await assert.rejects(requestYoutickUploadIntent({ ...ctx, job }), /does not match/);
    const paymentResult = structuredClone(ctx.paymentResult); paymentResult.transaction.signer_id = 'attacker.testnet';
    await assert.rejects(requestYoutickUploadIntent({ ...ctx, paymentResult }), /mismatch/);
    fs.writeFileSync(f.source, 'changed');
    await assert.rejects(requestYoutickUploadIntent(ctx), /differs/);
    assert.equal(ctx.provider.calls.length, 0); assert.equal(ctx.journal.get('session').control, undefined);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('rejects off-origin or malformed capabilities, redirects and oversized responses without exposing credentials', async () => {
  const variants = [
    value => json({ ...value, tus_endpoint: 'https://attacker.example/upload?token=SECRET' }),
    value => json({ ...value, tus_endpoint: 'https://me:password@origin.livepeer.com/tus/1' }),
    value => json({ ...value, tus_endpoint: `${URL}#fragment` }),
    value => json({ ...value, chunk_bytes: 1 }),
    value => json({ ...value, created: false }),
    () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } }),
    () => new Response(JSON.stringify({ data: 'x'.repeat(20_000) }), { status: 200 }),
  ];
  for (const intentResponse of variants) {
    const f = fixture(); let ctx;
    try {
      const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
      const provider = fakeProvider(ctx, { intentResponse }); ctx.fetchImpl = provider.fetch.bind(provider);
      await assert.rejects(requestYoutickUploadIntent(ctx), error => !error.message.includes('SECRET') && !error.message.includes('password'));
      assert.equal(provider.calls.length, 1); assert.equal(journal.get('session').upload, undefined);
      assert.equal(journal.get('session').control.state, 'pending');
      await assert.rejects(requestYoutickUploadIntent(ctx), /already pending/);
    } finally { ctx?.journal.close(); f.cleanup(); }
  }
});

test('sequential TUS HEAD and PATCH upload the exact original bytes without claiming publication', async () => {
  const f = fixture(); let ctx;
  try {
    fs.writeFileSync(f.source, Buffer.alloc(CHUNK + 17, 7)); // exercises two chunks
    ctx = setup(f); await requestYoutickUploadIntent(ctx);
    const result = await uploadYoutickSource(ctx);
    assert.equal(result.status, 'SOURCE_UPLOADED'); assert.equal(result.accepted_bytes, String(CHUNK + 17));
    assert.match(result.scope, /not proof of processing, publication or retrieval/);
    assert.deepEqual(ctx.provider.received, fs.readFileSync(f.source));
    assert.deepEqual(ctx.provider.calls.map(c => c.method), ['POST', 'HEAD', 'PATCH', 'PATCH']);
    assert.equal(ctx.journal.get('session').upload.state, 'source_uploaded');
    assert.equal(ctx.journal.get('session').upload.pending_patch, null);
    assert.ok(!JSON.stringify(result).includes(URL));
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('ambiguous chunk after zero, partial or full acceptance resumes only from verified HEAD after restart', async () => {
  for (const failPatch of ['none', 'partial', 'all']) {
    const f = fixture(); let ctx, reopened;
    try {
      const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
      const provider = fakeProvider(ctx, { failPatch }); ctx.fetchImpl = provider.fetch.bind(provider);
      await requestYoutickUploadIntent(ctx);
      await assert.rejects(uploadYoutickSource(ctx), error => /reconcile with HEAD/.test(error.message) && !error.message.includes('SECRET'));
      const pending = structuredClone(journal.get('session').upload.pending_patch);
      assert.equal(pending.start, '0'); assert.equal(pending.end, ctx.job.expected_source_bytes);
      assert.equal(provider.calls.filter(c => c.method === 'PATCH').length, 1);
      journal.close(); reopened = open(f, true); ctx.journal = reopened;
      const result = await uploadYoutickSource(ctx);
      assert.equal(result.status, 'SOURCE_UPLOADED'); assert.deepEqual(provider.received, fs.readFileSync(f.source));
      assert.equal(provider.calls.filter(c => c.method === 'POST').length, 1); // no new intent/payment
      assert.equal(provider.calls.filter(c => c.method === 'PATCH').length, failPatch === 'all' ? 1 : 2);
      assert.equal(provider.calls.filter(c => c.method === 'HEAD').length, 2);
      assert.equal(reopened.get('session').upload.pending_patch, null);
    } finally { reopened?.close(); ctx?.journal.close(); f.cleanup(); }
  }
});

test('a TUS offset outside the original pending chunk stops without sending another chunk', async () => {
  const f = fixture(); let ctx;
  try {
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
    const provider = fakeProvider(ctx, { failPatch: 'partial' }); ctx.fetchImpl = provider.fetch.bind(provider);
    await requestYoutickUploadIntent(ctx); await assert.rejects(uploadYoutickSource(ctx), /reconcile with HEAD/);
    provider.overrideHead(Number(ctx.job.expected_source_bytes) + 1);
    await assert.rejects(uploadYoutickSource(ctx), /invalid TUS offset/);
    assert.equal(provider.calls.filter(c => c.method === 'PATCH').length, 1);
    assert.ok(journal.get('session').upload.pending_patch);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('heartbeat uses a fresh signed nonce, the original lease and encrypted state', async () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f); await requestYoutickUploadIntent(ctx);
    const result = await heartbeatYoutickUpload(ctx);
    assert.equal(result.status, 'LEASE_RENEWED'); assert.equal(result.expires_at_ms, String(now + 1_800_000));
    assert.equal(ctx.journal.get('session').heartbeat.state, 'acknowledged');
    assert.equal(ctx.provider.calls.filter(c => c.method === 'POST').length, 2);
    assert.ok(!JSON.stringify(result).includes(LEASE));
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(ctx.provider.signatures.at(-1)));
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('the verified descriptor detects changes and unsafe read ranges', () => {
  const f = fixture(); let source;
  try {
    const evidence = inspectYoutickSource(f.source); source = openVerifiedYoutickSource(evidence, f.source);
    assert.equal(source.read(0, 3).toString('hex'), '050505');
    assert.throws(() => source.read(-1, 3), /invalid source chunk/);
    fs.writeFileSync(f.source, Buffer.alloc(Number(evidence.size), 9));
    assert.throws(() => source.read(0, 3), /source changed/);
    source.close(); assert.throws(() => source.read(0, 3), /invalid source chunk/);
  } finally { source?.close(); f.cleanup(); }
});

test('a lost initial response cannot create again; explicit resume recovers the original capability', async () => {
  const f = fixture(); let ctx, lost = true;
  try {
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
    const provider = fakeProvider(ctx, { intentResponse(value) {
      if (lost) { lost = false; throw new Error(`broken connection ${URL}`); }
      return json(value);
    } }); ctx.fetchImpl = provider.fetch.bind(provider);
    await assert.rejects(requestYoutickUploadIntent(ctx), error => /unresolved/.test(error.message) && !error.message.includes('SECRET'));
    assert.equal(journal.get('session').upload, undefined); assert.equal(journal.get('session').control.state, 'pending');
    await assert.rejects(requestYoutickUploadIntent(ctx), /already pending/);
    const result = await requestYoutickUploadIntent({ ...ctx, recovery: 'resume' });
    assert.equal(result.recovered, true); assert.equal(journal.get('session').upload.tus_endpoint, URL);
    assert.equal(provider.calls.length, 2); // one original, one explicit resume; no second creation
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('provider processing state persists and blocks resume, heartbeat and extra chunks', async () => {
  const f = fixture(); let ctx;
  try {
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
    const provider = fakeProvider(ctx, { reconcileState: 'PROCESSING' }); ctx.fetchImpl = provider.fetch.bind(provider);
    await requestYoutickUploadIntent(ctx);
    assert.equal((await requestYoutickUploadIntent({ ...ctx, recovery: 'reconcile' })).state, 'PROCESSING');
    const before = provider.calls.length;
    await assert.rejects(requestYoutickUploadIntent({ ...ctx, recovery: 'resume' }), /do not send/);
    await assert.rejects(heartbeatYoutickUpload(ctx), /do not send/);
    await assert.rejects(uploadYoutickSource(ctx), /do not send/);
    assert.equal(provider.calls.length, before);
    // Later status reads remain possible, but cannot clear the state on a failed request.
    assert.equal(journal.get('session').control.last_observed_state, 'PROCESSING');
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('concurrent upload operations on one original journal fail closed', async () => {
  const f = fixture(); let ctx, release;
  try {
    ctx = setup(f); const actualFetch = ctx.fetchImpl;
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    ctx.fetchImpl = async (...args) => { entered(); await gate; return actualFetch(...args); };
    const first = requestYoutickUploadIntent(ctx); await started;
    await assert.rejects(requestYoutickUploadIntent({ ...ctx, recovery: 'resume' }), /already in progress/);
    await assert.rejects(uploadYoutickSource(ctx), /already in progress/);
    release(); assert.equal((await first).status, 'UPLOAD_READY');
    assert.equal(ctx.provider.calls.length, 1);
  } finally { release?.(); ctx?.journal.close(); f.cleanup(); }
});

test('long-running sequential upload renews its lease before the next chunk', async () => {
  const f = fixture(); let ctx, time = now;
  try {
    fs.writeFileSync(f.source, Buffer.alloc(CHUNK + 3, 6));
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => time };
    const provider = fakeProvider(ctx, { clock: ctx.clock, afterPatch(bytes) { if (bytes === CHUNK) time += HEARTBEAT + 1; } });
    ctx.fetchImpl = provider.fetch.bind(provider); await requestYoutickUploadIntent(ctx);
    assert.equal((await uploadYoutickSource(ctx)).status, 'SOURCE_UPLOADED');
    assert.deepEqual(provider.calls.map(c => c.method), ['POST', 'HEAD', 'PATCH', 'POST', 'PATCH']);
    assert.match(provider.calls[3].url, /upload-heartbeats$/);
    assert.deepEqual(provider.received, fs.readFileSync(f.source));
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('changed source mid-upload stops before another PATCH', async () => {
  const f = fixture(); let ctx;
  try {
    fs.writeFileSync(f.source, Buffer.alloc(CHUNK + 3, 6));
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
    const provider = fakeProvider(ctx, { afterPatch(bytes) {
      if (bytes === CHUNK) { const fd = fs.openSync(f.source, 'r+'); try { fs.writeSync(fd, Buffer.from([8]), 0, 1, CHUNK); } finally { fs.closeSync(fd); } }
    } }); ctx.fetchImpl = provider.fetch.bind(provider);
    await requestYoutickUploadIntent(ctx);
    await assert.rejects(uploadYoutickSource(ctx), /source changed/);
    assert.equal(provider.calls.filter(c => c.method === 'PATCH').length, 1);
    assert.equal(journal.get('session').upload.acknowledged_offset, String(CHUNK));
    assert.equal(journal.get('session').upload.pending_patch, null);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('a loopback HTTP/TUS server exercises real request framing and partial-response recovery', async () => {
  const f = fixture(); let ctx, server, reopened, received = Buffer.alloc(0), dropped = false;
  try {
    const journal = open(f); ctx = { ...settledVideo(journal, f), clock: () => now };
    server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/v1/upload-intents' && req.method === 'POST') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const { body, envelope } = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(envelope.body_sha256, digest(canon(body)));
          assert.ok(nearApi.utils.PublicKey.fromString(envelope.session_public_key).verify(
            Buffer.from(Object.values(envelope).join('\n')), Buffer.from(req.headers['x-youtick-signature'], 'base64')));
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ schema: 'youtick.livepeer-upload-intent.v2', job_id: body.job_id, generation: 1,
            expected_source_bytes: body.expected_source_bytes, source_type: body.source_type, chunk_bytes: CHUNK,
            tus_endpoint: URL, lease_id: LEASE, lease_expires_at_ms: String(now + 1_800_000), heartbeat_interval_ms: HEARTBEAT, created: true }));
          return;
        }
        if (req.url === '/tus/one?token=SECRET-UPLOAD-CAPABILITY' && req.method === 'HEAD') {
          res.writeHead(200, { 'Tus-Resumable': '1.0.0', 'Upload-Length': ctx.job.expected_source_bytes,
            'Upload-Offset': String(received.length) }); res.end(); return;
        }
        if (req.url === '/tus/one?token=SECRET-UPLOAD-CAPABILITY' && req.method === 'PATCH') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const bytes = Buffer.concat(chunks); assert.equal(req.headers['upload-offset'], String(received.length));
          const pending = ctx.journal.get('session').upload.pending_patch; assert.equal(pending.sha256, digest(bytes));
          if (!dropped) { dropped = true; received = Buffer.concat([received, bytes.subarray(0, Math.floor(bytes.length / 2))]); req.socket.destroy(); return; }
          received = Buffer.concat([received, bytes]);
          res.writeHead(204, { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(received.length) }); res.end(); return;
        }
        res.writeHead(404); res.end();
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const local = `http://127.0.0.1:${server.address().port}`;
    // Test-only adapter maps the fixed remote origins to an actual loopback server.
    // Production uses fetch directly and never accepts alternate provider hosts.
    ctx.fetchImpl = (url, options) => {
      const endpoint = new globalThis.URL(url);
      assert.ok(['https://bridge-public-testnet.youtick.net', 'https://origin.livepeer.com'].includes(endpoint.origin));
      return fetch(`${local}${endpoint.pathname}${endpoint.search}`, options);
    };
    await requestYoutickUploadIntent(ctx);
    await assert.rejects(uploadYoutickSource(ctx), /reconcile with HEAD/);
    assert.ok(received.length > 0 && received.length < Number(ctx.job.expected_source_bytes));
    journal.close(); reopened = open(f, true); ctx.journal = reopened;
    assert.equal((await uploadYoutickSource(ctx)).status, 'SOURCE_UPLOADED');
    assert.deepEqual(received, fs.readFileSync(f.source));
  } finally {
    reopened?.close(); ctx?.journal.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    f.cleanup();
  }
});
