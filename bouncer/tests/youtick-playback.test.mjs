import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { reserveYoutickUploadSession, prepareYoutickUploadControl } from '../agent/youtick-session.mjs';
import { YOUTICK_ACCESS, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS, reserveYoutickPlaybackSession,
  prepareYoutickPlayGrant, verifyYoutickPlayGrantView, verifyYoutickPlayGrantTransaction,
  prepareYoutickPlaybackTokenRequest } from '../agent/youtick-playback.mjs';
import { makeYoutickPlayGrantArgs } from '../agent/youtick-play-proof.mjs';
import { fixture, input, open, settledVideo, now, vault, owner } from './helpers/youtick-fixture.mjs';

const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = value => Buffer.from(value, 'utf8').toString('hex');

function setup(f) {
  const journal = open(f), value = input(f);
  reserveYoutickUploadSession({ journal, id: 'session', input: value, nowMs: now });
  const playback = reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now });
  const ctx = settledVideo(journal, f);
  ctx.job = { ...ctx.job, status: 'Published', published_at_ms: now + 500 };
  ctx.publication = { publication_id: ctx.job.job_id, creator_id: vault, title: ctx.job.title, price_usdc: ctx.job.price_usdc,
    generation: 1, expected_source_bytes: ctx.job.expected_source_bytes, verified_source_bytes: ctx.job.expected_source_bytes,
    profile_id: ctx.job.profile_id, profile_config_sha256: ctx.job.profile_config_sha256, asset_id_hash: '1'.repeat(64),
    project_id_hash: '2'.repeat(64), playback_id: 'playback-123', provider_source_fingerprint: value.source.sha256,
    published_availability: 'ACTIVE', availability: 'ACTIVE', ready_at_ms: String(now), published_at_ms: now + 500 };
  return { ...ctx, playback };
}
function grantFixture(ctx) {
  const prepared = prepareYoutickPlayGrant(ctx), grant = { owner_id: vault, session_pk: prepared.args.session_pk, scope: 'Play',
    resource_id: prepared.args.job_id, expires_at_ms: now + 500_000, origin_hash: YOUTICK_PLAY_ORIGIN_HASH,
    device_hash: prepared.args.device_hash, revoked: false };
  const verification = { valid: true, owner_id: vault, reason: null }, ownerPublicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const txHash = hash(9), initId = hash(10), accessId = hash(11);
  const accessArgs = { target_owner_id: vault, session_pk: prepared.args.session_pk, scope: 'Play', resource_id: prepared.args.job_id,
    ttl_ms: YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: prepared.args.device_hash, session_pok: prepared.args.session_pok };
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: enc(grant) },
    transaction_outcome: { id: txHash, outcome: { receipt_ids: [initId] } },
    transaction: { hash: txHash, signer_id: owner, receiver_id: vault, public_key: ownerPublicKey,
      actions: [{ FunctionCall: { method_name: prepared.method, deposit: '1', gas: prepared.gas, args: enc(prepared.args) } }] },
    receipts: [{ receipt_id: accessId, predecessor_id: vault, receiver_id: YOUTICK_ACCESS,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: 'issue_session_grant', deposit: '0', gas: '70000000000000', args: enc({ request: accessArgs }) } }] } } }],
    receipts_outcome: [{ id: initId, outcome: { executor_id: vault, status: { SuccessReceiptId: accessId }, receipt_ids: [accessId] } },
      { id: accessId, outcome: { executor_id: YOUTICK_ACCESS, status: { SuccessValue: enc(grant) }, receipt_ids: [] } }] };
  return { prepared, grant, verification, ownerPublicKey, grantTxHash: txHash, grantResult: result };
}

test('play proof refuses non-testnet vaults, malformed resources and device bindings', () => {
  const key = nearApi.KeyPair.fromRandom('ed25519');
  const valid = { vault, jobId: 'clip:1', deviceHash: 'a'.repeat(64), key };
  assert.equal(makeYoutickPlayGrantArgs(valid).job_id, 'clip:1');
  for (const bad of [{ ...valid, vault: 'vault.near' }, { ...valid, jobId: '../bad?' },
    { ...valid, deviceHash: 'x'.repeat(64) }, { ...valid, key: null }]) {
    assert.throws(() => makeYoutickPlayGrantArgs(bad), /invalid/);
  }
});

