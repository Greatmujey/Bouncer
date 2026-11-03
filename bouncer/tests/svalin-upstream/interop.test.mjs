// OPTIONAL: run only through scripts/test-svalin-upstream.mjs, which checks the
// pinned external tree first. The Svalin app, reservation store, risk engine
// and NEAR payment reader here are real upstream code; EVERYTHING representing
// a chain, indexer, facilitator, portfolio or elapsed time is simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../../agent/procurement.mjs';
import { prepareSvalinProSession, reserveSvalinProOnce, recoverSvalinProReservationOnce,
  prepareSvalinProExactFt } from '../../agent/svalin-pro-session.mjs';
import { paySvalinProExactFtOnce, recoverSvalinProPayment, activateSvalinProOnce,
  inspectSvalinProActivation, requestSvalinProRiskOnce } from '../../agent/svalin-pro-runner.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../../agent/svalin-pro-readiness.mjs';
import { mockGuardedPayment, mockHash } from '../mock-guarded-payment.mjs';

const source = process.env.BOUNCER_SVALIN_SOURCE;
if (!source) throw new Error('run through npm run test:svalin-upstream');
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const { createApp } = await load('apps/api/src/app.ts');
const { loadConfig } = await load('apps/api/src/env.ts');
const { fakeFacilitator } = await load('apps/api/test/helpers.ts');
const { KeyStoreCore, MemoryStorage, keyId } = await load('apps/api/src/lib/key-store.ts');
const { nearPaymentsReceived, nearUsdcReceived } = await load('apps/api/src/payments/pro-payments.ts');

// The app and reader must use the explicitly injected in-memory transport.
// Any accidental use of the global HTTP fetch aborts, rather than contacting a
// real seller, chain, indexer or facilitator.
globalThis.fetch = async () => { throw new Error('network forbidden in source interoperability test'); };

