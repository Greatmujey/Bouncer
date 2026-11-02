import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildPayPerCallMessage, classifyPayPerCallView, inspectPayPerCallCatalog,
  inspectPayPerCallResult, PAYPERCALL_TESTNET_ESCROW } from '../agent/paypercall-inspect.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = Date.parse('2026-11-02T14:30:00Z'), BLOCK = mockHash('paypercall-final'), CODE = mockHash('escrow-code');
const VAULT = 'vault.owner.testnet', PROVIDER = 'seller.testnet', OPERATOR = 'operator.testnet';
const hash = input => crypto.createHash('sha256').update(input).digest('hex');
const goodService = overrides => ({ provider: PROVIDER, operator: OPERATOR, token: CIRCLE_TESTNET_USDC,
  price: '10000', timeout_secs: 60, referrer_bps: 0, active: true, name: 'Token Facts',
  endpoint: 'https://api.vendor.example/call', ...overrides });
const goodExpected = overrides => ({ call_id: 7, service_id: 2, payer: VAULT, token: CIRCLE_TESTNET_USDC,
  amount: '10000', referrer: null, request: 'wrap.testnet', ...overrides });
const goodCall = overrides => ({ service_id: 2, payer: VAULT, token: CIRCLE_TESTNET_USDC, amount: '10000',
  referrer: null, request_hash: hash('wrap.testnet'), deadline_ms: String(NOW + 60_000), status: 'Open',
  result_hash: null, result_uri: null, ...overrides });

function mockProvider(options = {}) {
  const calls = [], services = options.services ?? [goodService()], raw = options.raw ?? {};
  const mock = { calls,
    async viewNodeStatus() { calls.push({ kind: 'status' }); return { chain_id: options.chain ?? 'testnet' }; },
    async viewBlock(params) { calls.push({ kind: 'block', params });
      return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(options.blockTime ?? NOW) * 1_000_000n).toString() } }; },
    async query(params) {
      calls.push({ kind: 'query', params });
      if (options.queryFails?.includes(params.request_type)) throw new Error('RPC unavailable');
      const block_hash = options.mixed === params.request_type ? mockHash('other-block') : BLOCK;
      if (params.request_type === 'view_account') return { block_hash, code_hash: options.code ?? CODE };
      if (params.request_type === 'view_access_key_list') return { block_hash, keys: options.keys ?? [
        { public_key: 'ignored-public-key', access_key: { nonce: 1, permission: 'FullAccess' } },
        { public_key: 'another-public-key', access_key: { nonce: 1,
          permission: { FunctionCall: { receiver_id: 'example.testnet', method_names: ['x'], allowance: '1' } } } },
      ] };
      throw new Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args, params) {
      calls.push({ kind: 'view', contract, method, args, params });
      if (options.fail?.includes(method)) throw new Error('RPC unavailable');
      let value;
      if (Object.hasOwn(raw, method)) value = raw[method];
      else if (method === 'service_count') value = services.length;
      else if (method === 'get_service') value = services[args.service_id] ?? null;
      else if (method === 'get_storage_credit') value = '10000000000000000000000';
      else if (method === 'storage_balance_of') value = { total: '1250000000000000000000', available: '0' };
      else if (method === 'get_call') value = options.call ?? goodCall();
      else throw new Error('unexpected method');
      return { block_hash: options.mixed === method ? mockHash('other-block') : BLOCK,
        result: [...Buffer.from(JSON.stringify(value))] };
    } };
  return mock;
}
const inspect = p => inspectPayPerCallCatalog(p, { vault: VAULT, now: () => NOW });

