import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nearApi from 'near-api-js';
import { initializePostgresWalletPromptFence, createPostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { initializePostgresNativeOraclePromptFence, createPostgresNativeOraclePromptFence } from '../agent/postgres-native-oracle-prompt-fence.mjs';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';

// This file uses ONLY synthetic accounts, mock auth/providers and a disposable
// PostgreSQL database. It never calls a wallet, chain, seller or real service.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw new Error('PostgreSQL integration test URL is required');
const dbtest = url ? test : test.skip;
const pool = () => new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 });
const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const owner = () => `ownerlock-${crypto.randomBytes(7).toString('hex')}.testnet`;
const auth = async ({ evidence }) => evidence === 'synthetic-auth';
const never = async () => { throw Error('test must not call RPC'); };
const receiptProvider = { viewNodeStatus: never, txStatusReceipts: never };
const preflightProvider = Object.fromEntries(['viewNodeStatus','viewBlock','query','viewTestnetAccountPresenceAt',
  'callFunctionRaw','experimental_protocolConfig','gasPrice'].map(x => [x, never]));
const fences = db => ({ native: createPostgresNativeOraclePromptFence({ pool: db, authenticate: auth, wasmBytes: wasm,
  receiptProvider, preflightProvider }), ft: createPostgresWalletPromptFence({ pool: db, authenticate: auth }) });
function scenario(ownerId = owner(), ownerKey = key()) {
  const native = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: ownerId, vault: `native.${ownerId}`,
    policy_id: 'price', agent_public_key: key(), per_tx_cap_yocto: '100000000000000000000000',
    daily_cap_yocto: '100000000000000000000000', vault_deposit_yocto: '100000000000000000000000',
    agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } }).review;
  const ft = buildBufferWalletSpendingPlan({ owner: ownerId, vault: `vault.${ownerId}`, adapter: `buffer.${ownerId}`,
    policy_id: 'research', vault_agent_public_key: key(), forwarder_agent_public_key: key(), per_tx_cap_atoms: '20000000',
    daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '100000000000000000000000',
    forwarder_agent_gas_allowance_yocto: '200000000000000000000000' }).review;
  return { owner: ownerId, ownerKey, native, ft,
    nativeReq: { review: native, trustedReviewHash: native.review_sha256, trustedOwnerPublicKey: ownerKey, evidence: 'synthetic-auth' },
    ftReq: { review: ft, trustedReviewHash: ft.review_sha256, trustedOwnerPublicKey: ownerKey,
      stageId: 'configure_buffer_locked_policy', evidence: 'synthetic-auth' } };
}
async function resources(work) { const db = pool(); try { return await work(db, fences(db)); } finally { await db.end(); } }
if (url) test.before(async () => { const db = pool(); try {
  await initializePostgresNativeOraclePromptFence({ pool: db }); await initializePostgresWalletPromptFence({ pool: db });
} finally { await db.end(); } });

