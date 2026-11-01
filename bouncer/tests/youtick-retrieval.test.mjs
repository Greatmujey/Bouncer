import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import nearApi from 'near-api-js';
import { runYoutickPlayGrant, inspectRecordedYoutickPlayback } from '../agent/youtick-grant-runner.mjs';
import { requestYoutickPlaybackToken, probeYoutickHls } from '../agent/youtick-retrieval.mjs';
import { open, vault, now } from './helpers/youtick-fixture.mjs';
import { setup, hash, blockHash } from './helpers/youtick-grant-fixture.mjs';

// All of the following HTTP and media evidence is synthetic. The provider and
// receipt fixtures never represent an independent paid publication.
const testTokenKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function fakeTokenResponse(s, options = {}) {
  const playbackId = options.playbackId ?? s.publication.playback_id;
  const issued = Math.floor(now / 1000), expiry = options.exp ?? issued + 180;
  const header = b64url({ alg: 'ES256', typ: 'JWT' });
  const claims = b64url({ action: 'pull', iss: 'https://youtick.net',
    pub: Buffer.from(testTokenKey.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'), sub: options.sub ?? playbackId,
    video: 'none', exp: expiry, iat: issued, ...options.claims });
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: testTokenKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { schema: 'youtick.livepeer-playback-token.v1', playback_id: playbackId,
    token: `${unsigned}.${signature}`, expires_at_ms: String(expiry * 1000),
    hls_url: `https://playback.livepeer.studio/asset/hls/${playbackId}/index.m3u8` };
}
function tokenOptions(s, extra = {}) {
  return { journal: s.journal, grantId: 'grant', provider: s.provider, sourceFile: s.f.source, clock: () => now, ...extra };
}
async function completedGrant(s) { await runYoutickPlayGrant({ ...s.opts, execute: true }); }
async function issuedToken(s, extra = {}) {
  const value = fakeTokenResponse(s);
  const result = await requestYoutickPlaybackToken(tokenOptions(s, { execute: true,
    fetchImpl: async () => new Response(JSON.stringify(value), { status: 200 }), ...extra }));
  return { value, result };
}

test('playback preflight reinspects the reconciled grant, paid job, entitlement and current publication at one FINAL block', async () => {
  const s = setup();
  try {
    await assert.rejects(inspectRecordedYoutickPlayback(tokenOptions(s)), /original owner grant journal entry/);
    await completedGrant(s);
    const views = await inspectRecordedYoutickPlayback(tokenOptions(s, { sourceFile: undefined }));
    assert.equal(views.grant_tx_hash, s.settings.grantResult.transaction.hash);
    assert.equal(views.payment_tx_hash, s.video.paymentResult.transaction.hash);
    assert.equal(views.final_block_hash, blockHash); assert.equal(views.playback_id, s.publication.playback_id);
    assert.equal(views.signed, undefined);
    const prepared = await inspectRecordedYoutickPlayback(tokenOptions(s, { includeTokenRequest: true }));
    const pk = nearApi.utils.PublicKey.fromString(prepared.session_pk);
    assert.ok(pk.verify(Buffer.from(Object.values(prepared.signed.envelope).join('\n')), Buffer.from(prepared.signed.signature, 'base64')));
    assert.equal(prepared.signed.envelope.route, '/v1/playback-tokens');
    assert.equal(s.settings.sent, 1);
  } finally { s.close(); }
});

test('token request is review-only by default and stores bearer material only encrypted before a source-free byte probe', async () => {
  const s = setup(); let reopened;
  try {
    await completedGrant(s);
    let posts = 0, capturedSignature;
    const readOnly = await requestYoutickPlaybackToken(tokenOptions(s, { sourceFile: undefined, fetchImpl: async () => { throw new Error('unexpected request'); } }));
    assert.equal(readOnly.status, 'READY_FOR_TOKEN_REQUEST'); assert.equal(readOnly.source_verification_required, true);
    assert.equal(readOnly.reviewed_signer_key_sha256, null); assert.equal(s.journal.get('session').playback_token, undefined);
    const value = fakeTokenResponse(s);
    const result = await requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async (url, options) => {
      posts++; assert.equal(url, 'https://bridge-public-testnet.youtick.net/v1/playback-tokens');
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
      assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Origin, 'https://public-testnet.youtick.net');
      capturedSignature = options.headers['X-Youtick-Signature'];
      const body = JSON.parse(options.body), pk = nearApi.utils.PublicKey.fromString(body.envelope.session_public_key);
      assert.equal(body.body.job_id, s.video.job.job_id); assert.equal(body.body.playback_id, s.publication.playback_id);
      assert.ok(pk.verify(Buffer.from(Object.values(body.envelope).join('\n')), Buffer.from(capturedSignature, 'base64')));
      assert.equal(s.journal.get('session').playback_token.state, 'pending');
      const ciphertext = fs.readFileSync(s.f.file, 'utf8');
      assert.equal(ciphertext.includes(capturedSignature), false); assert.equal(ciphertext.includes(body.envelope.device_nonce), false);
      return new Response(JSON.stringify(value), { status: 200 });
    } }));
    assert.equal(result.status, 'TOKEN_RECEIVED'); assert.equal(result.signer_key_pinned, false); assert.equal(posts, 1);
    assert.equal(JSON.stringify(result).includes(value.token), false);
    assert.equal(JSON.stringify(result).includes(capturedSignature), false);
    assert.equal(fs.readFileSync(s.f.file, 'utf8').includes(value.token), false);
    assert.equal(s.journal.get('session').playback_token.state, 'issued');
    const again = await requestYoutickPlaybackToken(tokenOptions(s, { execute: true, sourceFile: undefined,
      fetchImpl: async () => { posts++; throw new Error('must not retry'); } }));
    assert.equal(again.status, 'TOKEN_AVAILABLE'); assert.equal(posts, 1);

    s.journal.close(); fs.unlinkSync(s.f.source); reopened = open(s.f, true);
    const gets = [], segment = Buffer.alloc(564, 5);
    const fetchImpl = async (url, options) => {
      gets.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['Livepeer-Jwt'], value.token); assert.equal(options.headers.Origin, 'https://public-testnet.youtick.net');
      assert.equal(options.credentials, 'omit');
      if (url.endsWith('/index.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n');
      if (url.endsWith('/variant.m3u8')) return new Response('#EXTM3U\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n');
      if (url.endsWith('/segment.ts')) return new Response(segment);
      throw new Error('unexpected URL with secret ' + value.token);
    };
    const proof = await probeYoutickHls(tokenOptions(s, { journal: reopened, sourceFile: undefined, fetchImpl }));
    assert.equal(proof.status, 'HLS_BYTES_RECEIVED'); assert.equal(proof.evidence.segment_bytes, segment.length);
    assert.equal(proof.evidence.segment_sha256, crypto.createHash('sha256').update(segment).digest('hex'));
    assert.equal(gets.length, 3); assert.ok(gets.every(url => url.startsWith('https://playback.livepeer.studio/')));
    assert.equal(JSON.stringify(proof).includes(value.token), false);
    assert.match(proof.scope, /no proof of playable media/);
    assert.equal(reopened.get('session').playback_probe.segment_sha256, proof.evidence.segment_sha256);
    assert.equal(fs.readFileSync(s.f.file, 'utf8').includes(value.token), false);
  } finally { reopened?.close(); s.close(); }
});