const goal = { version: 1, id: 'risk', vault: 'vault.testnet', owner: 'owner.testnet',
  vault_code_hash: mockHash('source-interop-v11'), policy_id: 'api',
  accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const config = loadConfig({ NODE_ENV: 'test', PORTFOLIO_SOURCE: 'mock', PAY_TO_NEAR: SVALIN_PAYEE, X402_ENV: 'testnet' });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-svalin-source-'));
  const file = path.join(dir, 'journal.enc'), encryptionKey = crypto.randomBytes(32);
  let journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey });
  let clock = Date.now(), nonce = 0n, prepared, activeView, chain, index = [], down = false;
  let loseReservation = false, loseSend = false, loseActivation = false;
  const counts = { reservation: 0, send: 0, activation: 0, status: 0, risk: 0, indexer: 0, retryTransport: 0 };
  const pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = pair.getPublicKey();
  const signer = new nearApi.KeyPairSigner(pair), now = () => clock;
  const code = () => journal.get(`${goal.id}-svalin-pro`)?.svalin?.code;
  const finalBlock = mockHash('source-final'), txBlock = mockHash('source-tx'), executionBlock = mockHash('source-execution');
  const storage = new MemoryStorage(), keyStore = new KeyStoreCore(storage);

  // Fake FastNEAR JSON. The ACTUAL upstream nearPaymentsReceived fetches this,
  // applies its time window, unread filter and NEP-141/refund parser, and hands
  // those results to the ACTUAL upstream seller's reservation/claim store.
  const indexerFetch = async (url, options) => {
    counts.indexer++; if (down) throw new Error('simulated indexer unavailable');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    if (url === 'https://indexer.invalid/v0/account') {
      assert.equal(body.account_id, SVALIN_PAYEE); assert.equal(body.is_event_log, true); assert.equal(body.is_success, true);
      return Response.json({ account_txs: [...index].reverse().map(({ tx, at }) => ({
        transaction_hash: tx, tx_block_timestamp: (BigInt(at) * 1_000_000n).toString(),
      })) });
    }
    assert.equal(url, 'https://indexer.invalid/v0/transactions');
    assert.ok(Array.isArray(body.tx_hashes));
    return Response.json({ transactions: index.filter(record => body.tx_hashes.includes(record.tx)).map(record => ({
      execution_outcome: { id: record.tx }, receipts: record.receipts,
    })) });
  };
  const finder = {
    solana: async () => { throw new Error('Solana was not configured in this test'); },
    near: async (offer, since, unread) => {
      assert.equal(offer.network, 'near:testnet'); assert.equal(offer.payTo, SVALIN_PAYEE); assert.equal(offer.token, TOKEN);
      return nearPaymentsReceived({ txApiUrl: 'https://indexer.invalid', network: offer.network, payTo: offer.payTo,
        token: offer.token, since, unread, now: now(), fetchImpl: indexerFetch });
    },
  };
  const app = createApp(config, { keyStore, proPayments: finder, facilitator: fakeFacilitator() });
  const account = { accountId: goal.owner, signer, async createTransaction(receiver, actions, pk) {
    return nearApi.transactions.createTransaction(goal.owner, pk, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: finalBlock, timestamp_nanosec: (BigInt(clock) * 1_000_000n).toString() } }; },
    async viewAccount(id, opts) {
      if (id === goal.owner) return { block_hash: opts.blockId, code_hash: '11111111111111111111111111111111' };
      assert.equal(id, goal.vault); return { block_hash: opts.blockId, code_hash: goal.vault_code_hash };
    },
    async viewAccessKeyList(id, opts) { assert.equal(id, goal.vault); return { block_hash: opts.blockId, keys: [] }; },
    async viewAccessKey(id, pk, opts) {
      assert.equal(id, goal.owner); assert.equal(String(pk), String(publicKey));
      return { block_hash: opts.blockId, permission: { FunctionCall: { receiver_id: goal.vault,
        method_names: ['execute_exact_ft'], allowance: '100000000000000000000000' } } };
    },
    async callFunction(_contract, method, args, opts) {
      if (method === 'get_owner') return goal.owner;
      if (method === 'contract_version') return 'bouncer-agent-v11-exact-ft-testnet';
      if (method === 'storage_balance_of') return { total: '1250000000000000000000' };
      if (method === 'is_exact_ft_policy_locked' || method === 'is_exact_ft_payee_locked' || method === 'is_agent_key_allowed') return true;
      if (method === 'get_policy') return { token: TOKEN };
      if (method === 'check') return [true, 'ok'];
      if (method === 'get_exact_ft_intent') {
        assert.equal(args.intent_id, prepared.intent_id);
        return opts.blockId === executionBlock ? { ...activeView, consumed: true, active: false } : structuredClone(activeView);
      }
      throw new Error(`unexpected simulated view ${method}`);
    },
    async callFunctionRaw(contract, method, args, opts) {
      const value = await this.callFunction(contract, method, args, opts);
      return { block_hash: opts.blockId, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async sendTransactionOnce(signed, finality) {
      counts.send++; assert.equal(finality, 'FINAL');
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash);
      assert.equal(fs.readFileSync(file, 'utf8').includes(code()), false);
      const call = signed.transaction.actions[0].functionCall;
      assert.equal(call.methodName, 'execute_exact_ft'); assert.equal(call.deposit, 0n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { intent_id: prepared.intent_id });
      const a = prepared.owner_call.args;
      chain = mockGuardedPayment({ hash, owner: goal.owner, contract: goal.vault, publicKey: String(publicKey),
        args: { policy_id: a.policy_id, payee: a.payee, amount: a.amount, memo: a.memo, expected_token: a.expected_token } });
      chain.transaction_outcome.block_hash = txBlock; chain.receipts_outcome[0].block_hash = executionBlock;
      chain.transaction.actions[0].FunctionCall.method_name = 'execute_exact_ft';
      chain.transaction.actions[0].FunctionCall.args = enc({ intent_id: prepared.intent_id });
      chain.receipts_outcome[0].outcome.logs = ['BOUNCER exact FT intent consumed; transfer initiated'];
      chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: goal.vault, new_owner_id: SVALIN_PAYEE, amount: a.amount, memo: a.memo }] })];
      chain.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
      const callback = chain.receipts[1].receipt.Action.actions[0].FunctionCall;
      callback.method_name = 'after_exact_ft_transfer';
      callback.args = enc({ intent_id: prepared.intent_id, policy_id: a.policy_id, token: TOKEN, amount: a.amount, bucket: 24, policy_revision: 1 });
      // +1s makes this synthetic transaction unambiguously later than the
      // reservation even when source and fake indexer timestamp precision differ.
      index.push({ tx: hash, at: Date.now() + 1000, receipts: [{ receipt: { receiver_id: TOKEN }, execution_outcome: chain.receipts_outcome[1] }] });
      if (loseSend) throw new Error('simulated lost send response');
      return { transaction_outcome: { id: hash } };
    },
    async sendTransactionUntil() { counts.retryTransport++; throw new Error('retrying transport is forbidden'); },
    async txStatusReceipts(hash, owner, finality) {
      assert.equal(owner, goal.owner); assert.equal(finality, 'FINAL'); assert.equal(chain?.transaction_outcome.id, hash);
      return structuredClone(chain);
    },
  };
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.cache, 'no-store'); assert.ok(opts.signal instanceof AbortSignal);
    assert.ok(url.startsWith(`${SVALIN_ORIGIN}/`));
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/pro' && opts.method === 'GET') return app.request(pathname, opts);
    if (pathname === '/v1/pro/near' && opts.method === 'POST') {
      counts.reservation++; const body = JSON.parse(opts.body);
      assert.equal(body.code === code(), true); assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'reservation_requested');
      assert.equal(fs.readFileSync(file, 'utf8').includes(body.code), false);
      const answer = await app.request(pathname, opts);
      if (loseReservation) throw new Error('simulated lost reservation response');
      return answer;
    }
    if (pathname === '/v1/pro/activate' && opts.method === 'POST') {
      counts.activation++; const body = JSON.parse(opts.body);
      assert.equal(body.code === code(), true);
      const s = journal.get(`${goal.id}-svalin-pro`).svalin;
      assert.ok(s.phase === 'recovery_requested' || s.activation?.phase === 'requested');
      const answer = await app.request(pathname, opts);
      if (loseActivation) throw new Error('simulated lost activation response');
      return answer;
    }
    if (pathname === '/v1/keys/me' && opts.method === 'GET') {
      counts.status++; assert.equal(opts.headers.authorization === `Bearer ${code()}`, true);
      return app.request(pathname, opts);
    }
    if (pathname === '/v1/risk/root.near' && opts.method === 'GET') {
      counts.risk++; assert.equal(opts.headers.authorization === `Bearer ${code()}`, true);
      assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.risk.phase, 'requested');
      return app.request(pathname, opts);
    }
    throw new Error('unexpected simulated seller request');
  };
  const options = () => ({ goal, journal, provider, account, publicKey, fetchImpl, now, execute: true, acknowledgeBackup: true });
  async function reserveAndPin() {
    await prepareSvalinProSession({ goal, journal, now });
    await reserveSvalinProOnce(options());
    prepared = await prepareSvalinProExactFt({ goal, journal, agentPublicKey: String(publicKey), now });
    const a = prepared.owner_call.args;
    activeView = { intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token, payee: a.payee, amount: a.amount,
      memo: a.memo, review_hash: a.review_hash, expires_at_ms: a.expires_at_ms, agent_public_key: a.agent_public_key,
      policy_revision: 1, payee_revision: 2, agent_revision: 3, consumed: false, cancelled: false, active: true };
  }
  return { file, counts, options, provider, now, code, reserveAndPin,
    get journal() { return journal; }, get prepared() { return prepared; },
    advance(ms) { clock = Math.max(clock, Date.now()) + ms; }, loseReservation() { loseReservation = true; }, loseSend() { loseSend = true; },
    loseActivation() { loseActivation = true; }, indexerDown() { down = true; },
    reopen() { journal.close(); journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey, requireExisting: true }); },
    async creditedHashes() {
      const entry = await storage.get(`pass:${await keyId(code())}`);
      return entry?.payments.map(payment => payment.tx) ?? [];
    },
    async reserveAndIndexOtherSession() {
      const otherCode = `svp_${nearApi.utils.serialize.base_encode(Buffer.alloc(32, 9))}`;
      const response = await app.request('/v1/pro/near', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: otherCode, plan: 'month' }) });
      assert.equal(response.status, 200); const checkout = await response.json(), tx = mockHash('other-session-payment');
      const log = 'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [
        { old_owner_id: 'other-payer.testnet', new_owner_id: SVALIN_PAYEE, amount: checkout.amount.replace('.', '') },
      ] });
      index.push({ tx, at: Date.now() + 1000, receipts: [{ receipt: { receiver_id: TOKEN },
        execution_outcome: { outcome: { status: { SuccessValue: '' }, logs: [log] } } }] });
      return { tx, async creditedHashes() {
        const entry = await storage.get(`pass:${await keyId(otherCode)}`);
        return entry?.payments.map(payment => payment.tx) ?? [];
      } };
    },
    replaceIndexWithAnotherPayer() {
      const a = prepared.owner_call.args, tx = mockHash('other-payer-only');
      const log = 'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', event: 'ft_transfer', data: [
        { old_owner_id: 'other-payer.testnet', new_owner_id: SVALIN_PAYEE, amount: a.amount },
      ] });
      index = [{ tx, at: index[0].at, receipts: [{ receipt: { receiver_id: TOKEN },
        execution_outcome: { outcome: { status: { SuccessValue: '' }, logs: [log] } } }] }];
      return tx;
    },
    async readIndexAt(ms) {
      return nearPaymentsReceived({ txApiUrl: 'https://indexer.invalid', network: 'near:testnet', payTo: SVALIN_PAYEE,
        token: TOKEN, since: 0, now: index[0].at + ms, fetchImpl: indexerFetch });
    },
    close() { journal.close(); encryptionKey.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const pay = f => paySvalinProExactFtOnce(f.options());
const recover = f => recoverSvalinProPayment({ goal, journal: f.journal, provider: f.provider, now: f.now });
const activate = f => activateSvalinProOnce({ ...f.options(), acknowledgeMutation: true });
const inspect = f => inspectSvalinProActivation({ ...f.options(), acknowledgeDisclosure: true });
const risk = f => requestSvalinProRiskOnce({ ...f.options(), target: 'root.near', acknowledgeDisclosure: true, acknowledgeUsage: true });

test('real seller source accepts a simulated nested payment, recovers a lost send, and labels sample data', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const bearer = f.code(); f.loseSend();
    await assert.rejects(pay(f), /unresolved.*never automatically resend/);
    const hash = f.journal.get(goal.id).tx_hash;
    assert.deepEqual(await f.readIndexAt(14_000), []); // upstream's 15s settle delay
    assert.equal((await f.readIndexAt(16_000))[0].tx, hash);
    f.reopen(); const recovered = await recover(f);
    assert.equal(recovered.settlement.tx_hash, hash); assert.equal(recovered.sends, 0); assert.equal(recovered.seller_requests, 0);
    f.advance(31_000); const active = await activate(f);
    assert.equal(active.status, 'SELLER_REPORTED_ACTIVE'); assert.equal(active.seller_attribution_verified, false);
    assert.deepEqual(await f.creditedHashes(), [hash]);
    const report = await risk(f);
    assert.equal(report.status, 'SELLER_REPORT_RECEIVED'); assert.equal(report.report.account, 'root.near');
    assert.equal(report.report.seller_reported_data_source, 'mock'); assert.equal(report.report.sample_data, true);
    assert.match(report.report.scope, /sample data, not live holdings/);
    assert.equal(report.seller_attribution_verified, false);
    for (const value of [recovered, active, report]) assert.equal(JSON.stringify(value).includes(bearer), false);
    f.reopen(); assert.equal((await risk(f)).paid_requests, 0); assert.equal((await activate(f)).activation_posts, 0);
    await assert.rejects(pay(f), /already recorded/);
    assert.equal(f.counts.reservation, 1); assert.equal(f.counts.send, 1); assert.equal(f.counts.retryTransport, 0);
    assert.equal(f.counts.activation, 1); assert.equal(f.counts.risk, 1); assert.ok(f.counts.indexer >= 2);
    assert.equal(fs.readFileSync(f.file, 'utf8').includes(bearer), false);
  } finally { f.close(); }
});

