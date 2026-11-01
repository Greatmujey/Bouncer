import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileJournal } from '../agent/procurement.mjs';
import nearApi from 'near-api-js';
import { YOUTICK_MARKET } from '../agent/youtick-capabilities.mjs';
import { inspectYoutickSource, verifyYoutickSource, reserveYoutickUploadSession, prepareYoutickUploadControl } from '../agent/youtick-session.mjs';
import { vault, owner, now, fixture, input, open, settledVideo } from './helpers/youtick-fixture.mjs';


test('source checks bind full bytes separately from the provider head/tail fingerprint', () => {
  const f = fixture();
  try {
    const value = inspectYoutickSource(f.source), data = fs.readFileSync(f.source), n = 1048576;
    assert.equal(value.size, String(data.length));
    assert.equal(value.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    const expected = crypto.createHash('sha256').update(`youtick.livepeer-source-fingerprint.v1\n${data.length}\n${n}\n${n}\n`)
      .update(data.subarray(0, n)).update(data.subarray(data.length - n)).digest('hex');
    assert.equal(value.provider_fingerprint, expected); assert.deepEqual(verifyYoutickSource(value, f.source), value);
    fs.writeFileSync(f.source, Buffer.alloc(data.length, 8));
    assert.throws(() => verifyYoutickSource(value, f.source), /differs/);
    fs.symlinkSync(f.source, path.join(f.dir, 'link')); assert.throws(() => inspectYoutickSource(path.join(f.dir, 'link')));
    fs.writeFileSync(path.join(f.dir, 'empty'), ''); assert.throws(() => inspectYoutickSource(path.join(f.dir, 'empty')), /bounded regular/);
    fs.linkSync(f.source, path.join(f.dir, 'hardlink')); assert.throws(() => inspectYoutickSource(f.source), /bounded regular/);
  } finally { f.cleanup(); }
});

test('encrypts the session key before exposing the public request, then reuses it on restart', () => {
  const f = fixture();
  try {
    const value = input(f); let journal = open(f);
    const first = reserveYoutickUploadSession({ journal, id: 'video1-session', input: value, nowMs: now });
    assert.equal(first.reused, false); assert.equal(first.request.creator_id, vault);
    const secret = journal.get('video1-session').session.private_key, disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(secret.startsWith('ed25519:')); assert.ok(!disk.includes(secret)); assert.ok(!JSON.stringify(first).includes(secret));
    assert.match(first.scope, /no quote, payment or upload/);
    journal.close(); journal = open(f, true);
    const second = reserveYoutickUploadSession({ journal, id: 'video1-session', input: value, nowMs: now + 1 });
    assert.equal(second.reused, true); assert.equal(second.request.upload_public_key, first.request.upload_public_key);
    assert.equal(fs.readFileSync(f.file, 'utf8'), disk); // no new key or write
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'other-id', input: value, nowMs: now }), /already has/);
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1-session', input: { ...value, title: 'different' }, nowMs: now }), /differs/);
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1-session', input: value, nowMs: now + 3600000 }), /expired/);
    const previous = structuredClone(journal.get('video1-session')); previous.session.public_key = 'ed25519:tampered';
    journal.put('video1-session', previous);
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1-session', input: value, nowMs: now }), /key mismatch/);
    journal.close();
    assert.throws(() => new FileJournal(f.file, vault, owner, { encryptionKey: crypto.randomBytes(32), requireExisting: true }), /authentication/);
  } finally { f.cleanup(); }
});

test('refuses plaintext, changed key, unsafe scope and missing original journal before reserving a session', () => {
  const f = fixture();
  try {
    const value = input(f), plain = new FileJournal(f.file, vault, owner);
    plain.encrypted = true; // A mutable flag cannot turn a plaintext journal into an encrypted one.
    assert.throws(() => reserveYoutickUploadSession({ journal: plain, id: 'video1', input: value, nowMs: now }), /encrypted file journal/);
    assert.equal(fs.existsSync(f.file), false); plain.close();
    let journal = open(f); fs.writeFileSync(f.keyFile, crypto.randomBytes(32), { mode: 0o600 });
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1', input: value, nowMs: now }), /key changed/);
    assert.equal(fs.existsSync(f.file), false); journal.close();
    fs.writeFileSync(f.keyFile, f.key, { mode: 0o600 }); journal = open(f);
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1', input: { ...value, owner: 'other.testnet' }, nowMs: now }), /owner\/vault-scoped/);
    assert.throws(() => reserveYoutickUploadSession({ journal, id: 'video1', input: { ...value, source_type: 'exe' }, nowMs: now }), /invalid/);
    assert.equal(fs.existsSync(f.file), false); journal.close();
    assert.throws(() => open(f, true), /original journal not found/);
  } finally { f.cleanup(); }
});


test('upload-control preparation requires exact paid job and records its attempt before returning a signed bearer capability', () => {
  const f = fixture();
  try {
    const journal = open(f), ctx = settledVideo(journal, f);
    assert.throws(() => prepareYoutickUploadControl({ ...ctx, recovery: 'resume' }), /missing or already pending/);
    const badJob = { ...ctx.job, creator_id: 'attacker.testnet' };
    assert.throws(() => prepareYoutickUploadControl({ ...ctx, job: badJob }), /does not match/);
    const badReceipt = structuredClone(ctx.paymentResult); badReceipt.transaction.signer_id = 'attacker.testnet';
    assert.throws(() => prepareYoutickUploadControl({ ...ctx, paymentResult: badReceipt }), /mismatch/);
    assert.equal(journal.get('session').control, undefined);
    const first = prepareYoutickUploadControl(ctx), entry = journal.get('session');
    assert.equal(entry.control.state, 'pending'); assert.equal(entry.control.last_mode, 'initial');
    assert.equal(entry.control.payment_tx_hash, ctx.paymentResult.transaction_outcome.id);
    assert.equal(first.envelope.account_id, vault); assert.equal(first.envelope.contract_id, YOUTICK_MARKET);
    assert.equal(first.body.source_fingerprint_sha256, input(f).source.provider_fingerprint);
    assert.match(first.scope, /no HTTP request or upload/);
    const pub = nearApi.utils.PublicKey.fromString(first.envelope.session_public_key);
    assert.equal(pub.verify(Buffer.from(Object.values(first.envelope).join('\n')), Buffer.from(first.signature, 'base64')), true);
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(first.signature));
    assert.throws(() => prepareYoutickUploadControl(ctx), /already pending/);
    journal.close();
    const reopened = open(f, true), again = prepareYoutickUploadControl({ ...ctx, journal: reopened, nowMs: now + 1000, recovery: 'reconcile' });
    assert.equal(again.body.recovery, 'reconcile'); assert.notEqual(again.envelope.device_nonce, first.envelope.device_nonce);
    assert.equal(reopened.get('session').control.original_nonce, first.envelope.device_nonce);
    assert.equal(pub.verify(Buffer.from(Object.values(again.envelope).join('\n')), Buffer.from(again.signature, 'base64')), true);
    fs.writeFileSync(f.source, 'different bytes');
    assert.throws(() => prepareYoutickUploadControl({ ...ctx, journal: reopened, recovery: 'resume' }), /differs/);
    reopened.close();
  } finally { f.cleanup(); }
});
