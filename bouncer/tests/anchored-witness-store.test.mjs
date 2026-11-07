import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { createAnchoredSetupWitnessPair } from '../agent/anchored-setup-witness-pair.mjs';
import { createGitWitnessHistoryAudit } from '../agent/git-witness-history-audit.mjs';
import { createGitWitnessRangeAudit } from '../agent/git-witness-range-audit.mjs';
import { createGitAuditedSetupCheckpointServer } from '../agent/independent-setup-checkpoint.mjs';

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
    const pair = createAnchoredSetupWitnessPair({ repo: work, branch, initialHead: base, anchor });
    const ft = pair.wallet, native = pair.native;
    await run({ work, bare, base, anchor, audit, ft, native });
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

test('incremental and full audits catch deletion followed by restoration that a net diff misses', async () => repository(async ({ work, bare, base, anchor, ft, audit }) => {
  const { auditFullGitWitnessHistory } = await import('../agent/full-git-witness-history-audit.mjs');
  const a = id('baseline-audit.testnet'); await ft.reserve(a);
  const trusted = anchor.snapshot(), initial = git(work,['rev-parse','HEAD']);
  const file = path.join(work,fileFor(a.owner,'wallet-prompt-witness-v1'));
  const original = fs.readFileSync(file); fs.unlinkSync(file); commit(work,'Delete earlier synthetic claim');
  fs.writeFileSync(file,original); const restored = commit(work,'Restore earlier synthetic claim');
  assert.equal(await audit(base,restored),true,'net tree alone cannot see the temporary removal');
  assert.equal((await auditFullGitWitnessHistory({repo:work,head:initial})).reachable_history_only,true);
  await assert.rejects(auditFullGitWitnessHistory({repo:work,head:restored}),/unsafe|append-only/);
  await assert.rejects(createGitWitnessRangeAudit({repo:work})(initial,restored),/unsafe|append-only/);
  await assert.rejects(ft.inspect(a.owner), e => e.code === 'WITNESS_UNAVAILABLE');
  assert.deepEqual(anchor.snapshot(), trusted);

  // Exercise the actual independently audited server factory, not a stub audit.
  const token = crypto.randomBytes(32).toString('base64url');
  const server = createGitAuditedSetupCheckpointServer({anchor,repo:work,branch,remoteUrl:bare,token,allowLocalForTests:true});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/compare-and-set`, {
      method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({expected:trusted,nextHead:restored}),
    });
    assert.equal(response.status,503);
    assert.deepEqual(anchor.snapshot(),trusted,'monitor must not advance over a temporarily deleted witness');
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('incremental audit checks all merge parents, including a side-history deletion and restoration', async () => repository(async ({ work, anchor, ft, audit }) => {
  const a = id('side-history.testnet'); await ft.reserve(a);
  const trusted = anchor.snapshot(), initial = trusted.head;
  const filename = fileFor(a.owner,'wallet-prompt-witness-v1');
  const index = path.join(path.dirname(work),'synthetic-index');
  const indexGit = args => execFileSync('git',args,{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_INDEX_FILE:index}}).trim();
  indexGit(['read-tree',initial]); indexGit(['update-index','--force-remove','--',filename]);
  const deletedTree = indexGit(['write-tree']), originalTree = git(work,['rev-parse',`${initial}^{tree}`]);
  const deleted = git(work,['commit-tree',deletedTree,'-p',initial,'-m','Synthetic side deletion']);
  const restored = git(work,['commit-tree',originalTree,'-p',deleted,'-m','Synthetic side restoration']);
  git(work,['commit','--allow-empty','-m','Synthetic safe mainline']);
  const main = git(work,['rev-parse','HEAD']);
  const merge = git(work,['commit-tree',originalTree,'-p',main,'-p',restored,'-m','Synthetic merge']);
  git(work,['update-ref',`refs/heads/${branch}`,merge,main]); git(work,['push','origin',branch]);
  assert.equal(await audit(initial,merge),true,'both end trees are identical');
  await assert.rejects(createGitWitnessRangeAudit({repo:work})(initial,merge),/unsafe|append-only/);
  await assert.rejects(ft.inspect(a.owner), e => e.code === 'WITNESS_UNAVAILABLE');
  assert.deepEqual(anchor.snapshot(),trusted);
}));

test('local Git replacement objects cannot hide an existing witness from the paired store', async () => repository(async ({ work, base, anchor, ft }) => {
  const a = id('replacement-object.testnet'); await ft.reserve(a);
  const trusted = anchor.snapshot(), treeWithoutWitness = git(work,['rev-parse',`${base}^{tree}`]);
  const replacement = git(work,['commit-tree',treeWithoutWitness,'-p',base,'-m','Synthetic replacement without witness']);
  git(work,['replace',trusted.head,replacement]);
  assert.equal((await ft.inspect(a.owner)).state.phase,'reserved');
  assert.deepEqual(anchor.snapshot(),trusted);
}));

test('incremental audit accepts an append-only merge with two safe parents', async () => repository(async ({ work, ft }) => {
  const a = id('safe-merge.testnet'); await ft.reserve(a);
  const initial = git(work,['rev-parse','HEAD']), tree = git(work,['rev-parse',`${initial}^{tree}`]);
  const side = git(work,['commit-tree',tree,'-p',initial,'-m','Synthetic safe side']);
  git(work,['commit','--allow-empty','-m','Synthetic safe main']); const main = git(work,['rev-parse','HEAD']);
  const merge = git(work,['commit-tree',tree,'-p',main,'-p',side,'-m','Synthetic safe merge']);
  git(work,['update-ref',`refs/heads/${branch}`,merge,main]); git(work,['push','origin',branch]);
  assert.equal(await createGitWitnessRangeAudit({repo:work})(initial,merge),true);
  assert.equal((await ft.inspect(a.owner)).state.phase,'reserved');
}));

test('full baseline audit rejects shallow histories and non-commit heads', async () => repository(async ({ work, base }) => {
  const { auditFullGitWitnessHistory } = await import('../agent/full-git-witness-history-audit.mjs');
  fs.appendFileSync(path.join(work,'README.md'),'Second commit\n'); commit(work,'Second synthetic commit');
  const shallow = path.join(path.dirname(work),'shallow');
  git(path.dirname(work),['clone','--depth=1',`file://${work}`,shallow]);
  assert.equal(git(shallow,['rev-parse','--is-shallow-repository']),'true');
  await assert.rejects(auditFullGitWitnessHistory({repo:shallow,head:git(shallow,['rev-parse','HEAD'])}),/unavailable or unsafe/);
  await assert.rejects(createGitWitnessRangeAudit({repo:shallow})(base,git(shallow,['rev-parse','HEAD'])),/incomplete or unsafe/);
  await assert.rejects(auditFullGitWitnessHistory({repo:work,head:'a'.repeat(40)}),/unavailable or unsafe/);
  await assert.rejects(createGitWitnessRangeAudit({repo:work})(base,'a'.repeat(40)),/unavailable|unsafe/);
  assert.equal((await auditFullGitWitnessHistory({repo:work,head:base})).wallet_or_transaction_authorized,false);
}));