test('real seller source can credit a DIFFERENT sender and transaction for the same exact amount', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const paid = await pay(f), original = paid.settlement.tx_hash;
    const other = f.replaceIndexWithAnotherPayer(); assert.notEqual(other, original);
    f.advance(31_000); const active = await activate(f);
    assert.equal(active.status, 'SELLER_REPORTED_ACTIVE'); assert.equal(active.seller_attribution_verified, false);
    assert.deepEqual(await f.creditedHashes(), [other]);
    assert.equal(active.settlement.tx_hash, original); assert.match(active.scope, /attribution.*unproven/);
    assert.equal(f.counts.send, 1); assert.equal(f.counts.activation, 1); assert.equal(f.counts.risk, 0);
  } finally { f.close(); }
});

test('a lost reservation response is recovered from the actual seller store without another reservation', async () => {
  const f = fixture(); try {
    await prepareSvalinProSession({ goal, journal: f.journal, now: f.now }); f.loseReservation();
    await assert.rejects(reserveSvalinProOnce(f.options()), /unresolved/); f.reopen();
    await assert.rejects(reserveSvalinProOnce(f.options()), /do not send another reservation/);
    const result = await recoverSvalinProReservationOnce({ ...f.options(), acknowledgeMutation: true });
    assert.equal(result.phase, 'reserved'); assert.equal(result.reservation.authorization, 'NOT_APPROVED');
    assert.equal(f.counts.reservation, 1); assert.equal(f.counts.activation, 1); assert.equal(f.counts.send, 0);
  } finally { f.close(); }
});

