import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE, NATIVE_ORACLE_V9_CODE_HASH,
  NATIVE_ORACLE_VAULT_FUNDING } from '../agent/native-oracle-wallet-plan.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { V11_SELECTED_WASM_FEATURES } from '../agent/svalin-setup-preflight.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { createPostgresNativeOraclePromptFence, initializePostgresNativeOraclePromptFence } from '../agent/postgres-native-oracle-prompt-fence.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWitnessedNativeOracleSetup } from '../agent/witnessed-native-oracle-wallet-setup.mjs';
import { createPostgresWalletPromptAuth, initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { nativeSetupAuthAction, signReviewedNativeSetupChallenge } from '../web-src/native-oracle-setup-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { prepareNativeOracleSetupWalletPrompt } from '../web-src/native-oracle-setup-wallet-prompt.mjs';

// Disposable PostgreSQL, fabricated RPC data and keys. No real auth, wallet,
// public-chain transaction or provider work. Never use a production database.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw new Error('PostgreSQL integration test URL is required');
const dbtest = url ? test : test.skip;
const pool = () => new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 });
const wasm = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const NEAR = 10n ** 24n, BLOCK = hash(70);
const auth = async ({ evidence }) => evidence === 'synthetic-auth';
const owner = () => `native-${crypto.randomBytes(8).toString('hex')}.testnet`;
if (url) test.before(async () => { const db = pool(); try { await initializePostgresNativeOraclePromptFence({ pool: db }); await initializePostgresWalletPromptAuth({ pool: db }); } finally { await db.end(); } });