test('an ambiguous token attempt stays pending across restart and never sends a replacement', async () => {
  const s = setup(); let reopened;
  try {
    await completedGrant(s); let posts = 0, leakedSignature;
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async (_url, options) => {
      posts++; leakedSignature = options.headers['X-Youtick-Signature'];
      throw new Error(`transport leaked ${leakedSignature}`);
    } })), error => /unresolved/.test(error.message) && !error.message.includes(leakedSignature));
    assert.equal(s.journal.get('session').playback_token.state, 'pending'); assert.equal(posts, 1);
    s.journal.close(); fs.unlinkSync(s.f.source); reopened = open(s.f, true);
    const result = await requestYoutickPlaybackToken(tokenOptions(s, { journal: reopened, sourceFile: undefined, execute: true,
      fetchImpl: async () => { posts++; throw new Error('unexpected'); } }));
    assert.equal(result.status, 'TOKEN_REQUEST_UNRESOLVED'); assert.equal(posts, 1);
    await assert.rejects(probeYoutickHls(tokenOptions(s, { journal: reopened, fetchImpl: async () => { throw new Error('unexpected'); } })), /unexpired/);
    assert.equal(fs.readFileSync(s.f.file, 'utf8').includes(leakedSignature), false);
  } finally { reopened?.close(); s.close(); }
});

