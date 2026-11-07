import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { createAnchoredWitnessStore } from '../agent/anchored-witness-store.mjs';
import { createGitWitnessHistoryAudit } from '../agent/git-witness-history-audit.mjs';
import { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createWalletPromptWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';

const branch = 'arena/0e4386ea-near-hub';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const id = (owner, native = false) => ({ owner, owner_public_key: key(), operation_id: crypto.randomBytes(16).toString('hex'),
  review_sha256: 'b'.repeat(64), stages: (native
    ? ['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent']
    : ['create_keyless_vault','register_vault_circle','fund_vault_circle'])
    .map((stage_id, i) => ({ stage_id, action_commitment_sha256: String(i + 1).repeat(64) })) });
function checkpoint(initial) {
  let state = { head: initial, revision: '0' }, count = 0, mode = 'normal';
  return {
    async read() { if (mode === 'offline') throw Error('independent store offline'); return { ...state }; },
    async compareAndSet({ expected, nextHead }) {
      if (JSON.stringify(expected) !== JSON.stringify(state)) throw Error('CAS conflict');
      if (mode === 'conflict') throw Error('CAS conflict');
      state = { head: nextHead, revision: String(++count) };
      if (mode === 'lose-ack') throw Error('unknown checkpoint commit');
      if (mode === 'lie') return { confirmed: true, head: nextHead, revision: 'not-the-stored-revision' };
      return { confirmed: true, ...state };
    }, mode(value) { mode = value; }, snapshot() { return { ...state }; },
  };
}
async function repository(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-head-anchor-'));
  const bare = path.join(root, 'remote.git'), work = path.join(root, 'work');
  try {
    fs.mkdirSync(work); git(root, ['init','--bare','--initial-branch',branch,bare]);
    git(work, ['init','--initial-branch',branch]); git(work, ['config','user.email','synthetic@example.test']);
    git(work, ['config','user.name','Synthetic test']); git(work, ['remote','add','origin',bare]);
    fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n'); git(work,['add','README.md']);
    git(work,['commit','-m','Initial synthetic baseline']); git(work,['push','origin',branch]);
    const base = git(work,['rev-parse','HEAD']), anchor = checkpoint(base), audit = createGitWitnessHistoryAudit({ repo: work });
    const setup = { repo: work, branch, initialHead: base };
    const ft = createWalletPromptWitness({ store: createAnchoredWitnessStore({ store: createGitBranchWitnessStore(setup), anchor, audit }) });
    const native = createNativeOraclePromptWitness({ store: createAnchoredWitnessStore({ store: createGitNativeOraclePromptWitnessStore(setup), anchor, audit }) });
    await run({ work, base, anchor, audit, ft, native });
  } finally { fs.rmSync(root,{ recursive:true,force:true }); }
}
const fileFor = (owner, folder) => `bouncer/evidence/${folder}/${crypto.createHash('sha256').update(owner).digest('hex')}.jsonl`;
const commit = (work, message) => { git(work,['add','-A']); git(work,['commit','-m',message]); git(work,['push','origin',branch]); return git(work,['rev-parse','HEAD']); };

test('each public Git claim advances and reads back the separately retained head', async () => repository(async ({ work, base, anchor, audit, ft, native }) => {
  const a = id('anchor-alice.testnet'), b = id('anchor-bob.testnet',true);
  const one = await ft.reserve(a); assert.equal(one.head, anchor.snapshot().head); assert.notEqual(one.head,base);
  const claim = await ft.assertClaimable(a,a.stages[0].stage_id);
  const two = await ft.claim(a,a.stages[0].stage_id,claim); assert.equal(two.head,anchor.snapshot().head);
  const three = await native.reserve(b); assert.equal(three.head,anchor.snapshot().head);
  assert.equal((await ft.inspect(a.owner)).state.phase,'claimed');
  assert.equal((await native.inspect(b.owner)).state.phase,'reserved');
  assert.equal(await audit(base,three.head),true);
  await assert.rejects(audit(three.head,base));
  fs.appendFileSync(path.join(work,'README.md'),'Unrelated code change\n');
  const later = commit(work,'An unrelated synthetic commit');
  assert.equal(await audit(three.head,later),true);
  assert.equal((await ft.inspect(a.owner)).state.phase,'claimed');
}));

test('fast-forward deletion of ANY owner or namespace is rejected before another witness is read or anchored', async () => repository(async ({ work, anchor, ft, native }) => {
  const a = id('old-claim.testnet'), b = id('other-owner.testnet',true), c = id('new-owner.testnet',true);
  await ft.reserve(a); const prior = await ft.assertClaimable(a,a.stages[0].stage_id); await ft.claim(a,a.stages[0].stage_id,prior);
  await native.reserve(b); const trusted = anchor.snapshot();
  fs.unlinkSync(path.join(work,fileFor(a.owner,'wallet-prompt-witness-v1')));
  const malicious = commit(work,'Delete a synthetic prior claim');
  assert.notEqual(malicious,trusted.head);
  await assert.rejects(native.inspect(b.owner), e => e.code === 'WITNESS_UNAVAILABLE');
  await assert.rejects(native.reserve(c), e => e.code === 'WITNESS_UNAVAILABLE');
  assert.deepEqual(anchor.snapshot(),trusted, 'an unrelated operation cannot roll forward a deleted claim');
}));

test('rewrites, malformed append-only suffixes and unexpected protected paths fail closed', async () => repository(async ({ work, anchor, audit, native }) => {
  const a = id('rewrite.testnet',true); await native.reserve(a); const baseline = anchor.snapshot().head;
  const file = fileFor(a.owner,'native-oracle-prompt-witness-v1');
  fs.appendFileSync(path.join(work,file),'{}\n'); const tampered = commit(work,'Append a malformed synthetic witness');
  await assert.rejects(audit(baseline,tampered));
  await assert.rejects(native.inspect(a.owner),e => e.code === 'WITNESS_UNAVAILABLE');
  const other = path.join(work,'bouncer/evidence/wallet-prompt-witness-v1/not-a-hash.jsonl');
  fs.mkdirSync(path.dirname(other),{recursive:true}); fs.writeFileSync(other,'{}\n'); const withBadPath = commit(work,'Add an invalid synthetic witness path');
  await assert.rejects(audit(baseline,withBadPath));
}));

test('lost checkpoint acknowledgement consumes the Git reservation and cannot produce a second one', async () => repository(async ({ anchor, ft }) => {
  const a = id('lost-anchor-ack.testnet'); anchor.mode('lose-ack');
  await assert.rejects(ft.reserve(a),e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  anchor.mode('normal'); assert.equal((await ft.inspect(a.owner)).state.phase,'reserved');
  await assert.rejects(ft.reserve(a),e => e.code === 'OWNER_ALREADY_WITNESSED');
}));

test('an unavailable or dishonest checkpoint never acknowledges an independent claim', async () => repository(async ({ anchor, ft }) => {
  const a = id('anchor-fail.testnet'); anchor.mode('offline');
  await assert.rejects(ft.reserve(a),e => e.code === 'WITNESS_UNAVAILABLE');
  anchor.mode('normal'); await ft.reserve(a); const prior = await ft.assertClaimable(a,a.stages[0].stage_id);
  anchor.mode('lie'); await assert.rejects(ft.claim(a,a.stages[0].stage_id,prior),e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  anchor.mode('normal'); assert.equal((await ft.inspect(a.owner)).state.phase,'claimed');
  await assert.rejects(ft.assertClaimable(a,a.stages[0].stage_id),e => e.code === 'WITNESS_NOT_CLAIMABLE');
}));
