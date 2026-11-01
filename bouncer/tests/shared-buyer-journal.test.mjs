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
import { initializePostgresBuyerSchema, openPostgresBuyerJournal, verifyEncryptedBuyerSnapshot,
  compareEncryptedBuyerSnapshots, MAX_BUYER_SNAPSHOT_BYTES } from '../agent/postgres-buyer-journal.mjs';
import { readBuyerKeyFile, validateBuyerDatabaseUrl } from '../agent/shared-buyer-config.mjs';
import { requestFingerprint, runProcurement, validatePlan } from '../agent/procurement.mjs';
import { runResourceAgent, routedResourceProvider } from '../agent/resource-agent.mjs';
import { recoverDirectResourcePayment, recoverResourceDelivery } from '../agent/recover-direct-payment.mjs';
import { inspectSharedBuyer, inspectSharedBuyerOwner } from '../scripts/inspect-shared-buyer.mjs';
import { openBuyerCheckpointDirectory } from '../agent/buyer-checkpoint-directory.mjs';
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
// Distinct test runs never share an owner fence, even when using the same DB.
const owner = `buyer-${crypto.randomBytes(8).toString('hex')}.testnet`, contract = 'bouncer.testnet', token = 'token.testnet', payee = 'seller.testnet';
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
  const pool = makePool(), key = crypto.randomBytes(32), journalId = id(), journals = new Set(), created = new Set();
  async function open(overrides = {}) {
    const journal = await openPostgresBuyerJournal({ pool, contractId: contract, ownerAccountId: owner, journalId, key, ...overrides });
    if (overrides.createNew) created.add(overrides.journalId ?? journalId);
    journals.add(journal); return journal;
  }
  const journal = await open({ createNew: true });
  return { pool, key, journalId, journal, open, async cleanup() {
    await Promise.allSettled([...journals].map(item => item.close()));
    // Test-only cleanup in a disposable superuser database. Operational
    // journals must never be deleted to escape an unresolved payment.
    await pool.query('DELETE FROM bouncer_buyer_v1.entries WHERE journal_id=ANY($1::text[])', [[...created]]);
    await pool.query('DELETE FROM bouncer_buyer_v1.journals WHERE journal_id=ANY($1::text[])', [[...created]]);
    await pool.end();
  } };
}
const reserveSynthetic = (journal, entryId, entry) => journal.withOwnerFence(() => journal.reservePending(entryId, entry));
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

dbtest('lost owner-fence COMMIT acknowledgment stops before signing or broadcasting', async () => {
  const f = await fixture(); let journal;
  try {
    await f.journal.close();
    const broken = faultPool(f.pool, 'pg_try_advisory_lock');
    journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal); broken.enable();
    let signs = 0; const prepare = runtime.account.createTransaction;
    runtime.account.createTransaction = async (...args) => { signs++; return prepare(...args); };
    await assert.rejects(runtime.run(), error => /owner fence failed/.test(error.message) && !error.message.includes('secret-value'));
    assert.equal(broken.fired, true); assert.equal(signs, 0); assert.equal(runtime.sends, 0);
    await journal.close(); const reopened = await f.open(); assert.deepEqual(reopened.list(), []);
  } finally { if (journal) await journal.close(); await f.cleanup(); }
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
    assert.throws(() => f.journal.reservePending('work', original), error => error.code === 'OWNER_FENCE_REQUIRED');
    await f.journal.withOwnerFence(async () => {
      for (const item of changes) await assert.rejects(f.journal.reservePending('work', item));
      assert.deepEqual(f.journal.list(), []);
      assert.throws(() => f.journal.reservePending('other', { ...original, id: 'work' }), /entry ID/);
      await f.journal.reservePending('work', original);
    });
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
      await reserveSynthetic(f.journal, 'work', await pendingEntry()); await f.journal.close();
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
    const entry = await pendingEntry(); await reserveSynthetic(f.journal, 'work', entry);
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

dbtest('owner-wide pending inspection locates the original hash and recovery unblocks a different contract', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal), client = await f.pool.connect();
  const role = `bouncer_buyer_owner_read_${crypto.randomBytes(5).toString('hex')}`; let createdRole = false;
  try {
    const second = id(), secondContract = 'other-bouncer.testnet';
    const other = await f.open({ contractId: secondContract, journalId: second, createNew: true });
    await assert.rejects(runtime.run(), /synthetic lost response/);
    const pending = f.journal.get('work'); let entered = false;
    await assert.rejects(other.withOwnerFence(async () => { entered = true; }), error => error.code === 'OWNER_UNRESOLVED');
    assert.equal(entered, false); assert.equal(runtime.sends, 1);

    await client.query(`CREATE ROLE ${role} NOLOGIN`); createdRole = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_buyer_v1 TO ${role}`);
    await client.query(`GRANT SELECT (contract_id, owner_account_id, journal_id, entry_id, status, tx_hash, seller_origin, challenge, created_at, updated_at) ON bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const readOnlyPool = { async connect() { return { query: client.query.bind(client), release() {} }; } };
    const snapshot = await inspectSharedBuyerOwner({ pool: readOnlyPool, ownerAccountId: owner, limit: 1 });
    assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0].journal_id, f.journalId);
    assert.equal(snapshot.entries[0].contract_id, contract); assert.equal(snapshot.entries[0].tx_hash, pending.tx_hash);
    assert.equal(snapshot.has_more, false); assert.ok(!JSON.stringify(snapshot).includes(pending.resource_authorization.signature));
    assert.deepEqual((await inspectSharedBuyerOwner({ pool: readOnlyPool, ownerAccountId: owner, limit: 1, offset: 1 })).entries, []);
    await assert.rejects(client.query('SELECT ciphertext FROM bouncer_buyer_v1.entries'), /permission denied/);
    await assert.rejects(client.query('DELETE FROM bouncer_buyer_v1.entries'), /permission denied/);
    await client.query('RESET ROLE');

    const cli = await runCli('scripts/inspect-shared-buyer.mjs', ['--owner', owner, '--pending-owner', '--limit', '1'],
      { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: '' });
    assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).entries[0].tx_hash, pending.tx_hash);
    assert.ok(!cli.stdout.includes(pending.resource_authorization.signature));
    await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] },
      requestId: 'work', provider: runtime.provider, journal: f.journal, log: () => {} });
    assert.equal(f.journal.get('work').status, 'completed');
    assert.equal((await inspectSharedBuyerOwner({ pool: f.pool, ownerAccountId: owner })).entries.length, 0);
    assert.equal(await other.withOwnerFence(async () => 'available'), 'available');
    assert.equal(runtime.sends, 1); // recovery used no new signature or broadcast
  } finally {
    await client.query('RESET ROLE');
    if (createdRole) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
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
    await journal.withOwnerFence(async () => {
      await journal.reservePending('work', await pendingEntry());
      const original = journal.get('work');
      assert.equal(verifyEncryptedBuyerSnapshot(await journal.exportEncryptedSnapshot(), f.key).entries[0].tx_hash, original.tx_hash);
      await journal.assertPendingForBroadcast('work', original.tx_hash);
    });
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

dbtest('adding the optional owner index preserves old v1 pending entries without a data migration', async () => {
  const f = await fixture();
  try {
    const entry = await pendingEntry(); await reserveSynthetic(f.journal, 'work', entry); await f.journal.close();
    await f.pool.query('DROP INDEX bouncer_buyer_v1.entries_owner_pending_idx');
    const before = await f.open();
    await assert.rejects(before.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    assert.equal(before.get('work').tx_hash, entry.tx_hash); await before.close();
    await initializePostgresBuyerSchema({ pool: f.pool });
    const reopened = await f.open(); assert.equal(reopened.get('work').tx_hash, entry.tx_hash);
    await assert.rejects(reopened.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    assert.equal((await f.pool.query("SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='bouncer_buyer_v1' AND indexname='entries_owner_pending_idx'")).rowCount, 1);
  } finally {
    // Test-only schema setup restores the optional index even on an assertion failure.
    await initializePostgresBuyerSchema({ pool: f.pool }); await f.cleanup();
  }
});

dbtest('row-level security cannot hide another journal from the owner fence or inspector', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal);
  try {
    await f.pool.query('ALTER TABLE bouncer_buyer_v1.entries ENABLE ROW LEVEL SECURITY');
    await assert.rejects(runtime.run(), error => error.code === 'UNSAFE_SCHEMA' && /row-level security/.test(error.message));
    assert.equal(runtime.sends, 0);
    await assert.rejects(inspectSharedBuyerOwner({ pool: f.pool, ownerAccountId: owner }), /row-level filtering/);
    assert.throws(() => f.journal.list(), /journal failed/);
  } finally {
    await f.pool.query('ALTER TABLE bouncer_buyer_v1.entries DISABLE ROW LEVEL SECURITY');
    await f.cleanup();
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

dbtest('losing only the owner fence before reservation prevents a broadcast', async () => {
  const f = await fixture(); let journal;
  try {
    await f.journal.close(); let sabotage = false;
    const digest = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-owner-fence-v1', 'near:testnet', owner])).digest();
    const signed = [digest.readInt32BE(0), digest.readInt32BE(4)];
    const broken = { async connect() {
      const client = await f.pool.connect();
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
        async query(sql, args) {
          if (sabotage && typeof sql === 'string' && sql.includes('FROM pg_catalog.pg_locks')) {
            sabotage = false;
            const released = await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer) AS unlocked', signed);
            assert.equal(released.rows[0].unlocked, true);
          }
          return client.query(sql, args);
        } };
    } };
    journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal);
    await assert.rejects(runtime.run({ beforePayment: async () => { sabotage = true; } }), error => error.code === 'SESSION_LOST');
    assert.equal(runtime.sends, 0); await journal.close();
    const reopened = await f.open(); assert.deepEqual(reopened.list(), []);
  } finally { if (journal) await journal.close(); await f.cleanup(); }
});

dbtest('a lost owner fence after reservation stops broadcast and leaves the committed hash quarantined', async () => {
  const f = await fixture(); let journal;
  try {
    await f.journal.close();
    const second = await f.open({ journalId: id(), createNew: true });
    const digest = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-owner-fence-v1', 'near:testnet', owner])).digest();
    const signed = [digest.readInt32BE(0), digest.readInt32BE(4)];
    const broken = { async connect() {
      const client = await f.pool.connect(); let inserted = false;
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
        async query(sql, args) {
          if (typeof sql === 'string' && sql.includes('INSERT INTO bouncer_buyer_v1.entries')) inserted = true;
          if (inserted && sql === 'COMMIT') {
            inserted = false; const result = await client.query(sql, args);
            const released = await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer) AS unlocked', signed);
            assert.equal(released.rows[0].unlocked, true);
            return result;
          }
          return client.query(sql, args);
        } };
    } };
    journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    const runtime = syntheticRuntime(journal);
    await assert.rejects(runtime.run(), /shared journal pre-broadcast check failed.*no payment was sent/);
    assert.equal(runtime.sends, 0);
    let called = false;
    await assert.rejects(second.withOwnerFence(async () => { called = true; }), error => error.code === 'OWNER_UNRESOLVED');
    assert.equal(called, false); await journal.close();
    const reopened = await f.open(); assert.equal(reopened.get('work').status, 'pending');
    await assert.rejects(second.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
  } finally { if (journal) await journal.close(); await f.cleanup(); }
});

