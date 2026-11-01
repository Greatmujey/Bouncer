import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { requestMultiAgencyQuoteOnce, prepareMultiAgencyExactIntent, payMultiAgencyExactFtOnce,
  recoverMultiAgencyExactFtPayment, inspectMultiAgencyExactResearchTask, payMultiAgencyQuoteOnce } from '../agent/multiagency-runner.mjs';
import { MULTIAGENCY_TREASURY as TREASURY } from '../agent/multiagency-readiness.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const nowMs = Date.parse('2026-11-01T15:00:00.000Z'), now = () => nowMs;
const goal = { version: 1, id: 'research', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('v11-code'), policy_id: 'research',
  title: 'Independent research brief', brief: 'Produce a cited public report about safe autonomous agent purchasing.', amount: '3000000',
  accept_public_brief: true, accept_stalled_deposit_risk: true, accept_unsigned_quote_and_memo_risk: true };
const quote = { code: 'ma-0123456789', title: goal.title, status: 'awaiting_deposit', channel: 'wallet',
  expires_at: '2026-11-04T15:00:00.000Z', payment: { network: 'testnet', token: TOKEN, receiver: TREASURY, amount: goal.amount, memo: 'ma-0123456789' } };
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagency-exact-')), file = path.join(dir, 'journal.enc.json'), encryptionKey = crypto.randomBytes(32);
  let journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey });
  const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair), publicKey = pair.getPublicKey();
  let posts = 0, checks = 0, sends = 0, fallback = 0, nonce = 0n, chain, prepared, activeView;
  let lost = false, badCode = false, badKey = false, badIntent = false, quoteChanged = false, badEvent = false, blocked = false;
  const finalBlock = mockHash('final-block'), txBlock = mockHash('tx-block'), executionBlock = mockHash('execution-block');
  const account = { accountId: goal.owner, signer, async createTransaction(receiver, actions, pk) {
    return nearApi.transactions.createTransaction(goal.owner, pk, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: finalBlock } }; },
    async viewAccount(id, options) { assert.equal(id, goal.vault); return { block_hash: options.blockId, code_hash: badCode ? mockHash('wrong') : goal.vault_code_hash }; },
    async viewAccessKeyList(id, options) { assert.equal(id, goal.vault); return { block_hash: options.blockId, keys: [] }; },
    async viewAccessKey(id, pk, options) {
      assert.equal(id, goal.owner); assert.equal(String(pk), String(publicKey));
      return { block_hash: options.blockId, permission: { FunctionCall: { receiver_id: goal.vault,
        method_names: badKey ? ['execute_exact_ft', 'execute'] : ['execute_exact_ft'] } } };
    },
    async callFunction(_contract, method, args, options) {
      if (method === 'get_owner') return goal.owner;
      if (method === 'contract_version') return 'bouncer-agent-v11-exact-ft-testnet';
      if (method === 'storage_balance_of') return { total: '1250000000000000000000' };
      if (method === 'is_exact_ft_policy_locked' || method === 'is_exact_ft_payee_locked' || method === 'is_agent_key_allowed') return true;
      if (method === 'get_policy') return { token: TOKEN };
      if (method === 'check') return blocked ? [false, 'BLOCKED: daily cap exceeded'] : [true, 'ok'];
      if (method === 'get_exact_ft_intent') {
        assert.equal(args.intent_id, prepared.intent_id);
        const view = structuredClone(activeView);
        if (badIntent) view.memo = 'ma-ffffffffee';
        if (options.blockId === executionBlock) { view.consumed = true; view.active = false; }
        return view;
      }
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionOnce(signed, wait) {
      sends++; assert.equal(wait, 'FINAL');
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).tx_hash, txHash); assert.equal(journal.get(goal.id).status, 'pending');
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
        data: [{ old_owner_id: goal.vault, new_owner_id: TREASURY, amount: goal.amount, memo: quote.code }] })];
      chain.receipts_outcome[2].outcome.logs = ['BOUNCER exact FT transfer succeeded; intent stays consumed'];
      const callback = chain.receipts[1].receipt.Action.actions[0].FunctionCall;
      callback.method_name = 'after_exact_ft_transfer';
      callback.args = enc({ intent_id: prepared.intent_id, policy_id: a.policy_id, token: TOKEN, amount: a.amount, bucket: 24, policy_revision: 1 });
      if (lost) throw new Error('synthetic response lost');
      return { transaction_outcome: { id: txHash } };
    },
    async sendTransactionUntil() { fallback++; throw new Error('retrying transport must never be used'); },
    async txStatusReceipts(hash, owner, finality) {
      assert.equal(owner, goal.owner); assert.equal(finality, 'FINAL'); assert.equal(chain?.transaction_outcome.id, hash);
      return structuredClone(chain);
    },
  };
  async function fetchImpl(url, options) {
    if (options.method === 'POST') {
      posts++; assert.equal(url, 'https://demo.multiagency.ai/api/quotes');
      assert.equal(journal.get(`${goal.id}-ma-quote`)?.multiagency?.phase, 'requested');
      return new Response(JSON.stringify(quote), { status: 201 });
    }
    checks++; assert.equal(url, `https://demo.multiagency.ai/api/quotes/${quote.code}`);
    const answer = structuredClone(quote); if (quoteChanged) answer.payment.amount = '3000001';
    return new Response(JSON.stringify(answer), { status: 200 });
  }
  const options = () => ({ goal, journal, fetchImpl, now, execute: true });
  async function pinSyntheticView() {
    prepared = await prepareMultiAgencyExactIntent({ goal, journal, agentPublicKey: String(publicKey), now });
    const a = prepared.owner_call.args;
    activeView = { intent_id: a.intent_id, policy_id: a.policy_id, token: a.expected_token, payee: a.payee, amount: a.amount,
      memo: a.memo, review_hash: a.review_hash, expires_at_ms: a.expires_at_ms, agent_public_key: a.agent_public_key,
      policy_revision: 1, payee_revision: 2, agent_revision: 3, consumed: false, cancelled: false, active: true };
    return prepared;
  }
  return { provider, account, publicKey, fetchImpl, options, pinSyntheticView, file,
    get journal() { return journal; }, get sends() { return sends; }, get posts() { return posts; }, get checks() { return checks; }, get fallback() { return fallback; },
    loseSend() { lost = true; }, changeCode() { badCode = true; }, changeKey() { badKey = true; }, changeIntent() { badIntent = true; },
    changeQuote() { quoteChanged = true; }, changeEvent() { badEvent = true; }, block() { blocked = true; },
    reopen() { journal.close(); journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey, requireExisting: true }); },
    close() { journal.close(); encryptionKey.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const q = f => requestMultiAgencyQuoteOnce(f.options());
const p = f => payMultiAgencyExactFtOnce({ ...f.options(), provider: f.provider, account: f.account, publicKey: f.publicKey });
const r = f => recoverMultiAgencyExactFtPayment({ goal, journal: f.journal, provider: f.provider, now });

test('read-only preparation requires the original quote and records no payment', async () => {
  const f = fixture(); try {
    await assert.rejects(f.pinSyntheticView(), /original research-quote journal/); assert.equal(f.sends, 0);
    await q(f); const prepared = await f.pinSyntheticView();
    assert.equal(prepared.owner_call.method, 'set_exact_ft_intent');
    assert.equal(prepared.agent_call.method, 'execute_exact_ft');
    assert.equal(f.journal.get(goal.id), undefined); assert.equal(f.sends, 0); assert.equal(f.posts, 1);
  } finally { f.close(); }
});

test('exact route signs only the pinned ID, fsyncs before one broadcast and recovers the original hash', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView(); const paid = await p(f);
    assert.equal(paid.status, 'PAID_NOT_YET_DELIVERED'); assert.equal(f.sends, 1); assert.equal(f.checks, 2); assert.equal(f.fallback, 0);
    const hash = paid.settlement.tx_hash; f.reopen();
    assert.equal((await r(f)).settlement.tx_hash, hash);
    await assert.rejects(p(f), /already recorded/);
    await assert.rejects(payMultiAgencyQuoteOnce({ ...f.options(), provider: f.provider, account: f.account, publicKey: f.publicKey }), /already recorded/);
    assert.equal(f.sends, 1); assert.equal(f.posts, 1);
  } finally { f.close(); }
});

