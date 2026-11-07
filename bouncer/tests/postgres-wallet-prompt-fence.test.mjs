import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import nearApi from 'near-api-js';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { wasm as V12, NOW as SETUP_NOW, snapshot as setupSnapshot, fixture as setupFixture } from './buffer-wallet-setup-fixture.mjs';
import { firstSetupPreflightFixture, setSyntheticSetupStage } from './fixtures/wallet-setup-preflight-provider.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';

// Disposable keys, invented review/transactions and an isolated PostgreSQL
// test database only. No authenticator here proves real ownership.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw new Error('PostgreSQL integration test URL is required');
const dbtest = url ? test : test.skip;
const setupDbTest = url && V12 ? test : test.skip;
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
  assert.deepEqual(Object.keys(f).sort(), ['claimPrompt', 'claimSetupStage', 'inspect', 'inspectSetupProgress', 'reconcileSetupOriginal',
    'reconcileSetupStage', 'recordOriginalHash', 'recordSetupStageOriginal', 'reserve', 'verifySetupFunded']);
  assert.throws(() => createPostgresWalletPromptFence({ pool: { connect() {} }, authenticate: syntheticAuth,
    setupReceiptProvider: {} }), /trusted read-only setup receipt provider/);
  assert.throws(() => createPostgresWalletPromptFence({ pool: { connect() {} }, authenticate: syntheticAuth,
    setupPreflightProvider: {} }), /trusted read-only setup preflight provider/);
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

function claimRequest(f, reservation) {
  return { owner: f.owner, ownerPublicKey: f.ownerKey, operationId: reservation.operation_id,
    reviewSha256: f.review.review_sha256, stageId: stage,
    actionCommitmentSha256: f.review.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
}

async function setupScenario(db) {
  const owner = newOwner(), ownerKey = key();
  const originals = [0, 1, 2].map((i) => setupFixture(i, 70 + i, { owner, ownerKey }));
  const { review, snapshot } = originals[0], { provider, state, blockHash } = firstSetupPreflightFixture({ owner, ownerKey });
  const receiptState = { chain: 'testnet', unavailable: false, calls: [], results: new Map(originals.map(o => [o.trustedOriginalHash, o.result])) };
  const receiptProvider = { async viewNodeStatus() { return { chain_id: receiptState.chain }; },
    async txStatusReceipts(id, account, finality) {
      receiptState.calls.push([id, account, finality]);
      if (receiptState.unavailable || !receiptState.results.has(id)) throw new Error('synthetic private receipt failure');
      return receiptState.results.get(id);
    } };
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12,
    setupReceiptProvider: receiptProvider, setupPreflightProvider: provider });
  const reserved = await fence.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
  const read = { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  const stageArgs = index => ({ ...read, operationId: reserved.operation_id, reviewSha256: review.review_sha256,
    stageId: review.stages[index].id, actionCommitmentSha256: review.stages[index].action_commitment_sha256 });
  const recordArgs = index => ({ ...stageArgs(index), originalHash: originals[index].trustedOriginalHash });
  const claimFirst = async ({ record = true } = {}) => {
    await fence.claimPrompt(stageArgs(0));
    if (record) await fence.recordOriginalHash({ ...read, operationId: reserved.operation_id, originalHash: originals[0].trustedOriginalHash });
  };
  const setStage = index => setSyntheticSetupStage(state, blockHash, index);
  return { owner, ownerKey, review, originals, fence, reserved, read, stageArgs, recordArgs, claimFirst, setStage,
    state, blockHash, receiptState, receiptProvider, provider };
}

