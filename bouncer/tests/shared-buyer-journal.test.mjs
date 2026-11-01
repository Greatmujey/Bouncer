// Real PostgreSQL and OS processes; all NEAR transactions/receipts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nearApi from 'near-api-js';
import { initializePostgresBuyerSchema, openPostgresBuyerJournal } from '../agent/postgres-buyer-journal.mjs';
import { readBuyerKeyFile, validateBuyerDatabaseUrl } from '../agent/shared-buyer-config.mjs';
import { requestFingerprint, runProcurement, validatePlan } from '../agent/procurement.mjs';
import { runResourceAgent, routedResourceProvider } from '../agent/resource-agent.mjs';
import { recoverDirectResourcePayment, recoverResourceDelivery } from '../agent/recover-direct-payment.mjs';
import { inspectSharedBuyer } from '../scripts/inspect-shared-buyer.mjs';
import { createResourceProvider } from '../services/resource-provider.mjs';
import { orderMemoV3 } from '../packages/provider-sdk/lib/resource-order.mjs';
import { signClaimAuthorization, verifyClaimAuthorization } from '../packages/provider-sdk/lib/resource-claim.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';
import { computeResult } from './mock-delivery.mjs';
import { runMixedMission } from '../agent/mixed-mission.mjs';
import { runPaidProjectMission } from '../agent/paid-mission.mjs';
import { runWorkflow } from '../agent/workflow.mjs';
import { runFtCallGoal, recoverFtCallGoal } from '../agent/ft-call.mjs';
import { runOnchainProofGoal } from '../agent/onchain-proof.mjs';
import { runOutlayerGoal, recoverOutlayerGoal } from '../agent/outlayer.mjs';
import { runOracleGoal, recoverOracleGoal } from '../agent/oracle-outlayer.mjs';
import { runProjectGoal, recoverProjectGoal } from '../agent/outlayer-project.mjs';

const databaseUrl = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !databaseUrl) throw new Error('PostgreSQL integration test URL is required');
const dbtest = databaseUrl ? test : test.skip;
const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'token.testnet', payee = 'seller.testnet';
const origin = 'https://synthetic-seller.example';
const agent = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(agent), publicKey = agent.getPublicKey();
const makePool = () => new pg.Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 5000 });
const id = () => `buyer-${crypto.randomBytes(8).toString('hex')}`;
const challenge = () => crypto.randomBytes(16).toString('hex');
const goal = { id: 'work', resource: 'compute', policy_id: 'resources', token, payee, max_amount: '1000',
  order_binding: 'seller-v3', input: { text: 'sensitive order contents', rounds: 2 } };
const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
  { policy_id: 'resources', token, payee, amount: '1000' }]));

if (databaseUrl) test.before(async () => {
  const pool = makePool();
  try { await initializePostgresBuyerSchema({ pool }); } finally { await pool.end(); }
});
async function fixture() {
  const pool = makePool(), key = crypto.randomBytes(32), journalId = id(), journals = new Set();
  async function open(overrides = {}) {
    const journal = await openPostgresBuyerJournal({ pool, contractId: contract, ownerAccountId: owner, journalId, key, ...overrides });
    journals.add(journal); return journal;
  }
  const journal = await open({ createNew: true });
  return { pool, key, journalId, journal, open, async cleanup() {
    await Promise.allSettled([...journals].map(item => item.close())); await pool.end();
  } };
}
async function pendingEntry({ requestId = 'work', c = challenge(), hash = mockHash(id()), sellerOrigin = origin, order = goal } = {}) {
  const memo = orderMemoV3(order.resource, order.input, c);
  const request = validatePlan({ contract_id: contract, owner_account_id: owner, requests: [{ id: requestId,
    resource: order.resource, policy_id: order.policy_id, token: order.token, payee: order.payee, amount: '1000', memo }] }).requests[0];
  const terms = { network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: sellerOrigin,
    resource: request.resource, policy_id: request.policy_id, token: request.token, payee: request.payee,
    amount: request.amount, memo: request.memo, tx_hash: hash };
  const authorization = await signClaimAuthorization({ terms, signer, publicKey });
  return { fingerprint: requestFingerprint(request), status: 'pending', request,
    provider_route: { provider_id: null, provider_origin: sellerOrigin }, started_at: new Date().toISOString(),
    payment_version: 'direct-signed-v1', agent_public_key: String(publicKey), tx_hash: hash, resource_authorization: authorization };
}
function syntheticRuntime(journal, { loseSend = true } = {}) {
  let sends = 0, balance = 0n, nonce = 0n, currentJournal = journal, shouldLoseSend = loseSend; const chains = new Map();
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(owner, key, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token, per_tx_cap: '1000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'daily_spent' || method === 'ft_balance_of') return String(balance);
      if (method === 'vault_balance') return String(10000n - balance);
      throw new Error('unexpected synthetic RPC method');
    },
    async sendTransactionUntil(signed) {
      sends++;
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      const recorded = currentJournal.list().find(entry => entry.tx_hash === txHash);
      assert.equal(recorded?.status, 'pending'); assert.ok(recorded.resource_authorization.signature);
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
      chains.set(txHash, mockGuardedPayment({ hash: txHash, owner, contract, publicKey: String(publicKey), args }));
      balance += BigInt(args.amount);
      if (shouldLoseSend) throw new Error('synthetic lost response after payment');
      return { transaction_outcome: { id: txHash } };
    },
    async txStatusReceipts(hash) { if (!chains.has(hash)) throw new Error('synthetic hash unknown'); return structuredClone(chains.get(hash)); },
  };
  const getQuote = async order => ({ resource: order.resource, ...products[order.resource],
    memo: orderMemoV3(order.resource, order.input, challenge()), auth_scheme: 'bouncer-nep413-claim-v1', seller_origin: origin });
  const run = (extra = {}) => runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: [goal], providerUrl: origin,
    getQuote, fulfill: async ({ input }) => computeResult(input), provider, account, publicKey, journal,
    execute: true, durablePayment: true, log: () => {}, ...extra });
  return { provider, account, getQuote, run, setJournal(value) { currentJournal = value; }, setLoseSend(value) { shouldLoseSend = value; },
    get sends() { return sends; }, chains };
}

