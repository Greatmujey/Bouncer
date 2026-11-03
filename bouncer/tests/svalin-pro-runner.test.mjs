import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { prepareSvalinProSession, reserveSvalinProOnce, prepareSvalinProExactFt } from '../agent/svalin-pro-session.mjs';
import { paySvalinProExactFtOnce, recoverSvalinProPayment, activateSvalinProOnce, inspectSvalinProActivation, requestSvalinProRiskOnce } from '../agent/svalin-pro-runner.mjs';
import { preflightExactFt } from '../agent/exact-ft-runtime.mjs';
import { assertPreparedExactFt } from '../agent/multiagency-exact-ft.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const START = Date.parse('2026-11-01T19:25:00.000Z');
const goal = { version: 1, id: 'risk', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('v11-code'),
  policy_id: 'api', accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-svalin-runner-'));
  const file = path.join(dir, 'journal.enc'), encryptionKey = crypto.randomBytes(32);
  let journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey }), clock = START;
  const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair), publicKey = pair.getPublicKey();
  let nonce = 0n, prepared, activeView, chain, sends = 0, fallback = 0, offers = 0, reservations = 0, activations = 0, statusChecks = 0, paidRequests = 0;
  let lostSend = false, badCode = false, badKey = false, badIntent = false, unregistered = false, denied = false;
  let badOffer = false, badEvent = false, badActivation = false, lostActivation = false, sellerActive = false, badReport = false, lostReport = false, emptyFindings = false;
  const finalBlock = mockHash('final'), txBlock = mockHash('tx'), executionBlock = mockHash('execution');
  const ownerAccount = { code_hash: '11111111111111111111111111111111' };
  const keyPermission = { allowance: '100000000000000000000000' };
  const now = () => clock;
  const code = () => journal.get(`${goal.id}-svalin-pro`)?.svalin?.code;
  const offer = () => ({ plans: [{ id: 'month', usd: badOffer ? 6 : 5, days: 30 }, { id: 'year', usd: 48, days: 365 }],
    callsPerDay: 100, near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN }, solana: null });
  const checkout = () => ({ plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: TOKEN,
    amount: '5.004217', expiresAt: new Date(START + 24 * 60 * 60_000).toISOString() });
  const account = { accountId: goal.owner, signer, async createTransaction(receiver, actions, pk) {
    return nearApi.transactions.createTransaction(goal.owner, pk, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: finalBlock, timestamp_nanosec: (BigInt(clock) * 1_000_000n).toString() } }; },
    async viewAccount(id, opts) {
      if (id === goal.owner) return { block_hash: opts.blockId, ...ownerAccount };
      assert.equal(id, goal.vault); return { block_hash: opts.blockId, code_hash: badCode ? mockHash('wrong') : goal.vault_code_hash };
    },
    async viewAccessKeyList(id, opts) { assert.equal(id, goal.vault); return { block_hash: opts.blockId, keys: [] }; },
    async viewAccessKey(id, pk, opts) { assert.equal(id, goal.owner); assert.equal(String(pk), String(publicKey));
      return { block_hash: opts.blockId, permission: { FunctionCall: { receiver_id: goal.vault,
        method_names: badKey ? ['execute_exact_ft', 'execute'] : ['execute_exact_ft'], ...keyPermission } } }; },
    async callFunction(_contract, method, args, opts) {
      if (method === 'get_owner') return goal.owner;
      if (method === 'contract_version') return 'bouncer-agent-v11-exact-ft-testnet';
      if (method === 'storage_balance_of') return unregistered ? null : { total: '1250000000000000000000' };
      if (method === 'is_exact_ft_policy_locked' || method === 'is_exact_ft_payee_locked' || method === 'is_agent_key_allowed') return true;
      if (method === 'get_policy') return { token: TOKEN };
      if (method === 'check') return denied ? [false, 'BLOCKED: daily cap exceeded'] : [true, 'ok'];
      if (method === 'get_exact_ft_intent') {
        assert.equal(args.intent_id, prepared.intent_id);
        const view = structuredClone(activeView); if (badIntent) view.memo = 'not-the-owner-memo';
        if (opts.blockId === executionBlock) { view.consumed = true; view.active = false; }
        return view;
      }
      throw new Error(`unexpected view ${method}`);
    },
    async callFunctionRaw(contract, method, args, opts) {
      const value = await this.callFunction(contract, method, args, opts);
      return { block_hash: opts.blockId, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async sendTransactionOnce(signed, finality) {
      sends++; assert.equal(finality, 'FINAL');
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, txHash);
      assert.equal(fs.readFileSync(file, 'utf8').includes(code()), false);
      const call = signed.transaction.actions[0].functionCall;
      assert.equal(call.methodName, 'execute_exact_ft'); assert.equal(call.deposit, 0n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { intent_id: prepared.intent_id });
      const a = prepared.owner_call.args;
      chain = mockGuardedPayment({ hash: txHash, owner: goal.owner, contract: goal.vault, publicKey: String(publicKey),
        args: { policy_id: a.policy_id, payee: a.payee, amount: a.amount, memo: a.memo, expected_token: a.expected_token } });
      chain.transaction_outcome.block_hash = txBlock; chain.receipts_outcome[0].block_hash = executionBlock;
      chain.transaction.actions[0].FunctionCall.method_name = 'execute_exact_ft';
      chain.transaction.actions[0].FunctionCall.args = enc({ intent_id: prepared.intent_id });
      chain.receipts_outcome[0].outcome.logs = ['BOUNCER exact FT intent consumed; transfer initiated'];
      chain.receipts_outcome[1].outcome.logs = badEvent ? [] : ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: goal.vault, new_owner_id: SVALIN_PAYEE, amount: a.amount, memo: a.memo }] })];
      chain.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
      const callback = chain.receipts[1].receipt.Action.actions[0].FunctionCall;
      callback.method_name = 'after_exact_ft_transfer';
      callback.args = enc({ intent_id: prepared.intent_id, policy_id: a.policy_id, token: TOKEN, amount: a.amount, bucket: 24, policy_revision: 1 });
      if (lostSend) throw new Error('synthetic transport response was lost');
      return { transaction_outcome: { id: txHash } };
    },
    async sendTransactionUntil() { fallback++; throw new Error('retrying transport must never be used'); },
    async txStatusReceipts(hash, owner, finality) {
      assert.equal(owner, goal.owner); assert.equal(finality, 'FINAL'); assert.equal(chain?.transaction_outcome.id, hash);
      return structuredClone(chain);
    },
  };
  async function fetchImpl(url, opts) {
    assert.equal(opts.redirect, 'error'); assert.equal(opts.cache, 'no-store');
    if (url === `${SVALIN_ORIGIN}/v1/pro` && opts.method === 'GET') { offers++; return new Response(JSON.stringify(offer())); }
    if (url === `${SVALIN_ORIGIN}/v1/pro/near` && opts.method === 'POST') {
      reservations++; const body = JSON.parse(opts.body);
      assert.equal(body.code, code()); assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.phase, 'reservation_requested');
      assert.equal(fs.readFileSync(file, 'utf8').includes(body.code), false);
      return new Response(JSON.stringify({ ...checkout(), echo: body.code }));
    }
    if (url === `${SVALIN_ORIGIN}/v1/pro/activate` && opts.method === 'POST') {
      activations++; const body = JSON.parse(opts.body);
      assert.equal(body.code, code()); assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.activation.phase, 'requested');
      if (!badActivation) sellerActive = true;
      if (lostActivation) throw new Error(`synthetic failure with bearer ${body.code}`);
      const status = { kind: 'pro', plan: 'pro', active: true, until: new Date(clock + 30 * 24 * 60 * 60_000).toISOString(), callsLeft: 100, callsPer: 'day' };
      return new Response(JSON.stringify(badActivation ? { status: null, found: 0, pending: [checkout()] } : { status, found: 1, pending: [], echo: body.code }));
    }
    if (url === `${SVALIN_ORIGIN}/v1/keys/me` && opts.method === 'GET') {
      statusChecks++; assert.equal(opts.headers.authorization, `Bearer ${code()}`);
      if (!sellerActive) return new Response(JSON.stringify({ error: 'unknown key' }), { status: 401 });
      return new Response(JSON.stringify({ kind: 'pro', plan: 'pro', active: true,
        until: new Date(clock + 30 * 24 * 60 * 60_000).toISOString(), callsLeft: 100, callsPer: 'day', echo: code() }));
    }
    if (url === `${SVALIN_ORIGIN}/v1/risk/root.near` && opts.method === 'GET') {
      paidRequests++; assert.equal(opts.headers.authorization, `Bearer ${code()}`);
      assert.equal(journal.get(`${goal.id}-svalin-pro`).svalin.risk.phase, 'requested');
      if (lostReport) throw new Error(`synthetic failure with bearer ${code()}`);
      const report = { wallet: badReport ? 'wrong.near' : 'root.near', chain: 'near', score: 21, grade: 'B', level: 'low',
        dataCoverage: 91, dataSource: 'fastnear', methodologyVersion: '2026-10.8', generatedAt: new Date(clock).toISOString(),
        metrics: { totalValueUsd: 14.75, pricedAssetCount: 2, unpricedAssetCount: 1 },
        findings: emptyFindings ? [] : [{ kind: 'small-portfolio', severity: 'low', action: `untrusted text with echo ${code()}` }], echo: code() };
      return new Response(JSON.stringify(report), { headers: { 'x-calls-left': '99' } });
    }
    throw new Error(`unexpected synthetic seller request ${url}`);
  }
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
  return { file, provider, account, ownerAccount, keyPermission, publicKey, fetchImpl, options, now, code, reserveAndPin,
    get journal() { return journal; }, get prepared() { return prepared; }, get sends() { return sends; }, get fallback() { return fallback; },
    get offers() { return offers; }, get reservations() { return reservations; }, get activations() { return activations; },
    get statusChecks() { return statusChecks; }, get paidRequests() { return paidRequests; },
    advance(ms) { clock += ms; }, loseSend() { lostSend = true; }, changeCode() { badCode = true; }, changeKey() { badKey = true; },
    changeIntent() { badIntent = true; }, unregister() { unregistered = true; }, deny() { denied = true; }, changeOffer() { badOffer = true; },
    changeEvent() { badEvent = true; }, changeActivation() { badActivation = true; }, loseActivation() { lostActivation = true; },
    changeReport() { badReport = true; }, loseReport() { lostReport = true; }, emptyFindings() { emptyFindings = true; },
    reopen() { journal.close(); journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey, requireExisting: true }); },
    close() { journal.close(); encryptionKey.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const pay = f => paySvalinProExactFtOnce(f.options());
const recover = f => recoverSvalinProPayment({ goal, journal: f.journal, provider: f.provider, now: f.now });
const activate = f => activateSvalinProOnce({ ...f.options(), acknowledgeMutation: true });
const inspect = f => inspectSvalinProActivation({ ...f.options(), acknowledgeDisclosure: true });
const risk = f => requestSvalinProRiskOnce({ ...f.options(), target: 'root.near', acknowledgeDisclosure: true, acknowledgeUsage: true });

test('synthetic complete path fences reservation, one exact payment, activation and one paid report without exposing the code', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const bearer = f.code();
    const paid = await pay(f); assert.equal(paid.status, 'PAID_NOT_YET_ACTIVATED');
    assert.equal(paid.settlement.amount, '5004217'); assert.equal(f.sends, 1); assert.equal(f.fallback, 0);
    assert.equal(JSON.stringify(paid).includes(bearer), false);
    await assert.rejects(activate(f), /wait at least 30 seconds/); assert.equal(f.activations, 0);
    f.advance(31_000);
    const active = await activate(f); assert.equal(active.status, 'SELLER_REPORTED_ACTIVE'); assert.equal(f.activations, 1);
    const got = await risk(f); assert.equal(got.status, 'SELLER_REPORT_RECEIVED'); assert.equal(got.report.account, 'root.near');
    assert.equal(got.report.score, 21); assert.deepEqual(got.report.findings, [{ kind: 'small-portfolio', severity: 'low' }]);
    assert.equal(got.report.seller_reported_data_source, 'fastnear'); assert.equal(got.report.sample_data, false);
    assert.equal(got.seller_attribution_verified, false); assert.equal(f.paidRequests, 1);
    for (const output of [active, got]) assert.equal(JSON.stringify(output).includes(bearer), false);
    assert.equal(fs.readFileSync(f.file, 'utf8').includes(bearer), false);
    f.reopen(); assert.equal((await recover(f)).settlement.tx_hash, paid.settlement.tx_hash);
    assert.equal((await activate(f)).activation_posts, 0); assert.equal((await risk(f)).paid_requests, 0);
    await assert.rejects(pay(f), /already recorded/); assert.equal(f.sends, 1); assert.equal(f.activations, 1); assert.equal(f.paidRequests, 1);
  } finally { f.close(); }
});

