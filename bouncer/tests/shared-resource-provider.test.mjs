// Integration tests: real PostgreSQL; all NEAR payment receipts below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nearApi from 'near-api-js';
import { createSharedResourceProvider, startConfiguredSharedProvider, validateSellerDatabaseUrl } from '../services/shared-resource-provider.mjs';
import { initializePostgresSellerSchema, openPostgresSellerStore } from '../services/postgres-seller-store.mjs';
import { challengeFromOrderMemoV3, signClaimAuthorization, verifyClaimAuthorization } from '../packages/provider-sdk/index.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';
import { httpResourceProvider, routedResourceProvider, runResourceAgent } from '../agent/resource-agent.mjs';
import { recoverResourceDelivery } from '../agent/recover-direct-payment.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { inspectSharedSeller } from '../scripts/inspect-shared-seller.mjs';

const databaseUrl = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !databaseUrl) throw new Error('PostgreSQL integration test URL is required');
const dbtest = databaseUrl ? test : test.skip;
const owner = 'owner.testnet', contract = 'bouncer.testnet';
const agent = nearApi.KeyPair.fromRandom('ed25519'), thief = nearApi.KeyPair.fromRandom('ed25519');
const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: resource, token: 'token.testnet', payee: 'seller.testnet', amount: '1000' }]));
const inputRepo = { repo: 'example/project' };
const githubResponse = () => new Response(JSON.stringify({ private: false, full_name: 'example/project', id: 42,
  description: null, stargazers_count: 5, forks_count: 2, open_issues_count: 1, license: null }),
{ status: 200, headers: { 'content-type': 'application/json' } });
const sellerId = () => `test-${crypto.randomBytes(8).toString('hex')}`;
const makePool = () => new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000 });
if (databaseUrl) test.before(async () => {
  const pool = makePool();
  try { await initializePostgresSellerSchema({ pool }); } finally { await pool.end(); }
});
const quoteOrder = (resource, input) => ({ resource, input, order_binding: 'seller-v3' });
const redemption = (hash, resource, input, quote, authorization) => ({ tx_hash: hash, resource, input, memo: quote.memo, authorization });
function fixture({ maxQuotes, dataFetch = async () => githubResponse(), rpcOverrides = {} } = {}) {
  const id = sellerId(), origin = `https://${id}.seller.example`, receipts = new Map(), pools = new Set(), providers = new Set();
  let reads = 0;
  const rpc = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash) {
    reads++; if (!receipts.has(hash)) throw new Error('missing synthetic receipt'); return structuredClone(receipts.get(hash));
  }, ...rpcOverrides };
  const config = { sellerId: id, contractId: contract, ownerAccountId: owner, sellerOrigin: origin, products, maxQuotes };
  function pool() { const p = makePool(); pools.add(p); return p; }
  async function provider(overrides = {}) {
    const p = await createSharedResourceProvider({ pool: pool(), rpcProvider: rpc, ...config, dataFetch, ...overrides });
    providers.add(p); return p;
  }
  function payment(hash, quote, key = agent) {
    receipts.set(hash, mockGuardedPayment({ hash, owner, contract, publicKey: String(key.getPublicKey()), args: {
      policy_id: quote.policy_id, payee: quote.payee, amount: quote.amount, memo: quote.memo, expected_token: quote.token } }));
  }
  async function authorization(hash, quote, key = agent) {
    return signClaimAuthorization({ publicKey: key.getPublicKey(), signer: new nearApi.KeyPairSigner(key), terms: {
      network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: origin, resource: quote.resource,
      policy_id: quote.policy_id, token: quote.token, payee: quote.payee, amount: quote.amount, memo: quote.memo, tx_hash: hash } });
  }
  async function cleanup() {
    await Promise.allSettled([...providers].map(p => p.close()));
    await Promise.allSettled([...pools].map(p => p.end()));
  }
  return { id, origin, config, receipts, rpc, pool, provider, payment, authorization, cleanup, get reads() { return reads; } };
}
async function listen(provider) {
  await new Promise((resolve, reject) => { provider.server.once('error', reject); provider.server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${provider.server.address().port}`;
}
function post(base, route, body) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) });
}

// No connection strings or secrets should be included in validation errors.
test('shared-seller database URL requires verified TLS off loopback and rejects host overrides', () => {
  const local = 'postgresql://u:secret@127.0.0.1:25432/seller';
  const remote = 'postgresql://u:secret@db.example/seller?sslmode=verify-full';
  assert.equal(validateSellerDatabaseUrl(local), local); assert.equal(validateSellerDatabaseUrl(remote), remote);
  for (const bad of ['postgresql://u:secret@db.example/seller', 'postgresql://u:secret@db.example/seller?sslmode=require',
    'postgresql://u:secret@127.0.0.1/seller?host=db.example', 'postgresql://u:secret@db.example/seller?sslmode=verify-full&sslmode=disable',
    'http://u:secret@db.example/seller', 'postgresql://u:secret@db.example/']) {
    assert.throws(() => validateSellerDatabaseUrl(bad), error => !error.message.includes('secret'));
  }
});

test('worker config rejects unknown fields without echoing an accidental credential', async () => {
  await assert.rejects(startConfiguredSharedProvider({ database_url: 'password=secret-value' }), error => !error.message.includes('secret-value'));
});

dbtest('HTTP database failures are sanitized and do not echo connection credentials', async () => {
  const f = fixture(), realPool = f.pool(); let fail = false;
  const faultyPool = { async connect() { if (fail) throw new Error('password=secret-value'); return realPool.connect(); } };
  const provider = await f.provider({ pool: faultyPool });
  try {
    const base = await listen(provider); fail = true;
    const response = await post(base, '/quote', quoteOrder('compute', { text: 'bounded', rounds: 1 }));
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret-value'));
  } finally { await f.cleanup(); }
});

dbtest('authenticated storage survives worker restart; public proof and wrong keys never reveal it', async () => {
  const f = fixture(), a = await f.provider(), b = await f.provider(), input = { name: 'private', content: 'shared but protected' };
  const hash = mockHash(`${f.id}:shared-storage`), quote = await a.quote(quoteOrder('storage', input));
  try {
    f.payment(hash, quote);
    const auth = await f.authorization(hash, quote), forged = await f.authorization(hash, quote, thief);
    await assert.rejects(b.redeem({ tx_hash: hash, resource: 'storage', input, memo: quote.memo }), /invalid seller-v3 redemption/);
    await assert.rejects(b.redeem(redemption(hash, 'storage', input, quote, { ...auth, signature: forged.signature })), /authorization/);
    assert.equal(f.reads, 0);
    await assert.rejects(b.redeem(redemption(hash, 'storage', input, quote, forged)), /verification failed/);
    assert.equal(f.reads, 1);
    await assert.rejects(b.redeem(redemption(hash, 'storage', { ...input, content: 'tampered' }, quote, auth)), /exact order/);
    const result = await b.redeem(redemption(hash, 'storage', input, quote, auth));
    const base = await listen(a), client = httpResourceProvider(base);
    assert.equal((await fetch(`${base}/storage/${result.object_id}`)).status, 404);
    assert.equal((await post(base, '/storage-read', { tx_hash: hash, object_id: result.object_id, authorization: forged })).status, 400);
    assert.equal(Buffer.from(await client.readStorage(result.object_id, { txHash: hash, authorization: auth })).toString(), input.content);
    await b.close();
    const restarted = await f.provider({ rpcProvider: { async viewNodeStatus() { throw new Error('must not reread RPC'); }, async txStatusReceipts() {} } });
    assert.deepEqual(await restarted.redeem(redemption(hash, 'storage', input, quote, auth)), result);
    await assert.rejects(restarted.redeem(redemption(hash, 'storage', input, quote, forged)), /authorization/);
    const pool = f.pool(), rows = await pool.query('SELECT * FROM bouncer_seller_v3.orders WHERE seller_id=$1', [f.id]);
    assert.equal(rows.rows[0].status, 'completed'); assert.equal(rows.rows[0].execution_token, null);
    assert.ok(!JSON.stringify(rows.rows).includes(auth.signature)); // seller retains no bearer signature
  } finally { await f.cleanup(); }
});

dbtest('inspection works with a SELECT-only role and never returns bearer signatures or object contents', async () => {
  const f = fixture(), provider = await f.provider(), pool = f.pool(), client = await pool.connect();
  const role = `bouncer_read_${crypto.randomBytes(6).toString('hex')}`; let roleCreated = false;
  try {
    const input = { name: 'secret', content: 'private bytes' }, hash = mockHash(`${f.id}:shared-inspection`);
    const quote = await provider.quote(quoteOrder('storage', input)); f.payment(hash, quote);
    const auth = await f.authorization(hash, quote);
    await provider.redeem(redemption(hash, 'storage', input, quote, auth));
    await provider.quote(quoteOrder('api', { text: 'unused quote' }));
    // Identifier is generated locally from fixed alphabet; values in inspection
    // itself are still bound parameters, never interpolated SQL.
    await client.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_seller_v3 TO ${role}`);
    await client.query(`GRANT SELECT ON bouncer_seller_v3.sellers, bouncer_seller_v3.orders TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const readOnlyPool = { async connect() { return { query: client.query.bind(client), release() {} }; } };
    const result = await inspectSharedSeller({ pool: readOnlyPool, sellerId: f.id });
    assert.equal(result.issued_quotes, 2); assert.equal(result.orders.length, 1); assert.equal(result.orders[0].tx_hash, hash);
    assert.ok(!JSON.stringify(result).includes(auth.signature)); assert.ok(!JSON.stringify(result).includes(input.content));
    const all = await inspectSharedSeller({ pool: readOnlyPool, sellerId: f.id, includeIssued: true });
    assert.equal(all.orders.length, 2); assert.ok(all.orders.some(row => row.status === 'issued'));
    const truncated = await inspectSharedSeller({ pool: readOnlyPool, sellerId: f.id, includeIssued: true, limit: 1 });
    assert.equal(truncated.has_more, true); assert.equal(truncated.orders.length, 1);
    await assert.rejects(client.query('DELETE FROM bouncer_seller_v3.orders WHERE seller_id=$1', [f.id]), /permission denied/);
  } finally {
    await client.query('RESET ROLE');
    if (roleCreated) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
    client.release(); await f.cleanup();
  }
});

dbtest('workers can issue and fulfill with a non-DDL, non-DELETE database role', async () => {
  const f = fixture(), pool = f.pool(), client = await pool.connect();
  const role = `bouncer_worker_${crypto.randomBytes(6).toString('hex')}`; let roleCreated = false;
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`); roleCreated = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_seller_v3 TO ${role}`);
    await client.query(`GRANT SELECT ON bouncer_seller_v3.meta TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON bouncer_seller_v3.sellers, bouncer_seller_v3.orders TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const workerPool = { async connect() { return { query: client.query.bind(client), release() {} }; } };
    const provider = await f.provider({ pool: workerPool });
    const input = { text: 'least privilege', rounds: 2 }, hash = mockHash(`${f.id}:least-privilege`);
    const quote = await provider.quote(quoteOrder('compute', input)); f.payment(hash, quote);
    assert.equal((await provider.redeem(redemption(hash, 'compute', input, quote, await f.authorization(hash, quote)))).type, 'compute');
    await assert.rejects(client.query('CREATE TABLE bouncer_seller_v3.should_not_exist(id int)'), /permission denied/);
    await assert.rejects(client.query('DELETE FROM bouncer_seller_v3.orders WHERE seller_id=$1', [f.id]), /permission denied/);
  } finally {
    await client.query('RESET ROLE');
    if (roleCreated) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
    client.release(); await f.cleanup();
  }
});