test('a distinct encrypted playback key is reserved before the order and survives restart', () => {
  const f = fixture(); let journal;
  try {
    journal = open(f); const value = input(f);
    reserveYoutickUploadSession({ journal, id: 'session', input: value, nowMs: now });
    const first = reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now });
    const record = journal.get('session'), secret = record.session.playback.private_key;
    assert.notEqual(first.session_pk, record.session.public_key); assert.ok(secret.startsWith('ed25519:'));
    assert.ok(!JSON.stringify(first).includes(secret)); assert.ok(!fs.readFileSync(f.file, 'utf8').includes(secret));
    journal.close(); journal = open(f, true);
    const second = reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now + 1 });
    assert.equal(second.reused, true); assert.equal(second.session_pk, first.session_pk); assert.equal(second.device_hash, first.device_hash);
    const tampered = structuredClone(journal.get('session')); tampered.session.playback.public_key = tampered.session.public_key;
    journal.put('session', tampered); assert.throws(() => reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now }), /mismatch/);
  } finally { journal?.close(); f.cleanup(); }
});

test('a new playback key cannot be fabricated after the original payment', () => {
  const f = fixture(); let journal;
  try {
    journal = open(f); settledVideo(journal, f);
    assert.throws(() => reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now }), /before any original order/);
    assert.equal(journal.get('session').session.playback, undefined);
  } finally { journal?.close(); f.cleanup(); }
});

test('proof is bound to the exact access contract, caller, vault, Play scope, job, origin and device', () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f); const prepared = prepareYoutickPlayGrant(ctx), pk = nearApi.utils.PublicKey.fromString(prepared.args.session_pk);
    const message = ['youtick-session-grant-v1', `contract=${hex(YOUTICK_ACCESS)}`, `caller=${hex(vault)}`, `target_owner=${hex(vault)}`,
      `session_pk=${hex(prepared.args.session_pk)}`, 'scope=play', `resource_id=${hex(ctx.job.job_id)}`, 'ttl_ms=600000',
      `origin_hash=${hex(YOUTICK_PLAY_ORIGIN_HASH)}`, `device_hash=${hex(prepared.args.device_hash)}`].join('\n');
    assert.ok(pk.verify(Buffer.from(message), Buffer.from(prepared.args.session_pok, 'hex')));
    assert.equal(pk.verify(Buffer.from(message.replace('scope=play', 'scope=other')), Buffer.from(prepared.args.session_pok, 'hex')), false);
    assert.equal(prepared.deposit, '1'); assert.equal(prepared.owner_id, owner); assert.equal(prepared.method, 'issue_youtick_play_grant');
    assert.ok(!JSON.stringify(prepared).includes(ctx.journal.get('session').session.playback.private_key));
    assert.throws(() => prepareYoutickPlayGrant({ ...ctx, publication: { ...ctx.publication, playback_id: 'https://evil.example/' } }), /publication/);
    assert.throws(() => prepareYoutickPlayGrant({ ...ctx, publication: { ...ctx.publication, provider_source_fingerprint: '0'.repeat(64) } }), /publication/);
    assert.throws(() => prepareYoutickPlayGrant({ ...ctx, publication: { ...ctx.publication, availability: 'TAKEDOWN' } }), /publication/);
    assert.throws(() => prepareYoutickPlayGrant({ ...ctx, job: { ...ctx.job, status: 'Authorized', published_at_ms: null } }), /publication/);
    const badPayment = structuredClone(ctx.paymentResult); badPayment.transaction.signer_id = 'attacker.testnet';
    assert.throws(() => prepareYoutickPlayGrant({ ...ctx, paymentResult: badPayment }), /mismatch/);
    fs.writeFileSync(f.source, 'tampered source'); assert.throws(() => prepareYoutickPlayGrant(ctx), /differs/);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('playback verification may use an expired upload key without re-enabling upload controls', () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f); const later = now + 3_600_001;
    assert.equal(prepareYoutickPlayGrant({ ...ctx, nowMs: later }).args.job_id, ctx.job.job_id);
    assert.throws(() => prepareYoutickUploadControl({ ...ctx, nowMs: later }), /expired/);
    assert.equal(ctx.journal.get('session').control, undefined);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('FINAL grant evidence requires the exact linked owner-to-vault-to-access receipt and current grant', () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f); const g = grantFixture(ctx);
    assert.equal(verifyYoutickPlayGrantView(g.prepared, g.grant, g.verification, now).job_id, ctx.job.job_id);
    assert.equal(verifyYoutickPlayGrantTransaction({ prepared: g.prepared, result: g.grantResult, txHash: g.grantTxHash,
      ownerPublicKey: g.ownerPublicKey, grant: g.grant }).access_receipt_id, hash(11));
    const weighted = structuredClone(g.grantResult); weighted.receipts[0].receipt.Action.actions[0].FunctionCall.gas = '80000000000000';
    assert.equal(verifyYoutickPlayGrantTransaction({ prepared: g.prepared, result: weighted, txHash: g.grantTxHash,
      ownerPublicKey: g.ownerPublicKey, grant: g.grant }).access_receipt_id, hash(11));
    const variations = [
      r => { r.final_execution_status = 'EXECUTED'; },
      r => { r.transaction.signer_id = 'attacker.testnet'; },
      r => { r.transaction.actions[0].FunctionCall.deposit = '0'; },
      r => { r.transaction.actions[0].FunctionCall.args = enc({ ...g.prepared.args, job_id: 'other' }); },
      r => { r.receipts[0].receiver_id = 'attacker.testnet'; },
      r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '1'; },
      r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.gas = '110000000000000'; },
      r => { const a = r.receipts[0].receipt.Action.actions[0].FunctionCall; a.args = enc(JSON.parse(Buffer.from(a.args, 'base64')).request); },
      r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
      r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
      r => { r.status.SuccessValue = enc({ ...g.grant, resource_id: 'other' }); },
    ];
    for (const mutate of variations) {
      const result = structuredClone(g.grantResult); mutate(result);
      assert.throws(() => verifyYoutickPlayGrantTransaction({ prepared: g.prepared, result, txHash: g.grantTxHash,
        ownerPublicKey: g.ownerPublicKey, grant: g.grant }));
    }
    for (const grant of [{ ...g.grant, revoked: true }, { ...g.grant, device_hash: 'a'.repeat(64) },
      { ...g.grant, expires_at_ms: now }, { ...g.grant, expires_at_ms: now + YOUTICK_PLAY_TTL_MS + 5001 }]) {
      assert.throws(() => verifyYoutickPlayGrantView(g.prepared, grant, g.verification, now), /missing, expired/);
    }
    assert.throws(() => verifyYoutickPlayGrantView(g.prepared, g.grant, { ...g.verification, valid: false }, now), /missing, expired/);
  } finally { ctx?.journal.close(); f.cleanup(); }
});