test('malformed, mismatched or oversized token responses remain pending without a second POST', async t => {
  const scenarios = {
    'HTTP error body': (value) => new Response(`secret ${value.token}`, { status: 500 }),
    'redirect': () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }),
    'oversized body': () => new Response('x'.repeat(17_000)),
    'invalid JSON': value => new Response(`not-json ${value.token}`),
    'different playback': value => new Response(JSON.stringify({ ...value, playback_id: 'other-playback' })),
    'foreign HLS host': value => new Response(JSON.stringify({ ...value, hls_url: 'https://attacker.example/index.m3u8' })),
    'extra field': value => new Response(JSON.stringify({ ...value, unexpected: 'x' })),
    'expired token': value => new Response(JSON.stringify({ ...value, expires_at_ms: String(now - 1000) })),
    'wrong JWT resource': (_value, s) => new Response(JSON.stringify(fakeTokenResponse(s, { sub: 'other-playback' }))),
    'too-long JWT lifetime': (_value, s) => new Response(JSON.stringify(fakeTokenResponse(s, { exp: Math.floor(now / 1000) + 181 }))),
    'malformed signature': value => new Response(JSON.stringify({ ...value, token: value.token.replace(/\.[^.]+$/, '.AAAA') })),
    'corrupt ES256 signature': value => {
      const parts = value.token.split('.'), signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
      return new Response(JSON.stringify({ ...value, token: `${parts[0]}.${parts[1]}.${signature.toString('base64url')}` }));
    },
    'signer key differs from signature': (_value, s) => {
      const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
      return new Response(JSON.stringify(fakeTokenResponse(s, { claims: { pub: Buffer.from(other).toString('base64') } })));
    },
  };
  for (const [label, response] of Object.entries(scenarios)) await t.test(label, async () => {
    const s = setup();
    try {
      await completedGrant(s); const value = fakeTokenResponse(s); let posts = 0;
      await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async () => { posts++; return response(value, s); } })),
        error => !error.message.includes(value.token) && !error.message.includes('attacker.example'));
      assert.equal(s.journal.get('session').playback_token.state, 'pending');
      const status = await requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async () => { posts++; throw new Error('unexpected'); } }));
      assert.equal(status.status, 'TOKEN_REQUEST_UNRESOLVED'); assert.equal(posts, 1);
    } finally { s.close(); }
  });
});

test('changed payment, contract, entitlement, grant, publication or local source blocks token issuance before any POST', async t => {
  const scenarios = {
    'access hash': s => { s.settings.accessHash = hash(31); },
    'market hash': s => { s.settings.marketHash = hash(32); },
    'different FINAL block': s => { s.settings.wrongBlock = true; },
    'entitlement removed': s => { s.settings.entitlement = false; },
    'access paused': s => { s.settings.state = { ...s.settings.state, paused: true }; },
    'unpublished job': s => { s.settings.job = { ...s.settings.job, status: 'Authorized', published_at_ms: null }; },
    'publication changed': s => { s.settings.publication = { ...s.settings.publication, playback_id: 'different-playback' }; },
    'revoked grant': s => { s.settings.grant = { ...s.settings.grant, revoked: true }; },
    'failed verification': s => { s.settings.verification = { valid: false, owner_id: vault, reason: 'paused' }; },
    'bad payment receipt': s => { s.settings.paymentResult = { ...s.settings.paymentResult, final_execution_status: 'EXECUTED' }; },
    'missing grant receipt': s => { s.settings.grantNotVisible = true; },
    'source changed': s => { fs.writeFileSync(s.f.source, 'tampered source'); },
  };
  for (const [label, mutate] of Object.entries(scenarios)) await t.test(label, async () => {
    const s = setup();
    try {
      await completedGrant(s); mutate(s); let posts = 0;
      await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async () => { posts++; throw new Error('unexpected'); } })));
      assert.equal(posts, 0); assert.equal(s.journal.get('session').playback_token, undefined); assert.equal(s.settings.sent, 1);
    } finally { s.close(); }
  });
});

test('concurrent token callers cannot bypass the write-ahead reservation', async () => {
  const s = setup();
  try {
    await completedGrant(s); const value = fakeTokenResponse(s); let release, reached, posts = 0;
    const wait = new Promise(resolve => { release = resolve; });
    const atSend = new Promise(resolve => { reached = resolve; });
    const first = requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async () => {
      posts++; reached(); await wait; return new Response(JSON.stringify(value));
    } }));
    await atSend;
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true })), /already running/);
    release(); assert.equal((await first).status, 'TOKEN_RECEIVED'); assert.equal(posts, 1);
  } finally { s.close(); }
});

