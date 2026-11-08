import { emptyCrossWitness } from './fixtures/empty-cross-witness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import nearApi from 'near-api-js';
import { buildBufferWalletSetup } from '../agent/buffer-wallet-setup-plan.mjs';
import { createPostgresWalletPromptFence, initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { createWalletPromptWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWitnessedWalletSetup } from '../agent/witnessed-wallet-setup.mjs';
import { wasm as V12, NOW, snapshot as setupSnapshot } from './buffer-wallet-setup-fixture.mjs';
import { firstSetupPreflightFixture } from './fixtures/wallet-setup-preflight-provider.mjs';

const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw Error('PostgreSQL integration test URL is required');
const dbtest = url && V12 ? test : test.skip;
function store() {
  let head = '0', text = '';
  return { async read() { return { head, text }; }, async append(input) {
    if (input.expectedHead !== head || input.expectedText !== text) throw Error('CAS conflict');
    text = input.text; head = String(Number(head) + 1); return { confirmed: true, head };
  } };
}

dbtest('actual PostgreSQL setup claim is independently witnessed before it returns', async () => {
  const db = new pg.Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 });
  try {
    await initializePostgresWalletPromptFence({ pool: db });
    const owner = `witness-${crypto.randomBytes(8).toString('hex')}.testnet`;
    const ownerKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
    const snapshot = setupSnapshot(); snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
    const { review } = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: NOW });
    const { provider } = firstSetupPreflightFixture({ owner, ownerKey });
    const receiptProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts() { throw Error('no synthetic receipt'); } };
    const fence = createPostgresWalletPromptFence({ pool: db, authenticate: async ({ evidence }) => evidence === 'synthetic-auth',
      setupWasmBytes: V12, setupPreflightProvider: provider, setupReceiptProvider: receiptProvider });
    const witness = createWalletPromptWitness({ store: store() }), coordinator = createWitnessedWalletSetup({ fence, witness, otherWitness: emptyCrossWitness(witness) });
    const result = await coordinator.reserve({ review, setupSnapshot: snapshot, trustedReviewHash: review.review_sha256,
      trustedOwnerPublicKey: ownerKey, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
    assert.equal(result.execution_authorized, false); assert.equal(result.status, 'RESERVED_NOT_CLAIMED');
    const claim = await coordinator.claim({ identity: result.identity, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' });
    assert.equal(claim.independently_witnessed, true); assert.equal(claim.execution_authorized, false);
    assert.equal((await witness.inspect(owner)).state.phase, 'claimed');
    await assert.rejects(coordinator.claim({ identity: result.identity, stageId: 'create_keyless_vault', evidence: 'synthetic-auth' }),
      e => e.code === 'WITNESS_NOT_CLAIMABLE');
    const originalHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 31));
    const original = await coordinator.recordOriginal({ identity: result.identity, stageId: 'create_keyless_vault', originalHash, evidence: 'synthetic-auth' });
    assert.equal(original.original_hash, originalHash); assert.equal(original.do_not_retry, true);
    assert.equal((await fence.inspect({ owner, ownerPublicKey: ownerKey, evidence: 'synthetic-auth' })).original_hash, originalHash);
    assert.equal((await witness.inspect(owner)).state.phase, 'original');
  } finally { await db.end(); }
});