test('Svalin review and calldata must agree on provider, amount, memo and expiry before any RPC', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); assert.doesNotThrow(() => assertPreparedExactFt(f.prepared));
    const changes = [
      p => { p.owner_call.args.payee = 'attacker.testnet'; },
      p => { p.owner_call.args.amount = '5004218'; },
      p => { p.review.checkout.amount_atoms = '5004218'; },
      p => { p.review.checkout.payee = 'attacker.testnet'; p.owner_call.args.payee = 'attacker.testnet'; },
      p => { p.review.checkout.network = 'near:mainnet'; },
      p => { p.review.checkout.plan = 'year'; },
      p => { p.review.code_commitment = 'not-a-commitment'; },
      p => { p.review.goal.accept_exact_amount_matching_risk = false; },
      p => { p.review.expires_at_ms = '1900000000000'; p.owner_call.args.expires_at_ms = '1900000000000'; },
      p => { p.review.extra = 'unreviewed'; },
      p => { p.review.protocol = 'unknown'; },
    ];
    for (const change of changes) {
      const p = structuredClone(f.prepared); change(p);
      p.review_hash = crypto.createHash('sha256').update(JSON.stringify(p.review)).digest('hex');
      p.intent_id = `sv-${p.review_hash.slice(0, 60)}`;
      p.owner_call.args.review_hash = p.review_hash; p.owner_call.args.intent_id = p.intent_id;
      p.owner_call.args.memo = `bouncer-svalin:${p.review_hash.slice(0, 32)}`; p.agent_call.args.intent_id = p.intent_id;
      assert.throws(() => assertPreparedExactFt(p), /reviewed provider terms/);
      let rpcTouched = false;
      const provider = { async viewNodeStatus() { rpcTouched = true; throw Error('unexpected RPC'); } };
      await assert.rejects(preflightExactFt({ prepared: p, publicKey: f.publicKey, provider }), /reviewed provider terms/);
      assert.equal(rpcTouched, false); assert.equal(f.sends, 0);
    }
    const wrongMemo = structuredClone(f.prepared); wrongMemo.owner_call.args.memo = 'different';
    assert.throws(() => assertPreparedExactFt(wrongMemo), /reviewed provider terms/);
    // A new, consistent code commitment cannot be authenticated without the
    // original encrypted session; shape and hashing do not prove approval.
    const differentCode = structuredClone(f.prepared); differentCode.review.code_commitment = 'a'.repeat(64);
    differentCode.review_hash = crypto.createHash('sha256').update(JSON.stringify(differentCode.review)).digest('hex');
    differentCode.intent_id = `sv-${differentCode.review_hash.slice(0, 60)}`;
    differentCode.owner_call.args.review_hash = differentCode.review_hash;
    differentCode.owner_call.args.intent_id = differentCode.intent_id;
    differentCode.owner_call.args.memo = `bouncer-svalin:${differentCode.review_hash.slice(0, 32)}`;
    differentCode.agent_call.args.intent_id = differentCode.intent_id;
    assert.doesNotThrow(() => assertPreparedExactFt(differentCode));
    assert.notEqual(differentCode.review_hash, f.prepared.review_hash);
  } finally { f.close(); }
});