// Simulates COMMIT acknowledgement loss AFTER a real PostgreSQL commit, or a
// failure before commit. The underlying database is never mocked.
function faultPool(pool, marker, afterCommit = true) {
  let enabled = false, fired = false;
  return { enable() { enabled = true; }, get fired() { return fired; }, async connect() {
    const c = await pool.connect(); let touched = false;
    return { on: c.on.bind(c), removeListener: c.removeListener.bind(c), release: c.release.bind(c), async query(sql, args) {
      if (typeof sql === 'string' && sql.includes(marker)) touched = true;
      if (enabled && touched && !fired && sql === 'COMMIT') {
        fired = true; if (afterCommit) await c.query(sql, args); throw new Error('synthetic lost acknowledgment password=secret-value');
      }
      return c.query(sql, args);
    } };
  } };
}

test('shared buyer database URL and encryption key file fail closed without exposing secrets', () => {
  const good = 'postgresql://u:secret@db.example/buyer?sslmode=verify-full';
  assert.equal(validateBuyerDatabaseUrl(good), good);
  assert.equal(validateBuyerDatabaseUrl('postgresql://u:secret@127.0.0.1/buyer'), 'postgresql://u:secret@127.0.0.1/buyer');
  for (const bad of ['postgresql://u:secret@db.example/buyer', 'postgresql://u:secret@db.example/buyer?sslmode=require',
    'postgresql://u:secret@127.0.0.1/buyer?host=elsewhere', 'postgresql://u:secret@db.example/buyer?sslmode=verify-full&sslmode=disable',
    'https://u:secret@db.example/buyer']) assert.throws(() => validateBuyerDatabaseUrl(bad), e => !e.message.includes('secret'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-buyer-key-')), file = path.join(dir, 'key'), link = path.join(dir, 'link');
  try {
    const key = crypto.randomBytes(32); fs.writeFileSync(file, key, { mode: 0o600 });
    assert.deepEqual(readBuyerKeyFile(file), key);
    fs.symlinkSync(file, link); assert.throws(() => readBuyerKeyFile(link), /owner-only/);
    fs.chmodSync(file, 0o644); assert.throws(() => readBuyerKeyFile(file), /owner-only/);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'short'); assert.throws(() => readBuyerKeyFile(file), /32 random bytes/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

dbtest('journal creation is explicit, locked, scoped, immutable and requires the original encryption key', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.open(), error => error.code === 'BUSY');
    assert.throws(() => f.journal.assertScope('other.testnet', owner), /different contract or owner/);
    assert.throws(() => f.journal.put('work', {}), /cannot be used/);
    await f.journal.close();
    await assert.rejects(f.open({ createNew: true }), error => error.code === 'ALREADY_EXISTS');
    await assert.rejects(f.open({ key: crypto.randomBytes(32) }), error => error.code === 'KEY_MISMATCH');
    await assert.rejects(f.open({ journalId: id() }), error => error.code === 'NOT_FOUND');
    const reopened = await f.open(); assert.deepEqual(reopened.list(), []);
  } finally { await f.cleanup(); }
});

dbtest('encrypted reservation persists claim and hash before an ambiguous send and recovers without a signer', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal);
  try {
    await assert.rejects(runtime.run(), /synthetic lost response/);
    const pending = f.journal.get(goal.id); assert.equal(pending.status, 'pending'); assert.equal(runtime.sends, 1);
    const rows = await f.pool.query('SELECT * FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId]);
    const wire = JSON.stringify(rows.rows);
    assert.equal(rows.rowCount, 1); assert.ok(!wire.includes(pending.resource_authorization.signature));
    assert.ok(!wire.includes(goal.input.text)); assert.ok(!wire.includes(pending.request.memo));
    await f.journal.close();
    const restarted = await f.open(); let quotes = 0;
    await assert.rejects(runtime.run({ journal: restarted, getQuote: async () => { quotes++; throw new Error('must not quote'); } }), /unresolved pending payment/);
    assert.equal(quotes, 0); assert.equal(runtime.sends, 1);
    const result = await recoverResourceDelivery({ goal, contractId: contract, ownerAccountId: owner, providerUrl: origin,
      provider: runtime.provider, journal: restarted, fulfill: async ({ input, authorization, tx_hash }) => {
        const request = restarted.get(goal.id).request;
        verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: origin,
          resource: request.resource, policy_id: request.policy_id, token, payee, amount: request.amount, memo: request.memo, tx_hash }, authorization, String(publicKey));
        return computeResult(input);
      }, log: () => {} });
    assert.equal(result.receipt.tx_hash, pending.tx_hash); assert.equal(restarted.get(goal.id).delivery.status, 'verified');
    assert.equal(runtime.sends, 1); // No signing or second broadcast during recovery.
    await restarted.close();
    const again = await f.open(); assert.equal(again.get(goal.id).tx_hash, pending.tx_hash);
    assert.equal(again.get(goal.id).delivery.status, 'verified');
  } finally { await f.cleanup(); }
});