dbtest('closing an in-flight fenced journal destroys its session without releasing a pending owner', async () => {
  const f = await fixture(); let release;
  try {
    const other = await f.open({ journalId: id(), createNew: true });
    let ready; const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const operation = f.journal.withOwnerFence(async () => {
      await f.journal.reservePending('work', await pendingEntry()); ready(); await gate;
    });
    await entered; const original = f.journal.get('work');
    await f.journal.close();
    // Wait for the destroyed backend to release the advisory session lock.
    const digest = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-owner-fence-v1', 'near:testnet', owner])).digest();
    const lock = [digest.readInt32BE(0), digest.readInt32BE(4)], client = await f.pool.connect();
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query('SELECT pg_catalog.pg_advisory_lock($1::integer,$2::integer)', lock);
      await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)', lock);
    } finally { client.release(); }
    await assert.rejects(other.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    release(); await operation;
    const reopened = await f.open(); assert.equal(reopened.get('work').tx_hash, original.tx_hash);
    assert.equal(reopened.get('work').status, 'pending');
  } finally { release?.(); await f.cleanup(); }
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

function worker({ journalId, key, c, nonce, barrier = false, hold = false, checkpointDir = '', checkpointHold = false, workerOwner = owner, workerAgent = agent }) {
  const child = fork(fileURLToPath(new URL('./fixtures/shared-buyer-worker.mjs', import.meta.url)), [], {
    env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: databaseUrl, BOUNCER_TEST_JOURNAL: journalId, BOUNCER_TEST_OWNER: workerOwner,
      BOUNCER_TEST_JOURNAL_KEY: key.toString('hex'), BOUNCER_TEST_AGENT_KEY: workerAgent.toString(),
      BOUNCER_TEST_CHALLENGE: c, BOUNCER_TEST_NONCE: String(nonce), BOUNCER_TEST_BARRIER: barrier ? '1' : '0', BOUNCER_TEST_HOLD: hold ? '1' : '0',
      BOUNCER_TEST_CHECKPOINT_DIR: checkpointDir, BOUNCER_TEST_CHECKPOINT_HOLD: checkpointHold ? '1' : '0' },
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

dbtest('different owner accounts may run concurrently but cannot pay the same seller challenge', async () => {
  const f = await fixture(); let a, b;
  try {
    await f.journal.close();
    const second = id(), otherOwner = `other-${crypto.randomBytes(6).toString('hex')}.testnet`;
    const created = await f.open({ journalId: second, ownerAccountId: otherOwner, createNew: true }); await created.close();
    const c = challenge();
    a = worker({ journalId: f.journalId, key: f.key, c, nonce: 1, barrier: true });
    b = worker({ journalId: second, key: f.key, c, nonce: 2, barrier: true, workerOwner: otherOwner });
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

dbtest('different journals for the same owner cannot prepare or sign concurrently, even with different keys', async () => {
  const f = await fixture(); let a, b, c;
  try {
    await f.journal.close();
    const second = id(), created = await f.open({ journalId: second, createNew: true }); await created.close();
    a = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 1, barrier: true });
    await a.wait('prepared'); // the first worker is inside the owner fence
    b = worker({ journalId: second, key: f.key, c: challenge(), nonce: 2 });
    assert.equal((await b.wait('result')).code, 'OWNER_BUSY');
    assert.equal(b.messages.filter(item => item.type === 'signed' || item.type === 'broadcast').length, 0);
    await b.waitExit();
    c = worker({ journalId: second, key: f.key, c: challenge(), nonce: 3, workerAgent: nearApi.KeyPair.fromRandom('ed25519') });
    assert.equal((await c.wait('result')).code, 'OWNER_BUSY');
    assert.equal(c.messages.filter(item => item.type === 'signed' || item.type === 'broadcast').length, 0);
    a.child.send({ type: 'go' });
    const sent = await a.wait('broadcast');
    assert.ok(sent.hash); assert.match((await a.wait('result')).message, /synthetic ambiguous send/);
    const rows = await f.pool.query("SELECT status, tx_hash FROM bouncer_buyer_v1.entries WHERE owner_account_id=$1", [owner]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, 'pending'); assert.equal(rows.rows[0].tx_hash, sent.hash);
  } finally { if (a) await a.stop(); if (b) await b.stop(); if (c) await c.stop(); await f.cleanup(); }
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

dbtest('SIGKILL leaves a cross-journal owner quarantine until the original hash is recovered', async () => {
  const f = await fixture(); let a, b, c;
  try {
    await f.journal.close();
    const second = id(), created = await f.open({ journalId: second, createNew: true }); await created.close();
    a = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 31, hold: true });
    const original = await a.wait('broadcast'); await a.stop();
    // OS process death precedes PostgreSQL noticing the closed session. Wait
    // for the owner lock itself instead of racing a fixed sleep.
    const digest = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-owner-fence-v1', 'near:testnet', owner])).digest();
    const lock = [digest.readInt32BE(0), digest.readInt32BE(4)], client = await f.pool.connect();
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query('SELECT pg_catalog.pg_advisory_lock($1::integer,$2::integer)', lock);
      await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)', lock);
    } finally { client.release(); }
    b = worker({ journalId: second, key: f.key, c: challenge(), nonce: 32 });
    assert.equal((await b.wait('result')).code, 'OWNER_UNRESOLVED');
    assert.equal(b.messages.filter(item => item.type === 'signed' || item.type === 'broadcast').length, 0);
    await b.waitExit();

    const reopened = await f.open(), pending = reopened.get('work');
    assert.equal(pending.tx_hash, original.hash);
    const args = { policy_id: pending.request.policy_id, payee: pending.request.payee, amount: pending.request.amount,
      memo: pending.request.memo, expected_token: pending.request.token };
    const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
      async txStatusReceipts(hash) { assert.equal(hash, original.hash); return mockGuardedPayment({ hash, owner, contract, publicKey: String(publicKey), args }); } };
    const processGoal = { ...goal, input: { text: 'process race', rounds: 2 } };
    await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [processGoal] },
      requestId: 'work', provider, journal: reopened, log: () => {} });
    assert.equal(reopened.get('work').status, 'completed');
    c = worker({ journalId: second, key: f.key, c: challenge(), nonce: 33 });
    assert.notEqual((await c.wait('broadcast')).hash, original.hash);
    assert.match((await c.wait('result')).message, /synthetic ambiguous send/);
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
    let release, ready;
    const barrier = new Promise(resolve => { release = resolve; }), prepared = new Promise(resolve => { ready = resolve; });
    const run = () => runProcurement({ plan, provider: runtime.provider, account: runtime.account, publicKey, journal: f.journal,
      journalRoutes, claimOrigins, execute: true, durablePayment: true, log: () => {},
      beforePayment: async () => { ready(); await barrier; } });
    const first = run(); await prepared;
    await assert.rejects(run(), error => error.code === 'OWNER_BUSY');
    release(); await assert.rejects(first, /synthetic lost response/);
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
    await reserveSynthetic(f.journal, 'work', entry); await f.journal.close();
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
    const stateFile = path.join(root, 'synthetic-rpc.json'), checkpointDir = path.join(root, 'checkpoints');
    fs.mkdirSync(checkpointDir, { mode: 0o700 });
    fs.writeFileSync(goalsPath, JSON.stringify({ contract_id: contract, owner_account_id: owner, provider_url: sellerOrigin, goals: [goal] }));
    fs.writeFileSync(journalKeyPath, f.key, { mode: 0o600 });
    fs.writeFileSync(agentPath, JSON.stringify({ account_id: owner, private_key: agent.toString() }), { mode: 0o600 });
    const preload = fileURLToPath(new URL('./fixtures/mock-shared-buyer-cli.mjs', import.meta.url));
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: journalKeyPath, BOUNCER_BUYER_SNAPSHOT_KEY_FILE: '',
      BOUNCER_TEST_OWNER: owner, BOUNCER_TEST_BUYER_CLI_STATE: stateFile, BOUNCER_TEST_CHECKPOINT_DIR: checkpointDir, NODE_OPTIONS: `--import=${preload}` };
    const args = ['--goals', goalsPath, '--key', agentPath, '--shared-journal', f.journalId, '--checkpoint-dir', checkpointDir, '--durable', '--execute'];
    const first = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(first.code, 0, first.stderr); assert.match(first.stdout, /PAID work/); assert.match(first.stdout, /FULFILLED work/);
    const again = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(again.code, 0, again.stderr); assert.match(again.stdout, /SKIP work/); assert.doesNotMatch(again.stdout, /PAID work/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends, 1); assert.equal(quotes, 1); assert.equal(redemptions, 2);
    const files = fs.readdirSync(checkpointDir); assert.equal(files.length, 1);
    const checkpointFile = path.join(checkpointDir, files[0]), snapshot = fs.readFileSync(checkpointFile, 'utf8');
    assert.equal(verifyEncryptedBuyerSnapshot(snapshot, f.key).entries[0].status, 'pending');
    // Losing a checkpoint while the database has a payment blocks restart before
    // any quote or synthetic broadcast; do not silently recreate the directory.
    fs.unlinkSync(checkpointFile);
    const missing = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(missing.code, 1); assert.match(missing.stderr, /checkpoint directory/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends, 1); assert.equal(quotes, 1);
    fs.writeFileSync(checkpointFile, snapshot, { mode: 0o600 });
    const reopened = await f.open(); assert.equal(reopened.get('work').delivery.status, 'verified');
    await reopened.close();
    // Test-only stale restore: deleting an entry is forbidden operationally.
    await f.pool.query('DELETE FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId]);
    const stale = await runCli('agent/resource-agent.mjs', args, env);
    assert.equal(stale.code, 1); assert.match(stale.stderr, /checkpoint directory/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).sends, 1); assert.equal(quotes, 1);
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

