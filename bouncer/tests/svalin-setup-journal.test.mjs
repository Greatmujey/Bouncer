import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { buildUnsignedSvalinTrialSetup } from '../agent/svalin-setup-plan.mjs';

import { fixture, resultFor, STAGES, OWNER, VAULT, hash } from './fixtures/svalin-setup-fixture.mjs';

test('new setup manifest needs explicit initialization, correct scope, encrypted journal and retained review', async () => {
  const f = fixture(); try {
    const tx = await f.signed(0);
    await assert.rejects(f.record(0, tx.signed), /manifest is missing/);
    await assert.rejects(f.init({ confirmNew: false }), /explicit new/);
    await assert.rejects(f.init({ trustedReviewHash: '0'.repeat(64) }), /retained|differs/);
    await assert.rejects(f.init({ ownerPublicKey: f.inputs.agentPublicKey }), /differ/);
    assert.equal(fs.existsSync(f.file), false);
    const plain = new FileJournal(path.join(f.dir, 'plain'), VAULT, OWNER);
    try { await assert.rejects(f.init({ journal: plain }), /encrypted owner\/vault/); } finally { plain.close(); }
    const wrong = new FileJournal(path.join(f.dir, 'wrong'), 'other.testnet', OWNER, { encryptionKey: f.key });
    try { await assert.rejects(f.init({ journal: wrong }), /encrypted owner\/vault/); } finally { wrong.close(); }
    const created = await f.init(); assert.equal(created.status, 'LOCAL_SETUP_JOURNAL_ONLY');
    assert.equal(created.stages.every(s => s.state === 'NOT_RECORDED'), true);
    assert.deepEqual(await f.init(), created); // idempotent, no reset or new record
    assert.equal(f.journal.list().length, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8').includes(f.ownerKey), false);
  } finally { f.close(); }
});

test('signed hash is fsynced before any future send; restart and changed nonce cannot replace it', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0), signedBytes = Buffer.from(nearApi.transactions.encodeTransaction(tx.signed)).toString('base64');
    await assert.rejects(f.record(0, tx.signed, { acknowledgeRecovery: false }), /acknowledgment/);
    const recorded = await f.record(0, tx.signed);
    assert.equal(recorded.status, 'ORIGINAL_SIGNED_HASH_RECORDED'); assert.equal(recorded.tx_hash, tx.txHash);
    assert.equal(recorded.sends, 0); assert.equal(recorded.do_not_resend, true);
    assert.equal(recorded.current_state_verified, false); assert.equal(recorded.owner_approval_verified, false);
    assert.equal(recorded.broadcast_authorized, false);
    const raw = fs.readFileSync(f.file, 'utf8');
    assert.equal(raw.includes(tx.txHash), false); assert.equal(raw.includes(signedBytes), false);
    assert.equal(JSON.stringify(f.journal.list()).includes(signedBytes), false);
    assert.equal(JSON.stringify(f.journal.list()).includes(f.ownerPair.toString()), false);
    f.reopen(); const state = await f.status();
    assert.equal(state.stages[0].state, 'ORIGINAL_HASH_PENDING'); assert.equal(state.stages[0].tx_hash, tx.txHash);
    await assert.rejects(f.record(0, tx.signed), /already recorded.*never resend/);
    const other = await f.signed(0, 2n);
    await assert.rejects(f.record(0, other.signed), /already recorded.*never resend/);
    await assert.rejects(f.record(1, (await f.signed(1, 3n)).signed), /earlier.*unresolved/);
    assert.equal((await f.status()).stages[0].tx_hash, tx.txHash);
  } finally { f.close(); }
});

test('all five stages reconcile only their original hashes; inspection and recovery never send', async () => {
  const f = fixture(); try {
    await f.init();
    for (let i = 0; i < STAGES.length; i++) {
      const tx = await f.signed(i, BigInt(i + 1));
      assert.equal((await f.record(i, tx.signed)).tx_hash, tx.txHash);
      if (i === 0) f.reopen(); // simulate restart after recorded hash / lost response
      const result = resultFor(f, i, tx.txHash);
      const dry = await f.reconcile(i, result, { update: false });
      assert.equal(dry.journal_updated, false); assert.equal((await f.status()).stages[i].state, 'ORIGINAL_HASH_PENDING');
      const resolved = await f.reconcile(i, result); assert.equal(resolved.tx_hash, tx.txHash);
      assert.equal(resolved.sends, 0); assert.equal(resolved.do_not_resend, true); assert.equal(resolved.journal_updated, true);
      assert.equal(resolved.broadcast_authorized, false);
      assert.equal(resolved.status, i === 4 ? 'FINAL_FUNDING_RECEIPTS_MATCH' : 'FINAL_SETUP_RECEIPT_MATCH');
      assert.equal((await f.reconcile(i, result)).journal_updated, false);
      assert.equal((await f.status()).stages[i].state, 'FINAL_RECEIPTS_MATCH');
      assert.equal(JSON.stringify(f.journal.list()).includes('untrusted-signature-not-for-the-journal'), false);
      await assert.rejects(f.record(i, tx.signed), /already recorded/);
    }
    f.reopen(); const state = await f.status();
    assert.equal(state.stages.every(stage => stage.state === 'FINAL_RECEIPTS_MATCH' && stage.do_not_resend), true);
    assert.equal(state.sends, 0); assert.equal(state.seller_requests, 0); assert.equal(state.current_state_verified, false);
    assert.equal(state.broadcast_authorized, false);
  } finally { f.close(); }
});