dbtest('lost reservation COMMIT acknowledgement never broadcasts and leaves the original hash reserved', async () => {
  const f = await fixture();
  try {
    await f.journal.close();
    const broken = faultPool(f.pool, 'INSERT INTO bouncer_buyer_v1.entries');
    const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal); broken.enable();
    await assert.rejects(runtime.run(), error => /reservation failed or its commit is uncertain/.test(error.message) && !error.message.includes('secret-value'));
    assert.equal(broken.fired, true); assert.equal(runtime.sends, 0);
    assert.throws(() => journal.get(goal.id), /journal failed/);
    await journal.close();
    const reopened = await f.open(); assert.equal(reopened.get(goal.id).status, 'pending');
    let quotes = 0;
    await assert.rejects(runtime.run({ journal: reopened, getQuote: async () => { quotes++; } }), /unresolved pending payment/);
    assert.equal(quotes, 0); assert.equal(runtime.sends, 0);
  } finally { await f.cleanup(); }
});

dbtest('lost completion acknowledgment retains one payment; reopening uses original hash without signing', async () => {
  const f = await fixture();
  try {
    await f.journal.close();
    const broken = faultPool(f.pool, 'UPDATE bouncer_buyer_v1.entries');
    const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal, { loseSend: false }); broken.enable();
    await assert.rejects(runtime.run(), /update failed or its commit is uncertain/);
    assert.equal(broken.fired, true); assert.equal(runtime.sends, 1); await journal.close();
    const reopened = await f.open(); const entry = reopened.get(goal.id); assert.equal(entry.status, 'completed');
    const result = await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] },
      requestId: goal.id, provider: runtime.provider, journal: reopened, log: () => {} });
    assert.equal(result.settlement.tx_hash, entry.tx_hash); assert.equal(runtime.sends, 1);
  } finally { await f.cleanup(); }
});

dbtest('completion failure before COMMIT leaves pending and recovers the same hash, not another payment', async () => {
  const f = await fixture();
  try {
    await f.journal.close();
    const broken = faultPool(f.pool, 'UPDATE bouncer_buyer_v1.entries', false);
    const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal, { loseSend: false }); broken.enable();
    await assert.rejects(runtime.run(), /commit is uncertain/); assert.equal(runtime.sends, 1); await journal.close();
    const reopened = await f.open(), original = reopened.get(goal.id); assert.equal(original.status, 'pending');
    await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] },
      requestId: goal.id, provider: runtime.provider, journal: reopened, log: () => {} });
    assert.equal(reopened.get(goal.id).tx_hash, original.tx_hash); assert.equal(reopened.get(goal.id).status, 'completed'); assert.equal(runtime.sends, 1);
  } finally { await f.cleanup(); }
});

dbtest('pre-broadcast rejection persists a pending hash and sends nothing', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal);
  try {
    await assert.rejects(runtime.run({ beforeBroadcast: () => { throw new Error('review expired'); } }), /pre-broadcast guard rejected/);
    assert.equal(runtime.sends, 0); assert.equal(f.journal.get(goal.id).status, 'pending');
    await f.journal.close(); const reopened = await f.open();
    await assert.rejects(runtime.run({ journal: reopened }), /unresolved pending payment/); assert.equal(runtime.sends, 0);
  } finally { await f.cleanup(); }
});

dbtest('forged requests, signatures, non-v3 and immutable-payment mutations fail before sending', async () => {
  const f = await fixture();
  try {
    const original = await pendingEntry();
    const changes = [
      { ...original, tx_hash: 'not-a-hash' },
      { ...original, fingerprint: '0'.repeat(64) },
      { ...original, status: 'completed' },
      { ...original, resource_authorization: { ...original.resource_authorization, signature: Buffer.alloc(64).toString('base64') } },
      { ...original, provider_route: { provider_id: null, provider_origin: 'https://attacker.example' } },
      { ...original, request: { ...original.request, amount: '2000' } },
      { ...original, request: { ...original.request, memo: 'bouncer-order-v2:compute:' + '0'.repeat(32) + ':' + '0'.repeat(64) } },
    ];
    for (const item of changes) await assert.rejects(f.journal.reservePending('work', item));
    assert.deepEqual(f.journal.list(), []);
    assert.throws(() => f.journal.reservePending('other', { ...original, id: 'work' }), /entry ID/);
    await f.journal.reservePending('work', original);
    await assert.rejects(f.journal.writeDurable('work', { ...original, tx_hash: mockHash(id()), status: 'completed' }), /immutable/);
    await assert.rejects(f.journal.writeDurable('work', original), /cannot be replaced or reset/);
    let quotes = 0;
    await assert.rejects(runResourceAgent({ contractId: contract, ownerAccountId: owner, goals: [{ ...goal, order_binding: 'seller-v2' }],
      journal: f.journal, execute: false, getQuote: async () => { quotes++; } }), /only seller-v3/);
    assert.equal(quotes, 0);
  } finally { await f.cleanup(); }
});

