import { emptyCrossWitness } from './fixtures/empty-cross-witness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { createWalletPromptWitness, parseWalletWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createGitBranchWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWitnessedWalletSetup } from '../agent/witnessed-wallet-setup.mjs';

const stages = ['create_keyless_vault', 'register_vault_circle', 'fund_vault_circle'];
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const id = (owner = 'alice.testnet') => ({ owner, owner_public_key: key(), operation_id: 'a'.repeat(32), review_sha256: 'b'.repeat(64),
  stages: stages.map((stage_id, i) => ({ stage_id, action_commitment_sha256: String(i + 1).repeat(64) })) });
function memoryStore() {
  let head = '0', text = '', failBefore = false, loseAck = false;
  return { async read() { if (failBefore) throw Error('private failure'); return { head, text }; },
    async append(input) { if (failBefore) throw Error('private failure');
      if (input.expectedHead !== head || input.expectedText !== text) throw Error('CAS conflict');
      text = input.text; head = String(Number(head) + 1); if (loseAck) throw Error('lost acknowledgment');
      return { head, confirmed: true }; },
    fault(value) { failBefore = value; }, loseAck(value) { loseAck = value; }, snapshot() { return { head, text }; } };
}
async function reserveAndClaim(witness, identity, index) {
  const checkpoint = await witness.assertClaimable(identity, stages[index]);
  return witness.claim(identity, stages[index], checkpoint);
}

