import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { YOUTICK_PLAY_TTL_MS } from '../agent/youtick-playback.mjs';
import { runYoutickPlayGrant, recoverYoutickPlayGrant } from '../agent/youtick-grant-runner.mjs';
import { open, vault, owner, now } from './helpers/youtick-fixture.mjs';
import { setup, hash } from './helpers/youtick-grant-fixture.mjs';

test('read-only owner review requires a paid published original, code pins and empty scoped key', async () => {
  const s = setup();
  try {
    const before = s.journal.list().length, result = await runYoutickPlayGrant(s.opts);
    assert.equal(result.status, 'READY_FOR_OWNER_APPROVAL'); assert.equal(result.prepared.deposit, '1');
    assert.equal(result.prepared.vault, vault); assert.equal(result.payment_tx_hash, s.video.paymentResult.transaction.hash);
    assert.equal(s.journal.list().length, before); assert.equal(s.settings.sent, 0);
    assert.equal(JSON.stringify(result).includes(s.journal.get('session').session.playback.private_key), false);
  } finally { s.close(); }
});

test('one owner grant is journaled encrypted before broadcast and recovered without a signing key or source file', async () => {
  const s = setup();
  try {
    s.settings.atSend = signed => {
      const pending = s.journal.get('grant');
      assert.equal(pending.status, 'pending'); assert.equal(pending.kind, 'youtick-owner-grant-v1');
      assert.equal(pending.tx_hash, nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest()));
      const ciphertext = fs.readFileSync(s.f.file, 'utf8');
      assert.equal(ciphertext.includes(pending.tx_hash), false);
      assert.equal(ciphertext.includes(s.ownerKey.toString()), false);
      assert.equal(ciphertext.includes(s.journal.get('session').session.playback.private_key), false);
      assert.equal(JSON.stringify(pending).includes(signed.signature.data.toString()), false);
    };
    const granted = await runYoutickPlayGrant({ ...s.opts, execute: true });
    assert.equal(granted.status, 'GRANTED'); assert.equal(granted.access_receipt_id, hash(26)); assert.equal(s.settings.sent, 1);
    assert.equal(s.journal.get('grant').status, 'completed'); assert.match(granted.scope, /no token request/);
    const again = await runYoutickPlayGrant({ ...s.opts, execute: true });
    assert.equal(again.tx_hash, granted.tx_hash); assert.equal(s.settings.sent, 1);
    s.journal.close(); fs.unlinkSync(s.f.source);
    const reopened = open(s.f, true);
    try {
      const recovered = await recoverYoutickPlayGrant({ journal: reopened, grantId: 'grant', provider: s.provider, clock: () => now });
      assert.equal(recovered.status, 'GRANTED'); assert.equal(recovered.tx_hash, granted.tx_hash); assert.equal(s.settings.sent, 1);
    } finally { reopened.close(); }
  } finally { s.close(); }
});

test('lost response after one broadcast survives restart and recovers by the original hash', async () => {
  const s = setup();
  try {
    s.settings.failAfterApply = true;
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /unresolved hash .*recover it without resending/);
    const pending = s.journal.get('grant'); assert.equal(pending.status, 'pending'); assert.equal(s.settings.sent, 1);
    assert.equal(pending.tx_hash, s.settings.grantResult.transaction.hash);
    s.journal.close(); fs.unlinkSync(s.f.source);
    const reopened = open(s.f, true);
    try {
      const recovered = await recoverYoutickPlayGrant({ journal: reopened, grantId: 'grant', provider: s.provider, clock: () => now });
      assert.equal(recovered.status, 'GRANTED'); assert.equal(recovered.tx_hash, pending.tx_hash); assert.equal(reopened.get('grant').status, 'completed');
      const rerun = await runYoutickPlayGrant({ ...s.opts, journal: reopened, account: undefined, publicKey: undefined, execute: true });
      assert.equal(rerun.tx_hash, pending.tx_hash); assert.equal(s.settings.sent, 1);
    } finally { reopened.close(); }
  } finally { s.close(); }
});

