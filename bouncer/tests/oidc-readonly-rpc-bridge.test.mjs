import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createVercelOidcVerifier, createOidcReadOnlyRpcBridge } from '../agent/oidc-readonly-rpc-bridge.mjs';
import { executeReadOnlyJob, validateReadOnlyJob, createReadOnlyRelayHandler } from '../testnet-relay/core.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const callback = 'https://bridge.example.test', site = 'https://site.example.test';
const issuer = 'https://oidc.vercel.com/team-example', owner = 'team-example', ownerId = 'team_123';
const project = 'bouncer-testnet-readonly-relay', projectId = 'prj_123', deploymentId = 'dpl_123';
const environment = 'production', defaultAudience = 'https://vercel.com/team-example';
const identity = { jwks: { keys: [jwk] }, issuer, owner, ownerId, project, projectId, deploymentId, environment };
const now = Date.now(), sec = Math.floor(now / 1000);
const hash = '4xEnDTpLB9EAQT26axqxK4S6ZWVwM5nyetp49NW2ukUW';
const json64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function token(aud, overrides = {}, headerChanges = {}, key = privateKey) {
  const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT', ...headerChanges };
  const claims = { iss: issuer, aud, sub: `owner:${owner}:project:${project}:environment:${environment}`,
    owner, owner_id: ownerId, project, project_id: projectId, deployment_id: deploymentId, environment,
    iat: sec, exp: sec + 7200, ...overrides };
  const body = `${json64(header)}.${json64(claims)}`;
  return `${body}.${crypto.sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const verify = createVercelOidcVerifier({ ...identity, now: () => now });
const request = (method, params, id = 'bouncer-read-only') => ({ jsonrpc: '2.0', id, method, params });
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const rpcOptions = body => ({ method: 'POST', redirect: 'error', body: JSON.stringify(body) });

test('only a correctly signed, current exact-deployment OIDC token passes', () => {
  const good = token(defaultAudience);
  assert.equal(verify(good, defaultAudience), true);
  assert.equal(verify(good, 'https://different.example'), false);
  for (const bad of [
    token(defaultAudience, { aud: [defaultAudience] }), token(defaultAudience, { iss: 'https://oidc.vercel.com/other' }),
    token(defaultAudience, { deployment_id: 'dpl_other' }), token(defaultAudience, { project_id: 'prj_other' }),
    token(defaultAudience, { owner_id: 'team_other' }), token(defaultAudience, { environment: 'preview' }),
    token(defaultAudience, { sub: 'owner:someone-else' }), token(defaultAudience, { exp: sec - 31 }),
    token(defaultAudience, { iat: sec + 31 }), token(defaultAudience, { nbf: sec + 31 }),
    token(defaultAudience, { exp: sec + 8000 }), token(defaultAudience, {}, { alg: 'none' }),
    token(defaultAudience, {}, { jku: 'https://attacker.test' }), token(defaultAudience, {}, { kid: 'other' }),
    `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`, 'not.a.jwt', '',
  ]) assert.equal(verify(bad, defaultAudience), false, 'must reject altered identity, audience, time, header or signature');
});

test('invalid, weak or duplicate key pins are rejected', () => {
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  assert.throws(() => createVercelOidcVerifier({ ...identity, jwks: { keys: [{ ...weak, kid: 'weak', alg: 'RS256', use: 'sig' }] } }));
  assert.throws(() => createVercelOidcVerifier({ ...identity, jwks: { keys: [jwk, jwk] } }));
  assert.throws(() => createVercelOidcVerifier({ ...identity, issuer: 'http://insecure.test' }));
});

test('read-only allowlist denies broadcasts, extra fields and unpinned views', () => {
  const examples = [
    request('status', []), request('block', { finality: 'final' }), request('block', { block_id: hash }),
    request('EXPERIMENTAL_protocol_config', { block_id: hash }),
    request('gas_price', [hash]), request('query', { request_type: 'view_account', account_id: 'great_mujey.testnet', block_id: hash }),
    request('query', { request_type: 'call_function', account_id: 'great_mujey.testnet', block_id: hash, method_name: 'get_owner', args_base64: 'e30=' }),
    request('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: 'great_mujey.testnet', wait_until: 'FINAL' }, 'bouncer-read-only-receipts'),
  ];
  for (const sample of examples) assert.equal(validateReadOnlyJob(sample), sample);
  for (const bad of [
    request('broadcast_tx_commit', ['signed-bytes']), request('send_tx', {}), request('block', { finality: 'optimistic' }),
    request('block', { block_id: 42 }), request('block', { block_id: hash, finality: 'final' }),
    request('block', { block_id: 'not-a-block-hash' }), request('block', { block_id: hash }, 'bouncer-read-only-receipts'),
    request('query', { request_type: 'view_account', account_id: 'great_mujey.near', block_id: hash }),
    request('query', { request_type: 'view_account', account_id: 'great_mujey.testnet', block_id: hash, extra: true }),
    request('query', { request_type: 'call_function', account_id: 'great_mujey.testnet', finality: 'final', method_name: 'new', args_base64: 'e30=' }),
    request('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: 'great_mujey.testnet', wait_until: 'NONE' }, 'bouncer-read-only-receipts'),
    { ...request('status', []), ignored: true },
  ]) assert.throws(() => validateReadOnlyJob(bad));
});

test('queue resists spoofed results, replay, response tampering and arbitrary URLs', async () => {
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now });
  await assert.rejects(bridge.fetch('https://attacker.test/', rpcOptions(request('status', []))));
  await assert.rejects(bridge.fetch('https://test.rpc.fastnear.com/', rpcOptions(request('send_tx', {}))));
  const waiting = bridge.fetch('https://test.rpc.fastnear.com/', rpcOptions(request('status', [])));
  const [id] = bridge.pending(); assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(bridge.take(id, 'bad'), null);
  assert.deepEqual(bridge.take(id, token(defaultAudience)), request('status', []));
  assert.equal(bridge.take(id, token(defaultAudience)), null);
  assert.deepEqual(bridge.pending(), []);
  const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-read-only', result: { chain_id: 'testnet' } }));
  const h = digest(raw), aud = `${callback}/internal/read-only-results/${id}/${h}`;
  assert.equal(bridge.submit(id, h, raw, token(defaultAudience)), false);
  assert.equal(bridge.submit(id, h, Buffer.from('tamper'), token(aud)), false);
  assert.equal(bridge.submit(id, h, raw, token(aud, { deployment_id: 'dpl_other' })), false);
  assert.equal(bridge.submit(id, h, raw, token(aud)), true);
  assert.equal(bridge.submit(id, h, raw, token(aud)), false);
  const body = await (await waiting).json(); assert.equal(body.result.chain_id, 'testnet');
});

test('a wrong JSON-RPC id or malformed result cannot resolve the queue', async () => {
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now });
  const controller = new AbortController();
  const waiting = bridge.fetch('https://test.rpc.fastnear.com/', { ...rpcOptions(request('status', [])), signal: controller.signal });
  const [id] = bridge.pending(); bridge.take(id, token(defaultAudience));
  const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'other', result: {} }));
  const h = digest(raw), aud = `${callback}/internal/read-only-results/${id}/${h}`;
  assert.equal(bridge.submit(id, h, raw, token(aud)), false);
  controller.abort(); await assert.rejects(waiting, /expired/);
  assert.deepEqual(bridge.pending(), []);
});

test('relay gets a fixed job, attests exact result and never reveals tokens to the browser', async () => {
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now });
  const tokens = [];
  const getToken = async options => { const t = token(options?.audience ?? defaultAudience); tokens.push(t); return t; };
  const fetchImpl = async (url, options) => {
    if (url.startsWith(`${callback}/internal/read-only-jobs/`)) {
      assert.equal(options.method, 'GET');
      const body = bridge.take(url.split('/').pop(), options.headers.authorization.slice(7));
      return body ? response(body) : new Response('', { status: 403 });
    }
    if (url === 'https://test.rpc.fastnear.com') {
      const job = JSON.parse(options.body); assert.equal(job.method, 'status');
      return response({ jsonrpc: '2.0', id: job.id, result: { chain_id: 'testnet' } });
    }
    if (url.startsWith(`${callback}/internal/read-only-results/`)) {
      const [h, id] = url.split('/').reverse();
      return new Response('', { status: bridge.submit(id, h, options.body, options.headers.authorization.slice(7)) ? 200 : 403 });
    }
    throw new Error('unexpected endpoint');
  };
  const waiting = bridge.fetch('https://test.rpc.fastnear.com/', rpcOptions(request('status', [])));
  const [jobId] = bridge.pending();
  assert.deepEqual(await executeReadOnlyJob({ jobId, callbackOrigin: callback, getToken, fetchImpl }), { delivered: true });
  assert.equal((await (await waiting).json()).result.chain_id, 'testnet');
  assert.equal(tokens.length, 2); assert.notEqual(tokens[0], tokens[1]);
});

test('relay denies malformed job and cannot return an unauthenticated response', async () => {
  const calls = [];
  await assert.rejects(executeReadOnlyJob({ jobId: 'a'.repeat(32), callbackOrigin: callback,
    getToken: async () => 'token', fetchImpl: async (url) => { calls.push(url); return response(request('broadcast_tx_commit', [])); } }));
  assert.equal(calls.length, 1, 'denied before contacting RPC');
  await assert.rejects(executeReadOnlyJob({ jobId: '../bad', callbackOrigin: callback, getToken: async () => 'token' }));
});

test('real read-only provider shapes cross the authenticated queue', async () => {
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now });
  const seen = [];
  const getToken = async options => token(options?.audience ?? defaultAudience);
  const fetchImpl = async (url, options) => {
    if (url.startsWith(`${callback}/internal/read-only-jobs/`)) return response(bridge.take(url.split('/').pop(), options.headers.authorization.slice(7)));
    if (url === 'https://test.rpc.fastnear.com' || url === 'https://archival-rpc.testnet.near.org') {
      const job = JSON.parse(options.body); seen.push([url, job.method]);
      const result = job.method === 'status' ? { chain_id: 'testnet' } :
        job.method === 'block' ? { header: { hash, timestamp_nanosec: String(now * 1_000_000), height: 1 } } :
        job.method === 'EXPERIMENTAL_tx_status' ? { status: 'FINAL' } : { block_hash: hash, result: [...Buffer.from('"hello"')] };
      return response({ jsonrpc: '2.0', id: job.id, result });
    }
    if (url.startsWith(`${callback}/internal/read-only-results/`)) {
      const [h, id] = url.split('/').reverse();
      return new Response('', { status: bridge.submit(id, h, options.body, options.headers.authorization.slice(7)) ? 200 : 403 });
    }
    throw Error('unexpected');
  };
  async function run(promise) {
    const [jobId] = bridge.pending(); assert.ok(jobId);
    await executeReadOnlyJob({ jobId, callbackOrigin: callback, getToken, fetchImpl });
    return await promise;
  }
  const provider = new ReadOnlyNearReceiptProvider('https://test.rpc.fastnear.com', { fetchImpl: bridge.fetch });
  assert.equal((await run(provider.viewNodeStatus())).chain_id, 'testnet');
  assert.equal((await run(provider.viewBlock({ finality: 'final' }))).header.hash, hash);
  assert.equal(seen.at(-1)[0], 'https://test.rpc.fastnear.com');
  assert.equal((await run(provider.block({ blockId: hash }))).header.hash, hash);
  assert.deepEqual(seen.at(-1), ['https://archival-rpc.testnet.near.org', 'block']);
  assert.equal((await run(provider.callFunctionRaw('great_mujey.testnet', 'get_owner', {}, { blockId: hash }))).block_hash, hash);
  assert.equal((await run(provider.txStatusReceipts(hash, 'great_mujey.testnet'))).status, 'FINAL');
  assert.equal(seen.at(-1)[0], 'https://archival-rpc.testnet.near.org');
});

test('public handler enforces exact browser origin and never returns a token', async () => {
  const handler = createReadOnlyRelayHandler({ callbackOrigin: callback, siteOrigin: site, getToken: async () => 'secret',
    fetchImpl: async () => new Response('', { status: 503 }) });
  const res = { headers: {}, code: 0, value: null, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; }, json(v) { this.value = v; return this; } };
  await handler({ method: 'GET', headers: { origin: 'https://attacker.test' }, query: { job: 'a'.repeat(32) } }, res);
  assert.equal(res.code, 405); assert.equal(res.headers['access-control-allow-origin'], undefined);
  await handler({ method: 'GET', headers: { origin: site }, query: { job: 'a'.repeat(32) } }, res);
  assert.equal(res.code, 502); assert.equal(res.headers['access-control-allow-origin'], site);
  assert.doesNotMatch(JSON.stringify(res.value), /secret/);
});

test('encrypted browser relay binds job and response without exposing its OIDC token', async () => {
  const signing = crypto.generateKeyPairSync('ed25519');
  const encryption = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = key => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now,
    signingPrivateKey: pem(signing.privateKey), encryptionPrivateKey: pem(encryption.privateKey) });
  const waiting = bridge.fetch('https://test.rpc.fastnear.com/', rpcOptions(request('status', [])));
  const [id] = bridge.pending(), job = bridge.takeForBrowser(id);
  assert.equal(bridge.takeForBrowser(id), null);
  let tokenText; const rpcUrls = [];
  const execute = async signedJob => {
    const { executeEncryptedBrowserJob } = await import('../testnet-relay/core.mjs');
    return executeEncryptedBrowserJob({ signedJob, callbackOrigin: callback, now: () => now,
      signingPublicKey: pem(signing.publicKey), encryptionPublicKey: pem(encryption.publicKey),
      getToken: async ({ audience }) => { tokenText = token(audience); return tokenText; },
      fetchImpl: async (url, options) => { const rpc = JSON.parse(options.body); rpcUrls.push(url);
        return response({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'block' ? { header: { hash } } : { chain_id: 'testnet' } }); } });
  };
  await assert.rejects(execute({ ...job, request_json: JSON.stringify(request('send_tx', {})) }));
  await assert.rejects(execute({ ...job, job_id: 'b'.repeat(32) }));
  await assert.rejects(execute({ ...job, expires_at_ms: job.expires_at_ms + 1 }));
  const envelope = await execute(job);
  assert.doesNotMatch(JSON.stringify(envelope), /chain_id|testnet|Bearer/);
  assert.equal(JSON.stringify(envelope).includes(tokenText), false);
  assert.equal(bridge.submitEncrypted({ ...envelope, job_id: 'c'.repeat(32) }), false);
  assert.equal(bridge.submitEncrypted({ ...envelope, request_sha256: 'a'.repeat(64) }), false);
  const damaged = Buffer.from(envelope.ciphertext_base64, 'base64'); damaged[0] ^= 1;
  assert.equal(bridge.submitEncrypted({ ...envelope, ciphertext_base64: damaged.toString('base64') }), false);
  assert.equal(bridge.submitEncrypted(envelope), true);
  assert.equal(bridge.submitEncrypted(envelope), false);
  assert.equal((await (await waiting).json()).result.chain_id, 'testnet');
  const historical = bridge.fetch('https://test.rpc.fastnear.com/', rpcOptions(request('block', { block_id: hash })));
  const historicalJob = bridge.takeForBrowser(bridge.pending()[0]);
  const historicalEnvelope = await execute(historicalJob);
  assert.equal(rpcUrls.at(-1), 'https://archival-rpc.testnet.near.org');
  assert.equal(bridge.submitEncrypted(historicalEnvelope), true);
  assert.equal((await (await historical).json()).result.header.hash, hash);
});

test('a different backend key cannot decrypt or authorize a browser relay result', async () => {
  const signing = crypto.generateKeyPairSync('ed25519'), otherSigning = crypto.generateKeyPairSync('ed25519');
  const encryption = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherEncryption = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = key => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
  const bridge = createOidcReadOnlyRpcBridge({ callbackOrigin: callback, defaultAudience, verifyOidc: verify, now: () => now,
    signingPrivateKey: pem(signing.privateKey), encryptionPrivateKey: pem(encryption.privateKey) });
  const controller = new AbortController();
  const waiting = bridge.fetch('https://test.rpc.fastnear.com/', { ...rpcOptions(request('status', [])), signal: controller.signal });
  const job = bridge.takeForBrowser(bridge.pending()[0]);
  const { executeEncryptedBrowserJob } = await import('../testnet-relay/core.mjs');
  const opts = { signedJob: job, callbackOrigin: callback, now: () => now,
    signingPublicKey: pem(signing.publicKey), encryptionPublicKey: pem(otherEncryption.publicKey),
    getToken: async ({ audience }) => token(audience),
    fetchImpl: async () => response({ jsonrpc: '2.0', id: 'bouncer-read-only', result: {} }) };
  await assert.rejects(executeEncryptedBrowserJob({ ...opts, signingPublicKey: pem(otherSigning.publicKey) }));
  const envelope = await executeEncryptedBrowserJob(opts);
  assert.equal(bridge.submitEncrypted(envelope), false);
  controller.abort(); await assert.rejects(waiting, /expired/);
});