setupDbTest('the first setup prompt binds the pinned V12, retained snapshot, owner and exact review', async () => resources(async db => {
  const bytes = Buffer.from(V12), owner = newOwner(), ownerKey = key(), snapshot = setupSnapshot();
  snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
  const review = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: SETUP_NOW }).review;
  const { provider: setupPreflightProvider, state, blockHash } = firstSetupPreflightFixture({ owner, ownerKey });
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: bytes, setupPreflightProvider });
  bytes[100] ^= 1; // server retained its own copy before caller mutation
  assert.throws(() => createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: bytes }), /pinned V12/);
  const request = { review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' };
  await assert.rejects(fence.reserve({ ...request, stageId: 'register_vault_circle' }), /first pinned setup stage/);
  const noArtifact = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth });
  await assert.rejects(noArtifact.reserve(request), /first pinned setup stage/);
  const reservation = await fence.reserve(request);
  assert.deepEqual(reservation.review, review); assert.deepEqual(reservation.setup_snapshot, snapshot);
  assert.equal(reservation.claim_status, 'AVAILABLE');
  const read = { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  assert.equal((await fence.inspect(read)).stage_id, 'create_keyless_vault');
  await assert.rejects(noArtifact.inspect(read), error => error.code === 'CORRUPT');
  const claimArgs = { owner, ownerPublicKey: ownerKey, operationId: reservation.operation_id,
    reviewSha256: review.review_sha256, stageId: 'create_keyless_vault',
    actionCommitmentSha256: review.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  const noPreflight = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12 });
  await assert.rejects(noPreflight.claimPrompt(claimArgs), error => error.code === 'SETUP_PREFLIGHT_UNAVAILABLE');
  assert.equal((await fence.inspect(read)).claim_status, 'AVAILABLE');
  const claim = await fence.claimPrompt(claimArgs);
  assert.equal(claim.status, 'PROMPT_CLAIMED_NO_HASH'); assert.equal(claim.execution_authorized, false);
  assert.equal(claim.preflight_block_hash, blockHash);
  assert.ok(state.calls.length > 10, 'fresh same-block reads happen before the claim');
  const recorded = await fence.recordOriginalHash({ ...read, operationId: reservation.operation_id, originalHash: hash(23) });
  assert.equal(recorded.original_hash, hash(23));
  assert.deepEqual(recorded.review, review); assert.deepEqual(recorded.setup_snapshot, snapshot);
  const spending = buildBufferWalletSpendingPlan({ owner, vault: `vault.${owner}`, adapter: `buffer.${owner}`,
    policy_id: 'research', vault_agent_public_key: key(), forwarder_agent_public_key: key(),
    per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '100000000000000000000000',
    forwarder_agent_gas_allowance_yocto: '200000000000000000000000' }).review;
  await assert.rejects(fence.reserve({ review: spending, trustedReviewHash: spending.review_sha256, trustedOwnerPublicKey: ownerKey,
    stageId: stage, evidence: 'synthetic-auth' }), error => error.code === 'OWNER_FENCED');
}));

