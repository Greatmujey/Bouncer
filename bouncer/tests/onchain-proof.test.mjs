import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { buildOnchainProofHeader, recoverOnchainProofGoal, redeemOnchainProofOnce, runOnchainProofGoal,
  selectOnchainProofOffer, validateOnchainProofGoal, verifyOnchainProofSettlement } from '../agent/onchain-proof.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const kp = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(kp), publicKey = kp.getPublicKey();
const goal = { version: 1, id: 'api-1', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'api',
  token: TOKEN, payee: 'vendor.testnet', max_amount: '1000', resource_url: 'https://seller.example/api',
  max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
const offer = { scheme: 'onchain-proof', network: 'near:testnet', amount: '1000', asset: TOKEN, payTo: goal.payee,
  maxTimeoutSeconds: 600, extra: { nonce: 'seller-nonce-abc', decimals: 6, minConfirmations: 1, amountFormatted: '0.001', symbol: 'USDC' } };
const challenge = () => ({ x402Version: 2, resource: { url: goal.resource_url }, accepts: [structuredClone(offer)] });
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const dec = value => JSON.parse(Buffer.from(value, 'base64').toString());
const log = () => {};
const response402 = value => new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': enc(value) } });
function memoryJournal() {
  const entries = new Map();
  return { get(id) { const v = entries.get(id); return v && structuredClone(v); },
    list() { return structuredClone([...entries.values()]); }, put(id, entry) { entries.set(id, structuredClone({ ...entry, id })); } };
}
function fixture({ journal: initialJournal = memoryJournal() } = {}) {
  let journal = initialJournal;
  let sends = 0, quotes = 0, redemptions = 0, signs = 0, chain, loss = false, httpLoss = false, noEvent = false;
  const account = { accountId: goal.owner_account_id, signer: {
    async getPublicKey() { return publicKey; }, async signTransaction(tx) { signs++; return signer.signTransaction(tx); },
  }, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(goal.owner_account_id, key, receiver, 42n, actions, Buffer.alloc(32, 9));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: goal.token };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'storage_balance_of') return { total: '1250000000000000000000', available: '0' };
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) {
      sends++; assert.equal(wait, 'FINAL');
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      const stored = journal.get(goal.id);
      assert.equal(stored.status, 'pending'); assert.equal(stored.tx_hash, hash); assert.equal(stored.redemption.status, 'not_started');
      assert.equal(JSON.stringify(stored).includes('private_key'), false);
      const call = signed.transaction.actions[0].functionCall;
      assert.equal(call.methodName, 'execute'); assert.equal(call.deposit, 0n); assert.equal(call.gas, 200000000000000n);
      const args = JSON.parse(Buffer.from(call.args).toString());
      chain = mockGuardedPayment({ hash, owner: goal.owner_account_id, contract: goal.contract_id, publicKey: String(publicKey), args });
      if (!noEvent) chain.receipts_outcome[1].outcome.logs = [
        'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
          data: [{ old_owner_id: goal.contract_id, new_owner_id: goal.payee, amount: args.amount, memo: args.memo }] }),
      ];
      if (loss) throw new Error('lost response after submission');
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, owner, wait) {
      assert.equal(hash, journal.get(goal.id).tx_hash); assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL');
      if (!chain) throw new Error('unknown transaction');
      return structuredClone(chain);
    },
  };
  async function fetchImpl(url, options) {
    assert.equal(url, goal.resource_url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    if (!options.headers) { quotes++; return response402(challenge()); }
    redemptions++;
    assert.equal(journal.get(goal.id).status, 'completed'); assert.equal(journal.get(goal.id).redemption.status, 'attempted');
    const proof = dec(options.headers['payment-signature']);
    assert.equal(proof.x402Version, 2); assert.deepEqual(proof.accepted, offer);
    assert.deepEqual(proof.payload, { nonce: offer.extra.nonce, txHash: `${goal.owner_account_id}:${journal.get(goal.id).tx_hash}` });
    if (httpLoss) throw new Error('lost response after seller received proof');
    return new Response('{"answer":42}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { account, provider, get journal() { return journal; }, set journal(v) { journal = v; }, fetchImpl,
    setLoss(v) { loss = v; }, setHttpLoss(v) { httpLoss = v; },
    setNoEvent(v) { noEvent = v; }, setChain(v) { chain = v; }, getChain() { return structuredClone(chain); },
    get sends() { return sends; }, get quotes() { return quotes; }, get redemptions() { return redemptions; }, get signs() { return signs; } };
}
const run = (f, extra = {}) => runOnchainProofGoal({ goal, provider: f.provider, account: f.account, publicKey,
  journal: f.journal, fetchImpl: f.fetchImpl, execute: true, log, ...extra });
const recover = (f, extra = {}) => recoverOnchainProofGoal({ goal, provider: f.provider, journal: f.journal, log, ...extra });
const redeem = (f, extra = {}) => redeemOnchainProofOnce({ goal, provider: f.provider, journal: f.journal, fetchImpl: f.fetchImpl, log, ...extra });

test('goal pins testnet, Circle, seller, URL and explicit public-proof risk', () => {
  assert.deepEqual(validateOnchainProofGoal(goal), goal);
  for (const change of [
    { accept_public_proof_risk: false }, { accept_unbound_resource_risk: false }, { version: 2 }, { token: 'wrap.testnet' }, { token: 'native' },
    { contract_id: 'bouncer.near' }, { owner_account_id: 'owner.near' }, { payee: 'vendor.near' },
    { max_amount: '0' }, { max_amount: '01000' }, { max_amount: (1n << 128n).toString() },
    { resource_url: 'http://seller.example/api' }, { resource_url: 'https://seller.example/api?secret=1' },
    { resource_url: 'https://user:password@seller.example/api' }, { resource_url: 'https://seller.example/api#x' },
    { resource_url: 'https://seller.example/a/../api' }, { max_quote_age_seconds: 0 }, { max_quote_age_seconds: 601 },
    { surprise: true },
  ]) assert.throws(() => validateOnchainProofGoal({ ...goal, ...change }));
  assert.equal(validateOnchainProofGoal({ ...goal, resource_url: 'http://127.0.0.1:3000/api' }).resource_url, 'http://127.0.0.1:3000/api');
});

test('402 selection rejects unsupported rails, substitution, overpricing, ambiguity and malformed headers', () => {
  assert.deepEqual(selectOnchainProofOffer(goal, enc(challenge())), offer);
  const unbound = challenge(); unbound.resource.url = '';
  assert.deepEqual(selectOnchainProofOffer(goal, enc(unbound)), offer); // explicit owner risk acceptance
  const changes = [
    c => { c.x402Version = 1; }, c => { c.resource.url = 'https://evil.example/api'; },
    c => { c.accepts[0].scheme = 'exact'; }, c => { c.accepts[0].network = 'near:mainnet'; },
    c => { c.accepts[0].asset = 'attacker.testnet'; }, c => { c.accepts[0].payTo = 'attacker.testnet'; },
    c => { c.accepts[0].amount = '1001'; }, c => { c.accepts[0].amount = '0'; }, c => { c.accepts[0].amount = '01'; },
    c => { c.accepts[0].maxTimeoutSeconds = 59; }, c => { c.accepts[0].extra.nonce = ''; }, c => { c.accepts[0].extra.nonce = 'bad\nnonce'; },
    c => { c.accepts[0].extra.nonce = 'a'.repeat(257); }, c => { c.accepts[0].extra.decimals = 24; },
    c => { c.accepts[0].extra.minConfirmations = 0; }, c => { c.accepts[0].extra.to = 'evil'; },
    c => { c.accepts[0].recipient = 'other'; }, c => { c.accepts.push(structuredClone(c.accepts[0])); },
    c => { c.accepts = []; }, c => { c.accepts = new Array(17).fill(c.accepts[0]); },
  ];
  for (const mutate of changes) { const c = challenge(); mutate(c); assert.throws(() => selectOnchainProofOffer(goal, enc(c))); }
  for (const invalid of ['', 'not-base64!', enc(challenge()) + '=', 'a'.repeat(9000), Buffer.from('{').toString('base64'), Buffer.from([0xff]).toString('base64')]) {
    assert.throws(() => selectOnchainProofOffer(goal, invalid));
  }
  const multi = challenge(); multi.accepts.unshift({ scheme: 'exact', network: 'near:testnet' });
  assert.deepEqual(selectOnchainProofOffer(goal, enc(multi)), offer);
});

test('dry run fetches one quote and checks policy, without signing, journaling or payment', async () => {
  const f = fixture(), result = await run(f, { execute: false });
  assert.equal(result.status, 'READY'); assert.deepEqual(result.offer, offer); assert.equal(f.quotes, 1);
  assert.equal(f.sends, 0); assert.equal(f.signs, 0); assert.equal(f.redemptions, 0); assert.equal(f.journal.list().length, 0);
});

test('one guarded nested payment and one seller redemption are durable and reusable without another request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onchain-proof-')), file = path.join(dir, 'journal.json');
  let journal = new FileJournal(file, goal.contract_id, goal.owner_account_id);
  try {
    const f = fixture({ journal }); const result = await run(f);
    assert.equal(result.status, 'RESPONDED'); assert.equal(result.settlement.amount, '1000');
    assert.equal(Buffer.from(result.response.body_base64, 'base64').toString(), '{"answer":42}');
    assert.equal(f.quotes, 1); assert.equal(f.sends, 1); assert.equal(f.signs, 1); assert.equal(f.redemptions, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    journal.close(); journal = new FileJournal(file, goal.contract_id, goal.owner_account_id); f.journal = journal;
    const r = await recover(f); assert.equal(r.redemption_status, 'delivered'); assert.deepEqual(r.response, result.response);
    assert.equal((await redeem(f)).status, 'REUSED');
    await assert.rejects(run(f), /existing journal entry/);
    assert.equal(f.quotes, 1); assert.equal(f.sends, 1); assert.equal(f.redemptions, 1);
  } finally { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lost payment response keeps original hash; key-free recovery and first redemption never repay', async () => {
  const f = fixture(); f.setLoss(true);
  await assert.rejects(run(f), /unresolved.*never resend automatically/);
  const hash = f.journal.get(goal.id).tx_hash; assert.equal(f.journal.get(goal.id).status, 'pending');
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 0);
  const r = await recover(f); assert.equal(r.settlement.tx_hash, hash); assert.equal(r.redemption_status, 'not_started');
  assert.equal((await redeem(f)).status, 'RESPONDED'); assert.equal(f.sends, 1); assert.equal(f.redemptions, 1);
  await assert.rejects(run(f), /existing journal entry/); assert.equal(f.quotes, 1);
});