dbtest('native and FT reservations for the same owner race atomically; at most one flow wins', async () => resources(async (db, f) => {
  const s = scenario();
  const result = await Promise.allSettled([f.native.reserve(s.nativeReq), f.ft.reserve(s.ftReq)]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  const rejected = result.find(x => x.status === 'rejected'); assert.equal(rejected.reason.code, 'OWNER_FENCED');
  const winner = result.findIndex(x => x.status === 'fulfilled'), operation = result[winner].value.operation_id;
  const row = (await db.query('SELECT owner,flow,operation_id,review_sha256 FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [s.owner])).rows;
  assert.equal(row.length, 1); assert.equal(row[0].flow, winner === 0 ? 'native_oracle' : 'buffer_wallet');
  assert.equal(row[0].operation_id, operation); assert.equal(row[0].review_sha256, winner === 0 ? s.native.review_sha256 : s.ft.review_sha256);
  await assert.rejects(f.native.reserve(s.nativeReq), e => e.code === 'OWNER_FENCED');
  await assert.rejects(f.ft.reserve(s.ftReq), e => e.code === 'OWNER_FENCED');
}));

dbtest('independent native and FT worker processes cannot reserve the same owner', async () => resources(async (db, f) => {
  const s = scenario(), path = fileURLToPath(new URL('./fixtures/wallet-owner-fence-worker.mjs', import.meta.url));
  const workers = ['native_oracle', 'buffer_wallet'].map(flow => {
    const child = fork(path, [], { env: { ...process.env, BOUNCER_TEST_POSTGRES_URL: url }, stdio: ['ignore','ignore','pipe','ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 500); });
    const ready = new Promise((resolve, reject) => { child.once('error', reject); child.once('message', m => m?.ready ? resolve() : reject(Error('not ready'))); });
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('worker timeout')); }, 20_000);
      child.on('message', m => { if (!m?.ready) { clearTimeout(timer); resolve(m); } });
      child.once('exit', (code, signal) => { if (code !== 0) { clearTimeout(timer); reject(Error(`worker exited ${code || signal}: ${stderr}`)); } });
      child.once('error', reject);
    });
    return { child, ready, done, send: () => child.send({ flow, request: flow === 'native_oracle' ? s.nativeReq : s.ftReq }) };
  });
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.send());
    const outcomes = await Promise.all(workers.map(w => w.done));
    assert.equal(outcomes.filter(x => x.ok).length, 1);
    assert.equal(outcomes.filter(x => x.code === 'OWNER_FENCED').length, 1);
    const row = (await db.query('SELECT flow,operation_id FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [s.owner])).rows;
    assert.equal(row.length, 1); assert.equal(row[0].operation_id, outcomes.find(x => x.ok).operation_id);
    await assert.rejects(f.native.reserve(s.nativeReq), e => e.code === 'OWNER_FENCED');
    await assert.rejects(f.ft.reserve(s.ftReq), e => e.code === 'OWNER_FENCED');
  } finally { workers.forEach(w => { if (w.child.connected) w.child.kill(); }); }
}));

dbtest('either flow fences the other while unrelated owners can still reserve', async () => resources(async (db, f) => {
  const a = scenario(), b = scenario(), c = scenario();
  await f.native.reserve(a.nativeReq); await assert.rejects(f.ft.reserve(a.ftReq), e => e.code === 'OWNER_FENCED');
  await f.ft.reserve(b.ftReq); await assert.rejects(f.native.reserve(b.nativeReq), e => e.code === 'OWNER_FENCED');
  assert.equal((await f.native.reserve(c.nativeReq)).owner, c.owner);
}));

dbtest('an unknown commit leaves the shared holder and original flow fenced in both namespaces', async () => resources(async (db, f) => {
  const s = scenario(); let touched = false, fired = false;
  const lossy = { async connect() { const c = await db.connect(); return { release: c.release.bind(c), async query(sql, args) {
    if (String(sql).includes('INSERT INTO bouncer_native_wallet_prompt_v1.plans')) touched = true;
    if (touched && !fired && sql === 'COMMIT') { fired = true; await c.query(sql, args); throw Error('lost synthetic acknowledgement'); }
    return c.query(sql, args);
  } }; } };
  const fence = fences(lossy).native;
  await assert.rejects(fence.reserve(s.nativeReq), e => e.code === 'DATABASE_UNKNOWN');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [s.owner])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_native_wallet_prompt_v1.plans WHERE owner=$1', [s.owner])).rows[0].n, 1);
  await assert.rejects(f.ft.reserve(s.ftReq), e => e.code === 'OWNER_FENCED');
  await assert.rejects(f.native.reserve(s.nativeReq), e => e.code === 'OWNER_FENCED');
}));

dbtest('lock, flow row and stages roll back together if insertion fails before commit', async () => resources(async (db, f) => {
  const s = scenario();
  const failing = { async connect() { const c = await db.connect(); return { release: c.release.bind(c), async query(sql, args) {
    if (String(sql).includes('INSERT INTO bouncer_native_wallet_prompt_v1.plans')) throw Error('synthetic failure before commit');
    return c.query(sql, args);
  } }; } };
  await assert.rejects(fences(failing).native.reserve(s.nativeReq), e => e.code === 'DATABASE_UNKNOWN');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [s.owner])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_native_wallet_prompt_v1.plans WHERE owner=$1', [s.owner])).rows[0].n, 0);
  // Test-only knowledge establishes the injected fault occurred before commit.
  // A real DATABASE_UNKNOWN response is never an instruction to retry a wallet.
  assert.equal((await f.ft.reserve(s.ftReq)).owner, s.owner);
}));

