import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { V3_OWNER } from '../agent/v3-faucet-github-fence.mjs';
import { createNativeOraclePromptWitness, parseNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createWalletPromptWitness, parseWalletWitness } from '../agent/git-wallet-prompt-witness.mjs';
import { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';

const stages = ['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent'];
const key = () => String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const tx = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const identity = (owner = 'alice.testnet') => ({ owner, owner_public_key: key(), operation_id: 'a'.repeat(32), review_sha256: 'b'.repeat(64),
  stages: stages.map((stage_id, i) => ({ stage_id, action_commitment_sha256: String(i + 1).repeat(64) })) });
function memoryStore() {
  let head = '0', text = '', failRead = false, loseAck = false, lieAck = false;
  return { async read() { if (failRead) throw Error('offline'); return { head, text }; },
    async append(input) {
      if (input.expectedHead !== head || input.expectedText !== text) throw Error('CAS conflict');
      if (lieAck) return { head: String(Number(head) + 1), confirmed: true };
      text = input.text; head = String(Number(head) + 1);
      if (loseAck) throw Error('ack lost');
      return { head, confirmed: true };
    },
    failRead(v) { failRead = v; }, loseAck(v) { loseAck = v; }, lieAck(v) { lieAck = v; },
    snapshot() { return { head, text }; },
  };
}
async function claim(witness, id, i) {
  const prior = await witness.assertClaimable(id, stages[i]);
  return witness.claim(id, stages[i], prior);
}

test('native witness permits only four ordered, immutable prompt claims and unique original hashes', async () => {
  const store = memoryStore(), witness = createNativeOraclePromptWitness({ store }), id = identity();
  assert.equal((await witness.inspect(id.owner)).state, null);
  await witness.reserve(id);
  await assert.rejects(witness.reserve(id), e => e.code === 'OWNER_ALREADY_WITNESSED');
  await assert.rejects(witness.assertClaimable(id, stages[1]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  for (let i = 0; i < stages.length; i++) {
    const result = await claim(witness, id, i);
    assert.equal(result.state.phase, 'claimed');
    await assert.rejects(witness.assertClaimable(id, stages[i]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
    if (i > 0) await assert.rejects(witness.recordOriginal(id, stages[i], tx(i)), e => e.code === 'WITNESS_INVALID');
    const saved = await witness.recordOriginal(id, stages[i], tx(i + 1));
    assert.equal(saved.state.phase, i === 3 ? 'complete' : 'original');
    assert.equal((await witness.recordOriginal(id, stages[i], tx(i + 1))).head, saved.head, 'same original is recovery, not a new prompt');
    await assert.rejects(witness.recordOriginal(id, stages[i], tx(i + 10)), e => e.code === 'WITNESS_MISMATCH');
  }
  const { state } = await witness.inspect(id.owner);
  assert.equal(state.phase, 'complete'); assert.equal(state.records.length, 9);
  assert.equal(state.records[0].format, 'bouncer-native-oracle-prompt-witness-v1');
  await assert.rejects(witness.assertClaimable(id, stages[3]), e => e.code === 'WITNESS_NOT_CLAIMABLE');
  assert.throws(() => parseWalletWitness(store.snapshot().text, id.owner), e => e.code === 'WITNESS_INVALID', 'native evidence is not FT evidence');
});

test('tampering, wrong identities, malformed keys and excluded owner fail closed', async () => {
  const store = memoryStore(), witness = createNativeOraclePromptWitness({ store }), id = identity();
  for (const bad of [
    { ...id, owner: V3_OWNER }, { ...id, owner: 'alice.near' }, { ...id, owner: '0'.repeat(64) },
    { ...id, owner_public_key: 'ed25519:not-a-key' }, { ...id, operation_id: 'A'.repeat(32) },
    { ...id, review_sha256: 'b'.repeat(63) }, { ...id, stages: id.stages.slice(0, 3) },
    { ...id, stages: [...id.stages].reverse() }, { ...id, secret_key: 'must-not-be-retained' },
  ]) await assert.rejects(witness.reserve(bad), e => e.code === 'WITNESS_INVALID');
  await witness.reserve(id); await claim(witness, id, 0); await witness.recordOriginal(id, stages[0], tx(1));
  const text = store.snapshot().text;
  for (const invalid of [text.replace('alice.testnet', 'bob.testnet'), text.slice(0, -1), text + '{}\n',
    text.replace('"format":', '"extra":true,"format":'), text.replace('bouncer-native-oracle-prompt-witness-v1', 'other')]) {
    assert.throws(() => parseNativeOraclePromptWitness(invalid, id.owner), e => e.code === 'WITNESS_INVALID');
  }
  assert.throws(() => parseNativeOraclePromptWitness(text, 'bob.testnet'), e => e.code === 'WITNESS_INVALID');
  await assert.rejects(witness.assertClaimable({ ...id, review_sha256: 'c'.repeat(64) }, stages[1]), e => e.code === 'WITNESS_MISMATCH');
});

test('competing claims, lost acknowledgments and false confirmations cannot yield a second claim', async () => {
  const store = memoryStore(), witness = createNativeOraclePromptWitness({ store }), id = identity();
  const reservations = await Promise.allSettled([witness.reserve(id), witness.reserve(id)]);
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
  const checkpoint = await witness.assertClaimable(id, stages[0]);
  const outcomes = await Promise.allSettled([witness.claim(id, stages[0], checkpoint), witness.claim(id, stages[0], checkpoint)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  await witness.recordOriginal(id, stages[0], tx(1));
  const next = await witness.assertClaimable(id, stages[1]);
  store.loseAck(true);
  await assert.rejects(witness.claim(id, stages[1], next), e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  store.loseAck(false);
  assert.equal((await witness.inspect(id.owner)).state.phase, 'claimed');
  await assert.rejects(witness.assertClaimable(id, stages[1]), e => e.code === 'WITNESS_NOT_CLAIMABLE');

  const other = createNativeOraclePromptWitness({ store: memoryStore() }), first = identity('other.testnet');
  // A store that claims an append succeeded but did not retain it cannot issue a reservation.
  const liar = memoryStore(), liarWitness = createNativeOraclePromptWitness({ store: liar });
  liar.lieAck(true); await assert.rejects(liarWitness.reserve(first), e => e.code === 'WITNESS_COMMIT_UNKNOWN');
  liar.lieAck(false); assert.equal((await liarWitness.inspect(first.owner)).state, null);
  await other.reserve(first);
  store.failRead(true);
  await assert.rejects(witness.inspect(id.owner), e => e.code === 'WITNESS_UNAVAILABLE');
});

test('a local disposable Git remote isolates native and existing FT witness namespaces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-witness-'));
  const bare = path.join(root, 'remote.git'), work = path.join(root, 'work'), branch = 'arena/0e4386ea-near-hub';
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(work); git(root, ['init', '--bare', '--initial-branch', branch, bare]);
    git(work, ['init', '--initial-branch', branch]); git(work, ['config', 'user.email', 'synthetic@example.test']);
    git(work, ['config', 'user.name', 'Synthetic test']); git(work, ['remote', 'add', 'origin', bare]);
    fs.writeFileSync(path.join(work, 'README.md'), 'Synthetic test only\n'); git(work, ['add', 'README.md']);
    git(work, ['commit', '-m', 'Initial synthetic commit']); git(work, ['push', 'origin', branch]);
    const initialHead = git(work, ['rev-parse', 'HEAD']);
    const native = createNativeOraclePromptWitness({ store: createGitNativeOraclePromptWitnessStore({ repo: work, branch, initialHead }) });
    const old = createWalletPromptWitness({ store: createGitBranchWitnessStore({ repo: work, branch, initialHead }) });
    const id = identity();
    await native.reserve(id); await claim(native, id, 0); await native.recordOriginal(id, stages[0], tx(1));
    assert.equal((await native.inspect(id.owner)).state.phase, 'original');
    assert.equal((await old.inspect(id.owner)).state, null);
    const file = `bouncer/evidence/native-oracle-prompt-witness-v1/${crypto.createHash('sha256').update(id.owner).digest('hex')}.jsonl`;
    assert.ok(fs.existsSync(path.join(work, file)));
    assert.equal(git(work, ['branch', '--show-current']), branch);
    fs.writeFileSync(path.join(work, 'unrelated.txt'), 'do not touch');
    await assert.rejects(native.inspect(id.owner), e => e.code === 'WITNESS_UNAVAILABLE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function completed(witness,id) {
  await witness.reserve(id);
  for(let i=0;i<stages.length;i++){
    await claim(witness,id,i);await witness.recordOriginal(id,stages[i],tx(i+1));
  }
}
const trial = () => ({goal_id:'native-oracle-trial-1',goal_sha256:'d'.repeat(64),agent_public_key:key(),original_hash:tx(50)});

test('the exact trial original is retained before any signature and can never be replaced',async()=>{
  const store=memoryStore(),witness=createNativeOraclePromptWitness({store}),id=identity(),request=trial();
  await completed(witness,id); const previous=await witness.inspect(id.owner);
  await assert.rejects(witness.claimTrial(id,request,'stale-head'),e=>e.code==='WITNESS_NOT_CLAIMABLE');
  await assert.rejects(witness.claimTrial(id,{...request,original_hash:tx(1)},previous.head),e=>e.code==='WITNESS_NOT_CLAIMABLE');
  const claim=await witness.claimTrial(id,request,previous.head);
  assert.equal(claim.state.phase,'trial_claimed');assert.deepEqual(claim.state.trial,request);
  assert.equal(claim.state.records.length,10);assert.equal(claim.state.records.at(-1).original_hash,request.original_hash);
  await assert.rejects(witness.claimTrial(id,request,claim.head),e=>e.code==='WITNESS_NOT_CLAIMABLE');
  await assert.rejects(witness.claimTrial(id,{...request,original_hash:tx(51)},claim.head),e=>e.code==='WITNESS_NOT_CLAIMABLE');
  const fresh=createNativeOraclePromptWitness({store});
  assert.deepEqual((await fresh.inspect(id.owner)).state.trial,request,'fresh process recovers the original');
  const text=store.snapshot().text;
  // Parsing alone cannot detect rewriting the last line; the separately
  // retained head and append-only Git audit are what catch that rollback.
  assert.equal(parseNativeOraclePromptWitness(text.replace(request.original_hash,tx(51)),id.owner).trial.original_hash,tx(51));
  assert.throws(()=>parseNativeOraclePromptWitness(text+'{}\n',id.owner),e=>e.code==='WITNESS_INVALID');
});

test('competing trial claims and a lost acknowledgment cannot grant a second trial',async()=>{
  const store=memoryStore(),witness=createNativeOraclePromptWitness({store}),id=identity(),request=trial();
  await completed(witness,id); const head=(await witness.inspect(id.owner)).head;
  const outcomes=await Promise.allSettled([witness.claimTrial(id,request,head),witness.claimTrial(id,{...request,original_hash:tx(51)},head)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  const otherStore=memoryStore(),other=createNativeOraclePromptWitness({store:otherStore}),id2=identity('other.testnet'),request2=trial();
  await completed(other,id2);const head2=(await other.inspect(id2.owner)).head;otherStore.loseAck(true);
  await assert.rejects(other.claimTrial(id2,request2,head2),e=>e.code==='WITNESS_COMMIT_UNKNOWN');
  otherStore.loseAck(false);assert.equal((await other.inspect(id2.owner)).state.trial.original_hash,request2.original_hash);
  await assert.rejects(other.claimTrial(id2,request2,head2),e=>e.code==='WITNESS_NOT_CLAIMABLE');
});