test('offline public request pins service, exact UTF-8 request, referrer and max price without signing', () => {
  const draft = buildPayPerCallMessage({ service_id: 2, request: 'wrap.testnet', max_price: '10000' });
  assert.deepEqual(JSON.parse(draft.msg), { service_id: 2, request: 'wrap.testnet', referrer: null, max_price: '10000' });
  assert.equal(draft.request_hash, hash('wrap.testnet')); assert.equal(draft.signed, false); assert.equal(draft.sent, false);
  assert.match(draft.scope, /cannot open this escrow/);
  assert.equal(buildPayPerCallMessage({ service_id: 0, request: 'é'.repeat(128), max_price: '1' }).request_hash, hash('é'.repeat(128)));
  for (const bad of [
    { service_id: -1, request: 'x', max_price: '1' }, { service_id: 2 ** 32, request: 'x', max_price: '1' },
    { service_id: 0.5, request: 'x', max_price: '1' }, { service_id: 0, request: '', max_price: '1' },
    { service_id: 0, request: 'é'.repeat(129), max_price: '1' }, { service_id: 0, request: '\ud800', max_price: '1' },
    { service_id: 0, request: 'x', max_price: '01' }, { service_id: 0, request: 'x', max_price: '0' },
    { service_id: 0, request: 'x', max_price: '1e6' }, { service_id: 0, request: 'x', max_price: (1n << 128n).toString() },
    { service_id: 0, request: 'x', referrer: 'alice.near', max_price: '1' },
  ]) assert.throws(() => buildPayPerCallMessage(bad));
});

test('catalog pins every read to one FINAL block and never calls a seller or authorizes payment', async () => {
  const p = mockProvider(), result = await inspect(p);
  assert.equal(result.status, 'READ_ONLY_CATALOG_NOT_PAYMENT_READY'); assert.equal(result.payment_ready, false);
  assert.equal(result.chain, 'testnet'); assert.equal(result.block_hash, BLOCK); assert.equal(result.escrow_code_hash, CODE);
  assert.deepEqual(result.escrow_access_keys, { key_count: 2, full_access_key_count: 1 });
  assert.equal(result.escrow_circle_registration, 'REGISTERED_AT_VIEW'); assert.equal(result.vault_circle_registration, 'REGISTERED_AT_VIEW');
  assert.equal(result.vault_storage_credit_yocto, '10000000000000000000000');
  assert.equal(result.complete_catalog_snapshot, true); assert.equal(result.circle_candidates_observed, 1);
  assert.equal(result.services[0].endpoint_reachability_checked, false);
  assert.equal(result.operator_contacted, false); assert.equal(result.signed, false); assert.equal(result.sent, false);
  assert.equal(result.blockers.length, 3); assert.match(result.scope, /not reachability/);
  for (const call of p.calls.filter(c => c.kind === 'view')) assert.deepEqual(call.params, { blockId: BLOCK });
  for (const call of p.calls.filter(c => c.kind === 'query')) assert.equal(call.params.block_id, BLOCK);
  assert.ok(p.calls.every(c => ['status', 'block', 'query', 'view'].includes(c.kind)));
});

test('existing native-only and localhost offers never count as public Circle candidates', async () => {
  const services = [goodService({ token: null, price: '10000000000000000000000', endpoint: 'http://127.0.0.1:8787' }),
    goodService({ endpoint: 'https://127.0.0.1:8787' }), goodService({ active: false }),
    goodService({ token: 'other.testnet' })];
  const result = await inspect(mockProvider({ services }));
  assert.equal(result.complete_catalog_snapshot, true); assert.equal(result.circle_candidates_observed, 0);
  assert.equal(result.services[0].https_hostname_syntax, false);
});

test('HTTPS string checks reject local, IP, credentialed and unreviewable endpoint forms without contacting them', async () => {
  for (const endpoint of ['http://api.vendor.example', 'https://localhost', 'https://a.local', 'https://a.internal',
    'https://vendor.test', 'https://127.0.0.1', 'https://[::1]/call', 'https://u:p@vendor.example/call',
    'https://vendor.example/call#fragment', 'not a URL', 'x'.repeat(300)]) {
    const result = await inspect(mockProvider({ services: [goodService({ endpoint })] }));
    assert.equal(result.circle_candidates_observed, 0, endpoint);
    assert.equal(result.operator_contacted, false);
  }
});

test('truncated and unrecognized catalogs remain incomplete rather than asserting absence', async () => {
  const limited = await inspectPayPerCallCatalog(mockProvider({ services: Array.from({ length: 4 }, () => goodService({ token: null })) }),
    { maxServices: 2, now: () => NOW });
  assert.equal(limited.service_count, 4); assert.equal(limited.scanned_services, 2);
  assert.equal(limited.complete_catalog_snapshot, false); assert.equal(limited.circle_candidates_observed, 0);
  for (const options of [
    { fail: ['service_count'] }, { raw: { service_count: '1' } }, { raw: { service_count: -1 } },
    { fail: ['get_service'] }, { mixed: 'get_service' }, { services: [null] },
    { services: [goodService({ price: 'NaN' })] }, { services: [goodService({ provider: 'evil.near' })] },
    { services: [goodService({ timeout_secs: 59 })] },
  ]) {
    const result = await inspect(mockProvider(options));
    assert.equal(result.complete_catalog_snapshot, false);
    assert.equal(result.circle_candidates_observed, 0); assert.equal(result.payment_ready, false);
  }
});