test('payment requires explicit approvals and fails closed for vault, key, intent, registration, offer and policy changes', async () => {
  for (const alter of [f => f.changeCode(), f => f.changeKey(), f => f.changeIntent(), f => f.unregister(), f => f.changeOffer()]) {
    const f = fixture(); try { await f.reserveAndPin(); alter(f); await assert.rejects(pay(f)); assert.equal(f.sends, 0); }
    finally { f.close(); }
  }
  const f = fixture(); try {
    await f.reserveAndPin(); await assert.rejects(paySvalinProExactFtOnce({ ...f.options(), acknowledgeBackup: false }), /acknowledgments/);
    await assert.rejects(paySvalinProExactFtOnce({ ...f.options(), execute: false }), /acknowledgments/);
    f.deny(); assert.equal((await pay(f)).status, 'BLOCKED'); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('owner contract code or an unavailable pinned owner view blocks the Svalin payment before signing or seller recheck', async () => {
  for (const mutate of [
    f => { f.ownerAccount.code_hash = mockHash('local-owner-contract'); },
    f => { delete f.ownerAccount.code_hash; },
    f => { f.ownerAccount.global_contract_hash = mockHash('global-contract'); },
    f => { f.ownerAccount.global_contract_account_id = 'shared.testnet'; },
    f => { f.ownerAccount.state = 'uninitialized'; },
    f => { f.ownerAccount.block_hash = mockHash('different-block'); },
    f => { const read = f.provider.viewAccount; f.provider.viewAccount = async (...args) => {
      if (args[0] === goal.owner) throw new Error('owner view unavailable'); return read(...args);
    }; },
  ]) {
    const f = fixture();
    try {
      await f.reserveAndPin(); const previousOffers = f.offers; let signed = 0;
      const create = f.account.createTransaction.bind(f.account);
      f.account.createTransaction = async (...args) => { signed++; return create(...args); };
      mutate(f);
      await assert.rejects(pay(f));
      assert.equal(f.offers, previousOffers, 'unsafe owner must stop before another seller request');
      assert.equal(signed, 0); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
    } finally { f.close(); }
  }
});

test('Svalin payment rejects missing, unlimited, invalid or excessive agent gas allowance before signing', async () => {
  for (const allowance of [undefined, null, '0', '01', 1, '1000000000000000000000001', '9'.repeat(40)]) {
    const f = fixture();
    try {
      await f.reserveAndPin(); const previousOffers = f.offers; let signed = 0;
      f.keyPermission.allowance = allowance;
      const create = f.account.createTransaction.bind(f.account);
      f.account.createTransaction = async (...args) => { signed++; return create(...args); };
      await assert.rejects(pay(f), /gas allowance/);
      assert.equal(f.offers, previousOffers); assert.equal(signed, 0); assert.equal(f.sends, 0);
      assert.equal(f.journal.get(goal.id), undefined);
    } finally { f.close(); }
  }
});

test('invalid optional shared preflight requirements fail before RPC without changing other adapters', async () => {
  const f = fixture(); try {
    await f.reserveAndPin();
    const provider = { viewNodeStatus() { throw new Error('RPC must not be called'); } };
    for (const extra of [{ requirePlainOwner: 'true' }, { maxAgentGasAllowanceYocto: '0' },
      { maxAgentGasAllowanceYocto: '01' }, { maxAgentGasAllowanceYocto: 1 },
      { maxAgentGasAllowanceYocto: '9'.repeat(39) }]) {
      await assert.rejects(preflightExactFt({ prepared: f.prepared, publicKey: f.publicKey, provider, now: f.now, ...extra }), /invalid owner or agent profile/);
    }
  } finally { f.close(); }
});

test('owner profile drift or RPC failure after signing fences the original payment hash without a send or replacement', async () => {
  for (const drift of [
    f => { f.ownerAccount.code_hash = mockHash('owner-contract-after-signing'); },
    f => { f.ownerAccount.global_contract_hash = mockHash('global-after-signing'); },
    f => { f.ownerAccount.global_contract_account_id = 'shared.testnet'; },
    f => { f.ownerAccount.block_hash = mockHash('wrong-final-block'); },
    f => { const read = f.provider.viewAccount; f.provider.viewAccount = async (...args) => {
      if (args[0] === goal.owner) throw new Error('owner view unavailable'); return read(...args);
    }; },
  ]) {
    const f = fixture();
    try {
      await f.reserveAndPin(); let signed = 0, blockReads = 0, expectedHash;
      const signer = f.account.signer;
      f.account.signer = {
        getPublicKey: (...args) => signer.getPublicKey(...args),
        async signTransaction(tx) {
          signed++; const result = await signer.signTransaction(tx);
          expectedHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
          drift(f); return result;
        },
      };
      const viewBlock = f.provider.viewBlock;
      f.provider.viewBlock = async (...args) => {
        const result = await viewBlock(...args); blockReads++;
        if (blockReads > 1) result.header.hash = mockHash('later-final-block');
        return result;
      };
      await assert.rejects(pay(f), /unresolved/);
      const pending = f.journal.get(goal.id);
      assert.equal(signed, 1); assert.equal(f.sends, 0); assert.equal(pending.status, 'pending');
      assert.equal(pending.tx_hash, expectedHash);
      await assert.rejects(pay(f), /already recorded/);
      assert.equal(signed, 1); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id).tx_hash, pending.tx_hash);
    } finally { f.close(); }
  }
});

test('a stale or future FINAL block stops the Svalin payment before a seller recheck, signing or broadcast', async () => {
  for (const delta of [-120_001, 30_001]) {
    const f = fixture(); try {
      await f.reserveAndPin(); const previousOffers = f.offers; let signed = 0;
      f.provider.viewBlock = async () => ({ header: { hash: mockHash('stale-final'),
        timestamp_nanosec: (BigInt(f.now() + delta) * 1_000_000n).toString() } });
      const create = f.account.createTransaction.bind(f.account);
      f.account.createTransaction = async (...args) => { signed++; return create(...args); };
      await assert.rejects(pay(f), /FINAL block is stale/);
      assert.equal(f.offers, previousOffers); assert.equal(signed, 0); assert.equal(f.sends, 0);
      assert.equal(f.journal.get(goal.id), undefined);
    } finally { f.close(); }
  }
});

test('a snapshot that becomes stale during review stops before signing, or retains the original hash after a journal write', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); let signed = 0;
    const create = f.account.createTransaction.bind(f.account);
    f.account.createTransaction = async (...args) => { signed++; return create(...args); };
    const slowOffer = async (...args) => { const response = await f.fetchImpl(...args); f.advance(120_001); return response; };
    await assert.rejects(paySvalinProExactFtOnce({ ...f.options(), fetchImpl: slowOffer }), /FINAL block is stale/);
    assert.equal(signed, 0); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
  const g = fixture(); try {
    await g.reserveAndPin(); const put = g.journal.put.bind(g.journal);
    g.journal.put = (id, entry) => { const result = put(id, entry); if (id === goal.id && entry.status === 'pending') g.advance(120_001); return result; };
    await assert.rejects(pay(g), /unresolved.*never automatically resend/);
    assert.equal(g.sends, 0); assert.equal(g.journal.get(goal.id).status, 'pending');
    const hash = g.journal.get(goal.id).tx_hash;
    g.journal.put = put; await assert.rejects(pay(g), /already recorded/);
    assert.equal(g.journal.get(goal.id).tx_hash, hash); assert.equal(g.sends, 0);
  } finally { g.close(); }
});