test('an unknown hash, failed FINAL lookup or missing current view never triggers a replacement send', async () => {
  const s = setup();
  try {
    s.settings.failBeforeApply = true;
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /unresolved hash/);
    const pendingHash = s.journal.get('grant').tx_hash;
    await assert.rejects(recoverYoutickPlayGrant({ journal: s.journal, grantId: 'grant', provider: s.provider, clock: () => now }), /unknown or unavailable/);
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /unknown or unavailable/);
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, grantId: 'replacement', execute: true }), /already has an owner grant attempt/);
    assert.equal(s.journal.get('grant').tx_hash, pendingHash); assert.equal(s.journal.get('grant').status, 'pending'); assert.equal(s.settings.sent, 1);
  } finally { s.close(); }
});

test('the grant runner prefers an available bounded one-shot sender over the generic transport', async () => {
  const s = setup();
  try {
    const underlying = s.provider.sendTransactionUntil.bind(s.provider); let bounded = 0;
    s.provider.sendTransactionOnce = async (...args) => { bounded++; return underlying(...args); };
    s.provider.sendTransactionUntil = async () => { throw new Error('generic sender should not be used'); };
    const granted = await runYoutickPlayGrant({ ...s.opts, execute: true });
    assert.equal(granted.status, 'GRANTED'); assert.equal(bounded, 1); assert.equal(s.settings.sent, 1);
  } finally { s.close(); }
});

test('a successful send with temporarily unavailable FINAL evidence stays pending and is later reconciled', async () => {
  const s = setup();
  try {
    s.settings.grantNotVisible = true;
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /FINAL proof or current views are unavailable; recover without resending/);
    const original = s.journal.get('grant'); assert.equal(original.status, 'pending'); assert.equal(s.settings.sent, 1);
    s.settings.grantNotVisible = false;
    const recovered = await recoverYoutickPlayGrant({ journal: s.journal, grantId: 'grant', provider: s.provider, clock: () => now });
    assert.equal(recovered.tx_hash, original.tx_hash); assert.equal(recovered.status, 'GRANTED'); assert.equal(s.settings.sent, 1);
  } finally { s.close(); }
});

test('simultaneous callers cannot sign or broadcast while the first journal operation is in flight', async () => {
  const s = setup();
  try {
    let release, entered; const inSend = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    s.settings.atSend = async () => { entered(); await blocked; };
    const first = runYoutickPlayGrant({ ...s.opts, execute: true }); await inSend;
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /already running/);
    await assert.rejects(recoverYoutickPlayGrant({ journal: s.journal, grantId: 'grant', provider: s.provider, clock: () => now }), /already running/);
    release(); assert.equal((await first).status, 'GRANTED'); assert.equal(s.settings.sent, 1);
  } finally { s.close(); }
});

test('an expired verified grant is not reported active or silently replaced', async () => {
  const s = setup();
  try {
    const first = await runYoutickPlayGrant({ ...s.opts, execute: true });
    const expired = await recoverYoutickPlayGrant({ journal: s.journal, grantId: 'grant', provider: s.provider, clock: () => now + YOUTICK_PLAY_TTL_MS + 1 });
    assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.tx_hash, first.tx_hash); assert.equal(s.settings.sent, 1);
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, grantId: 'new-grant', execute: true }), /already has an owner grant attempt/);
  } finally { s.close(); }
});