test('funding cannot pass an unresolved or refunded Circle registration', async () => {
  const f = fixture(); try {
    await f.init();
    for (let i = 0; i < 3; i++) {
      const tx = await f.signed(i, BigInt(i + 1)); await f.record(i, tx.signed);
      await f.reconcile(i, resultFor(f, i, tx.txHash));
    }
    const registration = await f.signed(3, 4n); await f.record(3, registration.signed);
    const result = resultFor(f, 3, registration.txHash);
    result.receipts_outcome[0].outcome.receipt_ids = [hash(222)]; // Circle refund, not a fresh registration
    await assert.rejects(f.reconcile(3, result), /registration/);
    assert.equal((await f.status()).stages[3].state, 'ORIGINAL_HASH_PENDING');
    const funding = await f.signed(4, 5n);
    await assert.rejects(f.record(4, funding.signed), /earlier.*unresolved/);
    await assert.rejects(f.record(3, registration.signed), /already recorded.*never resend/);
    f.reopen(); assert.equal((await f.status()).stages[3].tx_hash, registration.txHash);
  } finally { f.close(); }
});

test('unavailable, altered or contradictory FINAL results cannot complete the pending original', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0); await f.record(0, tx.signed);
    const valid = resultFor(f, 0, tx.txHash);
    for (const change of [r => { r.final_execution_status = 'EXECUTED'; }, r => { r.transaction.hash = hash(99); },
      r => { r.receipts = []; }, r => { r.receipts[0].receipt.Action.actions[1].Transfer.deposit = '1'; }]) {
      const bad = structuredClone(valid); change(bad); await assert.rejects(f.reconcile(0, bad));
      assert.equal((await f.status()).stages[0].state, 'ORIGINAL_HASH_PENDING');
    }
    await assert.rejects(f.reconcile(0, null), /not terminal FINAL/);
    assert.equal((await f.reconcile(0, valid)).status, 'FINAL_SETUP_RECEIPT_MATCH');
    const contradictory = structuredClone(valid); contradictory.status = { Failure: { ActionError: {} } };
    contradictory.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } };
    await assert.rejects(f.reconcile(0, contradictory), /contradicts/);
    assert.equal((await f.status()).stages[0].state, 'FINAL_RECEIPTS_MATCH');
  } finally { f.close(); }
});

test('FINAL failure remains fenced and blocks later stages, even if a different response later claims success', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0); await f.record(0, tx.signed);
    const success = resultFor(f, 0, tx.txHash), failed = structuredClone(success);
    failed.status = { Failure: { ActionError: {} } }; failed.receipts_outcome[0].outcome.status = { Failure: { ActionError: {} } };
    const proof = await f.reconcile(0, failed);
    assert.equal(proof.status, 'FINAL_FAILURE_NEEDS_RECONCILIATION'); assert.equal(proof.do_not_resend, true);
    f.reopen(); assert.equal((await f.status()).stages[0].state, 'FINAL_FAILURE_NEEDS_RECONCILIATION');
    await assert.rejects(f.reconcile(0, success), /contradicts/);
    await assert.rejects(f.record(0, tx.signed), /already recorded/);
    await assert.rejects(f.record(1, (await f.signed(1, 2n)).signed), /earlier.*unresolved/);
  } finally { f.close(); }
});

test('wrong signed payload, changed plan or mismatched original review cannot create a pending stage', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0);
    const invalid = { ...tx.signed, signature: { ...tx.signed.signature, data: Buffer.alloc(64, 7) } };
    await assert.rejects(f.record(0, invalid), /signed setup transaction/);
    await assert.rejects(f.record(1, tx.signed), /earlier.*unresolved/);
    const changedPlan = buildUnsignedSvalinTrialSetup({ ...f.inputs, goal: { ...f.inputs.goal, id: 'changed' } });
    await assert.rejects(f.record(0, tx.signed, { plan: changedPlan, trustedReviewHash: changedPlan.review.review_sha256 }), /manifest.*differs/);
    await assert.rejects(f.record(0, tx.signed, { ownerPublicKey: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) }), /manifest.*differs/);
    assert.equal((await f.status()).stages[0].state, 'NOT_RECORDED');
  } finally { f.close(); }
});

test('one journal fences concurrent signed attempts and another process cannot open the same file', async () => {
  const f = fixture(); try {
    await f.init(); const first = await f.signed(0), second = await f.signed(0, 2n);
    assert.throws(() => new FileJournal(f.file, VAULT, OWNER, { encryptionKey: f.key, requireExisting: true }), /EEXIST/);
    const settled = await Promise.allSettled([f.record(0, first.signed), f.record(0, second.signed)]);
    assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
    const state = await f.status(); assert.equal(state.stages[0].state, 'ORIGINAL_HASH_PENDING');
    assert.equal([first.txHash, second.txHash].includes(state.stages[0].tx_hash), true);
  } finally { f.close(); }
});