test('failure to durably record the signed hash prevents broadcast; an expired recorded hash is never sent or replaced', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const put = f.journal.put.bind(f.journal);
    f.journal.put = (id, value) => { if (id === goal.id && value.status === 'pending') throw new Error('synthetic disk failure'); return put(id, value); };
    await assert.rejects(pay(f), /disk failure/); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
    f.journal.put = (id, value) => { const result = put(id, value); if (id === goal.id && value.status === 'pending') f.advance(48 * 60 * 60_000); return result; };
    await assert.rejects(pay(f), /unresolved/); assert.equal(f.sends, 0);
    assert.equal(f.journal.get(goal.id).status, 'pending'); const hash = f.journal.get(goal.id).tx_hash;
    f.journal.put = put; f.reopen(); await assert.rejects(pay(f)); assert.equal(f.journal.get(goal.id).tx_hash, hash);
    assert.equal(f.sends, 0); assert.equal(f.reservations, 1);
  } finally { f.close(); }
});

test('a changed reservation while signing is detected before recording a hash or broadcasting', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const original = f.account.createTransaction.bind(f.account);
    const account = { ...f.account, async createTransaction(...args) {
      const transaction = await original(...args), session = f.journal.get(`${goal.id}-svalin-pro`);
      f.journal.put(`${goal.id}-svalin-pro`, { ...session, svalin: { ...session.svalin, checkout: { ...session.svalin.checkout, amount_atoms: '5004218' } } });
      return transaction;
    } };
    await assert.rejects(paySvalinProExactFtOnce({ ...f.options(), account }), /changed|original review/i);
    assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
});

