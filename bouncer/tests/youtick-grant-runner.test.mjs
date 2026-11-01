import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { reserveYoutickUploadSession } from '../agent/youtick-session.mjs';
import { reserveYoutickPlaybackSession, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS } from '../agent/youtick-playback.mjs';
import { runYoutickPlayGrant, recoverYoutickPlayGrant, YOUTICK_ACCESS_CODE_HASH } from '../agent/youtick-grant-runner.mjs';
import { YOUTICK_MARKET, YOUTICK_ACCESS } from '../agent/youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from '../agent/youtick-quote.mjs';
import { fixture, input, open, settledVideo, vault, owner, now } from './helpers/youtick-fixture.mjs';

const hash = byte => nearApi.utils.serialize.base_encode(Buffer.alloc(32, byte));
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const blockHash = hash(21), vaultHash = hash(22);

function setup() {
  const f = fixture(), journal = open(f);
  reserveYoutickUploadSession({ journal, id: 'session', input: input(f), nowMs: now });
  const playback = reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now });
  const video = settledVideo(journal, f); video.job.status = 'Published'; video.job.published_at_ms = now - 100;
  const publication = { publication_id: video.job.job_id, creator_id: vault, title: video.job.title, price_usdc: video.job.price_usdc,
    generation: 1, expected_source_bytes: video.job.expected_source_bytes, verified_source_bytes: video.job.expected_source_bytes,
    profile_id: video.job.profile_id, profile_config_sha256: video.job.profile_config_sha256,
    asset_id_hash: 'b'.repeat(64), project_id_hash: 'c'.repeat(64), playback_id: 'synthetic-playback', availability: 'ACTIVE',
    published_availability: 'ACTIVE', published_at_ms: video.job.published_at_ms, ready_at_ms: String(now - 200), provider_source_fingerprint: null };
  const ownerKey = nearApi.KeyPair.fromRandom('ed25519');
  const account = { accountId: owner, signer: new nearApi.KeyPairSigner(ownerKey),
    createTransaction: async (receiver, actions, publicKey) => nearApi.transactions.createTransaction(owner, publicKey, receiver, 1n, actions, Buffer.alloc(32, 24)) };
  const settings = { chain: 'testnet', vaultHash, accessHash: YOUTICK_ACCESS_CODE_HASH, marketHash: YOUTICK_V1_CODE_HASH,
    vaultOwner: owner, version: 'bouncer-agent-v10-youtick-testnet', state: { market_contract_id: YOUTICK_MARKET, paused: false, grant_issuance_enabled: true },
    policy: { max_ttl_ms: 600_000, require_origin: true, require_device: true }, entitlement: true, permission: 'FullAccess',
    job: video.job, publication, paymentResult: video.paymentResult, grant: null, grantResult: null, sent: 0, atSend: () => {} };
  const provider = {
    async viewNodeStatus() { return { chain_id: settings.chain }; },
    async query({ account_id, blockId }) {
      const result = { block_hash: settings.wrongBlock && account_id === YOUTICK_ACCESS ? hash(30) : blockId ?? blockHash };
      if (account_id === vault) result.code_hash = settings.vaultHash;
      else if (account_id === YOUTICK_ACCESS) result.code_hash = settings.accessHash;
      else if (account_id === YOUTICK_MARKET) result.code_hash = settings.marketHash;
      else throw new Error('unexpected view_account');
      return result;
    },
    async callFunction(target, method, args, block) {
      assert.equal(block.blockId, blockHash);
      if (target === vault && method === 'contract_version') return settings.version;
      if (target === vault && method === 'get_owner') return settings.vaultOwner;
      if (target === YOUTICK_ACCESS && method === 'get_contract_state') return settings.state;
      if (target === YOUTICK_ACCESS && method === 'get_scope_policy') return settings.policy;
      if (target === YOUTICK_MARKET && method === 'get_media_job') { assert.equal(args.job_id, video.job.job_id); return settings.job; }
      if (target === YOUTICK_MARKET && method === 'get_publication') { assert.equal(args.publication_id, video.job.job_id); return settings.publication; }
      if (target === YOUTICK_MARKET && method === 'has_entitlement') { assert.deepEqual(args, { account_id: vault, publication_id: video.job.job_id }); return settings.entitlement; }
      if (target === YOUTICK_ACCESS && method === 'get_session_grant') return settings.grant;
      if (target === YOUTICK_ACCESS && method === 'verify_session_grant') {
        assert.deepEqual(args, { session_pk: playback.session_pk, scope: 'Play', resource_id: video.job.job_id,
          origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: playback.device_hash });
        if (settings.verification) return settings.verification;
        return settings.grant ? { valid: true, owner_id: vault, reason: null } : { valid: false, owner_id: null, reason: 'Session grant not found' };
      }
      throw new Error(`unexpected view ${target}.${method}`);
    },
    async viewAccessKey(accountId, publicKey, block) {
      assert.equal(accountId, owner); assert.equal(String(publicKey), String(ownerKey.getPublicKey())); assert.equal(block.blockId, blockHash);
      return { permission: settings.permission };
    },
    async txStatusReceipts(txHash, accountId, finality) {
      assert.equal(accountId, owner); assert.equal(finality, 'FINAL');
      if (txHash === video.paymentResult.transaction.hash) return settings.paymentResult;
      if (txHash === settings.grantResult?.transaction.hash && !settings.grantNotVisible) return settings.grantResult;
      throw new Error('unknown or unavailable transaction');
    },
    async sendTransactionUntil(signed, wait) {
      settings.sent++; assert.equal(wait, 'FINAL'); await settings.atSend(signed);
      if (settings.failBeforeApply) throw new Error('ambiguous transport failure');
      const transaction = signed.transaction, fc = transaction.actions[0].functionCall;
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(transaction)).digest());
      const args = JSON.parse(Buffer.from(fc.args).toString('utf8'));
      const grant = { owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
        expires_at_ms: now + YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, revoked: false };
      const accessArgs = { target_owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
        ttl_ms: YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, session_pok: args.session_pok };
      const initId = hash(25), accessId = hash(26);
      settings.grant = grant;
      settings.grantResult = { final_execution_status: 'FINAL', status: { SuccessValue: enc(grant) },
        transaction_outcome: { id: txHash, outcome: { status: { SuccessReceiptId: initId }, receipt_ids: [initId] } },
        transaction: { hash: txHash, signer_id: owner, receiver_id: vault, public_key: String(transaction.publicKey),
          actions: [{ FunctionCall: { method_name: fc.methodName, deposit: String(fc.deposit), gas: String(fc.gas), args: enc(args) } }] },
        receipts: [{ receipt_id: accessId, predecessor_id: vault, receiver_id: YOUTICK_ACCESS,
          receipt: { Action: { actions: [{ FunctionCall: { method_name: 'issue_session_grant', deposit: '0', gas: '70000000000000', args: enc({ request: accessArgs }) } }] } } }],
        receipts_outcome: [{ id: initId, outcome: { executor_id: vault, status: { SuccessReceiptId: accessId }, receipt_ids: [accessId] } },
          { id: accessId, outcome: { executor_id: YOUTICK_ACCESS, status: { SuccessValue: enc(grant) }, receipt_ids: [] } }] };
      if (settings.failAfterApply) throw new Error('response lost after send');
      return settings.grantResult;
    },
  };
  const opts = { journal, grantId: 'grant', sessionId: 'session', goal: video.goal, sourceFile: f.source,
    vaultCodeHash: vaultHash, provider, account, publicKey: ownerKey.getPublicKey(), clock: () => now };
  return { f, journal, video, publication, ownerKey, provider, settings, opts, close() { journal.close(); f.cleanup(); } };
}

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