test('HLS redirects and references never send the bearer to an unapproved origin or unsafe URL', async t => {
  const s = setup();
  try {
    await completedGrant(s); const { value } = await issuedToken(s);
    const unsafe = [
      'http://playback.livepeer.studio/segment.ts', 'https://evil.example/segment.ts',
      'https://playback.livepeer.studio.evil.example/segment.ts', 'https://user@playback.livepeer.studio/segment.ts',
      'https://playback.livepeer.studio:444/segment.ts', 'https://playback.livepeer.studio/segment.ts?x=secret',
      'https://playback.livepeer.studio/segment.ts#fragment', 'https://127.0.0.1/segment.ts',
      '//evil.example/segment.ts', '/asset/hls/test/%2fsecret.ts', 'https://foo.lp-playback.studio/segment.ts',
      'https://livepeercdn.com/segment.ts',
    ];
    for (const uri of unsafe) await t.test(uri.replace(/secret/g, '<redacted>'), async () => {
      const calls = [];
      await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async (url, options) => {
        calls.push(url); assert.equal(options.headers['Livepeer-Jwt'], value.token);
        return new Response(`#EXTM3U\n#EXTINF:1.0,\n${uri}\n#EXT-X-ENDLIST\n`);
      } })), error => !error.message.includes(value.token) && !error.message.includes('evil.example') && !error.message.includes('secret'));
      assert.equal(calls.length, 1); assert.ok(calls[0].startsWith('https://playback.livepeer.studio/'));
    });
    let calls = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { approvedCdnOrigins: ['https://evil.example'], fetchImpl: async () => { calls++; } })), /unreviewed/);
    assert.equal(calls, 0);
    await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async () => {
      calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/credential-leak' } });
    } })), /unapproved/);
    assert.equal(calls, 1);
  } finally { s.close(); }
});

test('an explicitly reviewed exact CDN can receive the token only after a bounded manual redirect', async () => {
  const s = setup();
  try {
    await completedGrant(s); const { value } = await issuedToken(s), calls = [];
    const proof = await probeYoutickHls(tokenOptions(s, { approvedCdnOrigins: ['https://livepeercdn.com'], fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.redirect, 'manual'); assert.equal(options.headers['Livepeer-Jwt'], value.token);
      if (url.startsWith('https://playback.livepeer.studio/')) return new Response(null, { status: 302, headers: { location: 'https://livepeercdn.com/vod/master.m3u8' } });
      if (url.endsWith('/master.m3u8')) return new Response('#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n');
      if (url.endsWith('/segment.ts')) return new Response('synthetic bytes');
      throw new Error('unexpected');
    } }));
    assert.equal(proof.status, 'HLS_BYTES_RECEIVED'); assert.equal(calls.length, 3);
    assert.equal(calls[1], 'https://livepeercdn.com/vod/master.m3u8');
    assert.equal(proof.evidence.segment_bytes, 15); assert.equal(JSON.stringify(proof).includes(value.token), false);
  } finally { s.close(); }
});

test('HLS byte probe refuses unsupported playlists, redirects and unbounded streams', async t => {
  const cases = {
    'invalid playlist': '#EXTM3U\nnot-bound.ts\n#EXT-X-ENDLIST\n',
    'encrypted playlist': '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST\n',
    'byte range': '#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:100@0\ns.ts\n#EXT-X-ENDLIST\n',
    'fragmented mp4': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\ns.m4s\n#EXT-X-ENDLIST\n',
    'unfinished media': '#EXTM3U\n#EXTINF:1,\ns.ts\n',
    'overlong manifest': '#EXTM3U\n' + 'x'.repeat(270_000),
  };
  const s = setup();
  try {
    await completedGrant(s); await issuedToken(s);
    for (const [label, content] of Object.entries(cases)) await t.test(label, async () => {
      let calls = 0;
      await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async () => { calls++; return new Response(content); } })));
      assert.equal(calls, 1);
    });
    let calls = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async () => {
      calls++; return new Response(null, { status: 302, headers: { location: '/same-path' } });
    } })), /redirect limit/);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async url => {
      calls++;
      if (url.endsWith('/index.m3u8')) return new Response('#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');
      return new Response(Buffer.alloc(8 * 1024 * 1024 + 1));
    } })), /invalid or unresolved|exceeds/);
    assert.equal(calls, 2);
  } finally { s.close(); }
});