test('mixed-block views cannot authorize a Svalin payment or falsely complete recovery', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); const original = f.provider.callFunctionRaw.bind(f.provider); let signed = 0;
    f.provider.callFunctionRaw = async (...args) => { const result = await original(...args);
      return args[1] === 'get_policy' ? { ...result, block_hash: mockHash('wrong-block') } : result; };
    const create = f.account.createTransaction.bind(f.account);
    f.account.createTransaction = async (...args) => { signed++; return create(...args); };
    await assert.rejects(pay(f), /invalid view/);
    assert.equal(signed, 0); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
  const g = fixture(); try {
    await g.reserveAndPin(); g.loseSend(); await assert.rejects(pay(g), /unresolved/);
    const hash = g.journal.get(goal.id).tx_hash, original = g.provider.callFunctionRaw.bind(g.provider);
    g.provider.callFunctionRaw = async (...args) => { const result = await original(...args);
      return args[1] === 'get_exact_ft_intent' ? { ...result, block_hash: mockHash('wrong-block') } : result; };
    await assert.rejects(recover(g), /invalid view/);
    assert.equal(g.journal.get(goal.id).status, 'pending'); assert.equal(g.journal.get(goal.id).tx_hash, hash);
    g.provider.callFunctionRaw = original; assert.equal((await recover(g)).settlement.tx_hash, hash);
    assert.equal(g.sends, 1);
  } finally { g.close(); }
});