test('a disk failure prevents recording; a lost acknowledgement after a successful write remains fenced on restart', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0), original = f.journal.put.bind(f.journal);
    f.journal.put = () => { throw new Error('synthetic disk failure'); };
    await assert.rejects(f.record(0, tx.signed), /disk failure/);
    assert.equal((await f.status()).stages[0].state, 'NOT_RECORDED');
    f.journal.put = (...args) => { original(...args); throw new Error('synthetic lost write acknowledgment'); };
    await assert.rejects(f.record(0, tx.signed), /lost write acknowledgment/);
    f.reopen(); assert.equal((await f.status()).stages[0].tx_hash, tx.txHash);
    await assert.rejects(f.record(0, tx.signed), /already recorded/);
  } finally { f.close(); }
});

test('abrupt process death after fsync leaves a stale lock and the original hash survives controlled recovery', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0); f.journal.close();
    const input = { file: f.file, journalKey: f.key.toString('hex'), ownerPrivateKey: f.ownerPair.toString(),
      planInputs: { ...f.inputs, wasmBytes: f.inputs.wasmBytes.toString('base64') } };
    const script = fileURLToPath(new URL('./fixtures/svalin-setup-record-crash.mjs', import.meta.url));
    const denyNetwork = fileURLToPath(new URL('./fixtures/deny-test-network.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [`--import=${denyNetwork}`, script], { env: { ...process.env, BOUNCER_TEST_SETUP_INPUT: JSON.stringify(input) },
      encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr); assert.match(child.stdout, /recorded synthetic setup hash/);
    assert.equal(fs.existsSync(`${f.file}.lock`), true);
    assert.throws(() => new FileJournal(f.file, VAULT, OWNER, { encryptionKey: f.key, requireExisting: true }), /EEXIST/);
    // This is a disposable test lock. Only remove it after the child has died;
    // real operators must first establish that no process holds the journal.
    fs.unlinkSync(`${f.file}.lock`);
    f.reopen(); assert.equal((await f.status()).stages[0].tx_hash, tx.txHash);
    await assert.rejects(f.record(0, tx.signed), /already recorded/);
    assert.equal((await f.reconcile(0, resultFor(f, 0, tx.txHash))).tx_hash, tx.txHash);
  } finally { f.close(); }
});

test('a missing original journal cannot be silently replaced during setup recovery', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0); await f.record(0, tx.signed); f.journal.close();
    const retained = `${f.file}.retained`; fs.renameSync(f.file, retained);
    assert.throws(() => new FileJournal(f.file, VAULT, OWNER, { encryptionKey: f.key, requireExisting: true }), /original journal not found/);
    assert.equal(fs.existsSync(f.file), false);
    const empty = new FileJournal(f.file, VAULT, OWNER, { encryptionKey: f.key });
    try {
      await assert.rejects(f.record(0, tx.signed, { journal: empty }), /manifest is missing/);
      await assert.rejects(f.reconcile(0, resultFor(f, 0, tx.txHash), { journal: empty }), /manifest is missing/);
      assert.equal(fs.existsSync(f.file), false);
    } finally { empty.close(); }
    fs.renameSync(retained, f.file); f.reopen();
    assert.equal((await f.status()).stages[0].tx_hash, tx.txHash);
    await assert.rejects(f.record(0, tx.signed), /already recorded/);
  } finally { f.close(); }
});

test('missing, partial, substituted or malformed setup records fail closed without creating replacements', async () => {
  const f = fixture(); try {
    await f.init(); const tx = await f.signed(0); await f.record(0, tx.signed);
    const entry = f.journal.list().find(item => item.svalin_setup), original = structuredClone(entry);
    for (const change of [e => { e.tx_hash = hash(100); }, e => { e.fingerprint = '0'.repeat(64); },
      e => { e.svalin_setup.attempt.receiver_id = 'evil.testnet'; }, e => { e.status = 'completed'; },
      e => { e.svalin_setup.evidence = { status: 'FINAL_SETUP_RECEIPT_MATCH' }; }]) {
      const bad = structuredClone(original); change(bad); f.journal.put(bad.id, bad);
      await assert.rejects(f.status(), /record.*differs|malformed/);
    }
    f.journal.put(original.id, original);
    f.journal.put('svalin-setup-v1-unrecognized', { status: 'pending', fingerprint: 'x' });
    await assert.rejects(f.status(), /unrecognized/);
  } finally { f.close(); }
  const g = fixture(); try {
    g.journal.put('svalin-setup-v1-create_keyless_vault', { status: 'pending', fingerprint: 'x' });
    await assert.rejects(g.init(), /partial setup records/);
    await assert.rejects(g.status(), /manifest is missing/);
  } finally { g.close(); }
});