test('an expired recorded token is never silently renewed or used for media requests', async () => {
  const s = setup();
  try {
    await completedGrant(s); await issuedToken(s); let calls = 0;
    const options = tokenOptions(s, { execute: true, clock: () => now + 181_000, fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
    const status = await requestYoutickPlaybackToken(options);
    assert.equal(status.status, 'TOKEN_EXPIRED');
    await assert.rejects(probeYoutickHls(options), /unexpired/);
    assert.equal(calls, 0);
  } finally { s.close(); }
});

test('loopback HTTP exercises the real bounded fetch, token headers and media flow without any external payment', async () => {
  const s = setup(); let server;
  try {
    await completedGrant(s); const value = fakeTokenResponse(s), seen = [];
    server = http.createServer(async (req, res) => {
      const chunks = []; for await (const part of req) chunks.push(part);
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/v1/playback-tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
      }
      if (req.url.endsWith('/index.m3u8')) {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXTINF:1,\nclip.ts\n#EXT-X-ENDLIST\n'); return;
      }
      if (req.url.endsWith('/clip.ts')) { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end('local-test-bytes'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    // This rewrite is injected ONLY by the test; production uses the fixed HTTPS hosts.
    const loopback = (url, options) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
    assert.equal((await requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: loopback }))).status, 'TOKEN_RECEIVED');
    const proof = await probeYoutickHls(tokenOptions(s, { fetchImpl: loopback }));
    assert.equal(proof.status, 'HLS_BYTES_RECEIVED'); assert.equal(proof.evidence.segment_bytes, 16);
    assert.equal(seen.length, 3); assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].path, '/v1/playback-tokens'); assert.ok(seen[0].headers['x-youtick-signature']);
    assert.equal(JSON.parse(seen[0].body).body.playback_id, s.publication.playback_id);
    for (const request of seen.slice(1)) {
      assert.equal(request.method, 'GET'); assert.equal(request.headers['livepeer-jwt'], value.token);
      assert.equal(request.headers.origin, 'https://public-testnet.youtick.net');
    }
    assert.equal(JSON.stringify(proof).includes(value.token), false);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    s.close();
  }
});

test('an independently reviewed JWT signer fingerprint is enforced and survives encrypted recovery', async () => {
  const s = setup(); let reopened;
  try {
    await completedGrant(s); const keyHash = crypto.createHash('sha256').update(testTokenKey.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const { value, result } = await issuedToken(s, { expectedJwtKeySha256: keyHash });
    assert.equal(result.signer_key_sha256, keyHash); assert.equal(result.signer_key_pinned, true);
    assert.equal(result.issuer, 'https://youtick.net');
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { expectedJwtKeySha256: 'f'.repeat(64) })), /differs from the original/);
    s.journal.close(); fs.unlinkSync(s.f.source); reopened = open(s.f, true);
    const recovered = await requestYoutickPlaybackToken(tokenOptions(s, { journal: reopened, sourceFile: undefined }));
    assert.equal(recovered.status, 'TOKEN_AVAILABLE'); assert.equal(recovered.signer_key_pinned, true); assert.equal(recovered.signer_key_sha256, keyHash);
    const probe = await probeYoutickHls(tokenOptions(s, { journal: reopened, fetchImpl: async url => url.endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n') : new Response('bytes') }));
    assert.equal(probe.evidence.signer_key_sha256, keyHash); assert.equal(probe.evidence.signer_key_pinned, true);
    assert.equal(JSON.stringify(probe).includes(value.token), false);
  } finally { reopened?.close(); s.close(); }
});

test('a valid self-signed JWT does not satisfy a different independently reviewed key', async () => {
  const s = setup();
  try {
    await completedGrant(s); const value = fakeTokenResponse(s); let calls = 0;
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, expectedJwtKeySha256: 'f'.repeat(64),
      fetchImpl: async () => { calls++; return new Response(JSON.stringify(value)); } })), /independently reviewed key/);
    assert.equal(calls, 1); assert.equal(s.journal.get('session').playback_token.state, 'pending');
    const pending = await requestYoutickPlaybackToken(tokenOptions(s, { expectedJwtKeySha256: 'f'.repeat(64) }));
    assert.equal(pending.status, 'TOKEN_REQUEST_UNRESOLVED'); assert.equal(calls, 1);
  } finally { s.close(); }
});