dbtest('ciphertext, metadata and wrong-key tampering fail closed on reopen', async () => {
  for (const field of ['ciphertext', 'seller_origin', 'tx_hash', 'status', 'revision']) {
    const f = await fixture();
    try {
      await f.journal.reservePending('work', await pendingEntry()); await f.journal.close();
      if (field === 'ciphertext') await f.pool.query(`UPDATE bouncer_buyer_v1.entries SET ciphertext=set_byte(ciphertext, 0, get_byte(ciphertext,0) # 1) WHERE journal_id=$1`, [f.journalId]);
      if (field === 'seller_origin') await f.pool.query(`UPDATE bouncer_buyer_v1.entries SET seller_origin='https://attacker.example' WHERE journal_id=$1`, [f.journalId]);
      if (field === 'tx_hash') await f.pool.query('UPDATE bouncer_buyer_v1.entries SET tx_hash=$2 WHERE journal_id=$1', [f.journalId, mockHash(id())]);
      if (field === 'status') await f.pool.query(`UPDATE bouncer_buyer_v1.entries SET status='completed' WHERE journal_id=$1`, [f.journalId]);
      if (field === 'revision') await f.pool.query('UPDATE bouncer_buyer_v1.entries SET revision=revision+1 WHERE journal_id=$1', [f.journalId]);
      await assert.rejects(f.open(), error => error.code === 'CORRUPT');
    } finally { await f.cleanup(); }
  }
});

dbtest('read-only inspector returns metadata only and works without the encryption key', async () => {
  const f = await fixture(), client = await f.pool.connect(), role = `bouncer_buyer_read_${crypto.randomBytes(5).toString('hex')}`;
  let created = false;
  try {
    const entry = await pendingEntry(); await f.journal.reservePending('work', entry);
    await client.query(`CREATE ROLE ${role} NOLOGIN`); created = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_buyer_v1 TO ${role}`);
    await client.query(`GRANT SELECT (contract_id, owner_account_id, journal_id) ON bouncer_buyer_v1.journals TO ${role}`);
    await client.query(`GRANT SELECT (contract_id, owner_account_id, journal_id, entry_id, status, tx_hash, seller_origin, challenge, created_at, updated_at) ON bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const restrictedPool = { async connect() { return { query: client.query.bind(client), release() {} }; } };
    const result = await inspectSharedBuyer({ pool: restrictedPool, contractId: contract, ownerAccountId: owner, journalId: f.journalId });
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].tx_hash, entry.tx_hash);
    assert.ok(!JSON.stringify(result).includes(entry.resource_authorization.signature));
    await assert.rejects(client.query('SELECT ciphertext FROM bouncer_buyer_v1.entries'), /permission denied/);
    await assert.rejects(client.query('DELETE FROM bouncer_buyer_v1.entries'), /permission denied/);
  } finally {
    await client.query('RESET ROLE');
    if (created) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
    client.release(); await f.cleanup();
  }
});

dbtest('worker role can reserve without DDL, journal creation or DELETE permissions', async () => {
  const f = await fixture(), client = await f.pool.connect(), role = `bouncer_buyer_worker_${crypto.randomBytes(5).toString('hex')}`;
  let created = false;
  try {
    await f.journal.close();
    await client.query(`CREATE ROLE ${role} NOLOGIN`); created = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_buyer_v1 TO ${role}`);
    await client.query(`GRANT SELECT ON bouncer_buyer_v1.meta, bouncer_buyer_v1.journals TO ${role}`);
    await client.query(`GRANT SELECT, INSERT ON bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`GRANT UPDATE (status, revision, nonce, tag, ciphertext, updated_at) ON bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const restrictedPool = { async connect() { return { query: client.query.bind(client), on: client.on.bind(client),
      removeListener: client.removeListener.bind(client), release() {} }; } };
    const journal = await openPostgresBuyerJournal({ pool: restrictedPool, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    await journal.reservePending('work', await pendingEntry());
    const pending = journal.get('work'); assert.equal(pending.status, 'pending');
    await journal.writeDurable('work', { ...pending, status: 'completed', completed_at: new Date().toISOString(), settlement: {
      tx_hash: pending.tx_hash, token, payee, amount: '1000', verification: 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' } });
    assert.equal(journal.get('work').status, 'completed');
    await assert.rejects(client.query("UPDATE bouncer_buyer_v1.entries SET challenge='00000000000000000000000000000000'"), /permission denied/);
    await assert.rejects(client.query('DELETE FROM bouncer_buyer_v1.entries'), /permission denied/);
    await assert.rejects(client.query('CREATE TABLE bouncer_buyer_v1.must_not_exist(id int)'), /permission denied/);
    await journal.close();
    await assert.rejects(openPostgresBuyerJournal({ pool: restrictedPool, contractId: contract, ownerAccountId: owner, journalId: id(), key: f.key, createNew: true }));
  } finally {
    await client.query('RESET ROLE');
    if (created) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
    client.release(); await f.cleanup();
  }
});

dbtest('schema without critical challenge uniqueness is rejected before a worker starts', async () => {
  const admin = makePool(), dbName = `bouncer_buyer_${crypto.randomBytes(6).toString('hex')}`; let created = false, isolated;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`); created = true;
    const url = new URL(databaseUrl); url.pathname = `/${dbName}`;
    isolated = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await initializePostgresBuyerSchema({ pool: isolated });
    await isolated.query('ALTER TABLE bouncer_buyer_v1.entries DROP CONSTRAINT entries_challenge_key');
    await assert.rejects(openPostgresBuyerJournal({ pool: isolated, contractId: contract, ownerAccountId: owner,
      journalId: id(), key: crypto.randomBytes(32), createNew: true }), error => error.code === 'UNSAFE_SCHEMA');
  } finally {
    if (isolated) await isolated.end();
    if (created) await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  }
});