test('a lost send response remains pending and is recovered without a key or second send', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView(); f.loseSend();
    await assert.rejects(p(f), /unresolved.*never automatically resend/);
    const hash = f.journal.get(goal.id).tx_hash; assert.equal(f.journal.get(goal.id).status, 'pending'); f.reopen();
    assert.equal((await r(f)).settlement.tx_hash, hash); assert.equal(f.journal.get(goal.id).status, 'completed');
    await assert.rejects(p(f), /already recorded/); assert.equal(f.sends, 1); assert.equal(f.fallback, 0);
  } finally { f.close(); }
});

test('changed provider terms, vault code, scoped key or pinned intent prevent any broadcast', async () => {
  for (const alter of [f => f.changeCode(), f => f.changeKey(), f => f.changeIntent(), f => f.changeQuote()]) {
    const f = fixture(); try { await q(f); await f.pinSyntheticView(); alter(f); await assert.rejects(p(f)); assert.equal(f.sends, 0); }
    finally { f.close(); }
  }
});

test('policy denial stops without signing a payment, and missing token evidence stays unresolved', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView(); f.block(); assert.equal((await p(f)).status, 'BLOCKED'); assert.equal(f.sends, 0);
  } finally { f.close(); }
  const g = fixture(); try {
    await q(g); await g.pinSyntheticView(); g.changeEvent(); await assert.rejects(p(g), /unresolved/);
    assert.equal(g.sends, 1); assert.equal(g.journal.get(goal.id).status, 'pending');
    await assert.rejects(r(g), /Circle event/); await assert.rejects(p(g), /already recorded/); assert.equal(g.sends, 1);
  } finally { g.close(); }
});

