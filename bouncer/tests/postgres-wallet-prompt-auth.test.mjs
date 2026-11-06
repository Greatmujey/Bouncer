import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import nearApi from 'near-api-js';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { buildBufferWalletSpendingPlan } from '../agent/buffer-wallet-spending-plan.mjs';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { wasm as V12, NOW as SETUP_NOW, snapshot as setupSnapshot, fixture as setupFixture } from './buffer-wallet-setup-fixture.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { createPostgresWalletPromptAuth, initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';

// Real PostgreSQL and disposable Ed25519 keys with fabricated RPC views only.
// No actual account, wallet, RPC, transaction or seller is contacted.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw new Error('PostgreSQL integration test URL is required');
const dbtest = url ? test : test.skip;
const setupDbTest = url && V12 ? test : test.skip;
const origin = 'https://bouncer.example';
const blockHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 21));
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const pool = () => new pg.Pool({ connectionString: url, max: 16, connectionTimeoutMillis: 5000 });
function provider() {
  const state = { chain: 'testnet', permission: 'FullAccess', blockHash, ageMs: 0, unavailable: false };
  return { state, async viewNodeStatus() { if (state.unavailable) throw new Error('synthetic provider down'); return { chain_id: state.chain }; },
    async viewBlock(args) { assert.deepEqual(args, { finality: 'final' }); return { header: { hash: blockHash,
      timestamp_nanosec: String(BigInt(Date.now() - state.ageMs) * 1_000_000n) } }; },
    async viewAccessKey(owner, key, args) { assert.equal(args.blockId, blockHash); return { block_hash: state.blockHash, permission: state.permission }; } };
}
const pair = () => nearApi.KeyPair.fromRandom('ed25519');
const pk = x => String(x.getPublicKey());
function fixture() {
  const owner = `auth-${crypto.randomBytes(8).toString('hex')}.testnet`, ownerKey = pair();
  const { review } = buildBufferWalletSpendingPlan({ owner, vault: `vault.${owner}`, adapter: `buffer.${owner}`,
    policy_id: 'research', vault_agent_public_key: pk(pair()), forwarder_agent_public_key: pk(pair()),
    per_tx_cap_atoms: '20000000', daily_cap_atoms: '20000000', vault_agent_gas_allowance_yocto: '100000000000000000000000',
    forwarder_agent_gas_allowance_yocto: '200000000000000000000000' });
  const action = { format: 'bouncer-wallet-prompt-auth-v1', network: 'testnet', purpose: 'reserve', owner,
    owner_public_key: pk(ownerKey), review_sha256: review.review_sha256, stage_id: 'configure_buffer_locked_policy',
    action_commitment_sha256: review.stages[0].action_commitment_sha256 };
  return { owner, ownerKey, review, action };
}
function signed(challenge, f, signer = f.ownerKey) {
  const nonce = Uint8Array.from(Buffer.from(challenge.nonce_base64, 'base64'));
  const payload = nep413Payload({ message: challenge.message, nonce, recipient: challenge.recipient });
  const digest = crypto.createHash('sha256').update(payload).digest();
  return { challenge_id: challenge.challenge_id, accountId: f.owner, publicKey: pk(f.ownerKey),
    signature: Buffer.from(signer.sign(digest).signature).toString('base64') };
}
async function resources(run) {
  const db = pool(), rpc = provider();
  try { return await run(db, rpc, createPostgresWalletPromptAuth({ pool: db, origin, provider: rpc })); }
  finally { await db.end(); }
}
if (url) test.before(async () => {
  const db = pool();
  try { await initializePostgresWalletPromptAuth({ pool: db }); await initializePostgresWalletPromptFence({ pool: db }); }
  finally { await db.end(); }
});

test('authenticator requires a fixed HTTPS origin, trusted read-only provider and database', () => {
  const db = { connect() {} }, rpc = provider();
  for (const bad of ['http://bouncer.example', 'https://bouncer.example/path', 'https://user@bouncer.example', 'https://localhost', 'https://bouncer.example/']) {
    assert.throws(() => createPostgresWalletPromptAuth({ pool: db, provider: rpc, origin: bad }));
  }
  assert.throws(() => createPostgresWalletPromptAuth({ pool: db, provider: {}, origin }));
  const auth = createPostgresWalletPromptAuth({ pool: db, provider: rpc, origin });
  assert.deepEqual(Object.keys(auth).sort(), ['authenticate', 'issue']);
});

