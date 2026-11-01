import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { inspectMultiAgencyResearchTask, requestMultiAgencyQuoteOnce, payMultiAgencyQuoteOnce,
  recoverMultiAgencyPayment } from '../agent/multiagency-runner.mjs';
import { MULTIAGENCY_TREASURY as TREASURY } from '../agent/multiagency-readiness.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';
const nowMs = Date.parse('2026-11-01T15:00:00.000Z'), now = () => nowMs;
const goal = { version: 1, id: 'research', vault: 'vault.testnet', owner: 'owner.testnet', vault_code_hash: mockHash('reviewed-code'), policy_id: 'research',
  title: 'Independent research brief', brief: 'Produce a cited public report about safe autonomous agent purchasing.', amount: '3000000',
  accept_public_brief: true, accept_stalled_deposit_risk: true, accept_unsigned_quote_and_memo_risk: true };
const quote = { code: 'ma-0123456789', title: goal.title, status: 'awaiting_deposit', channel: 'wallet',
  expires_at: '2026-11-04T15:00:00.000Z', payment: { network: 'testnet', token: TOKEN, receiver: TREASURY, amount: goal.amount, memo: 'ma-0123456789' } };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multiagency-')), file = path.join(dir, 'journal.enc.json'), key = crypto.randomBytes(32);
  let journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey: key });
  const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair), publicKey = pair.getPublicKey();
  let quotes = 0, checks = 0, sends = 0, fallbacks = 0, nonce = 0n, chain, quoteLost = false, sendLost = false, quoteChanged = false, badCode = false;
  const finalBlock = mockHash('final-block'), paymentBlock = mockHash('payment-block');
  const account = { accountId: goal.owner, signer, async createTransaction(receiver, actions, pk) {
    return nearApi.transactions.createTransaction(goal.owner, pk, receiver, ++nonce, actions, Buffer.alloc(32, 4));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewBlock() { return { header: { hash: finalBlock, timestamp_nanosec: (BigInt(nowMs) * 1_000_000n).toString() } }; },
    async viewAccount(id, options) { assert.equal(id, goal.vault); return { block_hash: options.blockId, code_hash: badCode ? mockHash('wrong') : goal.vault_code_hash }; },
    async viewAccessKeyList(id, options) { assert.equal(id, goal.vault); return { block_hash: options.blockId, keys: [] }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.vault, method_names: ['execute'] } } }; },
    async callFunction(_contract, method) {
      if (method === 'get_owner') return goal.owner;
      if (method === 'storage_balance_of') return { total: '1250000000000000000000' };
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token: TOKEN };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionOnce(signed, wait) {
      sends++; assert.equal(wait, 'FINAL');
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).tx_hash, txHash); assert.equal(journal.get(goal.id).status, 'pending');
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString('utf8'));
      chain = mockGuardedPayment({ hash: txHash, owner: goal.owner, contract: goal.vault, publicKey: String(publicKey), args });
      chain.transaction_outcome.block_hash = paymentBlock; chain.receipts_outcome[0].block_hash = mockHash('execution-block');
      chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: goal.vault, new_owner_id: TREASURY, amount: goal.amount, memo: quote.code }] })];
      if (sendLost) throw new Error('response lost');
      return { transaction_outcome: { id: txHash } };
    },
    async sendTransactionUntil() { fallbacks++; throw new Error('must not use retrying transport'); },
    async txStatusReceipts(hash, owner, finality) {
      assert.equal(owner, goal.owner); assert.equal(finality, 'FINAL'); assert.equal(chain?.transaction_outcome.id, hash);
      return structuredClone(chain);
    },
  };
  async function fetchImpl(url, options) {
    assert.equal(options.redirect, 'error');
    if (options.method === 'POST') {
      quotes++; assert.equal(url, 'https://demo.multiagency.ai/api/quotes');
      assert.equal(journal.get(`${goal.id}-ma-quote`)?.multiagency?.phase, 'requested');
      assert.deepEqual(JSON.parse(options.body), { title: goal.title, brief: goal.brief, amount: goal.amount });
      if (quoteLost) throw new Error('synthetic lost quote');
      return new Response(JSON.stringify(quote), { status: 201 });
    }
    assert.equal(options.method, 'GET'); assert.equal(url, `https://demo.multiagency.ai/api/quotes/${quote.code}`); checks++;
    const answer = structuredClone(quote); if (quoteChanged) answer.payment.amount = '3000001';
    return new Response(JSON.stringify(answer), { status: 200 });
  }
  const opts = () => ({ goal, journal, fetchImpl, now, execute: true });
  return { provider, account, publicKey, fetchImpl, opts, file,
    get journal() { return journal; }, get quotes() { return quotes; }, get checks() { return checks; },
    get sends() { return sends; }, get fallbacks() { return fallbacks; },
    loseQuote() { quoteLost = true; }, loseSend() { sendLost = true; }, changeQuote() { quoteChanged = true; }, changeCode() { badCode = true; },
    reopen() { journal.close(); journal = new FileJournal(file, goal.vault, goal.owner, { encryptionKey: key, requireExisting: true }); },
    close() { journal.close(); key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const q = f => requestMultiAgencyQuoteOnce(f.opts());
const p = f => payMultiAgencyQuoteOnce({ ...f.opts(), provider: f.provider, account: f.account, publicKey: f.publicKey, log: () => {} });
const r = f => recoverMultiAgencyPayment({ goal, journal: f.journal, provider: f.provider, now, log: () => {} });

test('one public quote POST is reserved first and the encrypted original is reused after restart', async () => {
  const f = fixture(); try {
    await assert.rejects(requestMultiAgencyQuoteOnce({ ...f.opts(), execute: false }), /explicit quote execution/); assert.equal(f.quotes, 0);
    assert.equal((await q(f)).status, 'QUOTED'); assert.equal(f.quotes, 1);
    assert.ok(!fs.readFileSync(f.file, 'utf8').includes(goal.brief));
    f.reopen(); assert.equal((await q(f)).status, 'REUSED_QUOTE'); assert.equal(f.quotes, 1); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('lost quote response cannot be retried or paid from the pending original session', async () => {
  const f = fixture(); try {
    f.loseQuote(); await assert.rejects(q(f), /quote response is unresolved/); f.reopen();
    await assert.rejects(q(f), /quote response is unresolved/); await assert.rejects(p(f), /quote response is unresolved/);
    assert.equal(f.quotes, 1); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('one scoped guarded payment checks quote and vault, uses one-shot transport and never repays', async () => {
  const f = fixture(); try {
    await q(f); const paid = await p(f); assert.equal(paid.status, 'PAID_NOT_YET_DELIVERED');
    assert.equal(f.sends, 1); assert.equal(f.fallbacks, 0); assert.equal(f.checks, 1);
    f.reopen(); const recovered = await r(f); assert.equal(recovered.status, 'RECOVERED_PAYMENT_ONLY');
    assert.equal(recovered.settlement.tx_hash, paid.settlement.tx_hash);
    await assert.rejects(p(f), /already recorded/); assert.equal(f.sends, 1); assert.equal(f.quotes, 1);
  } finally { f.close(); }
});

test('lost payment response is recovered by the original hash without a second send', async () => {
  const f = fixture(); try {
    await q(f); f.loseSend(); await assert.rejects(p(f), /payment could not be confirmed.*do not retry automatically/);
    const hash = f.journal.get(goal.id).tx_hash; assert.equal(f.journal.get(goal.id).status, 'pending'); f.reopen();
    assert.equal((await r(f)).settlement.tx_hash, hash); assert.equal(f.journal.get(goal.id).status, 'completed');
    await assert.rejects(p(f), /already recorded/); assert.equal(f.sends, 1); assert.equal(f.fallbacks, 0);
  } finally { f.close(); }
});

test('changed quote or unreviewed vault code blocks before the first broadcast', async () => {
  for (const alter of [f => f.changeQuote(), f => f.changeCode()]) {
    const f = fixture(); try { await q(f); alter(f); await assert.rejects(p(f)); assert.equal(f.sends, 0); }
    finally { f.close(); }
  }
});

test('parallel callers sharing one encrypted journal cannot create duplicate quote posts', async () => {
  const f = fixture(); let arrived, release;
  const reached = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const slow = async (url, opts) => { arrived(); await gate; return f.fetchImpl(url, opts); };
  try {
    const first = requestMultiAgencyQuoteOnce({ ...f.opts(), fetchImpl: slow }); await reached;
    await assert.rejects(q(f), /another payment operation is already running/); release();
    assert.equal((await first).status, 'QUOTED'); assert.equal(f.quotes, 1);
  } finally { release(); f.close(); }
});

test('stale FINAL state blocks the legacy MultiAgency payment before quote recheck, signing or broadcast', async () => {
  const f = fixture(); try {
    await q(f); let signed = 0; const previousChecks = f.checks;
    f.provider.viewBlock = async () => ({ header: { hash: mockHash('stale-final'),
      timestamp_nanosec: (BigInt(nowMs - 120_001) * 1_000_000n).toString() } });
    const create = f.account.createTransaction.bind(f.account);
    f.account.createTransaction = async (...args) => { signed++; return create(...args); };
    await assert.rejects(p(f), /FINAL block is stale/);
    assert.equal(f.checks, previousChecks); assert.equal(signed, 0); assert.equal(f.sends, 0);
    assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
});

test('legacy MultiAgency rechecks FINAL freshness after quote lookup and after journaling', async () => {
  const f = fixture(); try {
    await q(f); let clock = nowMs;
    const slowQuote = async (...args) => { const response = await f.fetchImpl(...args); clock += 120_001; return response; };
    await assert.rejects(payMultiAgencyQuoteOnce({ ...f.opts(), now: () => clock, fetchImpl: slowQuote,
      provider: f.provider, account: f.account, publicKey: f.publicKey, log: () => {} }), /FINAL block is stale/);
    assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id), undefined);
  } finally { f.close(); }
  const g = fixture(); try {
    await q(g); let clock = nowMs; const put = g.journal.put.bind(g.journal);
    g.journal.put = (id, entry) => { const result = put(id, entry); if (id === goal.id && entry.status === 'pending') clock += 120_001; return result; };
    await assert.rejects(payMultiAgencyQuoteOnce({ ...g.opts(), now: () => clock, provider: g.provider,
      account: g.account, publicKey: g.publicKey, log: () => {} }), /pre-broadcast guard rejected.*FINAL block is stale/);
    assert.equal(g.sends, 0); assert.equal(g.journal.get(goal.id).status, 'pending');
    g.journal.put = put; await assert.rejects(p(g), /already recorded/); assert.equal(g.sends, 0);
  } finally { g.close(); }
});

test('expiry after journal reservation stops before broadcast and keeps the original pending', async () => {
  const f = fixture(); try {
    await q(f); let clock = nowMs;
    const originalPut = f.journal.put.bind(f.journal);
    f.journal.put = (id, entry) => {
      originalPut(id, entry);
      if (id === goal.id && entry.status === 'pending') clock = Date.parse(quote.expires_at) - 30_000;
    };
    await assert.rejects(payMultiAgencyQuoteOnce({ ...f.opts(), provider: f.provider, account: f.account, publicKey: f.publicKey,
      now: () => clock, log: () => {} }), /pre-broadcast guard rejected/);
    assert.equal(f.sends, 0); assert.equal(f.journal.get(goal.id).status, 'pending');
    await assert.rejects(p(f), /already recorded/); assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('key-free task inspection ties provider status, original FINAL payment and complete public handoff without side effects', async () => {
  const f = fixture(); try {
    await q(f); await p(f);
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
    const text = '**Deliverable**\n\nIndependent public report.', url = `${board}/issues/40#issuecomment-51`;
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
    const result = await inspectMultiAgencyResearchTask(args);
    assert.equal(result.status, 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT'); assert.equal(result.text, text); assert.equal(result.sends, 0);
    assert.equal(result.quote_posts, 0); assert.equal(result.journal_writes, 0); assert.equal(reads, 4);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.sends, 1); assert.equal(f.quotes, 1);
    tamper = true; await assert.rejects(inspectMultiAgencyResearchTask(args), /deliverable content/);
    await assert.rejects(inspectMultiAgencyResearchTask({ ...args, task: 0 }), /valid public task/);
    assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(f.sends, 1); assert.equal(f.quotes, 1);
  } finally { f.close(); }
});