test('pagination reads only the requested bounded range and never claims a complete multi-block catalog', async () => {
  const p = mockProvider({ services: Array.from({ length: 4 }, (_, i) => goodService({ name: `Service ${i}` })) });
  const result = await inspectPayPerCallCatalog(p, { maxServices: 2, offset: 1, now: () => NOW });
  assert.equal(result.scan_offset, 1); assert.equal(result.next_offset, 3);
  assert.deepEqual(result.services.map(s => s.service_id), [1, 2]);
  assert.deepEqual(p.calls.filter(c => c.method === 'get_service').map(c => c.args.service_id), [1, 2]);
  assert.equal(result.complete_catalog_snapshot, false);
  const last = await inspectPayPerCallCatalog(mockProvider({ services: Array.from({ length: 4 }, () => goodService()) }),
    { maxServices: 2, offset: 3, now: () => NOW });
  assert.equal(last.next_offset, null); assert.equal(last.scanned_services, 1); assert.equal(last.complete_catalog_snapshot, false);
  for (const offset of [-1, 2 ** 32, 1.5]) {
    const q = mockProvider(); await assert.rejects(inspectPayPerCallCatalog(q, { offset, now: () => NOW }));
    assert.equal(q.calls.length, 0);
  }
});

test('unknown, absent and malformed registrations and key views are distinguished', async () => {
  const absent = await inspect(mockProvider({ raw: { storage_balance_of: null, get_storage_credit: '0' }, keys: [] }));
  assert.equal(absent.vault_circle_registration, 'NOT_REGISTERED_AT_VIEW');
  assert.equal(absent.escrow_circle_registration, 'NOT_REGISTERED_AT_VIEW');
  assert.equal(absent.vault_storage_credit_yocto, '0');
  assert.deepEqual(absent.escrow_access_keys, { key_count: 0, full_access_key_count: 0 });
  const bad = await inspect(mockProvider({ raw: { storage_balance_of: { total: '1', available: '2' }, get_storage_credit: '1e3' },
    keys: [{ access_key: { permission: 'unrecognized' } }], mixed: 'view_account' }));
  assert.equal(bad.vault_circle_registration, 'UNKNOWN'); assert.equal(bad.vault_storage_credit_yocto, null);
  assert.equal(bad.escrow_access_keys, null); assert.equal(bad.escrow_code_hash, null);
  const unknown = await inspect(mockProvider({ fail: ['storage_balance_of', 'get_storage_credit'], queryFails: ['view_access_key_list'] }));
  assert.equal(unknown.escrow_circle_registration, 'UNKNOWN'); assert.equal(unknown.vault_circle_registration, 'UNKNOWN');
  assert.equal(unknown.escrow_access_keys, null);
  const noVault = await inspectPayPerCallCatalog(mockProvider(), { now: () => NOW });
  assert.equal(noVault.vault, null); assert.equal(noVault.vault_circle_registration, 'NOT_CHECKED');
  assert.ok(!mockProvider().calls.some(c => c.method === 'send_tx'));
});

test('wrong chain, stale blocks, backward clock and malformed inputs stop without mutation', async () => {
  for (const options of [{ chain: 'mainnet' }, { blockTime: NOW - 120_001 }, { blockTime: NOW + 30_001 }]) {
    const p = mockProvider(options); await assert.rejects(inspect(p));
    assert.ok(!p.calls.some(c => c.kind === 'view' || c.kind === 'query'));
  }
  let tick = 0;
  await assert.rejects(inspectPayPerCallCatalog(mockProvider(), { now: () => tick++ ? NOW - 1 : NOW }), /clock moved backwards/);
  tick = 0;
  await assert.rejects(inspectPayPerCallCatalog(mockProvider(), { now: () => tick++ ? NOW + 120_001 : NOW }), /stale/);
  for (const options of [{ vault: 'alice.near' }, { maxServices: 0 }, { maxServices: 21 }, { maxServices: 1.5 }]) {
    const p = mockProvider(); await assert.rejects(inspectPayPerCallCatalog(p, options)); assert.equal(p.calls.length, 0);
  }
});

