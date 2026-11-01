import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { prepareSvalinProSession, reserveSvalinProOnce, recoverSvalinProReservationOnce,
  prepareSvalinProExactFt } from '../agent/svalin-pro-session.mjs';

const nowMs = Date.parse('2026-11-01T19:25:00.000Z'), now = () => nowMs;
const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 7));
const goal = { version: 1, id: 'risk', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: hash,
  policy_id: 'api', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
function offer() {
  return { plans: [{ id: 'month', usd: 5, days: 30 }, { id: 'year', usd: 48, days: 365 }], callsPerDay: 100,
    near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN }, solana: null };
}
function checkout() {
  return { plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: TOKEN,
    amount: '5.004217', expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString() };
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-svalin-')), file = path.join(dir, 'journal.enc');
  const encryptionKey = crypto.randomBytes(32);
  let journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey });
  let gets = 0, posts = 0, recoveries = 0, failPost = false, failRecovery = false, response = checkout(), activation;
  const pubkey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const originalCode = () => journal.get(`${goal.id}-svalin-pro`)?.svalin?.code;
  async function fetchImpl(url, options) {
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'GET') {
      assert.equal(url, `${SVALIN_ORIGIN}/v1/pro`); gets++;
      return new Response(JSON.stringify(offer()));
    }
    const body = JSON.parse(options.body);
    assert.equal(body.code === originalCode(), true, 'only the original encrypted code may be sent');
    assert.equal(fs.readFileSync(file, 'utf8').includes(body.code), false, 'code must be encrypted before POST');
    if (url === `${SVALIN_ORIGIN}/v1/pro/near`) {
      posts++; assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'reservation_requested');
      assert.deepEqual(Object.keys(body).sort(), ['code', 'plan']); assert.equal(body.plan, 'month');
      if (failPost) throw new Error(`synthetic transport failure containing ${body.code}`);
      return new Response(JSON.stringify({ ...response, untrusted_echo: body.code }));
    }
    assert.equal(url, `${SVALIN_ORIGIN}/v1/pro/activate`); recoveries++;
    assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'recovery_requested');
    assert.deepEqual(Object.keys(body), ['code']);
    if (failRecovery) throw new Error(`synthetic activation failure containing ${body.code}`);
    return new Response(JSON.stringify(activation ?? { status: null, found: 0, pending: [checkout()] }));
  }
  const options = () => ({ goal, journal, fetchImpl, now, execute: true, acknowledgeBackup: true });
  return { dir, file, encryptionKey, pubkey, options, originalCode,
    get journal() { return journal; }, get gets() { return gets; }, get posts() { return posts; }, get recoveries() { return recoveries; },
    losePost() { failPost = true; }, loseRecovery() { failRecovery = true; },
    response(value) { response = value; }, activation(value) { activation = value; },
    reopen() { journal.close(); journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey, requireExisting: true }); },
    close() { journal.close(); encryptionKey.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const prepare = f => prepareSvalinProSession({ goal, journal: f.journal, now });
const reserve = f => reserveSvalinProOnce(f.options());
const recover = f => recoverSvalinProReservationOnce(f.options());
const intent = f => prepareSvalinProExactFt({ goal, journal: f.journal, agentPublicKey: f.pubkey, now });

test('random bearer is encrypted before any network request and survives an original-journal reopen', async () => {
  const f = fixture(); try {
    const result = await prepare(f), code = f.originalCode();
    assert.equal(result.phase, 'prepared'); assert.equal(result.bearer_code_returned, false);
    assert.equal(/^svp_[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(code), true);
    assert.equal(nearApi.utils.serialize.base_decode(code.slice(4)).length, 32);
    assert.equal(JSON.stringify(result).includes(code), false); assert.equal(fs.readFileSync(f.file, 'utf8').includes(code), false);
    assert.equal(f.gets + f.posts + f.recoveries, 0);
    f.reopen(); assert.equal(f.originalCode() === code, true);
    assert.equal((await prepare(f)).phase, 'prepared');
    const other = { ...goal, id: 'second' };
    await assert.rejects(prepareSvalinProSession({ goal: other, journal: f.journal, now }), /already exists/);
  } finally { f.close(); }
});

test('session and external POSTs fail closed without encrypted scope and explicit acknowledgments', async () => {
  const f = fixture(); const plainFile = path.join(f.dir, 'plain.json');
  const plain = new FileJournal(plainFile, goal.vault, goal.owner);
  try {
    await assert.rejects(prepareSvalinProSession({ goal, journal: plain, now }), /encrypted file journal/);
    await assert.rejects(prepareSvalinProSession({ goal: { ...goal, owner: 'owner.near' }, journal: f.journal, now }), /testnet goal/);
    await assert.rejects(prepareSvalinProSession({ goal: { ...goal, accept_exact_amount_matching_risk: false }, journal: f.journal, now }), /unacknowledged/);
    await prepare(f);
    await assert.rejects(reserveSvalinProOnce({ ...f.options(), execute: false }), /acknowledgments/);
    await assert.rejects(reserveSvalinProOnce({ ...f.options(), acknowledgeBackup: false }), /acknowledgments/);
    await assert.rejects(recoverSvalinProReservationOnce({ ...f.options(), execute: false }), /acknowledgments/);
    assert.equal(f.gets + f.posts + f.recoveries, 0);
  } finally { plain.close(); f.close(); }
});

test('one reservation POST follows durable write-ahead state and exposes only sanitized terms', async () => {
  const f = fixture(); try {
    await prepare(f); const code = f.originalCode();
    const result = await reserve(f);
    assert.equal(f.gets, 1); assert.equal(f.posts, 1); assert.equal(result.phase, 'reserved');
    assert.equal(result.reservation.amount_atoms, '5004217'); assert.equal(result.reservation.authorization, 'NOT_APPROVED');
    assert.equal(JSON.stringify(result).includes(code), false); assert.equal(fs.readFileSync(f.file, 'utf8').includes(code), false);
    f.journal.get(`${goal.id}-svalin-pro`).svalin.checkout.untrusted_echo = code;
    const repeated = await reserve(f);
    assert.equal(repeated.phase, 'reserved'); assert.equal(JSON.stringify(repeated).includes(code), false);
    assert.equal(repeated.payment_sent_by_this_library, false);
    assert.equal(f.gets, 1); assert.equal(f.posts, 1);
    f.reopen(); assert.equal((await prepare(f)).phase, 'reserved');
  } finally { f.close(); }
});

test('lost reservation response is never reposted; an explicitly approved activation can recover the same code', async () => {
  const f = fixture(); try {
    await prepare(f); const code = f.originalCode(); f.losePost();
    let failure; try { await reserve(f); } catch (error) { failure = error; }
    assert.match(failure.message, /unresolved/); assert.equal(failure.message.includes(code), false); assert.equal(failure.cause, undefined);
    assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'reservation_requested');
    f.reopen(); await assert.rejects(reserve(f), /do not send another reservation/);
    assert.equal(f.posts, 1); assert.equal(f.gets, 1);
    const result = await recover(f);
    assert.equal(result.phase, 'reserved'); assert.equal(result.reservation.amount_atoms, '5004217');
    assert.equal(f.originalCode() === code, true); assert.equal(f.recoveries, 1); assert.equal(f.posts, 1);
    assert.equal(JSON.stringify(result).includes(code), false);
  } finally { f.close(); }
});

test('ambiguous activation, an active pass, and mismatched or absent checkout never trigger automatic retries or payment', async () => {
  const cases = [
    { lost: true },
    { answer: { status: { active: true }, found: 1, pending: [] } },
    { answer: { status: null, found: 0, pending: [] } },
    { answer: { status: null, found: 0, pending: [checkout(), checkout()] } },
    { answer: { status: null, found: 0, pending: [{ ...checkout(), payTo: 'attacker.testnet' }] } },
    { answer: { status: null, found: 0, pending: [{ ...checkout(), amount: '5.010000' }] } },
  ];
  for (const c of cases) {
    const f = fixture(); try {
      await prepare(f); f.losePost(); await assert.rejects(reserve(f), /unresolved/);
      if (c.lost) f.loseRecovery(); else f.activation(c.answer);
      await assert.rejects(recover(f), /unresolved/);
      assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'recovery_requested');
      f.reopen(); await assert.rejects(recover(f), /not eligible/);
      await assert.rejects(reserve(f), /do not send another reservation/);
      await assert.rejects(intent(f), /reservation is missing or invalid/);
      assert.equal(f.posts, 1); assert.equal(f.recoveries, 1);
    } finally { f.close(); }
  }
});