function actionView(a) {
  if (a.enum === 'createAccount') return 'CreateAccount';
  if (a.enum === 'transfer') return { Transfer: { deposit: a.transfer.deposit.toString() } };
  if (a.enum === 'deployContract') return { DeployContract: { code: crypto.createHash('sha256').update(a.deployContract.code).digest('base64') } };
  if (a.enum === 'functionCall') return { FunctionCall: { method_name: a.functionCall.methodName,
    args: Buffer.from(a.functionCall.args).toString('base64'), gas: Number(a.functionCall.gas), deposit: a.functionCall.deposit.toString() } };
  const key = a.addKey, p = key.accessKey.permission.functionCall;
  return { AddKey: { public_key: String(key.publicKey), access_key: { nonce: Number(key.accessKey.nonce),
    permission: { FunctionCall: { allowance: p.allowance.toString(), receiver_id: p.receiverId, method_names: [...p.methodNames] } } } } };
}
function receipt(plan, ownerKey, index) {
  const batch = plan.batches[index], transaction = hash(10 + index), root = hash(20 + index), actions = batch.actions.map(actionView);
  const omit = index === 3;
  return { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: transaction, signer_id: batch.signerId, public_key: ownerKey, receiver_id: batch.receiverId, actions: structuredClone(actions) },
    transaction_outcome: { id: transaction, outcome: { executor_id: batch.signerId, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: omit ? [] : [{ receipt_id: root, predecessor_id: batch.signerId, receiver_id: batch.receiverId,
      receipt: { Action: { signer_id: batch.signerId, signer_public_key: ownerKey, actions: structuredClone(actions), input_data_ids: [], output_data_receivers: [] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: batch.receiverId, status: { SuccessValue: '' }, receipt_ids: [],
      logs: index === 2 ? ['BOUNCER native deposit received'] : [] } }] };
}
function scenario(db, overrides = {}) {
  const ownerId = owner(), vault = `native.${ownerId}`, ownerPair = nearApi.KeyPair.fromRandom('ed25519'),
    ownerKey = String(ownerPair.getPublicKey()), agentKey = key();
  const plan = buildNativeOracleWalletPlan({ wasmBytes: wasm, terms: { owner: ownerId, vault, policy_id: 'price', agent_public_key: agentKey,
    per_tx_cap_yocto: (NEAR / 10n).toString(), daily_cap_yocto: (NEAR / 10n).toString(), vault_deposit_yocto: (NEAR / 10n).toString(),
    agent_gas_allowance_yocto: NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } });
  const review = plan.review, state = { stage: 0, unavailable: false, blocked: false, mixed: false }, calls = [];
  const source = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } };
  const receiptProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(id, account, finality) {
    calls.push(id); assert.equal(account, ownerId); assert.equal(finality, 'FINAL');
    const i = [0,1,2,3].find(i => hash(10 + i) === id); if (state.unavailable || i === undefined) throw Error('synthetic receipt unavailable');
    return receipt(plan, ownerKey, i);
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, height: 321, timestamp_nanosec: String(BigInt(overrides.now?.() ?? Date.now()) * 1_000_000n) } }; },
    async query(q) {
      assert.equal(q.block_id, BLOCK);
      if (q.request_type === 'view_account' && q.account_id === ownerId) return { block_hash: state.mixed ? hash(71) : BLOCK,
        code_hash: NO_LOCAL_CONTRACT_HASH, storage_usage: 300, amount: String(20n * NEAR) };
      if (q.request_type === 'view_account' && q.account_id === 'outlayer.testnet') return { block_hash: BLOCK, code_hash: hash(72) };
      if (q.request_type === 'view_access_key_list' && q.account_id === ownerId) return { block_hash: BLOCK,
        keys: [{ public_key: ownerKey, access_key: { permission: state.blocked ? { FunctionCall: {} } : 'FullAccess', nonce: 100 } },
          ...(state.stage >= 4 ? [{ public_key: agentKey, access_key: { nonce: 100, permission: { FunctionCall: { receiver_id: vault,
            method_names: ['execute_outlayer_native_project'], allowance: review.agent_gas_allowance_yocto } } } }] : [])] };
      if (q.request_type === 'view_access_key_list' && q.account_id === vault) return { block_hash: BLOCK, keys: [] };
      throw Error('unexpected synthetic query');
    },
    async viewTestnetAccountPresenceAt(id, block) {
      assert.equal(id, vault); assert.equal(block, BLOCK);
      if (state.stage === 0) return { block_hash: BLOCK, exists: false };
      return { block_hash: BLOCK, exists: true, account: { block_hash: BLOCK, code_hash: NATIVE_ORACLE_V9_CODE_HASH,
        storage_usage: 455_000, amount: String(BigInt(NATIVE_ORACLE_VAULT_FUNDING) + (state.stage >= 3 ? NEAR / 10n : 0n)) } };
    },
    async experimental_protocolConfig() { return { chain_id: 'testnet', protocol_version: 90,
      runtime_config: { storage_amount_per_byte: '10000000000000000000', wasm_config: Object.fromEntries(V11_SELECTED_WASM_FEATURES.map(f => [f, true])) } }; },
    async gasPrice() { return { gas_price: '100000000' }; },
    async callFunctionRaw(id, method, args, ref) {
      assert.deepEqual(ref, { blockId: BLOCK }); let result;
      if (id === 'outlayer.testnet' && method === 'get_project') result = { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
      else if (id === 'outlayer.testnet' && method === 'get_version') result = { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source };
      else if (id === 'outlayer.testnet' && method === 'get_project_pricing') result = null;
      else if (id === vault && method === 'contract_version') result = 'bouncer-agent-v9';
      else if (id === vault && method === 'get_owner') result = ownerId;
      else if (id === vault && method === 'get_policy') result = state.stage === 1 ? null :
        { token: 'native', per_tx_cap: review.per_tx_cap_yocto, daily_cap: review.daily_cap_yocto };
      else if (id === vault && method === 'get_outlayer_native_project') result = state.stage === 1 ? null :
        { project: review.project, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
      else if (id === vault && method === 'is_agent_key_allowed') result = state.stage !== 1;
      else if (id === vault && method === 'vault_balance') result = state.stage >= 3 ? review.vault_deposit_yocto : '0';
      else if (id === vault && method === 'check') result = [true, 'ok'];
      else throw Error(`unexpected synthetic view ${method}`);
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(result))] };
    },
  };
  const options = { pool: db, authenticate: auth, wasmBytes: wasm, receiptProvider, preflightProvider: provider, ...overrides };
  const fence = createPostgresNativeOraclePromptFence(options);
  const reserve = { review, trustedReviewHash: review.review_sha256, trustedOwnerPublicKey: ownerKey, evidence: 'synthetic-auth' };
  const req = (res, i) => ({ owner: ownerId, ownerPublicKey: ownerKey, operationId: res.operation_id,
    reviewSha256: review.review_sha256, stageId: review.stages[i].id,
    actionCommitmentSha256: review.stages[i].action_commitment_sha256, evidence: 'synthetic-auth' });
  return { options, fence, reserve, req, review, ownerId, ownerKey, ownerPair, state, calls };
}
async function resources(run) { const db = pool(); try { return await run(db); } finally { await db.end(); } }
function faultPool(db, marker, afterCommit = () => {}) {
  let touched = false, fired = false;
  return { get fired() { return fired; }, async connect() {
    const c = await db.connect();
    return { release: c.release.bind(c), async query(sql, args) {
      if (String(sql).includes(marker)) touched = true;
      if (touched && !fired && sql === 'COMMIT') { fired = true; await c.query(sql, args); afterCommit(); throw Error('synthetic private database URL'); }
      return c.query(sql, args);
    } };
  } };
}