dbtest('atomic buyer key rotation preserves completed and pending payments and their owner quarantine', async () => {
  const f = await fixture(), next = crypto.randomBytes(32), runtime = syntheticRuntime(f.journal, { loseSend: false });
  try {
    await runtime.run();
    const pending = await pendingEntry({ requestId: 'z-pending' });
    await reserveSynthetic(f.journal, 'z-pending', pending);
    const original = f.journal.list();
    assert.equal(original.find(item => item.id === 'work').status, 'completed');
    assert.equal(original.find(item => item.id === 'z-pending').status, 'pending');
    const before = await f.pool.query(`SELECT entry_id, status, tx_hash, challenge, revision, nonce, ciphertext, tag
      FROM bouncer_buyer_v1.entries WHERE journal_id=$1 ORDER BY entry_id`, [f.journalId]);
    await assert.rejects(f.journal.rotateEncryptionKey(f.key), /must differ/);
    assert.deepEqual(await f.journal.rotateEncryptionKey(next), { rotated_entries: 2 });
    assert.deepEqual(f.journal.list(), original); assert.equal(runtime.sends, 1);
    const after = await f.pool.query(`SELECT entry_id, status, tx_hash, challenge, revision, nonce, ciphertext, tag
      FROM bouncer_buyer_v1.entries WHERE journal_id=$1 ORDER BY entry_id`, [f.journalId]);
    for (let i = 0; i < before.rows.length; i++) {
      const a = before.rows[i], b = after.rows[i];
      for (const field of ['entry_id', 'status', 'tx_hash', 'challenge', 'revision']) assert.deepEqual(b[field], a[field]);
      assert.notDeepEqual(b.nonce, a.nonce); assert.notDeepEqual(b.ciphertext, a.ciphertext); assert.notDeepEqual(b.tag, a.tag);
    }
    assert.ok(!JSON.stringify(after.rows).includes(pending.resource_authorization.signature));
    await f.journal.close();
    await assert.rejects(f.open(), error => error.code === 'KEY_MISMATCH');
    const reopened = await f.open({ key: next });
    assert.deepEqual(reopened.list(), original);
    await assert.rejects(reopened.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    assert.equal(runtime.sends, 1);
  } finally { next.fill(0); await f.cleanup(); }
});

dbtest('uncertain rotation COMMIT preserves exactly the old or new key and never changes a pending hash', async () => {
  for (const afterCommit of [false, true]) {
    const f = await fixture(), next = crypto.randomBytes(32); let journal;
    try {
      const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending); await f.journal.close();
      const broken = faultPool(f.pool, 'UPDATE bouncer_buyer_v1.journals SET key_check', afterCommit);
      journal = await openPostgresBuyerJournal({ pool: broken, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
      broken.enable();
      await assert.rejects(journal.rotateEncryptionKey(next), error => error.code === 'ROTATION_UNCERTAIN' &&
        /preserve BOTH keys/.test(error.message) && !error.message.includes('secret-value'));
      assert.equal(broken.fired, true); assert.throws(() => journal.list(), /journal failed/); await journal.close();
      const winningKey = afterCommit ? next : f.key, losingKey = afterCommit ? f.key : next;
      await assert.rejects(f.open({ key: losingKey }), error => error.code === 'KEY_MISMATCH');
      const reopened = await f.open({ key: winningKey });
      assert.equal(reopened.get('work').tx_hash, pending.tx_hash); assert.equal(reopened.get('work').status, 'pending');
      await assert.rejects(reopened.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    } finally { if (journal) await journal.close(); next.fill(0); await f.cleanup(); }
  }
});

dbtest('tampering during key rotation rolls back already re-encrypted rows and fails closed', async () => {
  const f = await fixture(), next = crypto.randomBytes(32), runtime = syntheticRuntime(f.journal, { loseSend: false });
  try {
    await runtime.run(); await reserveSynthetic(f.journal, 'z-pending', await pendingEntry({ requestId: 'z-pending' }));
    const before = await f.pool.query(`SELECT entry_id, ciphertext FROM bouncer_buyer_v1.entries WHERE journal_id=$1 ORDER BY entry_id`, [f.journalId]);
    const keyBefore = (await f.pool.query('SELECT key_check FROM bouncer_buyer_v1.journals WHERE journal_id=$1', [f.journalId])).rows[0].key_check;
    const corrupted = Buffer.from(before.rows[1].ciphertext); corrupted[0] ^= 1;
    await f.pool.query('UPDATE bouncer_buyer_v1.entries SET ciphertext=$3 WHERE journal_id=$1 AND entry_id=$2', [f.journalId, 'z-pending', corrupted]);
    await assert.rejects(f.journal.rotateEncryptionKey(next), error => error.code === 'CORRUPT');
    assert.throws(() => f.journal.list(), /journal failed/); await f.journal.close();
    const after = await f.pool.query('SELECT entry_id, ciphertext FROM bouncer_buyer_v1.entries WHERE journal_id=$1 ORDER BY entry_id', [f.journalId]);
    assert.deepEqual(after.rows[0].ciphertext, before.rows[0].ciphertext);
    assert.deepEqual(after.rows[1].ciphertext, corrupted);
    assert.deepEqual((await f.pool.query('SELECT key_check FROM bouncer_buyer_v1.journals WHERE journal_id=$1', [f.journalId])).rows[0].key_check, keyBefore);
    await assert.rejects(f.open({ key: next }), error => error.code === 'KEY_MISMATCH');
    await f.pool.query('UPDATE bouncer_buyer_v1.entries SET ciphertext=$3 WHERE journal_id=$1 AND entry_id=$2', [f.journalId, 'z-pending', before.rows[1].ciphertext]);
    const recovered = await f.open(); assert.equal(recovered.get('work').status, 'completed'); assert.equal(recovered.get('z-pending').status, 'pending');
    assert.equal(runtime.sends, 1);
  } finally { next.fill(0); await f.cleanup(); }
});

dbtest('rotation excludes active payments, other journal sessions and overlapping rotation', async () => {
  const f = await fixture(), next = crypto.randomBytes(32); let journal, releaseUpdate;
  try {
    let enteredFence, releaseFence;
    const inFence = new Promise(resolve => { enteredFence = resolve; }), fenceGate = new Promise(resolve => { releaseFence = resolve; });
    const payment = f.journal.withOwnerFence(async () => { enteredFence(); await fenceGate; });
    await inFence; await assert.rejects(f.journal.rotateEncryptionKey(next), error => error.code === 'BUSY');
    releaseFence(); await payment;
    await reserveSynthetic(f.journal, 'work', await pendingEntry()); await f.journal.close();
    let enabled = false, notifyUpdate;
    const updating = new Promise(resolve => { notifyUpdate = resolve; }), updateGate = new Promise(resolve => { releaseUpdate = resolve; });
    const blocked = { async connect() {
      const c = await f.pool.connect();
      return { on: c.on.bind(c), removeListener: c.removeListener.bind(c), release: c.release.bind(c), async query(sql, args) {
        if (enabled && typeof sql === 'string' && sql.includes('UPDATE bouncer_buyer_v1.entries SET nonce')) {
          enabled = false; notifyUpdate(); await updateGate;
        }
        return c.query(sql, args);
      } };
    } };
    journal = await openPostgresBuyerJournal({ pool: blocked, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    enabled = true; const rotating = journal.rotateEncryptionKey(next); await updating;
    await assert.rejects(journal.withOwnerFence(async () => {}), error => error.code === 'BUSY');
    assert.throws(() => journal.exportEncryptedSnapshot(), error => error.code === 'BUSY');
    await assert.rejects(journal.rotateEncryptionKey(crypto.randomBytes(32)), error => error.code === 'BUSY');
    await assert.rejects(f.open(), error => error.code === 'BUSY');
    releaseUpdate(); releaseUpdate = null; assert.deepEqual(await rotating, { rotated_entries: 1 });
    await journal.close(); const reopened = await f.open({ key: next }); assert.equal(reopened.get('work').status, 'pending');
  } finally { if (releaseUpdate) releaseUpdate(); if (journal) await journal.close(); next.fill(0); await f.cleanup(); }
});

dbtest('a restricted rotation role can rewrite only key material, not delete payments or alter their status', async () => {
  const f = await fixture(), next = crypto.randomBytes(32), client = await f.pool.connect();
  const role = `bouncer_buyer_rotate_${crypto.randomBytes(5).toString('hex')}`; let created = false, journal;
  try {
    await reserveSynthetic(f.journal, 'work', await pendingEntry()); await f.journal.close();
    await client.query(`CREATE ROLE ${role} NOLOGIN`); created = true;
    await client.query(`GRANT USAGE ON SCHEMA bouncer_buyer_v1 TO ${role}`);
    await client.query(`GRANT SELECT ON bouncer_buyer_v1.meta, bouncer_buyer_v1.journals, bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`GRANT UPDATE (key_check) ON bouncer_buyer_v1.journals TO ${role}`);
    await client.query(`GRANT UPDATE (nonce, tag, ciphertext) ON bouncer_buyer_v1.entries TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const restricted = { async connect() { return { query: client.query.bind(client), on: client.on.bind(client),
      removeListener: client.removeListener.bind(client), release() {} }; } };
    journal = await openPostgresBuyerJournal({ pool: restricted, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
    assert.deepEqual(await journal.rotateEncryptionKey(next), { rotated_entries: 1 });
    await assert.rejects(client.query(`UPDATE bouncer_buyer_v1.entries SET status='completed' WHERE journal_id=$1`, [f.journalId]), /permission denied/);
    await assert.rejects(client.query('DELETE FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId]), /permission denied/);
    await journal.close(); journal = null;
    await client.query('RESET ROLE'); const reopened = await f.open({ key: next }); assert.equal(reopened.get('work').status, 'pending');
  } finally {
    if (journal) await journal.close(); await client.query('RESET ROLE');
    if (created) { await client.query(`DROP OWNED BY ${role}`); await client.query(`DROP ROLE ${role}`); }
    client.release(); next.fill(0); await f.cleanup();
  }
});

dbtest('rotation CLI checks both protected key files and can recover the current key without signing', async () => {
  const f = await fixture(), next = crypto.randomBytes(32), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-buyer-rotation-'));
  try {
    await reserveSynthetic(f.journal, 'work', await pendingEntry()); await f.journal.close();
    const oldPath = path.join(root, 'old.key'), nextPath = path.join(root, 'next.key');
    fs.writeFileSync(oldPath, f.key, { mode: 0o600 }); fs.writeFileSync(nextPath, next, { mode: 0o600 });
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: oldPath,
      BOUNCER_BUYER_NEW_JOURNAL_KEY_FILE: nextPath };
    const args = ['--contract', contract, '--owner', owner, '--journal', f.journalId];
    let result = await runCli('scripts/rotate-shared-buyer-key.mjs', [...args, '--check'], env);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).matching_key, 'original');
    result = await runCli('scripts/rotate-shared-buyer-key.mjs', [...args, '--confirm-rotate'], env);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).rotated_entries, 1);
    result = await runCli('scripts/rotate-shared-buyer-key.mjs', [...args, '--check'], env);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).matching_key, 'new');
    assert.ok(fs.existsSync(oldPath) && fs.existsSync(nextPath));
    assert.ok(!result.stdout.includes(f.key.toString('hex')) && !result.stdout.includes(next.toString('hex')));
    const reopened = await f.open({ key: next }); assert.equal(reopened.get('work').status, 'pending');
  } finally { next.fill(0); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('SIGKILL during staged key rotation rolls back the transaction and preserves the pending hash', async () => {
  const f = await fixture(), next = crypto.randomBytes(32); let child;
  try {
    const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending); await f.journal.close();
    child = fork(fileURLToPath(new URL('./fixtures/rotate-buyer-worker.mjs', import.meta.url)), [], {
      env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: databaseUrl, BOUNCER_TEST_OWNER: owner, BOUNCER_TEST_JOURNAL: f.journalId,
        BOUNCER_TEST_OLD_KEY: f.key.toString('hex'), BOUNCER_TEST_NEW_KEY: next.toString('hex') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const [message] = await Promise.race([
      once(child, 'message'),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('rotation worker timed out')), 15000); timer.unref(); }),
    ]);
    assert.equal(message.type, 'staged-before-commit');
    await assert.rejects(f.open(), error => error.code === 'BUSY');
    const done = once(child, 'exit'); child.kill('SIGKILL'); await done; child = null;
    // Wait for PostgreSQL, not just the OS, to release the journal session lock.
    const words = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-lock-v1', contract, owner, f.journalId])).digest();
    const fence = await f.pool.connect();
    try {
      await fence.query("SET lock_timeout = '5s'");
      await fence.query('SELECT pg_catalog.pg_advisory_lock($1::integer,$2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
      await fence.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
    } finally { fence.release(); }
    await assert.rejects(f.open({ key: next }), error => error.code === 'KEY_MISMATCH');
    const reopened = await f.open();
    assert.equal(reopened.get('work').tx_hash, pending.tx_hash); assert.equal(reopened.get('work').status, 'pending');
    await assert.rejects(reopened.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    next.fill(0); await f.cleanup();
  }
});

dbtest('rotation limits and lost journal lock fail without partially changing encrypted state', async () => {
  for (const mode of ['entry-limit', 'byte-limit', 'lost-lock']) {
    const f = await fixture(), next = crypto.randomBytes(32); let journal;
    try {
      const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending); await f.journal.close();
      const before = (await f.pool.query('SELECT ciphertext FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId])).rows[0].ciphertext;
      let enabled = false, lockChecks = 0;
      const faulty = { async connect() {
        const c = await f.pool.connect();
        return { on: c.on.bind(c), removeListener: c.removeListener.bind(c), release: c.release.bind(c), async query(sql, args) {
          if (enabled && mode === 'lost-lock' && typeof sql === 'string' && sql.includes('FROM pg_catalog.pg_locks') && ++lockChecks === 2) {
            return { rows: [{ pid: -1, locked: false, owner_locked: false }] };
          }
          const result = await c.query(sql, args);
          if (enabled && typeof sql === 'string' && sql.includes('ORDER BY entry_id LIMIT $4 FOR UPDATE')) {
            if (mode === 'entry-limit') return { ...result, rows: Array.from({ length: 257 }, () => result.rows[0]) };
            if (mode === 'byte-limit') return { ...result, rows: [{ ...result.rows[0], ciphertext: Buffer.alloc(8 * 1024 * 1024 + 1) }] };
          }
          return result;
        } };
      } };
      journal = await openPostgresBuyerJournal({ pool: faulty, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
      enabled = true;
      await assert.rejects(journal.rotateEncryptionKey(next), error => error.code === (mode === 'lost-lock' ? 'SESSION_LOST' : 'ROTATION_LIMIT'));
      await journal.close();
      assert.deepEqual((await f.pool.query('SELECT ciphertext FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId])).rows[0].ciphertext, before);
      await assert.rejects(f.open({ key: next }), error => error.code === 'KEY_MISMATCH');
      const reopened = await f.open(); assert.equal(reopened.get('work').tx_hash, pending.tx_hash); assert.equal(reopened.get('work').status, 'pending');
    } finally { if (journal) await journal.close(); next.fill(0); await f.cleanup(); }
  }
});

test('key rotation CLI refuses unsafe inputs without printing key material or database credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-rotation-input-'));
  try {
    const key = crypto.randomBytes(32), file = path.join(root, 'old.key'), same = path.join(root, 'same.key'), symlink = path.join(root, 'link');
    fs.writeFileSync(file, key, { mode: 0o600 }); fs.writeFileSync(same, key, { mode: 0o600 }); fs.symlinkSync(file, symlink);
    const args = ['--contract', contract, '--owner', owner, '--journal', 'journal', '--check'];
    const env = { BOUNCER_BUYER_DATABASE_URL: 'postgresql://u:secret-value@bad.example/buyer',
      BOUNCER_BUYER_JOURNAL_KEY_FILE: file, BOUNCER_BUYER_NEW_JOURNAL_KEY_FILE: same };
    let result = await runCli('scripts/rotate-shared-buyer-key.mjs', args, env);
    assert.equal(result.code, 1); assert.match(result.stderr, /keys must differ/);
    assert.ok(!result.stderr.includes('secret-value') && !result.stderr.includes(key.toString('hex')));
    result = await runCli('scripts/rotate-shared-buyer-key.mjs', args, { ...env, BOUNCER_BUYER_NEW_JOURNAL_KEY_FILE: symlink });
    assert.equal(result.code, 1); assert.match(result.stderr, /owner-only/);
    fs.chmodSync(same, 0o644);
    result = await runCli('scripts/rotate-shared-buyer-key.mjs', args, env);
    assert.equal(result.code, 1); assert.match(result.stderr, /owner-only/);
    result = await runCli('scripts/rotate-shared-buyer-key.mjs', [...args, '--confirm-rotate'], env);
    assert.equal(result.code, 1); assert.match(result.stderr, /exactly one/);
    key.fill(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('authenticated encrypted snapshots detect stale payment state across key rotation', async () => {
  const f = await fixture(), next = crypto.randomBytes(32); let pendingSnapshot;
  try {
    const pending = await pendingEntry();
    await f.journal.withOwnerFence(async () => {
      await f.journal.reservePending('work', pending);
      // Export is usable before broadcast while the payment owner fence is held.
      pendingSnapshot = await f.journal.exportEncryptedSnapshot();
    });
    assert.ok(!pendingSnapshot.includes(pending.resource_authorization.signature));
    assert.ok(!pendingSnapshot.includes(JSON.stringify(pending.resource_authorization)));
    const first = verifyEncryptedBuyerSnapshot(pendingSnapshot, f.key);
    assert.equal(first.count, 1); assert.deepEqual(first.entries.map(row => [row.id, row.status, row.tx_hash]), [['work', 'pending', pending.tx_hash]]);
    const completed = { ...f.journal.get('work'), status: 'completed', completed_at: new Date().toISOString(),
      settlement: { tx_hash: pending.tx_hash, token: pending.request.token, payee: pending.request.payee, amount: pending.request.amount,
        verification: 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' } };
    await f.journal.writeDurable('work', completed);
    const completeSnapshot = await f.journal.exportEncryptedSnapshot();
    await f.journal.rotateEncryptionKey(next);
    const rotated = await f.journal.exportEncryptedSnapshot();
    assert.equal(verifyEncryptedBuyerSnapshot(rotated, next).entries[0].status, 'completed');
    assert.throws(() => verifyEncryptedBuyerSnapshot(rotated, f.key), error => error.code === 'SNAPSHOT_INVALID');
    const result = compareEncryptedBuyerSnapshots({ previous: pendingSnapshot, previousKey: f.key, current: rotated, currentKey: next });
    assert.equal(result.checkpoint_count, 1); assert.equal(result.entries[0].tx_hash, pending.tx_hash);
    assert.throws(() => compareEncryptedBuyerSnapshots({ previous: completeSnapshot, previousKey: f.key, current: pendingSnapshot, currentKey: f.key }),
      error => error.code === 'SNAPSHOT_ROLLBACK');
    assert.equal(f.journal.get('work').tx_hash, pending.tx_hash);
  } finally { next.fill(0); await f.cleanup(); }
});

dbtest('snapshot authentication rejects tampering, truncation, wrong keys and a different scope', async () => {
  const f = await fixture(), other = await fixture(), wrong = crypto.randomBytes(32);
  try {
    const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending);
    const snapshot = await f.journal.exportEncryptedSnapshot(), parsed = JSON.parse(snapshot);
    for (const mutate of [
      value => { value.payload.entries[0].tx_hash = mockHash('changed'); },
      value => { value.payload.entries = []; },
      value => { value.payload.entries[0].ciphertext = 'AA=='; },
      value => { value.mac = Buffer.alloc(32).toString('base64'); },
      value => { value.payload.extra = true; },
    ]) {
      const altered = structuredClone(parsed); mutate(altered);
      assert.throws(() => verifyEncryptedBuyerSnapshot(JSON.stringify(altered), f.key), error => error.code === 'SNAPSHOT_INVALID');
    }
    // Even a recomputed outer MAC cannot make malformed inner ciphertext or
    // duplicated rows into an authenticated, valid journal snapshot.
    const reauthenticate = value => {
      const k = Buffer.from(crypto.hkdfSync('sha256', f.key, Buffer.alloc(0), Buffer.from('bouncer-buyer-snapshot-mac-v1'), 32));
      try { value.mac = crypto.createHmac('sha256', k).update(JSON.stringify(value.payload)).digest('base64'); }
      finally { k.fill(0); }
      return JSON.stringify(value);
    };
    const badCipher = structuredClone(parsed); badCipher.payload.entries[0].ciphertext = 'AA==';
    const duplicate = structuredClone(parsed); duplicate.payload.entries.push(structuredClone(duplicate.payload.entries[0]));
    for (const altered of [reauthenticate(badCipher), reauthenticate(duplicate), snapshot.slice(0, -1), 'x'.repeat(MAX_BUYER_SNAPSHOT_BYTES + 1)]) {
      assert.throws(() => verifyEncryptedBuyerSnapshot(altered, f.key), error => error.code === 'SNAPSHOT_INVALID');
    }
    assert.throws(() => verifyEncryptedBuyerSnapshot(snapshot, wrong), error => error.code === 'SNAPSHOT_INVALID');
    const otherSnapshot = await other.journal.exportEncryptedSnapshot();
    assert.throws(() => compareEncryptedBuyerSnapshots({ previous: snapshot, previousKey: f.key, current: otherSnapshot, currentKey: other.key }),
      error => error.code === 'SNAPSHOT_SCOPE');
  } finally { wrong.fill(0); await other.cleanup(); await f.cleanup(); }
});

dbtest('snapshot refuses database corruption rather than certifying stale in-memory state', async () => {
  const f = await fixture();
  try {
    const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending);
    await f.pool.query('UPDATE bouncer_buyer_v1.entries SET ciphertext=decode($2,\'hex\') WHERE journal_id=$1', [f.journalId, 'ff']);
    await assert.rejects(f.journal.exportEncryptedSnapshot(), error => error.code === 'CORRUPT');
    assert.throws(() => f.journal.get('work'), error => error.code === 'FAILED');
  } finally { await f.cleanup(); }
});

dbtest('snapshot CLI exports securely, verifies offline and compares after key rotation without signing', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-buyer-checkpoint-')), next = crypto.randomBytes(32);
  try {
    const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending); await f.journal.close();
    const oldKey = path.join(root, 'old.key'), newKey = path.join(root, 'new.key'), file = path.join(root, 'checkpoint.json');
    fs.writeFileSync(oldKey, f.key, { mode: 0o600 }); fs.writeFileSync(newKey, next, { mode: 0o600 });
    const scope = ['--contract', contract, '--owner', owner, '--journal', f.journalId];
    const env = { BOUNCER_BUYER_DATABASE_URL: databaseUrl, BOUNCER_BUYER_JOURNAL_KEY_FILE: oldKey, BOUNCER_BUYER_SNAPSHOT_KEY_FILE: '' };
    const exported = await runCli('scripts/snapshot-shared-buyer.mjs', ['--export', file, ...scope], env);
    assert.equal(exported.code, 0, exported.stderr); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(pending.resource_authorization.signature));
    const offline = await runCli('scripts/snapshot-shared-buyer.mjs', ['--verify', file], { ...env, BOUNCER_BUYER_DATABASE_URL: '' });
    assert.equal(offline.code, 0, offline.stderr); assert.match(offline.stdout, new RegExp(pending.tx_hash));
    assert.ok(!offline.stdout.includes(pending.resource_authorization.signature));
    const overwrite = await runCli('scripts/snapshot-shared-buyer.mjs', ['--export', file, ...scope], env);
    assert.equal(overwrite.code, 1); assert.match(overwrite.stderr, /never overwritten/);
    const originalBytes = fs.readFileSync(file, 'utf8'); assert.equal(verifyEncryptedBuyerSnapshot(originalBytes, f.key).entries[0].tx_hash, pending.tx_hash);
    const journal = await f.open(); await journal.rotateEncryptionKey(next); await journal.close();
    const compared = await runCli('scripts/snapshot-shared-buyer.mjs', ['--compare', file, ...scope],
      { ...env, BOUNCER_BUYER_JOURNAL_KEY_FILE: newKey, BOUNCER_BUYER_SNAPSHOT_KEY_FILE: oldKey });
    assert.equal(compared.code, 0, compared.stderr); assert.match(compared.stdout, new RegExp(pending.tx_hash));
    assert.match(compared.stdout, /may be stale/); assert.ok(!compared.stdout.includes(pending.resource_authorization.signature));
    const wrongKey = await runCli('scripts/snapshot-shared-buyer.mjs', ['--verify', file],
      { ...env, BOUNCER_BUYER_JOURNAL_KEY_FILE: newKey });
    assert.equal(wrongKey.code, 1); assert.match(wrongKey.stderr, /failed authentication/);
    const link = path.join(root, 'link'); fs.symlinkSync(file, link);
    const badFile = await runCli('scripts/snapshot-shared-buyer.mjs', ['--verify', link], env);
    assert.equal(badFile.code, 1); assert.match(badFile.stderr, /owner-only/);
  } finally { next.fill(0); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('snapshot entry and byte limits abort without changing or poisoning the live journal', async () => {
  for (const mode of ['entry-limit', 'byte-limit']) {
    const f = await fixture(); let journal;
    try {
      const pending = await pendingEntry(); await reserveSynthetic(f.journal, 'work', pending); await f.journal.close();
      let enabled = false;
      const faulty = { async connect() {
        const c = await f.pool.connect();
        return { on: c.on.bind(c), removeListener: c.removeListener.bind(c), release: c.release.bind(c), async query(sql, args) {
          const result = await c.query(sql, args);
          if (enabled && typeof sql === 'string' && sql.includes('ORDER BY entry_id LIMIT $4') && !sql.includes('FOR UPDATE')) {
            if (mode === 'entry-limit') return { ...result, rows: Array.from({ length: 257 }, () => result.rows[0]) };
            return { ...result, rows: [{ ...result.rows[0], ciphertext: Buffer.alloc(8 * 1024 * 1024 + 1) }] };
          }
          return result;
        } };
      } };
      journal = await openPostgresBuyerJournal({ pool: faulty, contractId: contract, ownerAccountId: owner, journalId: f.journalId, key: f.key });
      enabled = true;
      await assert.rejects(journal.exportEncryptedSnapshot(), error => error.code === 'SNAPSHOT_LIMIT');
      assert.equal(journal.get('work').tx_hash, pending.tx_hash);
      enabled = false;
      assert.equal(verifyEncryptedBuyerSnapshot(await journal.exportEncryptedSnapshot(), f.key).entries[0].tx_hash, pending.tx_hash);
    } finally { if (journal) await journal.close(); await f.cleanup(); }
  }
});

dbtest('a checkpoint detects a missing later payment, while allowing added pending entries', async () => {
  const f = await fixture();
  try {
    const first = await pendingEntry(); await reserveSynthetic(f.journal, 'work', first);
    await f.journal.writeDurable('work', { ...f.journal.get('work'), status: 'completed', completed_at: new Date().toISOString(),
      settlement: { tx_hash: first.tx_hash, token: first.request.token, payee: first.request.payee, amount: first.request.amount,
        verification: 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' } });
    const before = await f.journal.exportEncryptedSnapshot();
    const second = await pendingEntry({ requestId: 'Another' }); await reserveSynthetic(f.journal, 'Another', second);
    const after = await f.journal.exportEncryptedSnapshot();
    const compared = compareEncryptedBuyerSnapshots({ previous: before, previousKey: f.key, current: after, currentKey: f.key });
    assert.equal(compared.count, 2); assert.deepEqual(compared.entries.map(row => row.id), ['Another', 'work']);
    assert.throws(() => compareEncryptedBuyerSnapshots({ previous: after, previousKey: f.key, current: before, currentKey: f.key }),
      error => error.code === 'SNAPSHOT_ROLLBACK');
    await assert.rejects(f.journal.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
  } finally { await f.cleanup(); }
});

dbtest('a pre-broadcast encrypted checkpoint retains the same pending hash after a lost payment response', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal); let checkpoint, hash;
  try {
    const send = runtime.provider.sendTransactionUntil.bind(runtime.provider);
    runtime.provider.sendTransactionUntil = async (...args) => {
      checkpoint = await f.journal.exportEncryptedSnapshot();
      const summary = verifyEncryptedBuyerSnapshot(checkpoint, f.key);
      assert.equal(summary.count, 1); assert.equal(summary.entries[0].status, 'pending');
      hash = summary.entries[0].tx_hash;
      return send(...args);
    };
    await assert.rejects(runtime.run(), /synthetic lost response/);
    assert.equal(runtime.sends, 1); assert.equal(f.journal.get(goal.id).tx_hash, hash);
    await recoverDirectResourcePayment({ config: { contract_id: contract, owner_account_id: owner, provider_url: origin, goals: [goal] },
      requestId: goal.id, provider: runtime.provider, journal: f.journal, log: () => {} });
    const current = await f.journal.exportEncryptedSnapshot();
    const result = compareEncryptedBuyerSnapshots({ previous: checkpoint, previousKey: f.key, current, currentKey: f.key });
    assert.equal(result.entries[0].tx_hash, hash); assert.equal(result.entries[0].status, 'completed'); assert.equal(runtime.sends, 1);
  } finally { await f.cleanup(); }
});

dbtest('pre-broadcast checkpoint failure leaves the original hash quarantined and sends nothing', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-checkpoint-fail-'));
  const dir = path.join(root, 'checkpoints'); fs.mkdirSync(dir, { mode: 0o700 });
  let checkpoints;
  try {
    checkpoints = await openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key });
    const runtime = syntheticRuntime(f.journal, { loseSend: false });
    await assert.rejects(runtime.run({ beforePayment: async () => checkpoints.assertCapacity(), beforeBroadcastCheckpoint: async record => {
      fs.renameSync(dir, `${dir}.moved`); // Simulate losing the trusted mount after the DB reservation.
      await checkpoints.checkpoint(record);
    } }), /checkpoint failed before broadcast.*no payment was sent/);
    assert.equal(runtime.sends, 0);
    const pending = f.journal.get(goal.id); assert.equal(pending.status, 'pending'); assert.ok(pending.tx_hash);
    await assert.rejects(f.journal.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
    checkpoints.close(); checkpoints = null;
    await f.journal.close();
    const reopened = await f.open(); assert.equal(reopened.get(goal.id).tx_hash, pending.tx_hash);
    await assert.rejects(openBuyerCheckpointDirectory({ directory: `${dir}.moved`, journal: reopened, currentKey: f.key }),
      error => error.code === 'CHECKPOINT_DIRECTORY');
  } finally { checkpoints?.close(); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('checkpoint directory persists every synthetic broadcast and reopens across key rotation', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-checkpoint-two-')), next = crypto.randomBytes(32);
  const dir = path.join(root, 'checkpoints'); fs.mkdirSync(dir, { mode: 0o700 }); let checkpoints;
  try {
    checkpoints = await openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key });
    const runtime = syntheticRuntime(f.journal, { loseSend: false }), goals = [goal, { ...goal, id: 'work-2', input: { text: 'another reviewed task', rounds: 2 } }];
    const send = runtime.provider.sendTransactionUntil.bind(runtime.provider);
    runtime.provider.sendTransactionUntil = async signed => {
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      const matching = fs.readdirSync(dir).filter(name => name.endsWith(`-${hash}.json`)); assert.equal(matching.length, 1);
      const snapshot = verifyEncryptedBuyerSnapshot(fs.readFileSync(path.join(dir, matching[0]), 'utf8'), f.key);
      assert.ok(snapshot.entries.some(entry => entry.tx_hash === hash && entry.status === 'pending'));
      return send(signed);
    };
    const result = await runtime.run({ goals, beforePayment: async () => checkpoints.assertCapacity(),
      beforeBroadcastCheckpoint: record => checkpoints.checkpoint(record) });
    assert.equal(result.payments.paid, 2); assert.equal(runtime.sends, 2);
    const files = fs.readdirSync(dir).sort(); assert.equal(files.length, 2);
    assert.match(files[0], /^000001-/); assert.match(files[1], /^000002-/);
    assert.equal(verifyEncryptedBuyerSnapshot(fs.readFileSync(path.join(dir, files[1]), 'utf8'), f.key).count, 2);
    checkpoints.close(); checkpoints = null;
    await f.journal.rotateEncryptionKey(next); await f.journal.close();
    const reopened = await f.open({ key: next });
    await assert.rejects(openBuyerCheckpointDirectory({ directory: dir, journal: reopened, currentKey: next }), error => error.code === 'SNAPSHOT_INVALID');
    checkpoints = await openBuyerCheckpointDirectory({ directory: dir, journal: reopened, currentKey: next, previousKey: f.key });
    checkpoints.assertCapacity();
  } finally { checkpoints?.close(); next.fill(0); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('checkpoint directory rejects symlinks, unsafe permissions, unexpected files and gaps', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-checkpoint-invalid-'));
  try {
    const dir = path.join(root, 'dir'), link = path.join(root, 'link'); fs.mkdirSync(dir, { mode: 0o700 }); fs.symlinkSync(dir, link);
    await assert.rejects(openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: crypto.randomBytes(32) }), error => error.code === 'SNAPSHOT_INVALID');
    const capacity = await openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key });
    capacity.assertCapacity(256); assert.throws(() => capacity.assertCapacity(257), error => error.code === 'CHECKPOINT_LIMIT'); capacity.close();
    await assert.rejects(openBuyerCheckpointDirectory({ directory: link, journal: f.journal, currentKey: f.key }), error => error.code === 'CHECKPOINT_DIRECTORY');
    fs.chmodSync(dir, 0o755);
    await assert.rejects(openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key }), error => error.code === 'CHECKPOINT_DIRECTORY');
    fs.chmodSync(dir, 0o700); fs.writeFileSync(path.join(dir, 'unrelated'), 'x', { mode: 0o600 });
    await assert.rejects(openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key }), error => error.code === 'CHECKPOINT_DIRECTORY');
    fs.unlinkSync(path.join(dir, 'unrelated'));
    fs.writeFileSync(path.join(dir, `000002-${mockHash('gap')}.json`), '{}', { mode: 0o600 });
    await assert.rejects(openBuyerCheckpointDirectory({ directory: dir, journal: f.journal, currentKey: f.key }), error => error.code === 'CHECKPOINT_DIRECTORY');
  } finally { await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('SIGKILL after a synced checkpoint but before broadcast leaves the hash and owner quarantined', async () => {
  const f = await fixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-checkpoint-kill-'));
  const dir = path.join(root, 'checkpoints'); fs.mkdirSync(dir, { mode: 0o700 }); let processWorker, checkpoints;
  try {
    await f.journal.close();
    processWorker = worker({ journalId: f.journalId, key: f.key, c: challenge(), nonce: 71, checkpointDir: dir, checkpointHold: true });
    const saved = await processWorker.wait('checkpointed'); await processWorker.stop();
    assert.equal(processWorker.messages.filter(message => message.type === 'broadcast').length, 0);
    const files = fs.readdirSync(dir); assert.equal(files.length, 1);
    assert.equal(verifyEncryptedBuyerSnapshot(fs.readFileSync(path.join(dir, files[0]), 'utf8'), f.key).entries[0].tx_hash, saved.hash);
    const words = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-lock-v1', contract, owner, f.journalId])).digest();
    const lock = await f.pool.connect();
    try {
      await lock.query("SET lock_timeout = '5s'");
      await lock.query('SELECT pg_catalog.pg_advisory_lock($1::integer,$2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
      await lock.query('SELECT pg_catalog.pg_advisory_unlock($1::integer,$2::integer)', [words.readInt32BE(0), words.readInt32BE(4)]);
    } finally { lock.release(); }
    const reopened = await f.open();
    assert.equal(reopened.get('work').tx_hash, saved.hash); assert.equal(reopened.get('work').status, 'pending');
    checkpoints = await openBuyerCheckpointDirectory({ directory: dir, journal: reopened, currentKey: f.key });
    await assert.rejects(reopened.withOwnerFence(async () => {}), error => error.code === 'OWNER_UNRESOLVED');
  } finally { checkpoints?.close(); if (processWorker) await processWorker.stop(); await f.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

dbtest('a corrupted pending row after checkpoint is caught by the final fence before broadcast', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal, { loseSend: false });
  try {
    await assert.rejects(runtime.run({ beforeBroadcastCheckpoint: async () => {
      await f.pool.query('UPDATE bouncer_buyer_v1.entries SET revision=revision+1 WHERE journal_id=$1', [f.journalId]);
    } }), /shared journal pre-broadcast check failed.*no payment was sent/);
    assert.equal(runtime.sends, 0);
    const rows = await f.pool.query('SELECT status, tx_hash FROM bouncer_buyer_v1.entries WHERE journal_id=$1', [f.journalId]);
    assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].status, 'pending');
    await f.journal.close(); await assert.rejects(f.open(), error => error.code === 'CORRUPT');
  } finally { await f.cleanup(); }
});

dbtest('the synchronous freshness guard remains after checkpointing and immediately before a broadcast', async () => {
  const f = await fixture(), runtime = syntheticRuntime(f.journal, { loseSend: false }), events = [];
  try {
    const send = runtime.provider.sendTransactionUntil.bind(runtime.provider);
    runtime.provider.sendTransactionUntil = async signed => { events.push('broadcast'); return send(signed); };
    await runtime.run({ beforeBroadcastCheckpoint: async () => { events.push('checkpoint'); }, beforeBroadcast: () => { events.push('guard'); } });
    assert.deepEqual(events, ['checkpoint', 'guard', 'broadcast']); assert.equal(runtime.sends, 1);
  } finally { await f.cleanup(); }
});