test('open and later-refunded states do not claim delivery, payout, or Bouncer ledger credit', () => {
  const opened = classifyPayPerCallView(goodExpected(), goodCall());
  assert.equal(opened.status, 'OPEN_NO_DELIVERY'); assert.equal(opened.bouncer_payment_verified, false);
  const refunded = classifyPayPerCallView(goodExpected(), goodCall({ status: 'Refunded' }));
  assert.equal(refunded.status, 'REFUND_REPORTED_NOT_VERIFIED');
  assert.equal(refunded.provider_payout_verified, false); assert.equal(refunded.vault_refund_credit_verified, false);
  assert.match(refunded.scope, /do not retry automatically/);
  assert.throws(() => classifyPayPerCallView(goodExpected(), goodCall({ status: 'Refunded' }), Buffer.from('answer')));
});

test('fulfilled status alone is not delivery; exact answer bytes must match and quality is not certified', () => {
  const bytes = Buffer.from('{"token":"wrap.testnet","supply":"100"}\n'), call = goodCall({ status: 'Fulfilled',
    result_hash: hash(bytes), result_uri: 'https://vendor.example/result/7' });
  const noAnswer = classifyPayPerCallView(goodExpected(), call);
  assert.equal(noAnswer.status, 'FULFILLED_WITHOUT_ANSWER'); assert.equal(noAnswer.bouncer_payment_verified, false);
  const matched = classifyPayPerCallView(goodExpected(), call, bytes);
  assert.equal(matched.status, 'ANSWER_HASH_MATCH'); assert.equal(matched.answer_bytes, bytes.length);
  assert.match(matched.scope, /correctness, usefulness, payment and payout remain unverified/);
  assert.throws(() => classifyPayPerCallView(goodExpected(), call, Buffer.from(bytes.toString().trim())), /do not match/);
  assert.throws(() => classifyPayPerCallView(goodExpected(), call, bytes.toString()), /exact bytes/);
  assert.throws(() => classifyPayPerCallView(goodExpected(), call, new Uint8Array(1024 * 1024 + 1)), /bounded/);
});

test('tampered call, request, price, token, payer and malformed commitment all fail closed', () => {
  const e = goodExpected(), call = goodCall();
  for (const altered of [
    { service_id: 3 }, { payer: 'attacker.testnet' }, { token: 'other.testnet' }, { amount: '9999' },
    { referrer: 'other.testnet' }, { request_hash: hash('something else') }, { deadline_ms: '1e3' },
    { status: 'Unknown' }, { status: 'Fulfilled', result_hash: 'A'.repeat(64) },
    { status: 'Fulfilled', result_hash: 'b'.repeat(64), result_uri: 'x'.repeat(257) },
  ]) assert.throws(() => classifyPayPerCallView(e, { ...call, ...altered }));
  for (const bad of [
    { call_id: Number.MAX_SAFE_INTEGER + 1 }, { service_id: -1 }, { payer: 'a.near' }, { token: 'x.near' },
    { amount: '01' }, { amount: '0' }, { request: 'not the same' }, { referrer: VAULT }, { referrer: undefined },
  ]) assert.throws(() => classifyPayPerCallView({ ...e, ...bad }, call));
});

test('result inspector fetches only the identified call at the pinned block', async () => {
  const answerBytes = Buffer.from('example answer'), p = mockProvider({ call: goodCall({ status: 'Fulfilled', result_hash: hash(answerBytes) }) });
  const result = await inspectPayPerCallResult(p, goodExpected(), { answerBytes, now: () => NOW });
  assert.equal(result.status, 'ANSWER_HASH_MATCH'); assert.equal(result.block_hash, BLOCK); assert.equal(result.sent, false);
  const view = p.calls.find(c => c.kind === 'view');
  assert.equal(view.contract, PAYPERCALL_TESTNET_ESCROW); assert.equal(view.method, 'get_call');
  assert.deepEqual(view.args, { call_id: 7 }); assert.deepEqual(view.params, { blockId: BLOCK });
  await assert.rejects(inspectPayPerCallResult(mockProvider({ mixed: 'get_call' }), goodExpected(), { now: () => NOW }), /invalid view/);
});