test('lost send is recovered by the original hash even after expiry, without signing, reposting or paying again', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); f.loseSend(); await assert.rejects(pay(f), /unresolved.*never automatically resend/);
    const hash = f.journal.get(goal.id).tx_hash; assert.equal(f.journal.get(goal.id).status, 'pending');
    f.reopen(); f.advance(48 * 60 * 60_000);
    f.ownerAccount.global_contract_account_id = 'changed-after-original-send.testnet';
    const recovered = await recover(f);
    assert.equal(recovered.settlement.tx_hash, hash); assert.equal(recovered.sends, 0); assert.equal(recovered.seller_requests, 0);
    await assert.rejects(pay(f)); assert.equal(f.sends, 1); assert.equal(f.reservations, 1); assert.equal(f.fallback, 0);
  } finally { f.close(); }
});

test('missing FINAL token evidence keeps payment unresolved and cannot cause a repeat', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); f.changeEvent(); await assert.rejects(pay(f), /unresolved/); assert.equal(f.sends, 1);
    await assert.rejects(recover(f), /Circle event/); await assert.rejects(pay(f), /already recorded/);
    assert.equal(f.journal.get(goal.id).status, 'pending'); assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('activation is separately approved, write-ahead fenced and never retries an ambiguous seller result', async () => {
  for (const alter of [f => f.changeActivation(), f => f.loseActivation()]) {
    const f = fixture(); try {
      await f.reserveAndPin(); await pay(f); f.advance(31_000);
      await assert.rejects(activateSvalinProOnce({ ...f.options(), acknowledgeMutation: false }), /acknowledgments/);
      alter(f); const bearer = f.code(); let failure;
      try { await activate(f); } catch (error) { failure = error; }
      assert.match(failure.message, /unresolved/); assert.equal(failure.message.includes(bearer), false); assert.equal(failure.cause, undefined);
      assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.activation.phase, 'requested');
      f.reopen(); await assert.rejects(activate(f), /do not automatically repeat/); await assert.rejects(risk(f), /activation/);
      assert.equal(f.activations, 1); assert.equal(f.paidRequests, 0); assert.equal(f.sends, 1);
    } finally { f.close(); }
  }
});