test('malformed seller terms stop before payment and never expose response echoes', async () => {
  const f = fixture(); try {
    await prepare(f); const code = f.originalCode();
    f.response({ ...checkout(), network: 'near:mainnet' });
    let failure; try { await reserve(f); } catch (error) { failure = error; }
    assert.match(failure.message, /unresolved/); assert.equal(failure.message.includes(code), false);
    assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'reservation_requested');
    await assert.rejects(intent(f), /reservation is missing or invalid/);
    assert.equal(f.posts, 1); assert.equal(f.recoveries, 0);
  } finally { f.close(); }
});

test('V11 calldata pins exact amount and a non-secret commitment without approving or sending', async () => {
  const f = fixture(); try {
    await prepare(f); await reserve(f); const code = f.originalCode();
    const prepared = await intent(f), a = prepared.owner_call.args;
    assert.equal(prepared.owner_call.method, 'set_exact_ft_intent'); assert.equal(prepared.owner_call.attached_yocto, '1');
    assert.equal(prepared.agent_call.method, 'execute_exact_ft'); assert.equal(prepared.agent_call.attached_yocto, '0');
    assert.equal(a.expected_token, TOKEN); assert.equal(a.payee, SVALIN_PAYEE); assert.equal(a.amount, '5004217');
    assert.match(a.memo, /^bouncer-svalin:[a-f0-9]{32}$/); assert.match(a.review_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(prepared).includes(code), false); assert.equal(a.memo.includes(code), false);
    assert.equal(prepared.review.code_commitment, crypto.createHash('sha256').update(`bouncer:svalin-pro-code:v1:${code}`).digest('hex'));
    assert.deepEqual(await intent(f), prepared); assert.equal(f.posts, 1); assert.equal(f.recoveries, 0);
    const later = () => nowMs + 24 * 60 * 60 * 1000 - 5 * 60_000;
    await assert.rejects(prepareSvalinProExactFt({ goal, journal: f.journal, agentPublicKey: f.pubkey, now: later }), /expiry/);
    await assert.rejects(prepareSvalinProExactFt({ goal, journal: f.journal, agentPublicKey: 'bad', now }), /public key/);
  } finally { f.close(); }
});

test('a failed write-ahead persistence prevents any reservation POST', async () => {
  const f = fixture(); try {
    await prepare(f); const original = f.journal.put.bind(f.journal);
    f.journal.put = (id, entry) => {
      if (entry.svalin?.phase === 'reservation_requested') throw new Error('synthetic fsync failure');
      return original(id, entry);
    };
    await assert.rejects(reserve(f), /fsync failure/);
    assert.equal(f.gets, 1); assert.equal(f.posts, 0); assert.equal(f.recoveries, 0);
    assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'prepared');
  } finally { f.close(); }
});