test('CLI is read-only and rejects an execute flag without contacting an endpoint', () => {
  const file = fileURLToPath(new URL('../agent/paypercall-inspect.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /never signs, sends/);
  const denied = spawnSync(process.execPath, [file, '--rpc', 'https://rpc.example', '--execute'], { encoding: 'utf8' });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /unknown, duplicate or incomplete/);
});

// Synthetic loopback RPC verifies the actual CLI's parsing and read-only wire
// traffic. The returned services, call and answer are fabricated; no public
// chain, operator, payment or independent fulfillment is involved.
test('catalog and answer-file CLI use bounded pinned read-only RPC and exact bytes', async () => {
  const requests = [], answer = Buffer.from('synthetic answer\n');
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), p = body.params; requests.push({ method: body.method, params: p });
    let value;
    if (body.method === 'status') value = { chain_id: 'testnet' };
    else if (body.method === 'block') value = { header: { hash: BLOCK, timestamp_nanosec: (BigInt(Date.now()) * 1_000_000n).toString() } };
    else if (body.method === 'query' && p.request_type === 'view_account') value = { block_hash: BLOCK, code_hash: CODE };
    else if (body.method === 'query' && p.request_type === 'view_access_key_list') value = { block_hash: BLOCK, keys: [] };
    else if (body.method === 'query' && p.request_type === 'call_function') {
      let item;
      if (p.method_name === 'service_count') item = 3;
      else if (p.method_name === 'get_service') item = goodService();
      else if (p.method_name === 'storage_balance_of') item = { total: '1250000000000000000000', available: '0' };
      else if (p.method_name === 'get_call') item = goodCall({ status: 'Fulfilled', result_hash: hash(answer) });
      else throw new Error('unexpected synthetic view');
      value = { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(item))] };
    } else throw new Error('unexpected synthetic RPC');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-paypercall-cli-'));
  const file = fileURLToPath(new URL('../agent/paypercall-inspect.mjs', import.meta.url));
  const rpc = `http://127.0.0.1:${server.address().port}`, answerFile = path.join(dir, 'answer');
  const run = async args => {
    const child = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
  };
  try {
    fs.writeFileSync(answerFile, answer);
    const catalog = await run(['catalog', '--rpc', rpc, '--limit', '1', '--offset', '1']);
    assert.equal(catalog.code, 0, catalog.stderr);
    const c = JSON.parse(catalog.stdout);
    assert.deepEqual(c.services.map(s => s.service_id), [1]); assert.equal(c.next_offset, 2);
    assert.equal(c.complete_catalog_snapshot, false); assert.equal(c.sent, false);
    const callArgs = ['call', '--rpc', rpc, '--call-id', '7', '--service-id', '2', '--payer', VAULT,
      '--amount', '10000', '--request', 'wrap.testnet', '--answer-file', answerFile];
    const inspected = await run(callArgs); assert.equal(inspected.code, 0, inspected.stderr);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.status, 'ANSWER_HASH_MATCH'); assert.equal(result.answer_bytes, answer.length);
    assert.equal(result.bouncer_payment_verified, false); assert.equal(result.sent, false);
    const before = requests.length;
    fs.symlinkSync(answerFile, path.join(dir, 'link'));
    const link = await run([...callArgs.slice(0, -1), path.join(dir, 'link')]);
    assert.equal(link.code, 1); assert.equal(requests.length, before);
    fs.writeFileSync(path.join(dir, 'too-large'), Buffer.alloc(1024 * 1024 + 1));
    const large = await run([...callArgs.slice(0, -1), path.join(dir, 'too-large')]);
    assert.equal(large.code, 1); assert.match(large.stderr, /at most 1 MiB/); assert.equal(requests.length, before);
    const invalid = await run(['catalog', '--rpc', rpc, '--offset', '1e2']);
    assert.equal(invalid.code, 1); assert.equal(requests.length, before);
    assert.ok(requests.every(r => ['status', 'block', 'query'].includes(r.method)));
    assert.ok(requests.filter(r => r.method === 'query').every(r => r.params.block_id === BLOCK));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