test('quote posting and exact paying cannot race on the same encrypted journal', async () => {
  const f = fixture(); let arrived, release;
  const reached = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const slow = async (url, opts) => { arrived(); await gate; return f.fetchImpl(url, opts); };
  try {
    const first = requestMultiAgencyQuoteOnce({ ...f.options(), fetchImpl: slow }); await reached;
    await assert.rejects(f.pinSyntheticView(), /another payment operation is already running/); release();
    assert.equal((await first).status, 'QUOTED'); assert.equal(f.posts, 1); assert.equal(f.sends, 0);
  } finally { release(); f.close(); }
});

test('read-only exact-task inspection combines FINAL payment, seller attribution and handoff, and rejects tampering', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView(); await p(f);
    const tx = f.journal.get(goal.id).tx_hash, board = 'https://github.com/MultiAgency/kanban-sandbox';
    const api = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
    const fence = (name, value) => `\`\`\`${name}\n${JSON.stringify(value)}\n\`\`\``;
    const seller = { ...structuredClone(quote), status: 'open', issue: 32, issue_url: `${board}/issues/32`,
      deposit: { transaction: tx, org: goal.vault, amount: goal.amount, memo: quote.code } };
    const engagement = { engagement_id: quote.code, channel: 'wallet', org: goal.vault,
      deposit: { amount: goal.amount, asset: TOKEN, treasury: TREASURY, transaction: tx, network: 'testnet' } };
    const team = { members: [{ issue: 40, engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }] };
    const epic = { number: 32, html_url: `${board}/issues/32`, user: { id: 334725530 }, title: `Job: ${goal.title}`,
      state: 'closed', state_reason: 'completed', closed_at: '2026-11-01T16:10:00Z', body: `intro\n\n${goal.brief}\n\n${fence('engagement', engagement)}\n\n${fence('team', team)}` };
    const task = { number: 40, html_url: `${board}/issues/40`, user: { id: 334725530 }, state: 'closed', state_reason: 'completed',
      closed_at: '2026-11-01T16:00:00Z', assignees: [{ id: 42 }], comments: 2,
      body: fence('terms', { engagement: 32, key: 'report', amount: '1000000', asset: TOKEN }) };
    const text = '**Deliverable**\n\nPublic research report.', url = `${board}/issues/40#issuecomment-51`;
    const delivered = { id: 51, user: { id: 42 }, issue_url: `${api}/40`, html_url: url, body: text,
      created_at: '2026-11-01T15:30:00Z', updated_at: '2026-11-01T15:30:00Z' };
    const handoff = { id: 52, user: { id: 42 }, issue_url: `${api}/40`, html_url: `${board}/issues/40#issuecomment-52`,
      body: fence('handoff', { deliverable: { url, sha256: crypto.createHash('sha256').update(text).digest('hex') } }),
      created_at: '2026-11-01T15:31:00Z', updated_at: '2026-11-01T15:31:00Z' };
    let tamper = false, reads = 0;
    const fetchImpl = async (address, opts) => {
      reads++; assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
      if (address.startsWith('https://demo.multiagency.ai/')) {
        assert.equal(opts.headers?.authorization, undefined); assert.equal(address, `https://demo.multiagency.ai/api/quotes/${quote.code}`);
        return new Response(JSON.stringify(seller), { status: 200 });
      }
      assert.equal(opts.headers.authorization, 'Bearer test-read-token');
      const values = { [`${api}/32`]: epic, [`${api}/40`]: task, [`${api}/40/comments?per_page=100`]: [delivered, handoff] };
      assert.ok(Object.hasOwn(values, address));
      const value = structuredClone(values[address]); if (tamper && Array.isArray(value)) value[0].body += ' modified';
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const before = fs.readFileSync(f.file);
    const args = { goal, journal: f.journal, provider: f.provider, task: 40, githubToken: 'test-read-token', fetchImpl, now };
    const result = await inspectMultiAgencyExactResearchTask(args);
    assert.equal(result.status, 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT'); assert.equal(result.text, text); assert.equal(result.sends, 0);
    assert.equal(result.quote_posts, 0); assert.equal(result.journal_writes, 0); assert.equal(reads, 4);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.sends, 1); assert.equal(f.posts, 1);
    tamper = true; await assert.rejects(inspectMultiAgencyExactResearchTask(args), /deliverable content/);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('the exact payment never falls back to a retrying transport', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView();
    f.provider.sendTransactionOnce = undefined;
    await assert.rejects(p(f), /requires one-shot transport/);
    assert.equal(f.fallback, 0); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
});

test('a quote changed after signing but before reservation stops with no broadcast', async () => {
  const f = fixture(); try {
    await q(f); await f.pinSyntheticView(); let reads = 0;
    const changedOnSecondRead = async (url, options) => {
      reads++;
      if (reads === 2) return new Response(JSON.stringify({ ...quote, payment: { ...quote.payment, amount: '3000001' } }), { status: 200 });
      return f.fetchImpl(url, options);
    };
    await assert.rejects(payMultiAgencyExactFtOnce({ ...f.options(), fetchImpl: changedOnSecondRead,
      provider: f.provider, account: f.account, publicKey: f.publicKey }), /quote differs/);
    assert.equal(reads, 2); assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
});

test('expiry immediately after durable reservation prevents broadcast and retains the original pending hash', async () => {
  const f = fixture(); try {
    await q(f); const prepared = await f.pinSyntheticView();
    let clock = nowMs;
    const originalPut = f.journal.put.bind(f.journal);
    f.journal.put = (id, entry) => { originalPut(id, entry); if (id === goal.id) clock = Number(prepared.owner_call.args.expires_at_ms); };
    await assert.rejects(payMultiAgencyExactFtOnce({ ...f.options(), now: () => clock, provider: f.provider,
      account: f.account, publicKey: f.publicKey }), /unresolved.*never automatically resend/);
    assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id).status, 'pending');
    assert.ok(f.journal.get(goal.id).tx_hash); f.reopen();
    await assert.rejects(p(f), /already recorded/); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('concurrent exact pay attempts sharing one encrypted journal cannot both reserve', async () => {
  const f = fixture(); let arrived, release;
  const reached = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    await q(f); await f.pinSyntheticView();
    const slow = async (url, opts) => { arrived(); await gate; return f.fetchImpl(url, opts); };
    const first = payMultiAgencyExactFtOnce({ ...f.options(), fetchImpl: slow, provider: f.provider, account: f.account, publicKey: f.publicKey });
    await reached;
    await assert.rejects(p(f), /another payment operation is already running/); release();
    assert.equal((await first).status, 'PAID_NOT_YET_DELIVERED'); assert.equal(f.sends, 1);
  } finally { release(); f.close(); }
});