dbtest('a lost database session lock stops reservation before any simulated broadcast', async () => {
  const f = await fixture();
  try {
    await f.journal.close(); let sabotage = false;
    const broken = { async connect() {
      const client = await f.pool.connect();
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
        async query(sql, args) {
          if (sabotage && typeof sql === 'string' && sql.includes('FROM pg_catalog.pg_locks')) return { rows: [{ pid: -1, locked: false }] };
          return client.query(sql, args);
        } };
    } };
    const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal); sabotage = true;
    await assert.rejects(runtime.run(), error => error.code === 'SESSION_LOST' || /session lock was lost/.test(error.message));
    assert.equal(runtime.sends, 0); await journal.close();
    const reopened = await f.open(); assert.deepEqual(reopened.list(), []);
  } finally { await f.cleanup(); }
});

dbtest('direct seller-v3 compute, storage and API recover with a real local seller and synthetic receipts', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-pg-buyer-seller-'));
  const sellerOrigin = 'http://127.0.0.1:0';
  const goals = [
    { ...goal, id: 'compute', input: { text: 'compute', rounds: 3 } },
    { ...goal, id: 'storage', resource: 'storage', input: { name: 'private', content: 'private storage content' } },
    { ...goal, id: 'api', resource: 'api', input: { text: 'api credit data' } },
  ];
  let seller, client;
  async function startSeller() {
    seller = createResourceProvider({ rpcProvider: runtime.provider, contractId: contract, ownerAccountId: owner,
      products, dataDir: path.join(root, 'seller'), sellerOrigin });
    await new Promise(resolve => seller.server.listen(0, '127.0.0.1', resolve));
    const actual = `http://127.0.0.1:${seller.server.address().port}`;
    client = routedResourceProvider({ providerUrl: sellerOrigin, goals, overrides: new Map([[sellerOrigin, actual]]),
      fetchImpl: (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }) });
  }
  try {
    await startSeller();
    await assert.rejects(runtime.run({ goals: [goals[0]], providerUrl: sellerOrigin, ...client }), /synthetic lost response/);
    const pending = f.journal.get('compute'); assert.equal(pending.status, 'pending');
    await seller.close(); seller = null; await f.journal.close();
    const reopened = await f.open(); runtime.setJournal(reopened); await startSeller();
    const recovered = await recoverResourceDelivery({ goal: goals[0], contractId: contract, ownerAccountId: owner, providerUrl: sellerOrigin,
      provider: runtime.provider, journal: reopened, ...client, log: () => {} });
    assert.equal(recovered.receipt.tx_hash, pending.tx_hash); assert.equal(runtime.sends, 1);
    runtime.setLoseSend(false);
    const result = await runtime.run({ goals: goals.slice(1), providerUrl: sellerOrigin, journal: reopened, ...client });
    assert.equal(result.payments.paid, 2); assert.deepEqual(result.deliveries.map(x => x.id), ['storage', 'api']);
    assert.equal(runtime.sends, 3);
    for (const item of goals) assert.equal(reopened.get(item.id).delivery.status, 'verified');
    const raw = await f.pool.query('SELECT ciphertext FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId]);
    for (const row of raw.rows) assert.equal(row.ciphertext.includes(Buffer.from('private storage content')), false);
  } finally { if (seller) await seller.close(); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

function worker({ journalId, key, c, nonce, barrier = false, hold = false }) {
  const child = fork(fileURLToPath(new URL('./fixtures/shared-buyer-worker.mjs', import.meta.url)), [], {
    env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: databaseUrl, BOUNCER_TEST_JOURNAL: journalId,
      BOUNCER_TEST_JOURNAL_KEY: key.toString('hex'), BOUNCER_TEST_AGENT_KEY: agent.toString(),
      BOUNCER_TEST_CHALLENGE: c, BOUNCER_TEST_NONCE: String(nonce), BOUNCER_TEST_BARRIER: barrier ? '1' : '0', BOUNCER_TEST_HOLD: hold ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = []; let stderr = '';
  child.on('message', message => messages.push(message)); child.stderr.on('data', chunk => { stderr += chunk; });
  function wait(type) {
    const existing = messages.find(item => item.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`worker timed out waiting for ${type}: ${stderr}`)); }, 15000);
      const receive = message => { if (message.type === type) { cleanup(); resolve(message); } };
      const exited = code => { cleanup(); reject(new Error(`worker exited ${code} before ${type}: ${stderr}`)); };
      function cleanup() { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); }
      child.on('message', receive); child.once('exit', exited);
    });
  }
  async function waitExit() {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }
  return { child, messages, wait, waitExit, stop };
}

