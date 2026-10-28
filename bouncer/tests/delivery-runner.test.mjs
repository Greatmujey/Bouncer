import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileJournal } from '../agent/procurement.mjs';
import { runResourceAgent } from '../agent/resource-agent.mjs';
import { orderMemo } from '../services/resource-provider.mjs';
import { computeResult } from './mock-delivery.mjs';

const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const key = { toString: () => 'ed25519:test' };
const makeGoal = (id = 'compute-1') => ({ id, resource: 'compute', input: { text: 'work', rounds: 2 },
  policy_id: 'compute', token: 'wrap.testnet', payee: 'vendor.testnet', max_amount: '100' });
function fixture(dir, goal = makeGoal()) {
  let paid = 0, balance = 0n, quoteCalls = 0;
  const journalPath = path.join(dir, 'journal.json');
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: ['execute'] } } }; },
    async callFunction(_contract, method) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') return { token: 'wrap.testnet', per_tx_cap: '1000', daily_cap: '1000' };
      if (method === 'daily_spent') return balance.toString();
      if (method === 'vault_balance') return (1000n - balance).toString();
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'ft_balance_of') return balance.toString();
      throw new Error(`unexpected view ${method}`);
    },
  };
  const account = { accountId: 'bouncer.testnet', async callFunctionRaw() {
    paid++; balance += 80n;
    return { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { id: `tx-${paid}` }, receipts_outcome: [{ outcome: { executor_id: 'wrap.testnet', status: { SuccessValue: '' } } }] };
  } };
  const getQuote = async ({ resource, input }) => {
    quoteCalls++;
    return { resource, policy_id: goal.policy_id, token: goal.token, payee: goal.payee, amount: '80', memo: orderMemo(resource, input) };
  };
  const options = { contractId: 'bouncer.testnet', ownerAccountId: 'bouncer.testnet', providerUrl: 'https://provider.example', goals: [goal],
    getQuote, fulfill: async ({ input }) => computeResult(input), provider, account, publicKey: key, execute: true, log: () => {} };
  return { journalPath, options, get paid() { return paid; }, get quoteCalls() { return quoteCalls; }, open: () => new FileJournal(journalPath, 'bouncer.testnet', 'bouncer.testnet') };
}
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-delivery-test-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('a wrong compute result leaves a paid unverified record; restart recovers without requote or repayment', () => withDir(async dir => {
  const f = fixture(dir); let journal = f.open();
  const bad = { ...f.options, journal, fulfill: async ({ input }) => ({ ...computeResult(input), result: '0'.repeat(64) }) };
  await assert.rejects(runResourceAgent(bad), /verification failed after confirmed payment.*independent recomputation/);
  assert.equal(f.paid, 1);
  const failed = journal.get('compute-1');
  assert.equal(failed.status, 'completed');
  assert.equal(failed.tx_hash, 'tx-1');
  assert.deepEqual(failed.provider_route, { provider_id: null, provider_origin: 'https://provider.example' });
  assert.equal(failed.delivery.status, 'unverified');
  assert.equal(failed.delivery.stage, 'verification');
  assert.equal(failed.request.amount, '80');
  assert.equal(fs.statSync(f.journalPath).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(failed.delivery).includes('000000'), false);
  journal.close();

  journal = f.open();
  const noQuote = async () => { throw new Error('quote endpoint unavailable'); };
  await assert.rejects(runResourceAgent({ ...f.options, journal, providerUrl: 'https://other.example', getQuote: noQuote,
    fulfill: async () => { throw new Error('must not disclose the order'); } }), /recorded provider route/);
  assert.equal(f.paid, 1);
  const recovered = await runResourceAgent({ ...f.options, journal, getQuote: noQuote });
  assert.equal(recovered.payments.skipped, 1); assert.equal(recovered.payments.paid, 0);
  assert.equal(f.paid, 1); assert.equal(f.quoteCalls, 1);
  const receipt = journal.get('compute-1').delivery.receipt;
  assert.equal(receipt.tx_hash, 'tx-1');
  assert.equal(receipt.contract_id, 'bouncer.testnet');
  assert.equal(receipt.provider_origin, 'https://provider.example');
  assert.equal(receipt.request.payee, 'vendor.testnet');
  assert.equal(receipt.request.amount, '80');
  assert.equal(receipt.request.memo, orderMemo('compute', f.options.goals[0].input));
  assert.equal(receipt.verification.scope, 'iterated-sha256');
  assert.deepEqual(receipt.result, computeResult(f.options.goals[0].input));
  journal.close();

  journal = f.open();
  const again = await runResourceAgent({ ...f.options, journal, getQuote: noQuote });
  assert.equal(again.payments.skipped, 1);
  assert.deepEqual(journal.get('compute-1').delivery.receipt, receipt);
  assert.equal(f.paid, 1);
  await assert.rejects(runResourceAgent({ ...f.options, journal, getQuote: noQuote,
    goals: [{ ...f.options.goals[0], input: { text: 'different', rounds: 2 } }] }), /recorded payment does not match/);
  assert.equal(f.paid, 1);
  journal.close();
}));