test('witness enforces one reservation and ordered, immutable claims and originals', async () => {
  const store = memoryStore(), witness = createWalletPromptWitness({ store }), identity = id();
  assert.equal((await witness.inspect(identity.owner)).state, null);
  await witness.reserve(identity);
  await assert.rejects(witness.reserve(identity), e => e.code === 'OWNER_ALREADY_WITNESSED');
  await assert.rejects(witness.assertClaimable(identity, stages[1]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  for (let index = 0; index < 3; index++) {
    await reserveAndClaim(witness, identity, index);
    await assert.rejects(witness.assertClaimable(identity, stages[index]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
    await witness.recordOriginal(identity, stages[index], hash(index + 1));
    await witness.recordOriginal(identity, stages[index], hash(index + 1)); // same hash, no new prompt
    await assert.rejects(witness.recordOriginal(identity, stages[index], hash(index + 10)), e => e.code === 'WITNESS_MISMATCH');
  }
  const state = (await witness.inspect(identity.owner)).state;
  assert.equal(state.phase, 'complete'); assert.equal(state.records.length, 7);
  await assert.rejects(witness.assertClaimable(identity, stages[2]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
});

test('tampering, duplicate originals and wrong owner fail closed', async () => {
  const store = memoryStore(), witness = createWalletPromptWitness({ store }), identity = id();
  await witness.reserve(identity); await reserveAndClaim(witness, identity, 0);
  await witness.recordOriginal(identity, stages[0], hash(1)); await reserveAndClaim(witness, identity, 1);
  await assert.rejects(witness.recordOriginal(identity, stages[1], hash(1)), e => e.code === 'WITNESS_INVALID');
  const text = store.snapshot().text;
  assert.throws(() => parseWalletWitness(text.replace('alice.testnet', 'other.testnet')), e => e.code === 'WITNESS_INVALID');
  assert.throws(() => parseWalletWitness(text.slice(0, -1)), e => e.code === 'WITNESS_INVALID');
  assert.throws(() => parseWalletWitness(text, 'other.testnet'), e => e.code === 'WITNESS_INVALID');
  await assert.rejects(witness.assertClaimable({ ...identity, operation_id: 'f'.repeat(32) }, stages[2]), e => e.code === 'WITNESS_MISMATCH');
});

test('concurrent reservations and lost acknowledgements never return a second permit', async () => {
  const store = memoryStore(), witness = createWalletPromptWitness({ store }), identity = id();
  const outcomes = await Promise.allSettled([witness.reserve(identity), witness.reserve(identity)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const claim = await witness.assertClaimable(identity, stages[0]);
  store.loseAck(true);
  await assert.rejects(witness.claim(identity, stages[0], claim), e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  store.loseAck(false);
  assert.equal((await witness.inspect(identity.owner)).state.phase, 'claimed');
  await assert.rejects(witness.assertClaimable(identity, stages[0]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
});

test('coordinator blocks restored database or uncertain witness before returning a claim', async () => {
  const store = memoryStore(), witness = createWalletPromptWitness({ store }), identity = id();
  let dbClaimed = 0, dbReserves = 0;
  const review = { owner: identity.owner, review_sha256: identity.review_sha256,
    stages: identity.stages.map(s => ({ id: s.stage_id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const fence = {
    async reserve() { dbReserves++; return { ...identity, review, stage_id: stages[0], setup_snapshot: {} }; },
    async claimPrompt() { dbClaimed++; return { owner: identity.owner, operation_id: identity.operation_id, review_sha256: identity.review_sha256,
      stage_id: stages[0], action_commitment_sha256: identity.stages[0].action_commitment_sha256,
      status: 'PROMPT_CLAIMED_NO_HASH', do_not_retry: true, execution_authorized: false, preflight_checked_at: new Date().toISOString() }; },
    async claimSetupStage() { throw Error('unused'); }, async recordOriginalHash() { throw Error('unused'); }, async recordSetupStageOriginal() { throw Error('unused'); },
  };
  const coordinated = createWitnessedWalletSetup({ fence, witness, otherWitness: emptyCrossWitness(witness) });
  const reserved = await coordinated.reserve({ review });
  assert.deepEqual(reserved.identity, identity); assert.equal(reserved.execution_authorized, false);
  store.loseAck(true);
  await assert.rejects(coordinated.claim({ identity, stageId: stages[0], evidence: 'synthetic' }), e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  assert.equal(dbClaimed, 1);
  store.loseAck(false);
  // Even a hypothetical stale/restored DB willing to reserve/claim again must
  // be stopped by the independent witness before that DB method is called.
  await assert.rejects(coordinated.reserve({ review }), e => e.code === 'OWNER_ALREADY_WITNESSED');
  await assert.rejects(coordinated.claim({ identity, stageId: stages[0], evidence: 'synthetic' }), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  assert.equal(dbReserves, 1); assert.equal(dbClaimed, 1);
});

test('an elapsed preflight never becomes usable after an independent claim', async () => {
  const store = memoryStore(), witness = createWalletPromptWitness({ store }), identity = id(), clock = Date.now();
  const review = { owner: identity.owner, review_sha256: identity.review_sha256,
    stages: identity.stages.map(s => ({ id: s.stage_id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const fence = { async reserve() { return { ...identity, review, stage_id: stages[0], setup_snapshot: {} }; },
    async claimPrompt() { return { owner: identity.owner, operation_id: identity.operation_id, review_sha256: identity.review_sha256,
      stage_id: stages[0], action_commitment_sha256: identity.stages[0].action_commitment_sha256, status: 'PROMPT_CLAIMED_NO_HASH',
      do_not_retry: true, execution_authorized: false, preflight_checked_at: new Date(clock - 5001).toISOString() }; },
    async claimSetupStage() {}, async recordOriginalHash() {}, async recordSetupStageOriginal() {} };
  const coordinated = createWitnessedWalletSetup({ fence, witness, otherWitness: emptyCrossWitness(witness), now: () => clock });
  await coordinated.reserve({ review });
  await assert.rejects(coordinated.claim({ identity, stageId: stages[0], evidence: 'synthetic' }), e => e.code === 'WITNESSED_CLAIM_STALE');
  assert.equal((await witness.inspect(identity.owner)).state.phase, 'claimed');
  await assert.rejects(coordinated.claim({ identity, stageId: stages[0], evidence: 'synthetic' }), e => e.code === 'WITNESS_NOT_CLAIMABLE');
});

test('real local Git CAS witness pushes only the configured branch and rejects a dirty worktree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-git-witness-'));
  const bare = path.join(root, 'remote.git'), work = path.join(root, 'work'), branch = 'arena/0ee9ab70-near-hub';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(work); git(root, ['init', '--bare', '--initial-branch', branch, bare]);
    git(work, ['init', '--initial-branch', branch]); git(work, ['config', 'user.email', 'synthetic@example.test']);
    git(work, ['config', 'user.name', 'Synthetic test']); git(work, ['remote', 'add', 'origin', bare]);
    fs.writeFileSync(path.join(work, 'README.md'), 'Synthetic test only\n'); git(work, ['add', 'README.md']);
    git(work, ['commit', '-m', 'Initial synthetic commit']); git(work, ['push', 'origin', branch]);
    const base = git(work, ['rev-parse', 'HEAD']);
    const store = createGitBranchWitnessStore({ repo: work, branch, initialHead: base });
    const witness = createWalletPromptWitness({ store }), identity = id();
    await witness.reserve(identity); const before = await witness.assertClaimable(identity, stages[0]);
    await witness.claim(identity, stages[0], before);
    assert.equal((await witness.inspect(identity.owner)).state.phase, 'claimed');
    assert.equal(git(work, ['branch', '--show-current']), branch);
    fs.writeFileSync(path.join(work, 'unrelated.txt'), 'do not overwrite');
    await assert.rejects(witness.inspect(identity.owner), e => e.code === 'WITNESS_UNAVAILABLE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