dbtest('different worker processes racing different journal IDs cannot pay the same seller challenge', async () => {
  const f = await fixture(); let a, b;
  try {
    await f.journal.close();
    const second = id(), created = await f.open({ journalId: second, createNew: true }); await created.close();
    const c = challenge();
    a = worker({ journalId: f.journalId, key: f.key, c, nonce: 1, barrier: true });
    b = worker({ journalId: second, key: f.key, c, nonce: 2, barrier: true });
    await Promise.all([a.wait('prepared'), b.wait('prepared')]);
    const signed = await Promise.all([a.wait('signed'), b.wait('signed')]);
    assert.notEqual(signed[0].hash, signed[1].hash); // duplicate quote, distinct signed transactions
    a.child.send({ type: 'go' }); b.child.send({ type: 'go' });
    const results = await Promise.all([a.wait('result'), b.wait('result')]);
    assert.equal(results.filter(item => item.code === 'CONFLICT').length, 1);
    const broadcasts = [...a.messages, ...b.messages].filter(item => item.type === 'broadcast');
    assert.equal(broadcasts.length, 1);
    const rows = await f.pool.query('SELECT tx_hash, status FROM bouncer_buyer_v1.entries WHERE challenge=$1', [c]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, 'pending'); assert.equal(rows.rows[0].tx_hash, broadcasts[0].hash);
  } finally { if (a) await a.stop(); if (b) await b.stop(); await f.cleanup(); }
});

dbtest('worker SIGKILL after reservation blocks another worker from requoting or resending the goal', async () => {
  const f = await fixture(); let a, b, c;
  try {
    await f.journal.close();
    a = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 10, hold: true });
    const broadcast = await a.wait('broadcast');
    b = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 11 });
    assert.equal((await b.wait('result')).code, 'BUSY');
    assert.equal(b.messages.filter(item => item.type === 'quote' || item.type === 'broadcast').length, 0);
    await a.stop();
    // Wait inside PostgreSQL for detection of the killed worker's closed socket;
    // an OS exit does not itself prove that the server released its lock yet.
    const words = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-lock-v1', contract, owner, f.journalId])).digest();
    const fence = await f.pool.connect();
    try {
      await fence.query("SET lock_timeout = '5s'");
      await fence.query('SELECT pg_catalog.pg_advisory_lock($1::integer, $2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
      await fence.query('SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
    } finally { fence.release(); }
    c = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 12 });
    const result = await c.wait('result'); assert.match(result.message, /unresolved pending payment/);
    assert.equal(c.messages.filter(item => item.type === 'quote' || item.type === 'broadcast').length, 0);
    await c.waitExit(); // result is sent before the worker releases its session lock
    const reopened = await f.open(); assert.equal(reopened.get('work').tx_hash, broadcast.hash); assert.equal(reopened.get('work').status, 'pending');
  } finally { if (a) await a.stop(); if (b) await b.stop(); if (c) await c.stop(); await f.cleanup(); }
});

test('unsupported mission and payment protocols reject the shared direct journal before external work', async () => {
  const journal = { sharedDirectV3: true };
  for (const run of [runMixedMission, runPaidProjectMission, runWorkflow, runFtCallGoal, recoverFtCallGoal, runOnchainProofGoal,
    runOutlayerGoal, recoverOutlayerGoal, runOracleGoal, recoverOracleGoal, runProjectGoal, recoverProjectGoal]) {
    await assert.rejects(run({ journal, execute: true }), /shared buyer journal does not coordinate/);
  }
});

dbtest('two concurrent calls sharing one async journal reserve one request before one broadcast', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal);
  try {
    const c = challenge(), request = (await pendingEntry({ c })).request;
    const plan = { contract_id: contract, owner_account_id: owner, requests: [request] };
    const journalRoutes = new Map([['work', { provider_id: null, provider_origin: origin }]]), claimOrigins = new Map([['work', origin]]);
    let prepared = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const run = () => runProcurement({ plan, provider: runtime.provider, account: runtime.account, publicKey, journal: f.journal,
      journalRoutes, claimOrigins, execute: true, durablePayment: true, log: () => {},
      beforePayment: async () => { if (++prepared === 2) release(); await barrier; } });
    const attempts = await Promise.allSettled([run(), run()]);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 2);
    assert.equal(runtime.sends, 1); assert.equal(f.journal.get('work').status, 'pending');
  } finally { await f.cleanup(); }
});