test('legacy token envelope uses a fresh nonce and correct signature only after payment, publication and linked grant checks', () => {
  const f = fixture(); let ctx;
  try {
    ctx = setup(f); const g = grantFixture(ctx);
    const args = { ...ctx, ...g }, first = prepareYoutickPlaybackTokenRequest(args), second = prepareYoutickPlaybackTokenRequest(args);
    assert.notEqual(first.envelope.device_nonce, second.envelope.device_nonce);
    assert.equal(first.envelope.route, '/v1/playback-tokens'); assert.equal(first.envelope.account_id, vault);
    assert.equal(first.envelope.resource, `playback:${ctx.job.job_id}:1:${ctx.publication.playback_id}`);
    const canonical = JSON.stringify(Object.fromEntries(Object.keys(first.body).sort().map(key => [key, first.body[key]])));
    assert.equal(first.envelope.body_sha256, digest(canonical));
    const pk = nearApi.utils.PublicKey.fromString(first.envelope.session_public_key);
    assert.ok(pk.verify(Buffer.from(Object.values(first.envelope).join('\n')), Buffer.from(first.signature, 'base64')));
    assert.ok(Number(first.envelope.expires_at_ms) <= g.grant.expires_at_ms);
    assert.throws(() => prepareYoutickPlaybackTokenRequest({ ...args, grantResult: undefined }), /grant transaction/);
    assert.throws(() => prepareYoutickPlaybackTokenRequest({ ...args, verification: { ...g.verification, valid: false } }), /missing, expired/);
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(first.signature));
  } finally { ctx?.journal.close(); f.cleanup(); }
});