dbtest('worker refuses a pre-existing schema missing the transaction replay index', async () => {
  // A separate disposable database means even a killed test cannot damage the
  // main test schema while it deliberately removes an essential constraint.
  const admin = makePool(), name = `bouncer_corrupt_${crypto.randomBytes(6).toString('hex')}`; let sub, created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(databaseUrl); url.pathname = `/${name}`;
    sub = new pg.Pool({ connectionString: url.toString() });
    await initializePostgresSellerSchema({ pool: sub });
    await sub.query('ALTER TABLE bouncer_seller_v3.orders DROP CONSTRAINT orders_tx_hash_key');
    await assert.rejects(initializePostgresSellerSchema({ pool: sub }), /replay constraints are missing/);
    const f = fixture();
    await assert.rejects(createSharedResourceProvider({ pool: sub, rpcProvider: f.rpc, ...f.config }), /replay constraints are missing/);
    await f.cleanup();
  } finally {
    if (sub) await sub.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});

dbtest('one quote accepts at most one of two FINAL payments; a transaction hash is globally unique', async () => {
  let arrived = 0, release, allArrived;
  const ready = new Promise(resolve => { allArrived = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(), original = f.rpc.txStatusReceipts;
  f.rpc.txStatusReceipts = async (...args) => { if (++arrived === 2) allArrived(); await blocked; return original(...args); };
  const a = await f.provider(), b = await f.provider(), input = { text: 'two independent payment claims', rounds: 3 };
  try {
    const quote = await a.quote(quoteOrder('compute', input)), h1 = mockHash(`${f.id}:shared-race-first`), h2 = mockHash(`${f.id}:shared-race-second`);
    f.payment(h1, quote); f.payment(h2, quote);
    const claims = [redemption(h1, 'compute', input, quote, await f.authorization(h1, quote)),
      redemption(h2, 'compute', input, quote, await f.authorization(h2, quote))];
    const jobs = [a.redeem(claims[0]), b.redeem(claims[1])].map(p => p.then(value => ({ value }), error => ({ error })));
    await ready; release();
    const results = await Promise.all(jobs);
    assert.equal(results.filter(r => r.value).length, 1); assert.match(results.find(r => r.error).error.message, /already claimed/);
    const status = await a.status(); assert.equal(status.length, 1); assert.equal(status[0].status, 'completed');
    // Defense in depth: even the low-level store cannot attach the same hash to
    // a second quote. Normally FINAL memo verification would already reject it.
    const q2 = await b.quote(quoteOrder('compute', { text: 'different', rounds: 1 }));
    const store = await openPostgresSellerStore({ pool: f.pool(), ...f.config });
    await assert.rejects(store.claim({ challenge: challengeFromOrderMemoV3('compute', { text: 'different', rounds: 1 }, q2.memo),
      resource: 'compute', memo: q2.memo, product: products.compute, txHash: status[0].tx_hash, agentPublicKey: String(agent.getPublicKey()), executionToken: 'a'.repeat(64) }), /transaction was already claimed/);
    assert.equal((await store.find(challengeFromOrderMemoV3('compute', { text: 'different', rounds: 1 }, q2.memo))).status, 'issued');
  } finally { release(); await f.cleanup(); }
});

dbtest('pending execution capability is hashed at rest and a wrong token cannot complete work', async () => {
  const f = fixture(), p = await f.provider(), pool = f.pool();
  try {
    const input = { text: 'capability', rounds: 1 }, quote = await p.quote(quoteOrder('compute', input));
    const challenge = challengeFromOrderMemoV3('compute', input, quote.memo), hash = mockHash(`${f.id}:execution-token`);
    const store = await openPostgresSellerStore({ pool, ...f.config }), token = '1'.repeat(64);
    assert.equal(await store.claim({ challenge, resource: 'compute', memo: quote.memo, product: products.compute,
      txHash: hash, agentPublicKey: String(agent.getPublicKey()), executionToken: token }), true);
    const row = (await pool.query('SELECT execution_token FROM bouncer_seller_v3.orders WHERE challenge=$1', [challenge])).rows[0];
    assert.notEqual(row.execution_token, token); assert.equal(row.execution_token, crypto.createHash('sha256').update(token).digest('hex'));
    await assert.rejects(store.complete({ challenge, txHash: hash, executionToken: '2'.repeat(64), result: { type: 'compute' } }), /not held by this worker/);
    assert.equal((await store.find(challenge)).status, 'pending');
    await store.complete({ challenge, txHash: hash, executionToken: token, result: { type: 'compute' } });
    assert.equal((await store.find(challenge)).status, 'completed');
  } finally { await f.cleanup(); }
});

dbtest('tampered FINAL receipts never reserve a paid quote; valid evidence can later claim it', async () => {
  const f = fixture(), p = await f.provider(), input = { text: 'settlement verification', rounds: 1 };
  try {
    const quote = await p.quote(quoteOrder('compute', input)), hash = mockHash(`${f.id}:tampered-final`);
    f.payment(hash, quote); const original = structuredClone(f.receipts.get(hash));
    const changed = structuredClone(original), transfer = changed.receipts.find(r => r.receipt_id === 'transfer');
    const args = JSON.parse(Buffer.from(transfer.receipt.Action.actions[0].FunctionCall.args, 'base64').toString());
    args.amount = '999';
    transfer.receipt.Action.actions[0].FunctionCall.args = Buffer.from(JSON.stringify(args)).toString('base64');
    f.receipts.set(hash, changed);
    const body = redemption(hash, 'compute', input, quote, await f.authorization(hash, quote));
    await assert.rejects(p.redeem(body), /verification failed/);
    assert.equal((await p.status()).length, 0);
    f.receipts.set(hash, original);
    assert.equal((await p.redeem(body)).type, 'compute');
  } finally { await f.cleanup(); }
});

dbtest('failed external fulfillment remains pending and is never repeated by another worker', async () => {
  let attempts = 0;
  const f = fixture({ dataFetch: async () => { attempts++; throw new Error('synthetic downstream failure'); } });
  const a = await f.provider(), b = await f.provider();
  try {
    const quote = await a.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:downstream-failure`);
    f.payment(hash, quote); const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    await assert.rejects(a.redeem(body), /pending.*reconcile/);
    await assert.rejects(b.redeem(body), /pending.*reconcile/);
    assert.equal(attempts, 1); assert.equal((await b.status())[0].status, 'pending');
  } finally { await f.cleanup(); }
});

dbtest('graceful shutdown drains a winning claim and refuses new work', async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ dataFetch: async () => { started(); await blocked; return githubResponse(); } });
  const a = await f.provider(), b = await f.provider();
  try {
    const quote = await a.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:drain`);
    f.payment(hash, quote); const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    const work = a.redeem(body); await entered;
    let closed = false; const shutdown = a.close().then(() => { closed = true; });
    await assert.rejects(a.quote(quoteOrder('api', { text: 'late' })), /shutting down/);
    assert.equal(closed, false); release();
    assert.equal((await work).repository_id, 42); await shutdown;
    assert.equal((await b.redeem(body)).repository_id, 42);
  } finally { release(); await f.cleanup(); }
});

dbtest('quote capacity and pinned seller identity are atomic across pools', async () => {
  const f = fixture({ maxQuotes: 7 }), a = await f.provider(), b = await f.provider();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).quote(quoteOrder('api', { text: String(i) }))));
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 7);
    assert.ok(attempts.filter(x => x.status === 'rejected').every(x => /capacity/.test(x.reason.message)));
    const check = await f.pool().query('SELECT issued_quotes FROM bouncer_seller_v3.sellers WHERE seller_id=$1', [f.id]);
    assert.equal(check.rows[0].issued_quotes, 7);
    await assert.rejects(f.provider({ products: { ...products, api: { ...products.api, amount: '999' } } }), /configuration changed/);
    await assert.rejects(f.provider({ sellerId: sellerId() }), /identity already belongs/);
  } finally { await f.cleanup(); }
});