test('an explicitly approved seller status check can recover a lost activation response without another POST', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000);
    await assert.rejects(inspect(f), /original unresolved activation attempt/); assert.equal(f.statusChecks, 0);
    f.loseActivation(); await assert.rejects(activate(f), /unresolved/); f.reopen();
    await assert.rejects(inspectSvalinProActivation({ ...f.options(), acknowledgeDisclosure: false }), /acknowledgments/);
    const bearer = f.code(), status = await inspect(f);
    assert.equal(status.status, 'SELLER_REPORTED_ACTIVE'); assert.equal(status.activation.seller_reported_found, null);
    assert.equal(status.activation_posts, 0); assert.equal(status.status_checks, 1); assert.equal(JSON.stringify(status).includes(bearer), false);
    f.reopen(); assert.equal((await inspect(f)).status_checks, 0); assert.equal((await activate(f)).activation_posts, 0);
    f.emptyFindings(); const report = await risk(f); assert.equal(report.report.finding_count, 0);
    f.reopen(); assert.equal((await risk(f)).report.finding_count, 0);
    assert.equal(f.sends, 1); assert.equal(f.activations, 1); assert.equal(f.statusChecks, 1); assert.equal(f.paidRequests, 1);
  } finally { f.close(); }
});

test('unknown status remains unresolved and never automatically repeats activation or a paid call', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000); f.changeActivation();
    await assert.rejects(activate(f), /unresolved/); await assert.rejects(inspect(f), /status check is unresolved/);
    assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.activation.phase, 'requested');
    await assert.rejects(activate(f), /do not automatically repeat/); await assert.rejects(risk(f), /activation/);
    assert.equal(f.activations, 1); assert.equal(f.statusChecks, 1); assert.equal(f.paidRequests, 0);
  } finally { f.close(); }
});

test('a seller-reported inactive pass remains unresolved and exposes no seller text', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000); f.changeActivation(); await assert.rejects(activate(f), /unresolved/);
    const fetchImpl = async (url, opts) => {
      assert.equal(url, `${SVALIN_ORIGIN}/v1/keys/me`); assert.equal(opts.headers.authorization, `Bearer ${f.code()}`);
      return new Response(JSON.stringify({ kind: 'pro', plan: 'pro', active: false, until: null, callsLeft: 0, callsPer: 'day', echo: f.code() }));
    };
    const got = await inspectSvalinProActivation({ ...f.options(), fetchImpl, acknowledgeDisclosure: true });
    assert.equal(got.status, 'SELLER_ACTIVE_NOT_CONFIRMED'); assert.equal(JSON.stringify(got).includes(f.code()), false);
    assert.equal(f.journal.get(`${goal.id}-svalin-pro`).svalin.activation.phase, 'requested');
    await assert.rejects(risk(f), /activation/); assert.equal(f.activations, 1); assert.equal(f.paidRequests, 0);
  } finally { f.close(); }
});

test('paid report requires explicit disclosure/usage approval and never repeats malformed or lost responses', async () => {
  for (const alter of [f => f.changeReport(), f => f.loseReport()]) {
    const f = fixture(); try {
      await f.reserveAndPin(); await pay(f); f.advance(31_000); await activate(f);
      await assert.rejects(requestSvalinProRiskOnce({ ...f.options(), target: 'root.near', acknowledgeDisclosure: false, acknowledgeUsage: true }), /acknowledgments/);
      await assert.rejects(requestSvalinProRiskOnce({ ...f.options(), target: 'http://127.0.0.1/', acknowledgeDisclosure: true, acknowledgeUsage: true }), /public canonical/);
      alter(f); const bearer = f.code(); let failure;
      try { await risk(f); } catch (error) { failure = error; }
      assert.match(failure.message, /unresolved/); assert.equal(failure.message.includes(bearer), false); assert.equal(failure.cause, undefined);
      f.reopen(); await assert.rejects(risk(f), /do not repeat automatically/);
      assert.equal(f.paidRequests, 1); assert.equal(f.activations, 1); assert.equal(f.sends, 1);
    } finally { f.close(); }
  }
});