setupDbTest('first setup claims fail closed on stale, changed or unavailable same-block chain state', async () => resources(async db => {
  const owner = newOwner(), ownerKey = key(), snapshot = setupSnapshot();
  snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
  const review = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: SETUP_NOW }).review;
  const { provider, state } = firstSetupPreflightFixture({ owner, ownerKey });
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12, setupPreflightProvider: provider });
  const reserved = await fence.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
  const args = { owner, ownerPublicKey: ownerKey, operationId: reserved.operation_id, reviewSha256: review.review_sha256,
    stageId: 'create_keyless_vault', actionCommitmentSha256: review.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  const read = { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  await assert.rejects(fence.claimPrompt({ ...args, evidence: 'bad' }), e => e.code === 'UNAUTHENTICATED');
  await assert.rejects(fence.claimPrompt({ ...args, reviewSha256: '0'.repeat(64) }), e => e.code === 'MISMATCH');
  assert.deepEqual(state.calls, [], 'invalid authentication or retained identity is rejected before RPC');
  const cases = [
    { apply: () => { state.ownerKey.permission = { FunctionCall: {} }; }, reset: () => { state.ownerKey.permission = 'FullAccess'; }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { apply: () => { state.ownerTokens = '19999999'; }, reset: () => { state.ownerTokens = '20000000'; }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { apply: () => { state.seller.code_hash = hash(77); }, reset: () => { state.seller.code_hash = hash(5); }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { apply: () => { state.fail.add('ownerKey'); }, reset: () => state.fail.delete('ownerKey'), code: 'SETUP_PREFLIGHT_BLOCKED' },
    { apply: () => { state.blockAgeMs = 200_000; }, reset: () => { state.blockAgeMs = 0; }, code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
    { apply: () => { state.network = 'mainnet'; }, reset: () => { state.network = 'testnet'; }, code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
  ];
  for (const item of cases) {
    item.apply();
    await assert.rejects(fence.claimPrompt(args), e => e.code === item.code && !e.message.includes('private'));
    assert.equal((await fence.inspect(read)).claim_status, 'AVAILABLE');
    item.reset();
  }
  // Provider functions were bound at construction, not reselected from a
  // later-mutated object. The test RPC state itself remains a trust boundary.
  provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  const outcomes = await Promise.allSettled([fence.claimPrompt(args), fence.claimPrompt(args)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'ALREADY_CLAIMED');
  assert.equal((await fence.inspect(read)).claim_status, 'CLAIMED');
}));

setupDbTest('a newly recorded original during preflight prevents claiming and is never replaced', async () => resources(async db => {
  const owner = newOwner(), ownerKey = key(), snapshot = setupSnapshot();
  snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
  const review = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: SETUP_NOW }).review;
  const { provider, state } = firstSetupPreflightFixture({ owner, ownerKey });
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12, setupPreflightProvider: provider });
  const reserved = await fence.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
  const read = { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  state.hook = () => fence.recordOriginalHash({ ...read, operationId: reserved.operation_id, originalHash: hash(63) });
  const args = { ...read, operationId: reserved.operation_id, reviewSha256: review.review_sha256,
    stageId: 'create_keyless_vault', actionCommitmentSha256: review.stages[0].action_commitment_sha256 };
  await assert.rejects(fence.claimPrompt(args), e => e.code === 'MISMATCH');
  const retained = await fence.inspect(read);
  assert.equal(retained.original_hash, hash(63)); assert.equal(retained.claim_status, 'ORIGINAL_ALREADY_RECORDED');
  await assert.rejects(fence.recordOriginalHash({ ...read, operationId: reserved.operation_id, originalHash: hash(64) }), e => e.code === 'MISMATCH');
}));

setupDbTest('a setup claim whose acknowledgement arrives after freshness expires is never returned or retried', async () => resources(async db => {
  const owner = newOwner(), ownerKey = key(), snapshot = setupSnapshot();
  snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
  const review = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: SETUP_NOW }).review;
  const { provider } = firstSetupPreflightFixture({ owner, ownerKey });
  const normal = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12, setupPreflightProvider: provider });
  const reserved = await normal.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
  let touched = false;
  const delayed = { async connect() {
    const c = await db.connect();
    return { release: c.release.bind(c), async query(sql, values) {
      if (String(sql).includes('UPDATE bouncer_wallet_prompt_v1.claims SET claimed=true')) touched = true;
      const result = await c.query(sql, values);
      if (sql === 'COMMIT' && touched) { touched = false; await new Promise(resolve => setTimeout(resolve, 5_100)); }
      return result;
    } };
  } };
  const slow = createPostgresWalletPromptFence({ pool: delayed, authenticate: syntheticAuth, setupWasmBytes: V12, setupPreflightProvider: provider });
  const args = { owner, ownerPublicKey: ownerKey, operationId: reserved.operation_id, reviewSha256: review.review_sha256,
    stageId: 'create_keyless_vault', actionCommitmentSha256: review.stages[0].action_commitment_sha256, evidence: 'synthetic-auth' };
  await assert.rejects(slow.claimPrompt(args), e => e.code === 'CLAIM_COMMITTED_PREFLIGHT_STALE' && /do not open or retry/.test(e.message));
  assert.equal((await normal.inspect({ owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' })).claim_status, 'CLAIMED');
  await assert.rejects(normal.claimPrompt(args), e => e.code === 'ALREADY_CLAIMED');
}));

setupDbTest('reconciliation reads only the retained setup original and never unlocks a retry or later stage', async () => resources(async db => {
  const owner = newOwner(), ownerKey = key(), f = setupFixture(0, 33, { owner, ownerKey });
  const observed = { calls: [], network: 'testnet', result: f.result, unavailable: false };
  const provider = {
    async viewNodeStatus() { observed.calls.push('status'); return { chain_id: observed.network }; },
    async txStatusReceipts(original, signer, finality) {
      observed.calls.push([original, signer, finality]);
      if (observed.unavailable) throw new Error('private RPC URL and access token');
      return observed.result;
    },
  };
  const { provider: setupPreflightProvider } = firstSetupPreflightFixture({ owner, ownerKey });
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: syntheticAuth, setupWasmBytes: V12,
    setupReceiptProvider: provider, setupPreflightProvider });
  const request = { review: f.review, setupSnapshot: f.snapshot, trustedReviewHash: f.trustedReviewHash,
    trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' };
  const reserved = await fence.reserve(request), read = { owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  const args = { ...read, operationId: reserved.operation_id, reviewSha256: f.trustedReviewHash,
    stageId: request.stageId, actionCommitmentSha256: f.review.stages[0].action_commitment_sha256, originalHash: f.trustedOriginalHash };
  await assert.rejects(fence.reconcileSetupOriginal(args), e => e.code === 'MISMATCH');
  assert.deepEqual(observed.calls, []);
  await fence.claimPrompt({ ...args });
  await fence.recordOriginalHash({ ...read, operationId: reserved.operation_id, originalHash: f.trustedOriginalHash });
  for (const patch of [{ operationId: '0'.repeat(32) }, { originalHash: hash(34) }, { reviewSha256: '0'.repeat(64) },
    { actionCommitmentSha256: '0'.repeat(64) }, { evidence: 'bad' }]) {
    await assert.rejects(fence.reconcileSetupOriginal({ ...args, ...patch }));
  }
  assert.deepEqual(observed.calls, []);
  const proof = await fence.reconcileSetupOriginal(args);
  assert.equal(proof.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(proof.tx_hash, f.trustedOriginalHash);
  assert.equal(proof.execution_authorized, false); assert.equal(proof.later_stage_unlocked, false);
  assert.equal(proof.provider_trusted_not_consensus_proof, true);
  assert.deepEqual(observed.calls, ['status', [f.trustedOriginalHash, owner, 'FINAL']]);
  assert.equal((await fence.reconcileSetupOriginal(args)).tx_hash, f.trustedOriginalHash, 're-reading is safe; resending is not');
  observed.network = 'mainnet'; observed.calls.length = 0;
  await assert.rejects(fence.reconcileSetupOriginal(args), e => e.code === 'RECEIPT_UNKNOWN');
  assert.deepEqual(observed.calls, ['status']); observed.network = 'testnet';
  observed.unavailable = true;
  await assert.rejects(fence.reconcileSetupOriginal(args), e => e.code === 'RECEIPT_UNKNOWN' && !e.message.includes('private'));
  observed.unavailable = false;
  for (const change of [r => { r.transaction.hash = hash(34); }, r => { r.receipts = []; }, r => { r.final_execution_status = 'EXECUTED'; }]) {
    observed.result = structuredClone(f.result); change(observed.result);
    await assert.rejects(fence.reconcileSetupOriginal(args), e => e.code === 'RECEIPT_UNKNOWN');
  }
  observed.result = structuredClone(f.result); observed.result.status = { Failure: { ActionError: {} } };
  const failure = await fence.reconcileSetupOriginal(args);
  assert.equal(failure.status, 'FINAL_FAILURE_NEEDS_RECONCILIATION'); assert.equal(failure.later_stage_unlocked, false);
  assert.equal((await fence.inspect(read)).original_hash, f.trustedOriginalHash);
  await assert.rejects(fence.claimPrompt(args), e => e.code === 'MISMATCH');
  await assert.rejects(fence.reserve(request), e => e.code === 'OWNER_FENCED');
}));

dbtest('two separate processes cannot claim the same reviewed wallet prompt twice', async () => resources(async (db, fence) => {
  const f = fixture(), reservation = await fence.reserve(f.request), claim = claimRequest(f, reservation);
  assert.equal(reservation.claim_status, 'AVAILABLE');
  const workers = [startWorker({ __mode: 'claim', ...claim }), startWorker({ __mode: 'claim', ...claim })];
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.send());
    const results = await Promise.all(workers.map(w => w.done));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => r.code === 'ALREADY_CLAIMED').length, 1);
    assert.equal((await fence.inspect(f.read)).claim_status, 'CLAIMED');
    await assert.rejects(fence.claimPrompt(claim), e => e.code === 'ALREADY_CLAIMED');
    await assert.rejects(db.query('UPDATE bouncer_wallet_prompt_v1.claims SET claimed=false WHERE owner_account_id=$1', [f.owner]), /single use/);
    await assert.rejects(db.query('DELETE FROM bouncer_wallet_prompt_v1.claims WHERE owner_account_id=$1', [f.owner]), /cannot be deleted/);
    assert.equal((await fence.recordOriginalHash({ ...f.read, operationId: reservation.operation_id, originalHash: hash(20) })).original_hash, hash(20));
  } finally { workers.forEach(w => { if (w.child.connected) w.child.kill(); }); }
}));

