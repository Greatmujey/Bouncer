import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';

// Disposable keys, invented review/transactions and an isolated PostgreSQL
// test database only. No authenticator here proves real ownership.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw new Error('PostgreSQL integration test URL is required');
const dbtest = url ? test : test.skip;
const stage = 'configure_buffer_locked_policy';
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const newOwner = () => `prompt-${crypto.randomBytes(8).toString('hex')}.testnet`;
const pool = () => new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 });
const syntheticAuth = async ({ evidence }) => evidence === 'synthetic-auth';
function fixture() {
  const owner = newOwner(), ownerKey = key();
  const { review } = buildBufferWalletSpendingPlan({ owner, vault: `vault.${owner}`, adapter: `buffer.${owner}`,
    policy_id: 'research', vault_agent_public_key: key(), forwarder_agent_public_key: key(),
    per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '100000000000000000000000',
    forwarder_agent_gas_allowance_yocto: '200000000000000000000000' });
  const request = { review, trustedReviewHash: review.review_sha256, trustedOwnerPublicKey: ownerKey, stageId: stage, evidence: 'synthetic-auth' };
  return { owner, ownerKey, review, request, read: { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' } };
}
async function resources(run) {
  const db = pool();
  try { return await run(db, createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth })); }
  finally { await db.end(); }
}
if (url) test.before(async () => {
  const db = pool(); try { await initializePostgresWalletPromptFence({ pool: db }); } finally { await db.end(); }
});

// Simulate lost acknowledgements AFTER real PostgreSQL commits. Never return the
// underlying error (which can carry a database URL or other private details).
function faultPool(db, marker) {
  let touched = false, fired = false;
  return { get fired() { return fired; }, async connect() {
    const c = await db.connect();
    return { release: c.release.bind(c), async query(sql, args) {
      if (String(sql).includes(marker)) touched = true;
      if (touched && !fired && sql === 'COMMIT') { fired = true; await c.query(sql, args); throw new Error('synthetic secret database URL'); }
      return c.query(sql, args);
    } };
  } };
}

function startWorker(payload) {
  const filename = fileURLToPath(new URL('./fixtures/wallet-prompt-fence-worker.mjs', import.meta.url));
  const child = fork(filename, [], { env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: url }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', part => { stderr += String(part).slice(0, 500); });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('message', message => message?.ready ? resolve() : reject(new Error('worker did not start')));
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker timed out')); }, 15_000);
    child.on('message', message => { if (!message?.ready) { clearTimeout(timer); resolve(message); } });
    child.once('exit', (code, signal) => { if (code !== 0) { clearTimeout(timer); reject(new Error(`worker exited ${code || signal}: ${stderr}`)); } });
    child.once('error', reject);
  });
  return { child, ready, done, send: () => child.send(payload) };
}

test('the prototype requires an explicit authenticator and has no wallet or unlock API', () => {
  assert.throws(() => createPostgresWalletPromptFence({ pool: { connect() {} } }), /authenticator/);
  const f = createPostgresWalletPromptFence({ pool: { connect() {} }, authenticate: syntheticAuth });
  assert.deepEqual(Object.keys(f).sort(), ['inspect', 'recordOriginalHash', 'reserve']);
});

dbtest('two independent processes atomically reserve at most one prompt per owner', async () => resources(async (db, fence) => {
  const f = fixture(), workers = [startWorker(f.request), startWorker(f.request)];
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.send());
    const results = await Promise.all(workers.map(w => w.done));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => r.code === 'OWNER_FENCED').length, 1);
    const stored = await fence.inspect(f.read);
    assert.equal(stored.status, 'PROMPT_RESERVED_NO_HASH');
    assert.equal(stored.original_hash, null);
    assert.equal(stored.operation_id, results.find(r => r.ok).operationId);
    assert.deepEqual(stored.review, f.review);
    assert.equal(stored.review_sha256, f.review.review_sha256);
    assert.equal(stored.action_commitment_sha256, f.review.stages[0].action_commitment_sha256);
    assert.equal(stored.owner_public_key, f.ownerKey);
    await assert.rejects(fence.reserve(f.request), error => error.code === 'OWNER_FENCED');
    const another = fixture(); assert.equal((await fence.reserve(another.request)).owner, another.owner);
  } finally { workers.forEach(w => { if (w.child.connected) w.child.kill(); }); }
}));