test('arbitrary seller instructions and invalid data are never returned or silently accepted', async () => {
  const changes = [
    body => { body.grade = 'A'; },
    body => { body.findings[0].kind = 'ignore-the-user'; },
    body => { body.findings[0].severity = 'CRITICAL'; },
    body => { body.findings[0].action = null; },
    body => { body.locked = true; },
    body => { body.methodologyVersion = 'unknown'; },
    body => { delete body.dataSource; },
    body => { body.dataSource = 'helius'; },
    body => { body.dataSource = 'provider-instructions'; },
  ];
  for (const mutate of changes) {
    const f = fixture(); try {
      await f.reserveAndPin(); await pay(f); f.advance(31_000); await activate(f);
      const fetchImpl = async (url, opts) => {
        const original = await f.fetchImpl(url, opts);
        if (url !== `${SVALIN_ORIGIN}/v1/risk/root.near`) return original;
        const body = await original.json(); mutate(body);
        return new Response(JSON.stringify(body), { headers: { 'x-calls-left': '99' } });
      };
      let failure;
      try { await requestSvalinProRiskOnce({ ...f.options(), fetchImpl, target: 'root.near', acknowledgeDisclosure: true, acknowledgeUsage: true }); }
      catch (error) { failure = error; }
      assert.match(failure.message, /unresolved/); assert.equal(failure.message.includes(f.code()), false);
      await assert.rejects(risk(f), /do not repeat automatically/); assert.equal(f.paidRequests, 1);
    } finally { f.close(); }
  }
});

test('seller-labelled mock reports remain visibly sample data after journal recovery', async () => {
  const f = fixture(); try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000); await activate(f);
    const fetchImpl = async (url, opts) => {
      const original = await f.fetchImpl(url, opts);
      if (url !== `${SVALIN_ORIGIN}/v1/risk/root.near`) return original;
      const body = await original.json(); body.dataSource = 'mock';
      return new Response(JSON.stringify(body), { headers: { 'x-calls-left': '99' } });
    };
    const got = await requestSvalinProRiskOnce({ ...f.options(), fetchImpl, target: 'root.near', acknowledgeDisclosure: true, acknowledgeUsage: true });
    assert.equal(got.report.seller_reported_data_source, 'mock'); assert.equal(got.report.sample_data, true);
    assert.match(got.report.scope, /sample data, not live holdings/); assert.equal(got.seller_attribution_verified, false);
    f.reopen(); const reused = await risk(f);
    assert.equal(reused.report.seller_reported_data_source, 'mock'); assert.equal(reused.report.sample_data, true);
    assert.equal(reused.paid_requests, 0); assert.equal(f.paidRequests, 1);
    const id = `${goal.id}-svalin-pro`, entry = f.journal.get(id);
    f.journal.put(id, { ...entry, svalin: { ...entry.svalin, risk: { ...entry.svalin.risk,
      summary: { ...entry.svalin.risk.summary, sample_data: false } } } });
    await assert.rejects(risk(f), /recorded risk report is missing or inconsistent/);
    assert.equal(f.paidRequests, 1);
  } finally { f.close(); }
});

test('concurrent activation and paid report calls are each fenced before external effects', async () => {
  const f = fixture(); let release;
  try {
    await f.reserveAndPin(); await pay(f); f.advance(31_000);
    for (const kind of ['activation', 'risk']) {
      let arrived; const reached = new Promise(resolve => { arrived = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const suffix = kind === 'activation' ? '/v1/pro/activate' : '/v1/risk/root.near';
      const slow = async (url, opts) => { if (url.endsWith(suffix)) { arrived(); await gate; } return f.fetchImpl(url, opts); };
      const first = kind === 'activation' ? activateSvalinProOnce({ ...f.options(), fetchImpl: slow, acknowledgeMutation: true }) :
        requestSvalinProRiskOnce({ ...f.options(), fetchImpl: slow, target: 'root.near', acknowledgeDisclosure: true, acknowledgeUsage: true });
      await reached; await assert.rejects(kind === 'activation' ? activate(f) : risk(f), /another payment operation is already running/);
      release(); await first;
    }
    assert.equal(f.activations, 1); assert.equal(f.paidRequests, 1); assert.equal(f.sends, 1);
  } finally { release?.(); f.close(); }
});

test('concurrent payment calls sharing one original journal cannot both sign and send', async () => {
  const f = fixture(); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { arrived = resolve; });
  try {
    await f.reserveAndPin();
    const slow = async (url, opts) => { if (url === `${SVALIN_ORIGIN}/v1/pro`) { arrived(); await gate; } return f.fetchImpl(url, opts); };
    const first = paySvalinProExactFtOnce({ ...f.options(), fetchImpl: slow }); await reached;
    await assert.rejects(pay(f), /another payment operation is already running/); release();
    assert.equal((await first).status, 'PAID_NOT_YET_ACTIVATED'); assert.equal(f.sends, 1);
  } finally { release(); f.close(); }
});