test('first-run verification gates every later payment and restart resumes the same batch', () => withDir(async dir => {
  const f = fixture(dir); let journal = f.open();
  const goals = [makeGoal('compute-1'), makeGoal('compute-2'), makeGoal('compute-3')];
  const events = [], pay = f.options.account.callFunctionRaw;
  f.options.account.callFunctionRaw = async (...args) => { events.push(`pay:${args[0].args.memo}`); return pay(...args); };
  const badFulfill = async ({ input }, { goalId }) => {
    events.push(`deliver:${goalId}`);
    const result = computeResult(input);
    return goalId === 'compute-1' ? { ...result, result: '0'.repeat(64) } : result;
  };
  await assert.rejects(runResourceAgent({ ...f.options, goals, journal, fulfill: badFulfill }), /verification failed after confirmed payment/);
  assert.equal(f.paid, 1);
  assert.equal(journal.get('compute-1').delivery.status, 'unverified');
  assert.equal(journal.get('compute-2'), undefined);
  assert.equal(journal.get('compute-3'), undefined);
  assert.equal(events.length, 2);
  assert.equal(events[1], 'deliver:compute-1');
  const firstTx = journal.get('compute-1').tx_hash;
  journal.close(); journal = f.open();
  const getQuote = async (order, { goalId }) => {
    if (goalId === 'compute-1') throw new Error('already paid request must not be requoted');
    return f.options.getQuote(order);
  };
  events.length = 0;
  const recovered = await runResourceAgent({ ...f.options, goals, journal, getQuote,
    fulfill: async ({ input }, { goalId }) => { events.push(`deliver:${goalId}`); return computeResult(input); } });
  assert.equal(recovered.payments.skipped, 1); assert.equal(recovered.payments.paid, 2);
  assert.equal(journal.get('compute-1').tx_hash, firstTx);
  assert.equal(f.paid, 3);
  assert.deepEqual(events.map(event => event.startsWith('pay:') ? 'pay' : event),
    ['deliver:compute-1', 'pay', 'deliver:compute-2', 'pay', 'deliver:compute-3']);
  assert.ok(goals.every(goal => journal.get(goal.id).delivery.status === 'verified'));
  journal.close();
}));

test('a failure to persist a verified receipt stops before another payment', () => withDir(async dir => {
  const f = fixture(dir), journal = f.open();
  const put = journal.put.bind(journal);
  journal.put = (id, entry) => { if (entry.delivery?.status === 'verified') throw new Error('receipt disk failure'); return put(id, entry); };
  const goals = [makeGoal('compute-1'), makeGoal('compute-2')];
  await assert.rejects(runResourceAgent({ ...f.options, goals, journal }), /receipt disk failure/);
  assert.equal(f.paid, 1);
  assert.equal(journal.get('compute-1').status, 'completed');
  assert.equal(journal.get('compute-2'), undefined);
  journal.close();
}));