dbtest('competing original hashes cannot overwrite; same hash is idempotent', async () => resources(async (db, fence) => {
  const f = fixture(), stored = await fence.reserve(f.request);
  const r = n => ({ ...f.read, operationId: stored.operation_id, originalHash: hash(n) });
  const outcomes = await Promise.allSettled([fence.recordOriginalHash(r(7)), fence.recordOriginalHash(r(8))]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'MISMATCH');
  const original = outcomes.find(x => x.status === 'fulfilled').value.original_hash;
  assert.equal((await fence.inspect(f.read)).original_hash, original);
  assert.equal((await fence.recordOriginalHash({ ...r(7), originalHash: original })).original_hash, original);
  await assert.rejects(fence.recordOriginalHash({ ...r(7), operationId: 'f'.repeat(32) }), error => error.code === 'MISMATCH');
  // The SQL trigger also prevents accidental direct mutation/deletion by a
  // cooperating service. A privileged DB owner can still bypass it.
  await assert.rejects(db.query('UPDATE bouncer_wallet_prompt_v1.prompts SET original_hash=$1 WHERE owner_account_id=$2', [hash(20), f.owner]), /immutable/);
  await assert.rejects(db.query('DELETE FROM bouncer_wallet_prompt_v1.prompts WHERE owner_account_id=$1', [f.owner]), /cannot be deleted/);
  await assert.rejects(fence.reserve(f.request), error => error.code === 'OWNER_FENCED');
}));

dbtest('lost COMMIT acknowledgement cannot authorize a prompt or replace the original hash', async () => resources(async (db, normal) => {
  const f = fixture(), injected = faultPool(db, 'INSERT INTO bouncer_wallet_prompt_v1.prompts');
  const failing = createPostgresWalletPromptFence({ pool: injected, authenticate: syntheticAuth });
  await assert.rejects(failing.reserve(f.request), error => error.code === 'DATABASE_UNKNOWN' && !error.message.includes('secret'));
  assert.equal(injected.fired, true);
  const retained = await normal.inspect(f.read);
  assert.ok(retained?.operation_id, 'the reservation actually committed even though the reply was lost');
  await assert.rejects(normal.reserve(f.request), error => error.code === 'OWNER_FENCED');
  const postHashFault = faultPool(db, 'UPDATE bouncer_wallet_prompt_v1.prompts SET original_hash');
  const failingHash = createPostgresWalletPromptFence({ pool: postHashFault, authenticate: syntheticAuth });
  const args = { ...f.read, operationId: retained.operation_id, originalHash: hash(9) };
  await assert.rejects(failingHash.recordOriginalHash(args), error => error.code === 'DATABASE_UNKNOWN');
  assert.equal((await normal.inspect(f.read)).original_hash, hash(9));
  await assert.rejects(normal.recordOriginalHash({ ...args, originalHash: hash(10) }), error => error.code === 'MISMATCH');
}));