test('an unresponsive injected POST or response stream cannot hang the journal or trigger a retry', async t => {
  for (const mode of ['silent transport', 'stalled body']) await t.test(mode, async () => {
    const s = setup();
    try {
      await completedGrant(s); let calls = 0;
      const fetchImpl = async () => {
        calls++;
        if (mode === 'silent transport') return new Promise(() => {});
        return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
      };
      await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, timeoutMs: 25, fetchImpl })), /unresolved/);
      assert.equal(s.journal.get('session').playback_token.state, 'pending'); assert.equal(calls, 1);
      const status = await requestYoutickPlaybackToken(tokenOptions(s, { execute: true, timeoutMs: 25, fetchImpl }));
      assert.equal(status.status, 'TOKEN_REQUEST_UNRESOLVED'); assert.equal(calls, 1);
    } finally { s.close(); }
  });
});

test('a late token response is discarded after the deadline and cannot replace the pending journal entry', async () => {
  const s = setup(); let finish, cancelled = false;
  try {
    await completedGrant(s);
    const delayed = new Promise(resolve => { finish = resolve; });
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, timeoutMs: 25, fetchImpl: () => delayed })), /unresolved/);
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true); assert.equal(s.journal.get('session').playback_token.state, 'pending');
  } finally { s.close(); }
});

test('an unresponsive media stream is bounded without recording a false byte proof', async () => {
  const s = setup();
  try {
    await completedGrant(s); await issuedToken(s); let calls = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { timeoutMs: 25, fetchImpl: async () => {
      calls++; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    } })), /unresolved/);
    assert.equal(calls, 1); assert.equal(s.journal.get('session').playback_probe, undefined);
    assert.equal(s.journal.get('session').playback_token.state, 'issued');
  } finally { s.close(); }
});

test('HLS rechecks live entitlement, code and original evidence before using a stored token', async t => {
  const cases = {
    'entitlement removed': s => { s.settings.entitlement = false; },
    'access code changed': s => { s.settings.accessHash = hash(33); },
    'market code changed': s => { s.settings.marketHash = hash(34); },
    'access paused': s => { s.settings.state = { ...s.settings.state, paused: true }; },
    'publication changed': s => { s.settings.publication = { ...s.settings.publication, playback_id: 'other-playback' }; },
    'grant revoked': s => { s.settings.grant = { ...s.settings.grant, revoked: true }; },
    'grant receipt unavailable': s => { s.settings.grantNotVisible = true; },
    'payment no longer FINAL': s => { s.settings.paymentResult = { ...s.settings.paymentResult, final_execution_status: 'EXECUTED' }; },
  };
  for (const [label, mutate] of Object.entries(cases)) await t.test(label, async () => {
    const s = setup();
    try {
      await completedGrant(s); await issuedToken(s); mutate(s); let gets = 0;
      await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async () => { gets++; throw new Error('unexpected'); } })));
      assert.equal(gets, 0); assert.equal(s.journal.get('session').playback_probe, undefined);
    } finally { s.close(); }
  });
});

test('expiration between media requests stops before another bearer is sent', async () => {
  const s = setup();
  try {
    await completedGrant(s); await issuedToken(s); let current = now, gets = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { clock: () => current, fetchImpl: async () => {
      gets++; current = now + 181_000;
      return new Response('#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');
    } })), /expired/);
    assert.equal(gets, 1); assert.equal(s.journal.get('session').playback_probe, undefined);
  } finally { s.close(); }
});

test('a changed token during retrieval does not produce a byte proof', async () => {
  const s = setup();
  try {
    await completedGrant(s); await issuedToken(s); let gets = 0;
    await assert.rejects(probeYoutickHls(tokenOptions(s, { fetchImpl: async url => {
      gets++;
      if (url.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');
      const entry = s.journal.get('session'), replacement = fakeTokenResponse(s);
      s.journal.put('session', { ...entry, playback_token: { ...entry.playback_token, token: replacement.token } });
      return new Response('synthetic content');
    } })), /original playback token changed/);
    assert.equal(gets, 2); assert.equal(s.journal.get('session').playback_probe, undefined);
  } finally { s.close(); }
});

test('transport-controlled response errors do not disclose bearer values', async () => {
  const s = setup();
  try {
    await completedGrant(s); let secret = '';
    await assert.rejects(requestYoutickPlaybackToken(tokenOptions(s, { execute: true, fetchImpl: async (_url, options) => {
      secret = options.headers['X-Youtick-Signature'];
      return { status: 200, body: { getReader() { throw new Error(secret); }, cancel() {} },
        headers: { get() { return null; } } };
    } })), error => /invalid playback response stream/.test(error.message) && !error.message.includes(secret));
    assert.equal(s.journal.get('session').playback_token.state, 'pending');
  } finally { s.close(); }
});