dbtest('a signed, owner-bound fresh testnet challenge works once and stores no signature', async () => resources(async (db, rpc, auth) => {
  const f = fixture(), challenge = await auth.issue(f.action), evidence = signed(challenge, f);
  assert.equal(Buffer.from(challenge.nonce_base64, 'base64').length, 32);
  assert.equal(challenge.recipient, 'bouncer.example');
  assert.match(challenge.message, /Site: https:\/\/bouncer\.example/);
  assert.match(challenge.message, /not a transaction and does not itself approve spending/);
  assert.equal(await auth.authenticate({ action: f.action, evidence }), true);
  assert.equal(await auth.authenticate({ action: f.action, evidence }), false, 'a signed challenge is single use');
  const stored = await db.query('SELECT * FROM bouncer_wallet_auth_v1.challenges WHERE challenge_id=$1', [challenge.challenge_id]);
  assert.equal(stored.rows[0].consumed, true);
  assert.ok(!JSON.stringify(stored.rows[0]).includes(evidence.signature));
  await assert.rejects(db.query('UPDATE bouncer_wallet_auth_v1.challenges SET consumed=false WHERE challenge_id=$1', [challenge.challenge_id]), /single use/);
  await assert.rejects(db.query('DELETE FROM bouncer_wallet_auth_v1.challenges WHERE challenge_id=$1', [challenge.challenge_id]), /cannot be deleted/);
}));

dbtest('a challenge cannot be reused concurrently or redirected to another origin or action', async () => resources(async (db, rpc, auth) => {
  const f = fixture(), c = await auth.issue(f.action), evidence = signed(c, f);
  const otherSite = createPostgresWalletPromptAuth({ pool: db, origin: 'https://other.example', provider: rpc });
  assert.equal(await otherSite.authenticate({ action: f.action, evidence }), false);
  assert.equal(await auth.authenticate({ action: { ...f.action, action_commitment_sha256: 'a'.repeat(64) }, evidence }), false);
  assert.equal(await auth.authenticate({ action: { ...f.action, owner: 'other.testnet' }, evidence }), false);
  assert.equal(await auth.authenticate({ action: f.action, evidence: { ...evidence, accountId: 'other.testnet' } }), false);
  assert.equal(await auth.authenticate({ action: f.action, evidence: { ...evidence, signature: signed(c, f, pair()).signature } }), false);
  const wrongNonce = { ...c, nonce_base64: Buffer.alloc(32, 99).toString('base64') };
  assert.equal(await auth.authenticate({ action: f.action, evidence: signed(wrongNonce, f) }), false);
  const realNow = Date.now;
  try {
    Date.now = () => c.expires_at_ms + 1;
    assert.equal(await auth.authenticate({ action: f.action, evidence }), false, 'an expired challenge is rejected');
  } finally { Date.now = realNow; }
  const attempts = await Promise.all(Array.from({ length: 10 }, () => auth.authenticate({ action: f.action, evidence })));
  assert.equal(attempts.filter(Boolean).length, 1);
}));

dbtest('stale or mismatched RPC and restricted or missing keys fail before a challenge is consumed', async () => resources(async (db, rpc, auth) => {
  const f = fixture(), c = await auth.issue(f.action), evidence = signed(c, f);
  const rejected = async () => assert.equal(await auth.authenticate({ action: f.action, evidence }), false);
  rpc.state.chain = 'mainnet'; await rejected(); rpc.state.chain = 'testnet';
  rpc.state.ageMs = 180_000; await rejected(); rpc.state.ageMs = 0;
  rpc.state.blockHash = hash(22); await rejected(); rpc.state.blockHash = blockHash;
  rpc.state.permission = { FunctionCall: { receiver_id: 'contract.testnet', method_names: [] } }; await rejected();
  rpc.state.permission = null; await rejected(); rpc.state.permission = 'FullAccess';
  rpc.state.unavailable = true; await rejected(); rpc.state.unavailable = false;
  assert.equal(await auth.authenticate({ action: f.action, evidence }), true);
}));