// Simulates a lost acknowledgment AFTER PostgreSQL really committed. Only the
// specified transition is intercepted; no in-memory fake database is involved.
function lostCommitPool(pool, sqlMarker) {
  let enabled = false, fired = false;
  return { enable() { enabled = true; }, get fired() { return fired; }, async connect() {
    const c = await pool.connect(); let touched = false;
    return { release: (...args) => c.release(...args), async query(sql, args) {
      if (typeof sql === 'string' && sql.includes(sqlMarker)) touched = true;
      if (enabled && touched && !fired && sql === 'COMMIT') {
        await c.query(sql, args); fired = true; throw new Error('simulated lost commit acknowledgement');
      }
      return c.query(sql, args);
    } };
  } };
}

dbtest('lost claim COMMIT acknowledgment cannot start fulfillment or be stolen after restart', async () => {
  let executions = 0;
  const f = fixture({ dataFetch: async () => { executions++; return githubResponse(); } });
  const broken = lostCommitPool(f.pool(), "SET status = 'pending'");
  const a = await f.provider({ pool: broken }), b = await f.provider();
  try {
    const quote = await a.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:shared-claim-ack-lost`);
    f.payment(hash, quote); const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    broken.enable();
    await assert.rejects(a.redeem(body), /lost commit acknowledgement/);
    assert.equal(broken.fired, true); assert.equal(executions, 0);
    await assert.rejects(b.redeem(body), /pending.*reconcile/);
    assert.equal((await b.status())[0].status, 'pending'); assert.equal(executions, 0);
  } finally { await f.cleanup(); }
});

dbtest('lost completion COMMIT acknowledgment returns the persisted result without repeating work', async () => {
  let executions = 0;
  const f = fixture({ dataFetch: async () => { executions++; return githubResponse(); } });
  const broken = lostCommitPool(f.pool(), "SET status = 'completed'");
  const a = await f.provider({ pool: broken }), b = await f.provider();
  try {
    const quote = await a.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:shared-completion-ack-lost`);
    f.payment(hash, quote); const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    broken.enable();
    await assert.rejects(a.redeem(body), /pending.*reconcile/);
    assert.equal(broken.fired, true); assert.equal(executions, 1);
    assert.equal((await b.redeem(body)).repository_id, 42); assert.equal(executions, 1);
    assert.equal((await b.status())[0].status, 'completed');
  } finally { await f.cleanup(); }
});