dbtest('unsafe primary status or database failure stops the signed payment before broadcast', async () => {
  for (const mode of ['replica', 'fsync', 'read_only', 'database_error']) {
    const f = await fixture();
    try {
      await f.journal.close(); let sabotage = false;
      const broken = { async connect() {
        const client = await f.pool.connect();
        return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
          async query(sql, args) {
            if (sabotage && typeof sql === 'string' && sql.includes("current_setting('fsync')")) {
              if (mode === 'replica') return { rows: [{ replica: true, fsync: 'on', read_only: 'off' }] };
              if (mode === 'fsync') return { rows: [{ replica: false, fsync: 'off', read_only: 'off' }] };
              if (mode === 'read_only') return { rows: [{ replica: false, fsync: 'on', read_only: 'on' }] };
            }
            if (sabotage && mode === 'database_error' && typeof sql === 'string' && sql.includes('INSERT INTO bouncer_buyer_v1.entries')) {
              throw new Error('synthetic database outage password=secret-value');
            }
            return client.query(sql, args);
          } };
      } };
      const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
      const runtime = syntheticRuntime(journal); sabotage = true;
      await assert.rejects(runtime.run(), error => !error.message.includes('secret-value') && /primary|reservation failed/.test(error.message));
      assert.equal(runtime.sends, 0); await journal.close();
      const reopened = await f.open(); assert.deepEqual(reopened.list(), []);
    } finally { await f.cleanup(); }
  }
});

async function runCli(script, args, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
  if (signal) throw new Error(`CLI stopped by ${signal}: ${stderr}`);
  return { code, stdout, stderr };
}