test('malicious or stale FINAL inputs fail before a grant is signed or sent', async t => {
  const cases = [
    ['wrong chain', s => { s.settings.chain = 'mainnet'; }, /testnet chain/],
    ['changed vault code', s => { s.settings.vaultHash = hash(31); }, /vault code/],
    ['changed access code', s => { s.settings.accessHash = hash(31); }, /access or market code/],
    ['changed market code', s => { s.settings.marketHash = hash(31); }, /access or market code/],
    ['different FINAL block', s => { s.settings.wrongBlock = true; }, /access or market code/],
    ['changed vault owner', s => { s.settings.vaultOwner = 'other.testnet'; }, /vault version or owner/],
    ['old vault version', s => { s.settings.version = 'bouncer-agent-v9'; }, /vault version or owner/],
    ['paused access', s => { s.settings.state.paused = true; }, /access state or Play policy/],
    ['access points at another market', s => { s.settings.state.market_contract_id = 'else.testnet'; }, /access state or Play policy/],
    ['short TTL policy', s => { s.settings.policy.max_ttl_ms = 100; }, /access state or Play policy/],
    ['unbound policy', s => { s.settings.policy.require_device = false; }, /access state or Play policy/],
    ['missing entitlement', s => { s.settings.entitlement = false; }, /entitlement/],
    ['existing grant', s => { s.settings.grant = { owner_id: vault }; }, /already granted/],
    ['paused Play scope', s => { s.settings.verification = { valid: false, owner_id: null, reason: 'Scope is paused' }; }, /Play scope is paused/],
    ['unpublished job', s => { s.settings.job = { ...s.video.job, status: 'Authorized', published_at_ms: null }; }, /publication/],
    ['wrong publication', s => { s.settings.publication = { ...s.publication, creator_id: 'other.testnet' }; }, /publication/],
    ['unfinalized payment', s => { s.settings.paymentResult = { ...s.video.paymentResult, final_execution_status: 'EXECUTED' }; }, /FINAL/],
    ['source changed', s => { fs.appendFileSync(s.f.source, 'x'); }, /source/],
    ['restricted owner key', s => { s.settings.permission = { FunctionCall: {} }; }, /full-access/],
    ['unexpected signer transaction', s => { s.opts.account.createTransaction = async (receiver, actions, key) =>
      nearApi.transactions.createTransaction(owner, key, 'other.testnet', 1n, actions, Buffer.alloc(32, 24)); }, /reviewed call/],
  ];
  for (const [name, mutate, error] of cases) await t.test(name, async () => {
    const s = setup();
    try { mutate(s); await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), error);
      assert.equal(s.settings.sent, 0); assert.equal(s.journal.get('grant'), undefined);
    } finally { s.close(); }
  });
});

test('recovery refuses changed bindings, payment evidence, code, receipt graph or current views without resending', async t => {
  const cases = [
    ['journal binding', s => { const e = s.journal.get('grant'); s.journal.put('grant', { ...e, binding: { ...e.binding, vault_code_hash: hash(31) } }); }, /journal entry/],
    ['payment hash', s => { const e = s.journal.get('payment'); s.journal.put('payment', { ...e, tx_hash: hash(31) }); }, /payment/],
    ['access code', s => { s.settings.accessHash = hash(31); }, /access or market code/],
    ['unlinked transaction', s => { s.settings.grantResult.transaction_outcome.outcome.status.SuccessReceiptId = hash(31); }, /receipt graph/],
    ['wrong action', s => { s.settings.grantResult.transaction.actions[0].FunctionCall.deposit = '0'; }, /differs from owner review/],
    ['changed current grant', s => { s.settings.grant = { ...s.settings.grant, resource_id: 'other' }; }, /current grant/],
    ['invalid verification', s => { s.settings.verification = { valid: false, owner_id: vault, reason: 'paused' }; }, /live access grant/],
  ];
  for (const [name, mutate, error] of cases) await t.test(name, async () => {
    const s = setup();
    try {
      await runYoutickPlayGrant({ ...s.opts, execute: true }); mutate(s);
      await assert.rejects(recoverYoutickPlayGrant({ journal: s.journal, grantId: 'grant', provider: s.provider, clock: () => now }), error);
      assert.equal(s.settings.sent, 1);
    } finally { s.close(); }
  });
});

test('only the original encrypted exclusive journal is accepted', async () => {
  const s = setup();
  try {
    const plain = new FileJournal(`${s.f.dir}/plain.json`, vault, owner);
    try { await assert.rejects(runYoutickPlayGrant({ ...s.opts, journal: plain, execute: true }), /encrypted exclusive/); }
    finally { plain.close(); }
    s.journal.close();
    await assert.rejects(runYoutickPlayGrant({ ...s.opts, execute: true }), /journal is closed/);
    assert.equal(s.settings.sent, 0);
  } finally { s.close(); }
});