// This test combines the real signed challenge, PostgreSQL journal and the
// independently pushed local Git witness using synthetic keys/chain data only.
// It exercises no real wallet, network, signer custody or transaction.
dbtest('NEP-413 authenticated setup binds the database and an independent Git witness', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { nep413Payload } = await import('../web-src/cli-login.mjs');
  const { signReviewedSetupChallenge } = await import('../web-src/witnessed-setup-auth.mjs');
  const { createPostgresWalletPromptAuth, initializePostgresWalletPromptAuth } = await import('../agent/postgres-wallet-prompt-auth.mjs');
  const { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } = await import('../agent/git-branch-witness-store.mjs');
  const { createAuthenticatedWitnessedSetupService } = await import('../agent/authenticated-witnessed-setup-service.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-auth-witness-'));
  const bare = path.join(dir, 'remote.git'), work = path.join(dir, 'work'), branch = 'arena/0ee9ab70-near-hub';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const db = new pg.Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 });
  try {
    fs.mkdirSync(work); git(dir, ['init', '--bare', '--initial-branch', branch, bare]); git(work, ['init', '--initial-branch', branch]);
    git(work, ['config', 'user.email', 'synthetic@example.test']); git(work, ['config', 'user.name', 'Synthetic test']);
    git(work, ['remote', 'add', 'origin', bare]); fs.writeFileSync(path.join(work, 'README.md'), 'Synthetic test only\n');
    git(work, ['add', 'README.md']); git(work, ['commit', '-m', 'Initial synthetic commit']); git(work, ['push', 'origin', branch]);
    const base = git(work, ['rev-parse', 'HEAD']);
    await initializePostgresWalletPromptAuth({ pool: db }); await initializePostgresWalletPromptFence({ pool: db });
    const owner = `auth-witness-${crypto.randomBytes(6).toString('hex')}.testnet`, pair = nearApi.KeyPair.fromRandom('ed25519');
    const ownerKey = String(pair.getPublicKey()), snapshot = setupSnapshot();
    snapshot.owner = owner; snapshot.candidate_vault = `vault.${owner}`;
    const { review } = buildBufferWalletSetup({ snapshot, wasmBytes: V12, nowMs: NOW });
    const { provider } = firstSetupPreflightFixture({ owner, ownerKey });
    const receiptProvider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts() { throw Error('no synthetic receipt'); } };
    const auth = createPostgresWalletPromptAuth({ pool: db, origin: 'https://bouncer.example', provider });
    const fence = createPostgresWalletPromptFence({ pool: db, authenticate: auth.authenticate, setupWasmBytes: V12,
      setupPreflightProvider: provider, setupReceiptProvider: receiptProvider });
    const witness = createWalletPromptWitness({ store: createGitBranchWitnessStore({ repo: work, branch, initialHead: base }) });
    const otherWitness = createNativeOraclePromptWitness({ store: createGitNativeOraclePromptWitnessStore({ repo: work, branch, initialHead: base }) });
    const coordinator = createWitnessedWalletSetup({ fence, witness, otherWitness });
    const taskId = 'a'.repeat(32);
    const service = createAuthenticatedWitnessedSetupService({ auth, fence, witness, coordinator, setupWasmBytes: V12, owner,
      async getRetainedReview(id) { return id === taskId ? { snapshot, review } : null; } });
    let messages = 0, sends = 0;
    const wallet = { async signMessage(params) {
      messages++;
      const payload = nep413Payload({ message: params.message, nonce: params.nonce, recipient: params.recipient });
      const digest = crypto.createHash('sha256').update(payload).digest();
      return { accountId: owner, publicKey: ownerKey, signature: Buffer.from(pair.sign(digest).signature).toString('base64') };
    }, async signAndSendTransaction() { sends++; throw Error('wallet transaction not expected'); } };
    const signed = (challenge, context) => signReviewedSetupChallenge({ wallet, context, challenge,
      location: { origin: 'https://bouncer.example', host: 'bouncer.example' }, crypto: crypto.webcrypto,
      fetch: async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login',
        result: { permission: 'FullAccess' } }) }) });
    const baseContext = { owner, ownerPublicKey: ownerKey };
    await assert.rejects(service.issueReservation({ taskId: 'f'.repeat(32), ownerPublicKey: ownerKey }), e => e.code === 'SETUP_UNAVAILABLE');
    const reserveChallenge = await service.issueReservation({ taskId, ownerPublicKey: ownerKey });
    const evidence = await signed(reserveChallenge, { ...baseContext, purpose: 'reserve', review });
    const reserved = await service.reserve({ taskId, ownerPublicKey: ownerKey, evidence });
    assert.equal(reserved.execution_authorized, false);
    await assert.rejects(service.reserve({ taskId, ownerPublicKey: ownerKey, evidence }));
    await assert.rejects(service.issueClaim({ identity: reserved.identity, stageId: 'fund_vault_circle' }));
    const claimChallenge = await service.issueClaim({ identity: reserved.identity, stageId: 'create_keyless_vault' });
    const claimEvidence = await signed(claimChallenge, { ...baseContext, purpose: 'claim_prompt', identity: reserved.identity, stageId: 'create_keyless_vault' });
    await assert.rejects(service.claim({ identity: reserved.identity, stageId: 'create_keyless_vault',
      evidence: { ...claimEvidence, accountId: 'other.testnet' } }), e => e.code === 'UNAUTHENTICATED');
    const claim = await service.claim({ identity: reserved.identity, stageId: 'create_keyless_vault', evidence: claimEvidence });
    assert.equal(claim.independently_witnessed, true); assert.equal(claim.execution_authorized, false);
    await assert.rejects(service.issueClaim({ identity: reserved.identity, stageId: 'create_keyless_vault' }));
    const originalHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 31));
    const originalChallenge = await service.issueOriginal({ identity: reserved.identity, stageId: 'create_keyless_vault', originalHash });
    const original = await service.recordOriginal({ identity: reserved.identity, stageId: 'create_keyless_vault', originalHash,
      evidence: await signed(originalChallenge, { ...baseContext, purpose: 'record_original_hash', identity: reserved.identity,
        stageId: 'create_keyless_vault', originalHash }) });
    assert.equal(original.do_not_retry, true);
    const inspectChallenge = await service.issueInspect({ ownerPublicKey: ownerKey });
    const inspected = await service.inspect({ ownerPublicKey: ownerKey, evidence: await signed(inspectChallenge, { ...baseContext, purpose: 'inspect' }) });
    assert.equal(inspected.status, 'WITNESSED'); assert.equal(inspected.witnessed_records.at(-1).original_hash, originalHash);
    assert.equal(inspected.execution_authorized, false);
    assert.equal(messages, 4); assert.equal(sends, 0);
  } finally { await db.end(); fs.rmSync(dir, { recursive: true, force: true }); }
});