dbtest('a lost claim acknowledgement never becomes a second claim', async () => resources(async (db, normal) => {
  const f = fixture(), reservation = await normal.reserve(f.request), claim = claimRequest(f, reservation);
  const injected = faultPool(db, 'UPDATE bouncer_wallet_prompt_v1.claims SET claimed');
  const failing = createPostgresWalletPromptFence({ pool: injected, authenticate: syntheticAuth });
  await assert.rejects(failing.claimPrompt(claim), error => error.code === 'DATABASE_UNKNOWN' && !error.message.includes('secret'));
  assert.equal(injected.fired, true);
  assert.equal((await normal.inspect(f.read)).claim_status, 'CLAIMED');
  await assert.rejects(normal.claimPrompt(claim), error => error.code === 'ALREADY_CLAIMED');
}));

dbtest('legacy, changed, unauthenticated or already-hashed prompts cannot be newly claimed', async () => resources(async (db, fence) => {
  const f = fixture(), operation = crypto.randomBytes(16).toString('hex');
  // Simulate a reservation from the older prototype, before eligibility rows
  // existed. Lack of a claim is never evidence that no wallet was opened.
  await db.query(`INSERT INTO bouncer_wallet_prompt_v1.prompts
    (owner_account_id,operation_id,owner_public_key,review_sha256,stage_id,action_commitment_sha256,review)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [f.owner, operation, f.ownerKey, f.review.review_sha256, stage,
    f.review.stages[0].action_commitment_sha256, JSON.stringify(f.review)]);
  const legacy = await fence.inspect(f.read);
  assert.equal(legacy.claim_status, 'LEGACY_NOT_CLAIMABLE');
  await assert.rejects(fence.claimPrompt(claimRequest(f, { operation_id: operation })), error => error.code === 'LEGACY_NOT_CLAIMABLE');
  const g = fixture(), reserved = await fence.reserve(g.request), request = claimRequest(g, reserved);
  await assert.rejects(fence.claimPrompt({ ...request, evidence: 'bad' }), error => error.code === 'UNAUTHENTICATED');
  for (const patch of [{ operationId: 'f'.repeat(32) }, { reviewSha256: '0'.repeat(64) },
    { actionCommitmentSha256: '0'.repeat(64) }, { stageId: 'install_buffer_vault_agent' }]) {
    await assert.rejects(fence.claimPrompt({ ...request, ...patch }), error => error.code === 'MISMATCH');
  }
  assert.equal((await fence.inspect(g.read)).claim_status, 'AVAILABLE');
  await fence.recordOriginalHash({ ...g.read, operationId: reserved.operation_id, originalHash: hash(22) });
  assert.equal((await fence.inspect(g.read)).claim_status, 'ORIGINAL_ALREADY_RECORDED');
  await assert.rejects(fence.claimPrompt(request), error => error.code === 'MISMATCH');
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

dbtest('missing unique index, RLS or disabled trigger prevents reservations and reads', async () => resources(async (db, normal) => {
  const f = fixture();
  // Inject catalog faults around a real PostgreSQL connection without changing
  // the shared schema while other test files run concurrently.
  function catalogFault(kind) {
    return { async connect() {
      const client = await db.connect();
      return { release: client.release.bind(client), async query(sql, args) {
        const result = await client.query(sql, args), text = String(sql);
        if (['index', 'claim-index', 'stage-index'].includes(kind) && text.includes('FROM pg_catalog.pg_index')) {
          const target = kind === 'index' ? 'prompts:operation_id' : kind === 'claim-index' ? 'claims:operation_id' : 'setup_stages:operation_id,stage_index';
          result.rows = result.rows.filter(row => `${row.table_name}:${row.columns.join(',')}` !== target);
        }
        if ((kind === 'rls' || (kind === 'claim-rls' && args?.[0] === 'claims') ||
            (kind === 'stage-rls' && args?.[0] === 'setup_stages')) && text.includes('SELECT t.relrowsecurity')) result.rows[0].relrowsecurity = true;
        if ((kind === 'trigger' || (kind === 'claim-trigger' && args?.[0] === 'claims') ||
            (kind === 'stage-trigger' && args?.[0] === 'setup_stages')) && text.includes('FROM pg_catalog.pg_trigger')) result.rows[0].tgenabled = 'D';
        return result;
      } };
    } };
  }
  for (const kind of ['index', 'rls', 'trigger', 'claim-index', 'claim-rls', 'claim-trigger', 'stage-index', 'stage-rls', 'stage-trigger']) {
    const fence = createPostgresWalletPromptFence({ pool: catalogFault(kind), authenticate: syntheticAuth });
    await assert.rejects(fence.reserve(f.request), error => error.code === 'UNSAFE_SCHEMA');
    await assert.rejects(fence.inspect(f.read), error => error.code === 'UNSAFE_SCHEMA');
  }
  assert.equal(await normal.inspect(f.read), null);
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

setupDbTest('ordered setup advances only through three retained originals and a funded-state check', async () => resources(async db => {
  const s = await setupScenario(db), { fence, read } = s;
  const first = await fence.inspectSetupProgress(read);
  assert.deepEqual(first.stages.map(x => [x.stage_id, x.claimed, x.original_hash]), [
    ['create_keyless_vault', false, null], ['register_vault_circle', false, null], ['fund_vault_circle', false, null],
  ]);
  assert.equal(first.execution_authorized, false); assert.equal(first.independently_durable, false);
  await assert.rejects(fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  await assert.rejects(fence.claimSetupStage(s.stageArgs(2)), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  await assert.rejects(fence.recordSetupStageOriginal(s.recordArgs(1)), e => e.code === 'CLAIM_REQUIRED');
  assert.equal(s.receiptState.calls.length, 0);
  await s.claimFirst({ record: false });
  await assert.rejects(fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  await fence.recordOriginalHash({ ...read, operationId: s.reserved.operation_id, originalHash: s.originals[0].trustedOriginalHash });

  s.setStage(1);
  const registration = await fence.claimSetupStage(s.stageArgs(1));
  assert.equal(registration.status, 'PROMPT_CLAIMED_NO_HASH');
  assert.equal(registration.prior_originals_matched, 1); assert.equal(registration.preflight_block_hash, s.blockHash);
  assert.equal(registration.execution_authorized, false); assert.equal(registration.wallet_invocation_verified, false);
  await assert.rejects(fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'ALREADY_CLAIMED');
  await assert.rejects(fence.claimSetupStage(s.stageArgs(2)), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  await assert.rejects(fence.recordSetupStageOriginal({ ...s.recordArgs(1), originalHash: s.originals[0].trustedOriginalHash }), e => e.code === 'MISMATCH');
  const registered = await fence.recordSetupStageOriginal(s.recordArgs(1));
  assert.equal(registered.original_hash, s.originals[1].trustedOriginalHash);
  assert.deepEqual(await fence.recordSetupStageOriginal(s.recordArgs(1)), registered);
  await assert.rejects(fence.recordSetupStageOriginal({ ...s.recordArgs(1), originalHash: hash(90) }), e => e.code === 'MISMATCH');
  const registrationProof = await fence.reconcileSetupStage(s.recordArgs(1));
  assert.equal(registrationProof.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(registrationProof.later_stage_unlocked, false);
  await assert.rejects(fence.reconcileSetupStage({ ...s.recordArgs(1), originalHash: hash(90) }), e => e.code === 'MISMATCH');

  s.setStage(2);
  const funding = await fence.claimSetupStage(s.stageArgs(2));
  assert.equal(funding.status, 'PROMPT_CLAIMED_NO_HASH'); assert.equal(funding.prior_originals_matched, 2);
  const verifyArgs = { ...read, operationId: s.reserved.operation_id, reviewSha256: s.review.review_sha256 };
  await assert.rejects(fence.verifySetupFunded(verifyArgs), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  await fence.recordSetupStageOriginal(s.recordArgs(2));
  const fundingProof = await fence.reconcileSetupStage(s.recordArgs(2));
  assert.equal(fundingProof.status, 'FINAL_FUNDING_RECEIPTS_MATCH');
  assert.equal(fundingProof.seller_payment_verified, false);
  s.setStage(3);
  const funded = await fence.verifySetupFunded(verifyArgs);
  assert.equal(funded.status, 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH'); assert.equal(funded.prior_receipt_graphs_matched, 3);
  assert.equal(funded.spending_unlocked, false); assert.equal(funded.independent_delivery_verified, false);
  const final = await fence.inspectSetupProgress(read);
  assert.deepEqual(final.stages.map(x => x.original_hash), s.originals.map(x => x.trustedOriginalHash));
  assert.deepEqual(final.stages.map(x => x.claimed), [true, true, true]);
}));

setupDbTest('later setup claims reject unknown originals, drift, tampering, races and retries', async () => resources(async db => {
  const s = await setupScenario(db), { fence, state, receiptState } = s;
  await s.claimFirst(); s.setStage(1);
  const args = s.stageArgs(1), prior = s.originals[0].trustedOriginalHash;
  await assert.rejects(fence.claimSetupStage({ ...args, evidence: 'bad' }), e => e.code === 'UNAUTHENTICATED');
  await assert.rejects(fence.claimSetupStage({ ...args, actionCommitmentSha256: '0'.repeat(64) }), e => e.code === 'MISMATCH');
  assert.equal(receiptState.calls.length, 0);
  const cases = [
    { set: () => { receiptState.unavailable = true; }, reset: () => { receiptState.unavailable = false; }, code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
    { set: () => { receiptState.chain = 'mainnet'; }, reset: () => { receiptState.chain = 'testnet'; }, code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
    { set: () => { const x = structuredClone(s.originals[0].result); x.transaction.hash = hash(90); receiptState.results.set(prior, x); },
      reset: () => receiptState.results.set(prior, s.originals[0].result), code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
    { set: () => { const x = structuredClone(s.originals[0].result); x.final_execution_status = 'EXECUTED'; receiptState.results.set(prior, x); },
      reset: () => receiptState.results.set(prior, s.originals[0].result), code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
    { set: () => { state.vaultPresence.account.code_hash = hash(91); }, reset: () => s.setStage(1), code: 'SETUP_PREFLIGHT_BLOCKED' },
    { set: () => { state.vaultKeys.keys.push({ public_key: s.ownerKey }); },
      reset: () => { state.vaultKeys.keys = []; }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { set: () => { state.seller.code_hash = hash(92); }, reset: () => { state.seller.code_hash = hash(5); }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { set: () => { state.vaultRegistration = { total: '1', available: '0' }; }, reset: () => { state.vaultRegistration = null; }, code: 'SETUP_PREFLIGHT_BLOCKED' },
    { set: () => { state.blockAgeMs = 200_000; }, reset: () => { state.blockAgeMs = 0; }, code: 'SETUP_PREFLIGHT_UNAVAILABLE' },
  ];
  for (const item of cases) {
    item.set();
    await assert.rejects(fence.claimSetupStage(args), e => e.code === item.code && !e.message.includes('private'));
    assert.equal((await fence.inspectSetupProgress(s.read)).stages[1].claimed, false);
    item.reset();
  }
  const results = await Promise.allSettled([fence.claimSetupStage(args), fence.claimSetupStage(args), fence.claimSetupStage(args)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'ALREADY_CLAIMED').length, 2);
  await assert.rejects(fence.claimSetupStage(args), e => e.code === 'ALREADY_CLAIMED');
}));

setupDbTest('later-stage claims and originals survive lost commit acknowledgements without retry', async () => resources(async db => {
  const s = await setupScenario(db);
  await s.claimFirst(); s.setStage(1);
  const injected = faultPool(db, 'UPDATE bouncer_wallet_prompt_v1.setup_stages SET claimed=true');
  const faulted = createPostgresWalletPromptFence({ pool: injected, authenticate: syntheticAuth, setupWasmBytes: V12,
    setupReceiptProvider: s.receiptProvider, setupPreflightProvider: s.provider });
  await assert.rejects(faulted.claimSetupStage(s.stageArgs(1)), e => e.code === 'DATABASE_UNKNOWN' && !e.message.includes('secret'));
  assert.equal(injected.fired, true);
  assert.equal((await s.fence.inspectSetupProgress(s.read)).stages[1].claimed, true);
  await assert.rejects(s.fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'ALREADY_CLAIMED');
  await assert.rejects(s.fence.claimSetupStage(s.stageArgs(2)), e => e.code === 'PRIOR_STAGE_UNRESOLVED');
  const recordFault = faultPool(db, 'UPDATE bouncer_wallet_prompt_v1.setup_stages SET original_hash=');
  const recordFence = createPostgresWalletPromptFence({ pool: recordFault, authenticate: syntheticAuth, setupWasmBytes: V12 });
  await assert.rejects(recordFence.recordSetupStageOriginal(s.recordArgs(1)), e => e.code === 'DATABASE_UNKNOWN');
  assert.equal(recordFault.fired, true);
  assert.equal((await s.fence.inspectSetupProgress(s.read)).stages[1].original_hash, s.originals[1].trustedOriginalHash);
  await assert.rejects(s.fence.recordSetupStageOriginal({ ...s.recordArgs(1), originalHash: hash(90) }), e => e.code === 'MISMATCH');
  assert.equal((await s.fence.recordSetupStageOriginal(s.recordArgs(1))).do_not_retry, true);
}));

setupDbTest('later-stage journal guards prevent changed identities, deletion and overwritten hashes', async () => resources(async db => {
  const s = await setupScenario(db), owner = s.owner;
  for (const sql of [
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET stage_id='fund_vault_circle' WHERE owner_account_id=$1 AND stage_index=1`,
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET action_commitment_sha256='bad' WHERE owner_account_id=$1 AND stage_index=1`,
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET original_hash='bad' WHERE owner_account_id=$1 AND stage_index=1`,
    `DELETE FROM bouncer_wallet_prompt_v1.setup_stages WHERE owner_account_id=$1 AND stage_index=1`,
  ]) await assert.rejects(db.query(sql, [owner]));
  await s.claimFirst(); s.setStage(1); await s.fence.claimSetupStage(s.stageArgs(1));
  await s.fence.recordSetupStageOriginal(s.recordArgs(1));
  for (const sql of [
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET claimed=false,claimed_at=NULL WHERE owner_account_id=$1 AND stage_index=1`,
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET original_hash='another' WHERE owner_account_id=$1 AND stage_index=1`,
    `UPDATE bouncer_wallet_prompt_v1.setup_stages SET claimed_at=clock_timestamp() WHERE owner_account_id=$1 AND stage_index=1`,
  ]) await assert.rejects(db.query(sql, [owner]));
  assert.equal((await s.fence.inspectSetupProgress(s.read)).stages[1].original_hash, s.originals[1].trustedOriginalHash);
}));