dbtest('the hold is immutable and disabled guard blocks both native and FT claims', async () => resources(async (db, f) => {
  const n = scenario(), t = scenario(), native = await f.native.reserve(n.nativeReq), ft = await f.ft.reserve(t.ftReq);
  await assert.rejects(db.query('DELETE FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [n.owner]));
  await assert.rejects(db.query("UPDATE bouncer_wallet_owner_fence_v1.holders SET flow='buffer_wallet' WHERE owner=$1", [n.owner]));
  const nativeClaim = { owner: n.owner, ownerPublicKey: n.ownerKey, operationId: native.operation_id, reviewSha256: n.native.review_sha256,
    stageId: n.native.stages[0].id, actionCommitmentSha256: n.native.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  const ftClaim = { owner: t.owner, ownerPublicKey: t.ownerKey, operationId: ft.operation_id, reviewSha256: t.ft.review_sha256,
    stageId: t.ft.stages[0].id, actionCommitmentSha256: t.ft.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  await db.query('ALTER TABLE bouncer_wallet_owner_fence_v1.holders DISABLE TRIGGER holder_immutable');
  try {
    await assert.rejects(f.native.claim(nativeClaim), e => e.code === 'GLOBAL_FENCE_UNSAFE');
    await assert.rejects(f.ft.claimPrompt(ftClaim), e => e.code === 'GLOBAL_FENCE_UNSAFE');
  } finally { await db.query('ALTER TABLE bouncer_wallet_owner_fence_v1.holders ENABLE TRIGGER holder_immutable'); }
}));

dbtest('missing or wrong shared hold blocks a new claim but never hides legacy state or allows another flow', async () => resources(async (db, f) => {
  const s = scenario(), reservation = await f.ft.reserve(s.ftReq);
  const request = { owner: s.owner, ownerPublicKey: s.ownerKey, operationId: reservation.operation_id, reviewSha256: s.ft.review_sha256,
    stageId: s.ft.stages[0].id, actionCommitmentSha256: s.ft.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  await db.query('ALTER TABLE bouncer_wallet_owner_fence_v1.holders DISABLE TRIGGER holder_immutable');
  try { await db.query('DELETE FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [s.owner]); }
  finally { await db.query('ALTER TABLE bouncer_wallet_owner_fence_v1.holders ENABLE TRIGGER holder_immutable'); }
  await assert.rejects(f.ft.claimPrompt(request), e => e.code === 'OWNER_FENCED');
  assert.equal((await f.ft.inspect({ owner: s.owner, ownerPublicKey: s.ownerKey, evidence: 'synthetic-auth' })).operation_id, reservation.operation_id);
  const original = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 39));
  assert.equal((await f.ft.recordOriginalHash({ owner: s.owner, ownerPublicKey: s.ownerKey, operationId: reservation.operation_id,
    originalHash: original, evidence: 'synthetic-auth' })).original_hash, original, 'retaining an existing original must stay possible');
  await assert.rejects(f.native.reserve(s.nativeReq), e => e.code === 'OWNER_FENCED');
}));

dbtest('row-level security on the opposite-flow table cannot hide a legacy reservation', async () => resources(async (db, f) => {
  const nativeOwner = scenario(), ftOwner = scenario();
  await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts ENABLE ROW LEVEL SECURITY');
  try {
    await assert.rejects(f.native.reserve(nativeOwner.nativeReq), e => e.code === 'GLOBAL_FENCE_UNSAFE');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [nativeOwner.owner])).rows[0].n, 0);
  } finally { await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts DISABLE ROW LEVEL SECURITY'); }
  await db.query('ALTER TABLE bouncer_native_wallet_prompt_v1.plans ENABLE ROW LEVEL SECURITY');
  try {
    await assert.rejects(f.ft.reserve(ftOwner.ftReq), e => e.code === 'GLOBAL_FENCE_UNSAFE');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_wallet_owner_fence_v1.holders WHERE owner=$1', [ftOwner.owner])).rows[0].n, 0);
  } finally { await db.query('ALTER TABLE bouncer_native_wallet_prompt_v1.plans DISABLE ROW LEVEL SECURITY'); }
}));

dbtest('a legacy database with old prompt rows is never silently enrolled as safe', async () => {
  const admin = pool(), name = `bouncer_legacy_${crypto.randomBytes(6).toString('hex')}`; let legacy;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const parsed = new URL(url); parsed.pathname = `/${name}`; legacy = new pg.Pool({ connectionString: parsed.toString(), max: 2 });
    await legacy.query('CREATE SCHEMA bouncer_wallet_prompt_v1; CREATE TABLE bouncer_wallet_prompt_v1.prompts(owner_account_id text)');
    await legacy.query("INSERT INTO bouncer_wallet_prompt_v1.prompts(owner_account_id) VALUES('legacy.testnet')");
    await assert.rejects(initializePostgresWalletPromptFence({ pool: legacy }), e => e.code === 'GLOBAL_FENCE_LEGACY_RECONCILIATION_REQUIRED');
    assert.equal((await legacy.query('SELECT count(*)::integer AS n FROM bouncer_wallet_prompt_v1.prompts')).rows[0].n, 1);
    assert.equal((await legacy.query("SELECT pg_catalog.to_regnamespace('bouncer_wallet_owner_fence_v1') IS NULL AS absent")).rows[0].absent, true);
  } finally {
    await legacy?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
  }
});