test('a later bad delivery leaves prior verified work intact and does not pay remaining goals', () => withDir(async dir => {
  const f = fixture(dir), journal = f.open();
  const goals = [makeGoal('compute-1'), makeGoal('compute-2'), makeGoal('compute-3')];
  const fulfill = async ({ input }, { goalId }) => goalId === 'compute-2'
    ? { ...computeResult(input), result: '0'.repeat(64) } : computeResult(input);
  await assert.rejects(runResourceAgent({ ...f.options, goals, journal, fulfill }), /verification failed after confirmed payment/);
  assert.equal(f.paid, 2);
  assert.equal(journal.get('compute-1').delivery.status, 'verified');
  assert.equal(journal.get('compute-2').delivery.status, 'unverified');
  assert.equal(journal.get('compute-3'), undefined);
  const previousHashes = [journal.get('compute-1').tx_hash, journal.get('compute-2').tx_hash];
  const recovered = await runResourceAgent({ ...f.options, goals, journal });
  assert.equal(recovered.payments.skipped, 2); assert.equal(recovered.payments.paid, 1);
  assert.deepEqual([journal.get('compute-1').tx_hash, journal.get('compute-2').tx_hash], previousHashes);
  assert.equal(f.paid, 3);
  journal.close();
}));

test('an earlier unverified delivery is checked again before any new batch payment', () => withDir(async dir => {
  const f = fixture(dir); const journal = f.open();
  const badFulfill = async ({ input }) => ({ ...computeResult(input), result: '0'.repeat(64) });
  await assert.rejects(runResourceAgent({ ...f.options, journal, fulfill: badFulfill }), /verification failed/);
  assert.equal(f.paid, 1);
  await assert.rejects(runResourceAgent({ ...f.options, journal, goals: [makeGoal(), makeGoal('compute-2')], fulfill: badFulfill }), /verification failed/);
  assert.equal(f.paid, 1, 'the second goal must not be paid while the earlier result is still invalid');
  assert.equal(journal.get('compute-2'), undefined);
  const recovered = await runResourceAgent({ ...f.options, journal, goals: [makeGoal(), makeGoal('compute-2')] });
  assert.equal(recovered.payments.skipped, 1);
  assert.equal(recovered.payments.paid, 1);
  assert.equal(f.paid, 2);
  journal.close();
}));

test('receipt corruption blocks a later batch before any new payment', () => withDir(async dir => {
  const f = fixture(dir); let journal = f.open();
  await runResourceAgent({ ...f.options, journal });
  journal.close();
  const saved = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
  saved.entries[0].delivery.receipt.provider_origin = 'https://attacker.example';
  fs.writeFileSync(f.journalPath, JSON.stringify(saved), { mode: 0o600 });
  journal = f.open();
  await assert.rejects(runResourceAgent({ ...f.options, journal, goals: [makeGoal(), makeGoal('compute-2')] }), /receipt does not match/);
  assert.equal(f.paid, 1);
  journal.close();
}));

test('a tampered recorded request is rejected when reopening the journal', () => withDir(async dir => {
  const f = fixture(dir); const journal = f.open();
  await runResourceAgent({ ...f.options, journal }); journal.close();
  const saved = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
  saved.entries[0].request.amount = '81';
  fs.writeFileSync(f.journalPath, JSON.stringify(saved), { mode: 0o600 });
  assert.throws(() => f.open(), /recorded request does not match/);
  assert.equal(fs.existsSync(`${f.journalPath}.lock`), false);
  assert.equal(f.paid, 1);
}));

test('legacy journals without a recorded request still require the exact original quote', () => withDir(async dir => {
  const f = fixture(dir); let journal = f.open();
  await runResourceAgent({ ...f.options, journal }); journal.close();
  const saved = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
  delete saved.entries[0].request;
  delete saved.entries[0].provider_route;
  delete saved.entries[0].delivery;
  fs.writeFileSync(f.journalPath, JSON.stringify(saved), { mode: 0o600 });
  journal = f.open();
  const badQuote = async order => ({ ...(await f.options.getQuote(order)), amount: '90' });
  await assert.rejects(runResourceAgent({ ...f.options, journal, getQuote: badQuote }), /journal entry does not match/);
  const replay = await runResourceAgent({ ...f.options, journal });
  assert.equal(replay.payments.skipped, 1);
  assert.equal(f.paid, 1);
  journal.close();
}));