test('lost seller response is journaled before disclosure; recovery cannot retry or repay', async () => {
  const f = fixture(); f.setHttpLoss(true);
  await assert.rejects(run(f), /redemption was attempted.*never repay or retry automatically/);
  assert.equal(f.journal.get(goal.id).status, 'completed'); assert.equal(f.journal.get(goal.id).redemption.status, 'attempted');
  assert.equal((await recover(f)).redemption_status, 'attempted');
  await assert.rejects(redeem(f), /already attempted/);
  await assert.rejects(run(f), /existing journal entry/);
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.quotes, 1);
});

test('unfinalized, altered or missing nested event stays unresolved and cannot redeem', async () => {
  const f = fixture(); f.setNoEvent(true);
  await assert.rejects(run(f), /missing unique matching Circle NEP-297/);
  assert.equal(f.journal.get(goal.id).status, 'pending'); assert.equal(f.redemptions, 0);
  await assert.rejects(recover(f), /NEP-297/); await assert.rejects(redeem(f), /NEP-297/);
  const bad = f.getChain(); bad.final_execution_status = 'EXECUTED_OPTIMISTIC'; f.setChain(bad);
  await assert.rejects(recover(f), /FINAL/); assert.equal(f.sends, 1);
});

test('settlement binds trusted token log to the exact guarded payment and graph', async () => {
  const f = fixture(); await run(f);
  const e = f.journal.get(goal.id), chain = f.getChain(), verify = result => verifyOnchainProofSettlement({
    result, goal, request: e.request, publicKey: e.agent_public_key, txHash: e.tx_hash });
  assert.equal(verify(chain).tx_hash, e.tx_hash);
  const changes = [
    c => { c.receipts_outcome[1].outcome.logs = []; },
    c => { c.receipts_outcome[1].outcome.logs.push(c.receipts_outcome[1].outcome.logs[0]); },
    c => { c.receipts_outcome[1].outcome.logs[0] = c.receipts_outcome[1].outcome.logs[0].replace('seller-nonce-abc', 'other'); },
    c => { c.receipts_outcome[1].outcome.executor_id = 'evil.testnet'; },
    c => { c.receipts_outcome[0].outcome.receipt_ids = ['callback']; },
    c => { c.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    c => { c.receipts_outcome[1].outcome.status = { Failure: {} }; },
    // A separate multi-action token receipt cannot lend an event to the
    // uniquely linked guarded transfer, whose own event has been removed.
    c => {
      const extra = structuredClone(c.receipts[0]); extra.receipt_id = 'unrelated';
      extra.receipt.Action.actions.push(structuredClone(extra.receipt.Action.actions[0]));
      c.receipts.unshift(extra);
      const o = structuredClone(c.receipts_outcome[1]); o.id = 'unrelated'; c.receipts_outcome.push(o);
      c.receipts_outcome[1].outcome.logs = [];
    },
  ];
  for (const mutate of changes) { const bad = structuredClone(chain); mutate(bad); assert.throws(() => verify(bad)); }
  assert.throws(() => verifyOnchainProofSettlement({ result: chain, goal: { ...goal, policy_id: 'other' }, request: e.request,
    publicKey: e.agent_public_key, txHash: e.tx_hash }), /does not match/);
});

test('journal rejects changed offer, reviewed goal, settlement, response and proof locator', async () => {
  const f = fixture(); await run(f); const saved = f.journal.get(goal.id);
  await assert.rejects(recover(f, { goal: { ...goal, resource_url: 'https://other.example/api' } }), /does not match/);
  for (const mutate of [
    e => { e.protocol.offer.payTo = 'attacker.testnet'; }, e => { e.protocol.offer.extra.nonce = 'other'; },
    e => { e.request.amount = '1'; }, e => { e.settlement.amount = '1'; },
    e => { e.redemption.body_base64 = Buffer.from('changed').toString('base64'); },
  ]) {
    const bad = structuredClone(saved); mutate(bad); f.journal.put(goal.id, bad); await assert.rejects(recover(f));
  }
  f.journal.put(goal.id, saved);
  const p = dec(buildOnchainProofHeader(goal, offer, saved.tx_hash));
  assert.equal(p.payload.txHash, `${goal.owner_account_id}:${saved.tx_hash}`);
  assert.throws(() => buildOnchainProofHeader(goal, { ...offer, payTo: 'evil.testnet' }, saved.tx_hash));
});

test('wrong chain, key scope, policy, registration or disk prevents any broadcast', async () => {
  for (const mutate of [
    f => { f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' }); },
    f => { f.provider.viewAccessKey = async () => ({ permission: 'FullAccess' }); },
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (...args) => args[1] === 'get_policy' ? { token: 'wrap.testnet' } : original(...args); },
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (...args) => args[1] === 'storage_balance_of' ? null : original(...args); },
    f => { f.account.signer.getPublicKey = async () => nearApi.KeyPair.fromRandom('ed25519').getPublicKey(); },
    f => { f.journal.put = () => { throw new Error('disk full'); }; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(run(f)); assert.equal(f.sends, 0); assert.equal(f.redemptions, 0); }
});

test('duplicate nonce and concurrent executions cannot create two payments within one journal', async () => {
  const f = fixture(); await run(f);
  await assert.rejects(run(f, { goal: { ...goal, id: 'api-2' } }), /seller challenge was already recorded/);
  assert.equal(f.sends, 1);
  const c = fixture(); const results = await Promise.allSettled([run(c), run(c)]);
  assert.equal(c.sends, 1); assert.equal(c.redemptions, 1);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('onchain-proof quote, payment, recovery and redemption share an exclusive journal operation', async () => {
  const f = fixture();
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const slow = async (url, options) => {
    assert.equal(Object.hasOwn(options, 'exclusiveJournalScope'), false);
    if (!options.headers) { reached(); await gate; }
    return f.fetchImpl(url, options);
  };
  const first = run(f, { fetchImpl: slow });
  try {
    await entered;
    await assert.rejects(run(f), /another payment operation is already running/);
    await assert.rejects(recover(f), /another payment operation is already running/);
    await assert.rejects(redeem(f), /another payment operation is already running/);
    assert.equal(f.sends, 0);
    assert.equal(f.redemptions, 0);
  } finally { release(); await first.catch(() => {}); }
  assert.equal((await first).status, 'RESPONDED');
  assert.equal(f.sends, 1);
  assert.equal(f.redemptions, 1);
  assert.equal((await recover(f)).status, 'RECONCILED');
});

test('onchain-proof prefers one-shot transport and does not fall back after an ambiguous send', async () => {
  const f = fixture();
  let oneShot = 0, legacy = 0;
  f.provider.sendTransactionOnce = async () => { oneShot++; throw new Error('synthetic lost one-shot response'); };
  f.provider.sendTransactionUntil = async () => { legacy++; throw new Error('unexpected fallback'); };
  await assert.rejects(run(f), /unresolved/);
  assert.equal(oneShot, 1); assert.equal(legacy, 0);
  assert.equal(f.journal.get(goal.id).status, 'pending'); assert.ok(f.journal.get(goal.id).tx_hash);
});

test('onchain-proof operation releases its lock on preflight errors', async () => {
  const f = fixture();
  await assert.rejects(run(f, { fetchImpl: async () => { throw new Error('synthetic unavailable'); } }), /synthetic unavailable/);
  assert.equal((await run(f)).status, 'RESPONDED');
  assert.equal(f.sends, 1);
});

test('non-idempotent concurrent redemption and oversized response are never auto-retried', async () => {
  const f = fixture(); f.setLoss(true); await assert.rejects(run(f)); await recover(f);
  let calls = 0;
  const slow = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return new Response('x'); };
  const results = await Promise.allSettled([redeem(f, { fetchImpl: slow }), redeem(f, { fetchImpl: slow })]);
  assert.equal(calls, 1); assert.ok(results.some(r => r.status === 'fulfilled')); assert.equal(f.sends, 1);
  const big = fixture(); big.setLoss(true); await assert.rejects(run(big)); await recover(big);
  await assert.rejects(redeem(big, { fetchImpl: async () => new Response('x'.repeat(65537)) }), /too large/);
  await assert.rejects(redeem(big), /already attempted/); assert.equal(big.sends, 1);
});