function worker(f, events) {
  const filename = fileURLToPath(new URL('./fixtures/shared-seller-worker.mjs', import.meta.url));
  const child = fork(filename, [], { env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: databaseUrl,
    BOUNCER_TEST_SELLER: f.id, BOUNCER_TEST_ORIGIN: f.origin }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 2000); });
  child.on('message', message => events.emit('worker', { child, message }));
  child.on('exit', (code, signal) => events.emit('exit', { child, code, signal }));
  return { child, get stderr() { return stderr; }, base: null };
}
function waitEvent(events, filter, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.off('worker', onEvent); reject(new Error('worker event timeout')); }, ms);
    function onEvent(event) {
      if (event.message.type === 'error') { clearTimeout(timer); events.off('worker', onEvent); reject(new Error(event.message.message)); return; }
      if (filter(event)) { clearTimeout(timer); events.off('worker', onEvent); resolve(event); }
    }
    events.on('worker', onEvent);
  });
}
async function startWorkers(f, n, events) {
  const ready = [], workers = [];
  for (let i = 0; i < n; i++) {
    const p = waitEvent(events, event => event.message.type === 'ready');
    const w = worker(f, events); workers.push(w); ready.push(p.then(({ message }) => { w.base = `http://127.0.0.1:${message.port}`; }));
    // Start sequentially so a ready notification is never assigned to the wrong worker.
    await ready[i];
  }
  return workers;
}
async function setReceipt(w, events, hash, quote) {
  const id = crypto.randomBytes(4).toString('hex');
  const ack = waitEvent(events, event => event.child === w.child && event.message.type === 'receipt-ready' && event.message.id === id);
  w.child.send({ type: 'receipt', id, hash, quote, publicKey: String(agent.getPublicKey()) }); await ack;
}
async function closeWorker(w) {
  if (w.child.exitCode !== null || w.child.signalCode !== null) return;
  const exited = once(w.child, 'exit');
  if (w.child.connected) w.child.send({ type: 'close' });
  const timer = setTimeout(() => w.child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

dbtest('three separate Node workers racing one claim perform the external operation only once', async () => {
  const f = fixture(), parent = await f.provider(), events = new EventEmitter(); let workers = [];
  try {
    workers = await startWorkers(f, 3, events);
    const quote = await parent.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:shared-cross-process`);
    const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    await Promise.all(workers.map(w => setReceipt(w, events, hash, quote)));
    let starts = 0; events.on('worker', e => { if (e.message.type === 'fulfillment') starts++; });
    const started = waitEvent(events, e => e.message.type === 'fulfillment');
    let rejected = 0, rejectedReady;
    const losersReady = new Promise(resolve => { rejectedReady = resolve; });
    const requests = workers.map(async w => {
      const response = await post(w.base, '/redeem', body), value = await response.json();
      if (response.status === 409 && ++rejected === 2) rejectedReady();
      return { status: response.status, value };
    });
    const winner = await started;
    let deadline;
    try { await Promise.race([losersReady, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('losers did not return')), 10000); })]); }
    finally { clearTimeout(deadline); }
    assert.equal(starts, 1); winner.child.send({ type: 'release' });
    const results = await Promise.all(requests);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    const replay = await post(workers.find(w => w.child !== winner.child).base, '/redeem', body);
    assert.equal(replay.status, 200); assert.equal((await replay.json()).result.repository_id, 42); assert.equal(starts, 1);
  } finally { await Promise.allSettled(workers.map(closeWorker)); await f.cleanup(); }
});

dbtest('SIGKILL after the pending commit leaves a durable non-stealable order across processes', async () => {
  const f = fixture(), parent = await f.provider(), events = new EventEmitter(); let workers = [];
  try {
    workers = await startWorkers(f, 2, events);
    const quote = await parent.quote(quoteOrder('api', inputRepo)), hash = mockHash(`${f.id}:shared-worker-crash`);
    const body = redemption(hash, 'api', inputRepo, quote, await f.authorization(hash, quote));
    await Promise.all(workers.map(w => setReceipt(w, events, hash, quote)));
    let starts = 0; events.on('worker', e => { if (e.message.type === 'fulfillment') starts++; });
    const started = waitEvent(events, e => e.child === workers[0].child && e.message.type === 'fulfillment');
    const first = post(workers[0].base, '/redeem', body).then(r => r.status, () => 'connection lost');
    await started; const exited = once(workers[0].child, 'exit'); workers[0].child.kill('SIGKILL'); await exited;
    assert.equal(await first, 'connection lost');
    const recovery = await post(workers[1].base, '/redeem', body);
    assert.equal(recovery.status, 409); assert.match((await recovery.json()).error, /pending.*reconcile/);
    const additional = await startWorkers(f, 1, events); workers.push(...additional);
    await setReceipt(additional[0], events, hash, quote);
    const afterRestart = await post(additional[0].base, '/redeem', body);
    assert.equal(afterRestart.status, 409); assert.equal(starts, 1);
    const status = await parent.status(); assert.equal(status[0].status, 'pending'); assert.equal(status[0].tx_hash, hash);
  } finally { await Promise.allSettled(workers.map(closeWorker)); await f.cleanup(); }
});

dbtest('buyer recovers a lost synthetic payment through another worker and completes compute, storage and API', async () => {
  const f = fixture(), a = await f.provider(), b = await f.provider(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-buyer-'));
  const journal = new FileJournal(path.join(root, 'journal.json'), contract, owner);
  const keyPair = agent, signer = new nearApi.KeyPairSigner(keyPair), publicKey = keyPair.getPublicKey();
  let nonce = 0n, sends = 0, spent = 0n, lost = true;
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(owner, key, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const chain = { ...f.rpc,
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token: 'token.testnet', per_tx_cap: '1000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'daily_spent') return String(spent);
      if (method === 'vault_balance') return String(10000n - spent);
      if (method === 'ft_balance_of') return String(spent);
      throw new Error(`unexpected ${method}`);
    },
    async sendTransactionUntil(signed) {
      sends++;
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
      const entry = journal.list().find(e => e.tx_hash === hash); assert.equal(entry.status, 'pending');
      const r = entry.request;
      verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: f.origin,
        resource: r.resource, policy_id: r.policy_id, token: r.token, payee: r.payee, amount: r.amount, memo: r.memo, tx_hash: hash },
      entry.resource_authorization, String(publicKey));
      f.receipts.set(hash, mockGuardedPayment({ hash, owner, contract, publicKey: String(publicKey), args }));
      spent += BigInt(args.amount);
      if (lost) { lost = false; throw new Error('synthetic response loss after payment'); }
      return { transaction_outcome: { id: hash } };
    },
  };
  const goals = [
    { id: 'compute', resource: 'compute', input: { text: 'shared compute', rounds: 3 } },
    { id: 'storage', resource: 'storage', input: { name: 'file', content: 'shared database storage' } },
    { id: 'api', resource: 'api', input: { text: 'shared useful data' } },
  ].map(g => ({ ...g, policy_id: g.resource, token: 'token.testnet', payee: 'seller.testnet', max_amount: '1000', order_binding: 'seller-v3' }));
  try {
    const urlA = await listen(a), urlB = await listen(b);
    const client = url => routedResourceProvider({ providerUrl: f.origin, goals, overrides: new Map([[f.origin, url]]),
      fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }) });
    const run = (subset, url) => runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: subset, providerUrl: f.origin,
      provider: chain, account, publicKey, journal, ...client(url), execute: true, durablePayment: true, log: () => {} });
    await assert.rejects(run([goals[0]], urlA), /synthetic response loss/);
    const pending = structuredClone(journal.get('compute')); assert.equal(pending.status, 'pending'); assert.equal(sends, 1);
    await a.close();
    const recovered = await recoverResourceDelivery({ goal: goals[0], contractId: contract, ownerAccountId: owner, providerUrl: f.origin,
      provider: chain, journal, ...client(urlB), log: () => {} });
    assert.equal(recovered.receipt.tx_hash, pending.tx_hash); assert.equal(sends, 1);
    const result = await run(goals.slice(1), urlB);
    assert.equal(result.payments.paid, 2); assert.deepEqual(result.deliveries.map(d => d.id), ['storage', 'api']);
    assert.equal(sends, 3); assert.equal((await b.status()).filter(row => row.status === 'completed').length, 3);
    assert.ok(goals.every(g => journal.get(g.id).delivery.status === 'verified'));
  } finally { journal.close(); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});