test('unresolved payment stops before a quote, and missing storage readback stops before payment', () => withDir(async dir => {
  const f = fixture(dir); const journal = f.open();
  journal.put('compute-1', { status: 'pending', fingerprint: 'unknown' });
  await assert.rejects(runResourceAgent({ ...f.options, journal }), /unresolved pending/);
  assert.equal(f.quoteCalls, 0); assert.equal(f.paid, 0);
  journal.close();
  const storage = { ...makeGoal('storage-1'), resource: 'storage', input: { name: 'note', content: 'hello' } };
  const g = fixture(path.join(dir, 'storage'), storage); const j = g.open();
  await assert.rejects(runResourceAgent({ ...g.options, journal: j }), /requires provider readback before payment/);
  assert.equal(g.quoteCalls, 0); assert.equal(g.paid, 0);
  j.close();
}));

test('bad storage readback remains unverified; the same payment can later produce a receipt', () => withDir(async dir => {
  const goal = { ...makeGoal('storage-1'), resource: 'storage', input: { name: 'note', content: 'hello' } };
  const f = fixture(dir, goal); let journal = f.open();
  const fulfill = async ({ tx_hash, input }) => ({ type: 'storage', object_id: hash(`${tx_hash}:${input.name}`),
    sha256: hash(input.content), bytes: Buffer.byteLength(input.content) });
  await assert.rejects(runResourceAgent({ ...f.options, journal, fulfill, readStorage: async () => Buffer.from('wrong') }), /storage readback/);
  assert.equal(journal.get('storage-1').delivery.status, 'unverified');
  assert.equal(f.paid, 1); journal.close();
  journal = f.open();
  const result = await runResourceAgent({ ...f.options, journal, fulfill, getQuote: async () => { throw new Error('no quote'); },
    readStorage: async () => Buffer.from('hello') });
  assert.equal(result.payments.skipped, 1); assert.equal(f.paid, 1);
  assert.equal(journal.get('storage-1').delivery.receipt.verification.scope, 'single-read-content');
  const receipt = structuredClone(journal.get('storage-1').delivery.receipt);
  await assert.rejects(runResourceAgent({ ...f.options, journal, fulfill, getQuote: async () => { throw new Error('no quote'); },
    readStorage: async () => Buffer.from('tampered') }), /storage readback/);
  assert.deepEqual(journal.get('storage-1').delivery.receipt, receipt, 'a failed later replay must not overwrite the prior receipt');
  assert.equal(f.paid, 1);
  journal.close();
}));

test('GitHub mismatch is not marked verified; a later identity match uses the same payment', () => withDir(async dir => {
  const goal = { ...makeGoal('api-1'), resource: 'api', input: { repo: 'near/near-api-js' } };
  const f = fixture(dir, goal); const journal = f.open();
  const data = { type: 'api', operation: 'github-repository', repository: 'near/near-api-js', repository_id: 123,
    description: null, stars: 7, forks: 2, open_issues: 1, license: 'MIT', retrieved_at: '2026-10-28T12:00:00.000Z' };
  const opts = { ...f.options, journal, fulfill: async () => data };
  await assert.rejects(runResourceAgent({ ...opts, repositoryLookup: async () => ({ ...data, repository_id: 999 }) }), /identity/);
  assert.equal(journal.get('api-1').delivery.status, 'unverified'); assert.equal(f.paid, 1);
  const result = await runResourceAgent({ ...opts, getQuote: async () => { throw new Error('no quote'); }, repositoryLookup: async () => ({ ...data, stars: 8 }) });
  assert.equal(result.payments.skipped, 1); assert.equal(f.paid, 1);
  assert.equal(journal.get('api-1').delivery.receipt.verification.scope, 'repository-identity-only');
  journal.close();
}));