setupDbTest('independent processes cannot claim the same later setup prompt twice', async () => resources(async db => {
  const s = await setupScenario(db); await s.claimFirst();
  const payload = { ...s.stageArgs(1), __mode: 'setup-claim',
    __originals: { [s.originals[0].trustedOriginalHash]: s.originals[0].result } };
  const workers = [startWorker(payload), startWorker(payload)];
  try {
    await Promise.all(workers.map(w => w.ready)); workers.forEach(w => w.send());
    const results = await Promise.all(workers.map(w => w.done));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => r.code === 'ALREADY_CLAIMED').length, 1);
    assert.equal((await s.fence.inspectSetupProgress(s.read)).stages[1].claimed, true);
  } finally { workers.forEach(w => { if (w.child.connected) w.child.kill(); }); }
}));

setupDbTest('a later claim whose commit acknowledgement is stale cannot be returned or reopened', async () => resources(async db => {
  const s = await setupScenario(db); await s.claimFirst(); s.setStage(1);
  let touched = false;
  const delayed = { async connect() {
    const c = await db.connect();
    return { release: c.release.bind(c), async query(sql, args) {
      if (String(sql).includes('UPDATE bouncer_wallet_prompt_v1.setup_stages SET claimed=true')) touched = true;
      const result = await c.query(sql, args);
      if (sql === 'COMMIT' && touched) { touched = false; await new Promise(resolve => setTimeout(resolve, 5_100)); }
      return result;
    } };
  } };
  const slow = createPostgresWalletPromptFence({ pool: delayed, authenticate: syntheticAuth, setupWasmBytes: V12,
    setupReceiptProvider: s.receiptProvider, setupPreflightProvider: s.provider });
  await assert.rejects(slow.claimSetupStage(s.stageArgs(1)), e => e.code === 'CLAIM_COMMITTED_PREFLIGHT_STALE');
  assert.equal((await s.fence.inspectSetupProgress(s.read)).stages[1].claimed, true);
  await assert.rejects(s.fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'ALREADY_CLAIMED');
}));

setupDbTest('legacy setup without atomically created later-stage rows never starts or advances', async () => resources(async db => {
  const s = await setupScenario(db);
  // Mimic a reservation from before the stage journal existed, only in the
  // isolated database. Disable triggers for this test connection, not globally.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query('DELETE FROM bouncer_wallet_prompt_v1.setup_stages WHERE owner_account_id=$1', [s.owner]);
    await client.query('COMMIT');
  } finally { client.release(); }
  await assert.rejects(s.fence.inspectSetupProgress(s.read), e => e.code === 'LEGACY_NOT_CLAIMABLE');
  await assert.rejects(s.fence.claimPrompt(s.stageArgs(0)), e => e.code === 'LEGACY_NOT_CLAIMABLE');
  await assert.rejects(s.fence.claimSetupStage(s.stageArgs(1)), e => e.code === 'LEGACY_NOT_CLAIMABLE');
  assert.equal(s.state.calls.length, 0); assert.equal(s.receiptState.calls.length, 0);
}));