test('native PostgreSQL fence requires authentication, exact V9 and fixed read-only providers', () => {
  assert.throws(() => createPostgresNativeOraclePromptFence({ pool: { connect() {} } }), e => e.code === 'UNSAFE_CONFIGURATION');
  const dummy = { async viewNodeStatus() {}, async txStatusReceipts() {} };
  assert.throws(() => createPostgresNativeOraclePromptFence({ pool: { connect() {} }, authenticate: auth, wasmBytes: wasm,
    receiptProvider: dummy, preflightProvider: {} }), e => e.code === 'UNSAFE_CONFIGURATION');
});

dbtest('one authenticated owner review is reserved atomically and contains all four immutable stages', async () => resources(async db => {
  const f = scenario(db);
  await assert.rejects(f.fence.reserve({ ...f.reserve, evidence: 'wrong' }), e => e.code === 'UNAUTHENTICATED');
  const secp = String(nearApi.KeyPair.fromRandom('secp256k1').getPublicKey());
  await assert.rejects(f.fence.reserve({ ...f.reserve, trustedOwnerPublicKey: secp }), e => e.code === 'INVALID_REQUEST');
  const outcomes = await Promise.allSettled([f.fence.reserve(f.reserve), f.fence.reserve(f.reserve)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'OWNER_FENCED');
  const reservation = outcomes.find(x => x.status === 'fulfilled').value;
  assert.equal(reservation.status, 'RESERVED_NOT_CLAIMED'); assert.equal(reservation.execution_authorized, false);
  assert.deepEqual(reservation.stages.map(s => s.stage_id), f.review.stages.map(s => s.id));
  assert.ok(reservation.stages.every(s => !s.claimed && s.original_hash === null));
  const inspected = await f.fence.inspect({ owner: f.ownerId, ownerPublicKey: f.ownerKey, evidence: 'synthetic-auth' });
  assert.equal(inspected.operation_id, reservation.operation_id); assert.deepEqual(inspected.review, f.review);
  await assert.rejects(f.fence.inspect({ owner: f.ownerId, ownerPublicKey: key(), evidence: 'synthetic-auth' }), e => e.code === 'MISMATCH');
}));

dbtest('claims progress only through four checked originals, once each, with no wallet authorization', async () => resources(async db => {
  const f = scenario(db), reserved = await f.fence.reserve(f.reserve);
  await assert.rejects(f.fence.claim(f.req(reserved, 1)), e => e.code === 'PRIOR_UNRESOLVED');
  await assert.rejects(f.fence.recordOriginal({ ...f.req(reserved, 0), originalHash: hash(10) }), e => e.code === 'MISMATCH');
  for (let i = 0; i < 4; i++) {
    f.state.stage = i;
    const claim = await f.fence.claim(f.req(reserved, i));
    assert.equal(claim.status, 'PROMPT_CLAIMED_NO_HASH'); assert.equal(claim.do_not_retry, true);
    assert.equal(claim.execution_authorized, false); assert.equal(claim.independently_durable, false);
    await assert.rejects(f.fence.claim(f.req(reserved, i)), e => e.code === 'ALREADY_CLAIMED');
    if (i > 0) await assert.rejects(f.fence.recordOriginal({ ...f.req(reserved, i), originalHash: hash(10) }), e => e.code === 'MISMATCH');
    const recorded = await f.fence.recordOriginal({ ...f.req(reserved, i), originalHash: hash(10 + i) });
    assert.equal(recorded.original_hash, hash(10 + i)); assert.equal(recorded.current_state_verified, false);
    await f.fence.recordOriginal({ ...f.req(reserved, i), originalHash: hash(10 + i) });
    await assert.rejects(f.fence.recordOriginal({ ...f.req(reserved, i), originalHash: hash(40 + i) }), e => e.code === 'MISMATCH');
  }
  const progress = await f.fence.inspect({ owner: f.ownerId, ownerPublicKey: f.ownerKey, evidence: 'synthetic-auth' });
  assert.ok(progress.stages.every((s, i) => s.claimed && s.original_hash === hash(10 + i)));
  assert.deepEqual(f.calls, [hash(10), hash(10), hash(11), hash(10), hash(11), hash(12)]);
}));

dbtest('competing or uncertain claims cannot yield a second usable claim', async () => resources(async db => {
  const f = scenario(db), reserved = await f.fence.reserve(f.reserve), request = f.req(reserved, 0);
  const outcomes = await Promise.allSettled([f.fence.claim(request), f.fence.claim(request)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'ALREADY_CLAIMED');
  const g = scenario(db), other = await g.fence.reserve(g.reserve);
  const faulty = faultPool(db, 'UPDATE bouncer_native_wallet_prompt_v1.stages SET claimed=true');
  const uncertain = createPostgresNativeOraclePromptFence({ ...g.options, pool: faulty });
  await assert.rejects(uncertain.claim(g.req(other, 0)), e => e.code === 'DATABASE_UNKNOWN' && !e.message.includes('private database'));
  assert.equal(faulty.fired, true);
  await assert.rejects(g.fence.claim(g.req(other, 0)), e => e.code === 'ALREADY_CLAIMED');
}));

dbtest('RPC unavailability, changed chain state and schema guard tampering block claims', async () => resources(async db => {
  const f = scenario(db), reserved = await f.fence.reserve(f.reserve), req = f.req(reserved, 0);
  f.state.blocked = true; await assert.rejects(f.fence.claim(req), e => e.code === 'PREFLIGHT_BLOCKED');
  f.state.blocked = false; f.state.mixed = true; await assert.rejects(f.fence.claim(req), e => e.code === 'PREFLIGHT_UNAVAILABLE');
  f.state.mixed = false;
  await assert.rejects(db.query('DELETE FROM bouncer_native_wallet_prompt_v1.plans WHERE owner=$1', [f.ownerId]));
  await assert.rejects(db.query('UPDATE bouncer_native_wallet_prompt_v1.stages SET original_hash=$1 WHERE owner=$2 AND stage_index=0', [hash(10), f.ownerId]));
  await db.query('ALTER TABLE bouncer_native_wallet_prompt_v1.stages DISABLE TRIGGER stage_immutable');
  try { await assert.rejects(f.fence.claim(req), e => e.code === 'UNSAFE_SCHEMA'); }
  finally { await db.query('ALTER TABLE bouncer_native_wallet_prompt_v1.stages ENABLE TRIGGER stage_immutable'); }
  await f.fence.claim(req); await f.fence.recordOriginal({ ...req, originalHash: hash(10) });
  f.state.stage = 1; f.state.unavailable = true;
  await assert.rejects(f.fence.claim(f.req(reserved, 1)), e => e.code === 'PREFLIGHT_UNAVAILABLE');
}));

function memoryWitnessStore() {
  let head = '0'.repeat(40), counter = 0, text = '', loseAck = false;
  return { async read() { return { head, text }; }, async append(request) {
    if (request.expectedHead !== head || request.expectedText !== text) throw Error('CAS conflict');
    text = request.text; head = (++counter).toString(16).padStart(40, '0'); if (loseAck) throw Error('lost acknowledgment');
    return { confirmed: true, head };
  }, loseAck(v) { loseAck = v; } };
}

dbtest('independent witness plus PostgreSQL permits one checked stage and records exactly its original', async () => resources(async db => {
  const f = scenario(db), store = memoryWitnessStore(), witness = createNativeOraclePromptWitness({ store });
  const coordinator = createWitnessedNativeOracleSetup({ fence: f.fence, witness });
  const reserved = await coordinator.reserve(f.reserve), identity = reserved.identity;
  assert.equal(reserved.status, 'RESERVED_NOT_CLAIMED'); assert.equal(reserved.execution_authorized, false);
  await assert.rejects(coordinator.reserve(f.reserve), e => e.code === 'OWNER_ALREADY_WITNESSED');
  const stageId = f.review.stages[0].id;
  const claim = await coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' });
  assert.equal(claim.independently_witnessed, true); assert.equal(claim.execution_authorized, false);
  await assert.rejects(coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  const original = await coordinator.recordOriginal({ identity, stageId, originalHash: hash(10), evidence: 'synthetic-auth' });
  assert.equal(original.status, 'ORIGINAL_RECORDED');
  await coordinator.recordOriginal({ identity, stageId, originalHash: hash(10), evidence: 'synthetic-auth' });
  await assert.rejects(coordinator.recordOriginal({ identity, stageId, originalHash: hash(11), evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_MISMATCH');
  f.state.stage = 1;
  const next = await coordinator.claim({ identity, stageId: f.review.stages[1].id, evidence: 'synthetic-auth' });
  assert.equal(next.independently_witnessed, true); assert.deepEqual(f.calls, [hash(10)]);
  await assert.rejects(coordinator.verifyCompletion({ identity, evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_MISMATCH');
}));

dbtest('lost witness acknowledgement leaves both systems claimed and cannot yield another prompt', async () => resources(async db => {
  const f = scenario(db), store = memoryWitnessStore(), witness = createNativeOraclePromptWitness({ store });
  const coordinator = createWitnessedNativeOracleSetup({ fence: f.fence, witness });
  const { identity } = await coordinator.reserve(f.reserve), stageId = f.review.stages[0].id;
  store.loseAck(true);
  await assert.rejects(coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  store.loseAck(false);
  assert.equal((await witness.inspect(identity.owner)).state.phase, 'claimed');
  await assert.rejects(coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  const dbState = await f.fence.inspect({ owner: f.ownerId, ownerPublicKey: f.ownerKey, evidence: 'synthetic-auth' });
  assert.equal(dbState.stages[0].claimed, true); assert.equal(dbState.stages[0].original_hash, null);
}));

dbtest('a witness acknowledgement after preflight expiry cannot return a claim or permit retry', async () => resources(async db => {
  let clock = Date.now(); const now = () => clock, f = scenario(db, { now }), store = memoryWitnessStore();
  const originalWitness = createNativeOraclePromptWitness({ store });
  const witness = { ...originalWitness, async claim(...args) { const saved = await originalWitness.claim(...args); clock += 5001; return saved; } };
  const coordinator = createWitnessedNativeOracleSetup({ fence: f.fence, witness, now });
  const { identity } = await coordinator.reserve(f.reserve), stageId = f.review.stages[0].id;
  await assert.rejects(coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' }), e => e.code === 'WITNESSED_CLAIM_STALE');
  assert.equal((await originalWitness.inspect(identity.owner)).state.phase, 'claimed');
  await assert.rejects(coordinator.claim({ identity, stageId, evidence: 'synthetic-auth' }), e => e.code === 'WITNESS_NOT_CLAIMABLE');
}));


dbtest('synthetic NEP-413 wallet challenges bind native reserve, claim and original to both durable systems', async () => resources(async db => {
  const f = scenario(db), site = { origin: 'https://bouncer.example', host: 'bouncer.example' };
  const authProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } }; },
    async viewAccessKey(owner, publicKey, ref) { assert.equal(owner, f.ownerId); assert.equal(publicKey, f.ownerKey);
      assert.equal(ref.blockId, BLOCK); return { block_hash: BLOCK, permission: 'FullAccess' }; } };
  const authenticator = createPostgresWalletPromptAuth({ pool: db, origin: site.origin, provider: authProvider });
  const fence = createPostgresNativeOraclePromptFence({ ...f.options, authenticate: authenticator.authenticate });
  const witness = createNativeOraclePromptWitness({ store: memoryWitnessStore() });
  const coordinator = createWitnessedNativeOracleSetup({ fence, witness });
  let walletMessages = 0, walletTransactions = 0;
  const wallet = { manifest: { id: 'near-mobile' }, async signMessage(p) {
    walletMessages++; assert.equal(p.accountId, f.ownerId);
    const digest = crypto.createHash('sha256').update(nep413Payload(p)).digest();
    return { accountId: f.ownerId, publicKey: f.ownerKey, signature: Buffer.from(f.ownerPair.sign(digest).signature).toString('base64') };
  }, async signAndSendTransaction() { walletTransactions++; throw Error('not allowed'); } };
  const fetch = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', result: { permission: 'FullAccess' } }) });
  const sign = async context => {
    const challenge = await authenticator.issue(nativeSetupAuthAction(context));
    return signReviewedNativeSetupChallenge({ wallet, context, challenge, location: site, crypto: crypto.webcrypto, fetch });
  };
  const common = { owner: f.ownerId, ownerPublicKey: f.ownerKey };
  const reserveContext = { ...common, purpose: 'reserve_native_setup', review: f.review };
  const evidence = await sign(reserveContext);
  const result = await coordinator.reserve({ ...f.reserve, evidence }), identity = result.identity, stageId = f.review.stages[0].id;
  await assert.rejects(fence.reserve({ ...f.reserve, evidence }), e => e.code === 'UNAUTHENTICATED');
  const claimContext = { ...common, purpose: 'claim_native_setup_stage', identity, stageId };
  const claimEvidence = await sign(claimContext);
  const claimed = await coordinator.claim({ identity, stageId, evidence: claimEvidence });
  assert.equal(claimed.independently_witnessed, true); assert.equal(claimed.execution_authorized, false);
  const recordContext = { ...common, purpose: 'record_native_setup_original', identity, stageId, originalHash: hash(10) };
  const recordEvidence = await sign(recordContext);
  await assert.rejects(coordinator.recordOriginal({ identity, stageId, originalHash: hash(11), evidence: recordEvidence }), e => e.code === 'UNAUTHENTICATED');
  const saved = await coordinator.recordOriginal({ identity, stageId, originalHash: hash(10), evidence: recordEvidence });
  assert.equal(saved.original_hash, hash(10)); assert.equal(saved.execution_authorized, false);
  assert.equal(walletMessages, 3); assert.equal(walletTransactions, 0);
}));


dbtest('a preflight that expires while committing consumes the claim but is never returned for use', async () => resources(async db => {
  let clock = Date.now(); const now = () => clock, f = scenario(db, { now }), reserved = await f.fence.reserve(f.reserve);
  let touched = false;
  const slow = { async connect() { const c = await db.connect(); return { release: c.release.bind(c), async query(sql, args) {
    if (String(sql).includes('UPDATE bouncer_native_wallet_prompt_v1.stages SET claimed=true')) touched = true;
    const result = await c.query(sql, args);
    if (touched && sql === 'COMMIT') { clock += 5001; touched = false; }
    return result;
  } }; } };
  const fence = createPostgresNativeOraclePromptFence({ ...f.options, pool: slow });
  await assert.rejects(fence.claim(f.req(reserved, 0)), e => e.code === 'CLAIM_COMMITTED_PREFLIGHT_STALE');
  await assert.rejects(f.fence.claim(f.req(reserved, 0)), e => e.code === 'ALREADY_CLAIMED');
}));

dbtest('synthetic browser prompts, owner challenges, PostgreSQL, local Git and prior receipts cover all four stages', async () => resources(async db => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-browser-db-git-'));
  try {
  const bare = path.join(root, 'remote.git'), work = path.join(root, 'work'), branch = 'arena/0e4386ea-near-hub';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(work); git(root, ['init', '--bare', '--initial-branch', branch, bare]);
  git(work, ['init', '--initial-branch', branch]); git(work, ['config', 'user.email', 'synthetic@example.test']);
  git(work, ['config', 'user.name', 'Synthetic test']); git(work, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(work, 'README.md'), 'Synthetic test only\n'); git(work, ['add', 'README.md']);
  git(work, ['commit', '-m', 'Initial synthetic commit']); git(work, ['push', 'origin', branch]);
  const initialHead = git(work, ['rev-parse', 'HEAD']);
  const f = scenario(db), site = { origin: 'https://bouncer.example', host: 'bouncer.example' };
  const authProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: String(BigInt(Date.now()) * 1_000_000n) } }; },
    async viewAccessKey(owner, publicKey, ref) { assert.equal(owner, f.ownerId); assert.equal(publicKey, f.ownerKey);
      assert.equal(ref.blockId, BLOCK); return { block_hash: BLOCK, permission: 'FullAccess' }; } };
  const authenticator = createPostgresWalletPromptAuth({ pool: db, origin: site.origin, provider: authProvider });
  const fence = createPostgresNativeOraclePromptFence({ ...f.options, authenticate: authenticator.authenticate });
  const witness = createNativeOraclePromptWitness({ store: createGitNativeOraclePromptWitnessStore({ repo: work, branch, initialHead }) });
  const coordinator = createWitnessedNativeOracleSetup({ fence, witness });
  let signed = 0, prompted = 0;
  const wallet = { manifest: { id: 'near-mobile', features: { signAndSendTransaction: true } }, async signMessage(p) {
    signed++; const digest = crypto.createHash('sha256').update(nep413Payload(p)).digest();
    return { accountId: f.ownerId, publicKey: f.ownerKey, signature: Buffer.from(f.ownerPair.sign(digest).signature).toString('base64') };
  }, async signAndSendTransaction(p) {
    assert.equal(p.network, 'testnet'); assert.equal(p.signerId, f.ownerId);
    assert.equal(p.receiverId, prompted === 3 ? f.ownerId : f.review.vault);
    return { transaction: { hash: hash(10 + prompted++) } }; // fabricated; no network or actual wallet
  } };
  const fetch = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', result: { permission: 'FullAccess' } }) });
  const sign = async context => signReviewedNativeSetupChallenge({ wallet, context,
    challenge: await authenticator.issue(nativeSetupAuthAction(context)), location: site, crypto: crypto.webcrypto, fetch });
  const common = { owner: f.ownerId, ownerPublicKey: f.ownerKey };
  const reservation = await coordinator.reserve({ ...f.reserve, evidence: await sign({ ...common, purpose: 'reserve_native_setup', review: f.review }) });
  const identity = reservation.identity;
  const deviceKey = { status: 'LOCAL_DEVICE_KEY_AVAILABLE', origin: site.origin, owner: f.ownerId, vault: f.review.vault,
    public_key: f.review.agent_public_key, expected_public_key_matched: true, private_key_exportable: false,
    local_storage_only: true, signing_authorized: false }; // synthetic metadata; real device custody is separately required
  for (let i = 0; i < 4; i++) {
    const stageId = f.review.stages[i].id;
    const prompt = await prepareNativeOracleSetupWalletPrompt({ wallet, identity, review: reservation.review, deviceKey, stageId,
      wasmBytes: wasm, location: site, isTopLevel: true, crypto: crypto.webcrypto });
    const claim = await coordinator.claim({ identity, stageId, evidence: await sign({ ...common, purpose: 'claim_native_setup_stage', identity, stageId }) });
    const outcome = await prompt.invoke(claim);
    assert.equal(outcome.original_hash, hash(10 + i)); assert.equal(outcome.final_execution_verified, false);
    const record = { ...common, purpose: 'record_native_setup_original', identity, stageId, originalHash: outcome.original_hash };
    await coordinator.recordOriginal({ identity, stageId, originalHash: outcome.original_hash, evidence: await sign(record) });
    f.state.stage = i + 1;
  }
  assert.equal(prompted, 4); assert.equal(signed, 9);
  assert.equal((await witness.inspect(f.ownerId)).state.phase, 'complete');
  const verifyContext = { ...common, purpose: 'verify_native_setup_completion', identity };
  const completion = await coordinator.verifyCompletion({ identity, evidence: await sign(verifyContext) });
  assert.equal(completion.status, 'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED');
  assert.equal(completion.independently_witnessed, true); assert.equal(completion.execution_authorized, false);
  assert.equal(completion.independent_delivery_verified, false); assert.equal(prompted, 4); assert.equal(signed, 10);
  assert.deepEqual(f.calls, [hash(10), hash(10), hash(11), hash(10), hash(11), hash(12), hash(10), hash(11), hash(12), hash(13)]);
  const alteredWitness = { ...witness, async inspect(owner) {
    const snapshot = await witness.inspect(owner), altered = structuredClone(snapshot);
    altered.state.records.find(r => r.event === 'original').original_hash = hash(99);
    return altered;
  } };
  const disagreeing = createWitnessedNativeOracleSetup({ fence, witness: alteredWitness });
  await assert.rejects(disagreeing.verifyCompletion({ identity, evidence: await sign(verifyContext) }), e => e.code === 'WITNESS_MISMATCH');
  let reads = 0;
  const changingWitness = { ...witness, async inspect(owner) {
    const snapshot = await witness.inspect(owner); if (++reads === 2) return { ...snapshot, head: 'e'.repeat(40) }; return snapshot;
  } };
  const changing = createWitnessedNativeOracleSetup({ fence, witness: changingWitness });
  await assert.rejects(changing.verifyCompletion({ identity, evidence: await sign(verifyContext) }), e => e.code === 'WITNESS_MISMATCH');
  f.state.blocked = true;
  const changed = await coordinator.verifyCompletion({ identity, evidence: await sign(verifyContext) });
  assert.equal(changed.status, 'BLOCKED_OR_UNKNOWN'); assert(changed.blockers.includes('exact_owner_key'));
  assert.equal(prompted, 4); assert.notEqual(git(work, ['rev-parse', 'HEAD']), initialHead);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}));