dbtest('authenticated fence reserves only the exact signed review, then records the original hash', async () => resources(async (db, rpc, auth) => {
  const f = fixture(), fence = createPostgresWalletPromptFence({ pool: db, authenticate: auth.authenticate });
  const first = await auth.issue(f.action), evidence = signed(first, f);
  const request = { review: f.review, trustedReviewHash: f.review.review_sha256, trustedOwnerPublicKey: pk(f.ownerKey),
    stageId: f.action.stage_id, evidence };
  const tampered = { ...request, stageId: 'install_buffer_vault_agent' };
  await assert.rejects(fence.reserve(tampered), error => error.code === 'UNAUTHENTICATED');
  const reservation = await fence.reserve(request);
  assert.equal(reservation.status, 'PROMPT_RESERVED_NO_HASH');
  assert.equal(reservation.owner, f.owner);
  await assert.rejects(fence.reserve(request), error => error.code === 'UNAUTHENTICATED');
  const second = await auth.issue(f.action);
  await assert.rejects(fence.reserve({ ...request, evidence: signed(second, f) }), error => error.code === 'OWNER_FENCED');
  const claimAction = { format: f.action.format, network: 'testnet', purpose: 'claim_prompt', owner: f.owner,
    owner_public_key: pk(f.ownerKey), operation_id: reservation.operation_id, review_sha256: f.review.review_sha256,
    stage_id: f.action.stage_id, action_commitment_sha256: f.action.action_commitment_sha256 };
  const claimChallenge = await auth.issue(claimAction), claimEvidence = signed(claimChallenge, f);
  const claimArgs = { owner: f.owner, ownerPublicKey: pk(f.ownerKey), operationId: reservation.operation_id,
    reviewSha256: f.review.review_sha256, stageId: f.action.stage_id,
    actionCommitmentSha256: f.action.action_commitment_sha256, evidence: claimEvidence };
  await assert.rejects(fence.claimPrompt({ ...claimArgs, actionCommitmentSha256: '0'.repeat(64) }), error => error.code === 'UNAUTHENTICATED');
  const claimed = await fence.claimPrompt(claimArgs);
  assert.equal(claimed.status, 'PROMPT_CLAIMED_NO_HASH'); assert.equal(claimed.execution_authorized, false);
  await assert.rejects(fence.claimPrompt(claimArgs), error => error.code === 'UNAUTHENTICATED');
  const freshClaim = await auth.issue(claimAction);
  await assert.rejects(fence.claimPrompt({ ...claimArgs, evidence: signed(freshClaim, f) }), error => error.code === 'ALREADY_CLAIMED');
  const recordAction = { format: f.action.format, network: 'testnet', purpose: 'record_original_hash', owner: f.owner,
    owner_public_key: pk(f.ownerKey), operation_id: reservation.operation_id, original_hash: hash(31) };
  const c = await auth.issue(recordAction);
  const recorded = await fence.recordOriginalHash({ owner: f.owner, ownerPublicKey: pk(f.ownerKey),
    operationId: reservation.operation_id, originalHash: hash(31), evidence: signed(c, f) });
  assert.equal(recorded.original_hash, hash(31));
  const inspectAction = { format: f.action.format, network: 'testnet', purpose: 'inspect', owner: f.owner, owner_public_key: pk(f.ownerKey) };
  const inspect = await auth.issue(inspectAction);
  assert.equal((await fence.inspect({ owner: f.owner, ownerPublicKey: pk(f.ownerKey), evidence: signed(inspect, f) })).original_hash, hash(31));
}));