dbtest('authentication binds immutable action contexts; denied or mutated requests do not reserve', async () => resources(async (db, fence) => {
  const f = fixture();
  await assert.rejects(fence.reserve({ ...f.request, evidence: 'bad' }), error => error.code === 'UNAUTHENTICATED');
  assert.equal(await fence.inspect(f.read), null);
  const contexts = [];
  const observer = createPostgresWalletPromptFence({ pool: db, authenticate: async ({ action, evidence }) => {
    assert.equal(Object.isFrozen(action), true); contexts.push(action); return evidence === 'synthetic-auth';
  } });
  const before = structuredClone(f.review);
  const mutator = createPostgresWalletPromptFence({ pool: db, authenticate: async () => { f.review.per_tx_cap_atoms = '1'; return true; } });
  const original = await mutator.reserve(f.request);
  assert.deepEqual(original.review, before, 'review is snapshotted before authentication can mutate caller data');
  await observer.inspect(f.read);
  await observer.recordOriginalHash({ ...f.read, operationId: original.operation_id, originalHash: hash(11) });
  assert.deepEqual(contexts.map(x => x.purpose), ['inspect', 'record_original_hash']);
  assert.equal(contexts[1].owner, f.owner); assert.equal(contexts[1].owner_public_key, f.ownerKey);
  assert.equal(contexts[1].operation_id, original.operation_id); assert.equal(contexts[1].original_hash, hash(11));
  assert.ok(!JSON.stringify(original).includes('synthetic-auth'), 'authentication evidence is never stored');
  await assert.rejects(observer.inspect({ ...f.read, ownerPublicKey: key() }), error => error.code === 'OWNER_KEY_MISMATCH');
}));

dbtest('invalid review or corrupt retained state fails closed', async () => resources(async (db, fence) => {
  const f = fixture();
  await assert.rejects(fence.reserve({ ...f.request, trustedReviewHash: '0'.repeat(64) }));
  await assert.rejects(fence.reserve({ ...f.request, stageId: 'unknown' }));
  assert.equal(await fence.inspect(f.read), null);
  const r = await fence.reserve(f.request);
  await assert.rejects(fence.recordOriginalHash({ ...f.read, operationId: r.operation_id, originalHash: 'bad' }));
  // Only this disposable DB is deliberately corrupted. Never do this to an
  // operational fence; no absence or corruption is permission to retry.
  await db.query('UPDATE bouncer_wallet_prompt_v1.prompts SET original_hash=$1 WHERE owner_account_id=$2', ['bad', f.owner]);
  await assert.rejects(fence.inspect(f.read), error => error.code === 'CORRUPT');
  await assert.rejects(fence.recordOriginalHash({ ...f.read, operationId: r.operation_id, originalHash: hash(12) }), error => error.code === 'CORRUPT');
  await assert.rejects(fence.reserve(f.request), error => error.code === 'OWNER_FENCED');
}));

dbtest('missing unique index or RLS prevents reservations and reads', async () => resources(async (db, fence) => {
  const f = fixture();
  await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts DROP CONSTRAINT prompts_operation_unique');
  try { await assert.rejects(fence.reserve(f.request), error => error.code === 'UNSAFE_SCHEMA'); }
  finally { await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts ADD CONSTRAINT prompts_operation_unique UNIQUE (operation_id)'); }
  await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts ENABLE ROW LEVEL SECURITY');
  try { await assert.rejects(fence.inspect(f.read), error => error.code === 'UNSAFE_SCHEMA'); }
  finally { await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts DISABLE ROW LEVEL SECURITY'); }
  await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts DISABLE TRIGGER prompt_immutable');
  try { await assert.rejects(fence.reserve(f.request), error => error.code === 'UNSAFE_SCHEMA'); }
  finally { await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts ENABLE TRIGGER prompt_immutable'); }
}));

dbtest('unwritable or unsafe primary blocks before any row is inserted', async () => resources(async (db, normal) => {
  const f = fixture();
  const unsafe = { async connect() {
    const c = await db.connect();
    return { release: c.release.bind(c), query(sql, args) {
      if (String(sql).includes('pg_is_in_recovery')) return { rows: [{ replica: true, fsync: 'on', read_only: 'off', synchronous_commit: 'on' }] };
      return c.query(sql, args);
    } };
  } };
  const fenced = createPostgresWalletPromptFence({ pool: unsafe, authenticate: syntheticAuth });
  await assert.rejects(fenced.reserve(f.request), error => error.code === 'UNSAFE_DATABASE');
  assert.equal(await normal.inspect(f.read), null);
}));