dbtest('actual shared-buyer CLIs inspect and recover a single original hash and delivery without a signing key', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-pg-buyer-cli-'));
  let sellerOrigin, entry, chain, rpcReads = 0, quotes = 0, broadcasts = 0, redemptions = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/rpc') {
        if (body.method === 'status') return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'testnet' } }));
        if (body.method === 'EXPERIMENTAL_tx_status') {
          rpcReads++; assert.equal(body.params.tx_hash, entry.tx_hash); assert.equal(body.params.sender_account_id, owner);
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: chain }));
        }
        broadcasts++; res.statusCode = 500; return res.end('{}');
      }
      if (req.url === '/quote') { quotes++; res.statusCode = 500; return res.end('{}'); }
      if (req.url === '/redeem') {
        redemptions++; assert.equal(body.tx_hash, entry.tx_hash); assert.deepEqual(body.input, goal.input);
        verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: sellerOrigin,
          resource: 'compute', policy_id: 'resources', token, payee, amount: '1000', memo: entry.request.memo, tx_hash: entry.tx_hash }, body.authorization, String(publicKey));
        return res.end(JSON.stringify({ ok: true, result: computeResult(body.input) }));
      }
      res.statusCode = 404; res.end('{}');
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    sellerOrigin = `http://127.0.0.1:${server.address().port}`;
    entry = await pendingEntry({ sellerOrigin });
    const args = { policy_id: entry.request.policy_id, payee, amount: '1000', memo: entry.request.memo, expected_token: token };
    chain = mockGuardedPayment({ hash: entry.tx_hash, owner, contract, publicKey: String(publicKey), args });
    await f.journal.reservePending('work', entry); await f.journal.close();
    const goalsPath = path.join(root, 'goals.json'), keyPath = path.join(root, 'journal.key');
    fs.writeFileSync(goalsPath, JSON.stringify({ contract_id: contract, owner_account_id: owner, provider_url: sellerOrigin, goals: [goal] }));
    fs.writeFileSync(keyPath, f.key, { mode: 0o600 });
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: keyPath };
    const rpcUrl = `${sellerOrigin}/rpc`;
    const inspect = await runCli('scripts/inspect-shared-buyer.mjs', ['--contract', contract, '--owner', owner, '--journal', f.journalId],
      { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: '' });
    assert.equal(inspect.code, 0, inspect.stderr); assert.match(inspect.stdout, new RegExp(entry.tx_hash));
    assert.ok(!inspect.stdout.includes(entry.resource_authorization.signature));
    const payment = await runCli('agent/recover-direct-payment.mjs', ['--goals', goalsPath, '--id', 'work', '--shared-journal', f.journalId, '--rpc', rpcUrl], env);
    assert.equal(payment.code, 0, payment.stderr); assert.match(payment.stdout, new RegExp(entry.tx_hash));
    const delivery = await runCli('agent/recover-direct-delivery.mjs', ['--goals', goalsPath, '--id', 'work', '--shared-journal', f.journalId, '--rpc', rpcUrl], env);
    assert.equal(delivery.code, 0, delivery.stderr); assert.match(delivery.stdout, new RegExp(entry.tx_hash));
    assert.ok(!delivery.stdout.includes(entry.resource_authorization.signature));
    assert.equal(rpcReads, 2); assert.equal(redemptions, 1); assert.equal(quotes, 0); assert.equal(broadcasts, 0);
    const recovered = await f.open(); assert.equal(recovered.get('work').delivery.status, 'verified');
  } finally { await new Promise(resolve => server.close(resolve)); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('journal initialization CLI is explicit and a file/shared journal mix fails before quoting', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-pg-buyer-init-'));
  try {
    await f.journal.close();
    const keyPath = path.join(root, 'key'), goalsPath = path.join(root, 'goals.json');
    fs.writeFileSync(keyPath, f.key, { mode: 0o600 });
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: keyPath };
    const registration = ['--contract', contract, '--owner', owner, '--journal', f.journalId, '--confirm-new'];
    const duplicate = await runCli('scripts/init-shared-buyer-journal.mjs', registration, env);
    assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already exists/);
    const next = id(), fresh = await runCli('scripts/init-shared-buyer-journal.mjs', ['--contract', contract, '--owner', owner, '--journal', next, '--confirm-new'], env);
    assert.equal(fresh.code, 0, fresh.stderr); assert.match(fresh.stdout, /no seller or NEAR was contacted/);
    const inspect = await runCli('scripts/inspect-shared-buyer.mjs', ['--contract', contract, '--owner', owner, '--journal', next],
      { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: '' });
    assert.equal(inspect.code, 0, inspect.stderr); assert.deepEqual(JSON.parse(inspect.stdout).entries, []);
    fs.writeFileSync(goalsPath, JSON.stringify({ contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] }));
    fs.writeFileSync(`${goalsPath}.bouncer-journal.json`, '{}');
    const mixed = await runCli('agent/resource-agent.mjs', ['--goals', goalsPath, '--key', 'never-read.json', '--shared-journal', next, '--durable', '--execute'], env);
    assert.equal(mixed.code, 1); assert.match(mixed.stderr, /file journal must be reconciled/);
    const absent = await runCli('agent/recover-direct-payment.mjs', ['--goals', goalsPath, '--id', 'work', '--shared-journal', id()], env);
    assert.equal(absent.code, 1); assert.match(absent.stderr, /original shared buyer journal not found/);
  } finally { await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('resource-agent CLI uses the shared journal for one synthetic payment and reuses it on restart', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-pg-resource-cli-'));
  let sellerOrigin, quotes = 0, redemptions = 0; const c = challenge();
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); res.setHeader('content-type', 'application/json');
      if (req.url === '/quote') {
        quotes++;
        return res.end(JSON.stringify({ ok: true, quote: { resource: body.resource, ...products[body.resource],
          memo: orderMemoV3(body.resource, body.input, c), auth_scheme: 'bouncer-nep413-claim-v1', seller_origin: sellerOrigin } }));
      }
      if (req.url === '/redeem') {
        redemptions++;
        verifyClaimAuthorization({ network: 'near:testnet', contract_id: contract, owner_account_id: owner, seller_origin: sellerOrigin,
          resource: 'compute', policy_id: 'resources', token, payee, amount: '1000', memo: body.memo, tx_hash: body.tx_hash }, body.authorization, String(publicKey));
        return res.end(JSON.stringify({ ok: true, result: computeResult(body.input) }));
      }
      res.statusCode = 404; res.end('{}');
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  try {
    await f.journal.close(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    sellerOrigin = `http://127.0.0.1:${server.address().port}`;
    const goalsPath = path.join(root, 'goals.json'), journalKeyPath = path.join(root, 'journal.key'), agentPath = path.join(root, 'agent.json');
    const stateFile = path.join(root, 'synthetic-rpc.json');
    fs.writeFileSync(goalsPath, JSON.stringify({ contract_id: contract, owner_account_id: owner, provider_url: sellerOrigin, goals: [goal] }));
    fs.writeFileSync(journalKeyPath, f.key, { mode: 0o600 });
    fs.writeFileSync(agentPath, JSON.stringify({ account_id: owner, private_key: agent.toString() }), { mode: 0o600 });
    const preload = fileURLToPath(new URL('./fixtures/mock-shared-buyer-cli.mjs', import.meta.url));
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: journalKeyPath,
      BOUNCER_TEST_BUYER_CLI_STATE: stateFile, NODE_OPTIONS: `--import=${preload}` };
    const args = ['--goals', goalsPath, '--key', agentPath, '--shared-journal', f.journalId, '--durable', '--execute'];
    const first = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(first.code, 0, first.stderr); assert.match(first.stdout, /PAID work/); assert.match(first.stdout, /FULFILLED work/);
    const again = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(again.code, 0, again.stderr); assert.match(again.stdout, /SKIP work/); assert.doesNotMatch(again.stdout, /PAID work/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends, 1); assert.equal(quotes, 1); assert.equal(redemptions, 2);
    const reopened = await f.open(); assert.equal(reopened.get('work').delivery.status, 'verified');
  } finally { await new Promise(resolve => server.close(resolve)); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('lost verified-delivery COMMIT acknowledgment never rolls back the confirmed payment', async () => {
  const f = await fixture();
  try {
    await f.journal.close();
    const broken = faultPool(f.pool, 'UPDATE bouncer_buyer_v1.entries');
    const journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal, { loseSend: false }); let deliveries = 0;
    await assert.rejects(runtime.run({ fulfill: async ({ input }) => { deliveries++; broken.enable(); return computeResult(input); } }), /update failed or its commit is uncertain/);
    assert.equal(deliveries, 1); assert.equal(runtime.sends, 1); await journal.close();
    const reopened = await f.open(), entry = reopened.get(goal.id);
    assert.equal(entry.status, 'completed'); assert.equal(entry.delivery.status, 'verified');
    const checked = await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] },
      requestId: goal.id, provider: runtime.provider, journal: reopened, log: () => {} });
    assert.equal(checked.settlement.tx_hash, entry.tx_hash); assert.equal(runtime.sends, 1); assert.equal(deliveries, 1);
  } finally { await f.cleanup(); }
});