setupDbTest('signed NEP-413 challenges bind the first pinned vault-creation reservation and claim', async () => resources(async (db, rpc, auth) => {
  const f = fixture(), snapshot = setupSnapshot();
  snapshot.owner = f.owner; snapshot.candidate_vault = `vault.${f.owner}`;
  const review = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: SETUP_NOW }).review;
  const original = setupFixture(0, 35, { owner: f.owner, ownerKey: pk(f.ownerKey) });
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async txStatusReceipts(hash, owner, finality) {
      assert.equal(hash, original.trustedOriginalHash); assert.equal(owner, f.owner); assert.equal(finality, 'FINAL');
      return original.result;
    } };
  const fence = createPostgresWalletPromptFence({ pool: db, authenticate: auth.authenticate, setupWasmBytes: V12, setupReceiptProvider: provider });
  const action = { format: f.action.format, network: 'testnet', purpose: 'reserve', owner: f.owner,
    owner_public_key: pk(f.ownerKey), review_sha256: review.review_sha256, stage_id: 'create_keyless_vault',
    action_commitment_sha256: review.stages[0].action_commitment_sha256 };
  const challenge = await auth.issue(action);
  const reservation = await fence.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
    trustedOwnerPublicKey: pk(f.ownerKey), stageId: action.stage_id, evidence: signed(challenge, f) });
  assert.equal(reservation.claim_status, 'AVAILABLE');
  const claimAction = { ...action, purpose: 'claim_prompt', operation_id: reservation.operation_id };
  const c = await auth.issue(claimAction);
  const claimArgs = { owner: f.owner, ownerPublicKey: pk(f.ownerKey), operationId: reservation.operation_id,
    reviewSha256: review.review_sha256, stageId: action.stage_id,
    actionCommitmentSha256: action.action_commitment_sha256, evidence: signed(c, f) };
  const claim = await fence.claimPrompt(claimArgs);
  assert.equal(claim.status, 'PROMPT_CLAIMED_NO_HASH');
  assert.equal(claim.execution_authorized, false); assert.equal(claim.wallet_invocation_verified, false);
  await assert.rejects(fence.claimPrompt(claimArgs), e => e.code === 'UNAUTHENTICATED');
  const recordAction = { format: f.action.format, network: 'testnet', purpose: 'record_original_hash', owner: f.owner,
    owner_public_key: pk(f.ownerKey), operation_id: reservation.operation_id, original_hash: original.trustedOriginalHash };
  const recordChallenge = await auth.issue(recordAction);
  await fence.recordOriginalHash({ owner: f.owner, ownerPublicKey: pk(f.ownerKey), operationId: reservation.operation_id,
    originalHash: original.trustedOriginalHash, evidence: signed(recordChallenge, f) });
  const receiptAction = { ...claimAction, purpose: 'reconcile_setup_original', original_hash: original.trustedOriginalHash };
  const receiptChallenge = await auth.issue(receiptAction);
  const receiptArgs = { ...claimArgs, originalHash: original.trustedOriginalHash, evidence: signed(receiptChallenge, f) };
  await assert.rejects(fence.reconcileSetupOriginal({ ...receiptArgs, originalHash: hash(36) }), e => e.code === 'UNAUTHENTICATED');
  const proof = await fence.reconcileSetupOriginal(receiptArgs);
  assert.equal(proof.status, 'FINAL_SETUP_RECEIPT_MATCH'); assert.equal(proof.later_stage_unlocked, false);
  await assert.rejects(fence.reconcileSetupOriginal(receiptArgs), e => e.code === 'UNAUTHENTICATED');
}));

dbtest('a lost challenge-consumption acknowledgement never grants authentication', async () => resources(async (db, rpc, normal) => {
  const f = fixture(), c = await normal.issue(f.action), evidence = signed(c, f); let touched = false, fired = false;
  const injected = { async connect() {
    const client = await db.connect();
    return { release: client.release.bind(client), async query(sql, args) {
      if (String(sql).includes('UPDATE bouncer_wallet_auth_v1.challenges SET consumed=true')) touched = true;
      if (touched && !fired && sql === 'COMMIT') { fired = true; await client.query(sql, args); throw new Error('synthetic secret'); }
      return client.query(sql, args);
    } };
  } };
  const auth = createPostgresWalletPromptAuth({ pool: injected, origin, provider: rpc });
  assert.equal(await auth.authenticate({ action: f.action, evidence }), false);
  assert.equal(fired, true);
  assert.equal(await normal.authenticate({ action: f.action, evidence }), false, 'the challenge was actually consumed');
  const next = await normal.issue(f.action);
  assert.equal(await normal.authenticate({ action: f.action, evidence: signed(next, f) }), true);
}));

dbtest('unsafe schema, unsupported keys and malformed signatures fail closed', async () => resources(async (db, rpc, auth) => {
  const f = fixture();
  await assert.rejects(auth.issue({ ...f.action, owner: '0x' + 'a'.repeat(40) }));
  await assert.rejects(auth.issue({ ...f.action, owner_public_key: pk(nearApi.KeyPair.fromRandom('secp256k1')) }));
  await assert.rejects(auth.issue({ ...f.action, extra: true }));
  let getterCalled = false;
  const accessor = { ...f.action, get purpose() { getterCalled = true; return 'reserve'; } };
  await assert.rejects(auth.issue(accessor));
  assert.equal(getterCalled, false, 'untrusted action accessors are not invoked');
  const c = await auth.issue(f.action), evidence = signed(c, f);
  assert.equal(await auth.authenticate({ action: f.action, evidence: { ...evidence, signature: 'invalid' } }), false);
  await db.query('ALTER TABLE bouncer_wallet_auth_v1.challenges DISABLE TRIGGER challenge_immutable');
  try {
    await assert.rejects(auth.issue(f.action), /database unavailable or uncertain/);
    assert.equal(await auth.authenticate({ action: f.action, evidence }), false);
  } finally { await db.query('ALTER TABLE bouncer_wallet_auth_v1.challenges ENABLE TRIGGER challenge_immutable'); }
  assert.equal(await auth.authenticate({ action: f.action, evidence }), true);
}));