test('reservation recovery really can mutate another seller reservation, so it requires approval', async () => {
  const f = fixture(); try {
    await prepareSvalinProSession({ goal, journal: f.journal, now: f.now }); f.loseReservation();
    await assert.rejects(reserveSvalinProOnce(f.options()), /unresolved/);
    const other = await f.reserveAndIndexOtherSession(); f.advance(31_000);
    await assert.rejects(recoverSvalinProReservationOnce({ ...f.options(), acknowledgeMutation: false }), /mutation acknowledgment/);
    assert.deepEqual(await other.creditedHashes(), []); assert.equal(f.counts.activation, 0);
    const recovered = await recoverSvalinProReservationOnce({ ...f.options(), acknowledgeMutation: true });
    assert.equal(recovered.phase, 'reserved'); assert.deepEqual(await other.creditedHashes(), [other.tx]);
    assert.equal(f.counts.activation, 1); assert.equal(f.counts.send, 0);
  } finally { f.close(); }
});

test('a lost activation response is recovered through the actual status endpoint, not another claim', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000); f.loseActivation();
    await assert.rejects(activate(f), /unresolved/); f.reopen();
    await assert.rejects(activate(f), /do not automatically repeat/);
    const status = await inspect(f);
    assert.equal(status.status, 'SELLER_REPORTED_ACTIVE'); assert.equal(status.activation.seller_reported_found, null);
    assert.equal(status.seller_attribution_verified, false); assert.equal(status.activation_posts, 0); assert.equal(status.status_checks, 1);
    const report = await risk(f); assert.equal(report.report.sample_data, true);
    assert.equal(f.counts.activation, 1); assert.equal(f.counts.status, 1); assert.equal(f.counts.send, 1); assert.equal(f.counts.risk, 1);
  } finally { f.close(); }
});

test('an unavailable indexer leaves actual seller activation unresolved and does not cause a retry', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000); f.indexerDown();
    await assert.rejects(activate(f), /unresolved/); f.reopen();
    await assert.rejects(activate(f), /do not automatically repeat/);
    await assert.rejects(inspect(f), /status check is unresolved/);
    await assert.rejects(risk(f), /activation/);
    assert.deepEqual(await f.creditedHashes(), []);
    assert.equal(f.counts.reservation, 1); assert.equal(f.counts.send, 1); assert.equal(f.counts.activation, 1); assert.equal(f.counts.risk, 0);
  } finally { f.close(); }
});

test('actual seller NEP-141 reader nets refunds and ignores failed token receipts', () => {
  const event = (from, to, amount) => 'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', event: 'ft_transfer',
    data: [{ old_owner_id: from, new_owner_id: to, amount }] });
  const receipt = (log, status) => ({ receipt: { receiver_id: TOKEN }, execution_outcome: { outcome: { logs: [log], status } } });
  assert.equal(nearUsdcReceived([receipt(event(goal.vault, SVALIN_PAYEE, '5004217'), { SuccessValue: '' })], SVALIN_PAYEE, TOKEN), 5004217n);
  assert.equal(nearUsdcReceived([receipt(event(goal.vault, SVALIN_PAYEE, '5004217'), { SuccessValue: '' }),
    receipt(event(SVALIN_PAYEE, goal.vault, '5004217'), { SuccessValue: '' })], SVALIN_PAYEE, TOKEN), 0n);
  assert.equal(nearUsdcReceived([receipt(event(goal.vault, SVALIN_PAYEE, '5004217'), { Failure: {} })], SVALIN_PAYEE, TOKEN), 0n);
});
