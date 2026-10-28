import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileJournal, runProcurement, validatePlan } from '../agent/procurement.mjs';

const basePlan = () => ({
  contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  requests: [
    { id: 'compute-1', resource: 'compute', policy_id: 'compute', token: 'wrap.testnet', payee: 'compute.testnet', amount: '100' },
    { id: 'storage-1', resource: 'storage', policy_id: 'storage', token: 'storage-token.testnet', payee: 'storage.testnet', amount: '200' },
    { id: 'api-1', resource: 'api', policy_id: 'api', token: 'api-token.testnet', payee: 'api.testnet', amount: '300' },
  ],
});
const publicKey = { toString: () => 'ed25519:agent-key' };
class MemoryJournal {
  entries = new Map();
  get(id) { return this.entries.get(id); }
  put(id, value) { this.entries.set(id, { ...value }); }
}
function fixture() {
  const policies = {
    compute: { token: 'wrap.testnet', per_tx_cap: '1000', daily_cap: '2000' },
    storage: { token: 'storage-token.testnet', per_tx_cap: '1000', daily_cap: '2000' },
    api: { token: 'api-token.testnet', per_tx_cap: '1000', daily_cap: '2000' },
  };
  const balances = new Map();
  const calls = [];
  let mode = '';
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() {
      return mode === 'full_key' ? { permission: 'FullAccess' } : {
        permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: mode === 'extra_method' ? ['execute', 'set_policy'] : ['execute'] } },
      };
    },
    async callFunction(contract, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v4';
      if (method === 'get_policy') return policies[args.policy_id] || null;
      if (method === 'is_agent_key_allowed') return mode !== 'not_granted';
      if (method === 'check') return mode === 'blocked' ? [false, 'over cap'] : [true, 'ok'];
      if (method === 'ft_balance_of') return (balances.get(`${contract}|${args.account_id}`) || 0n).toString();
      throw new Error(`unexpected ${method}`);
    },
  };
  const account = {
    accountId: 'owner.testnet',
    async callFunctionRaw(options) {
      calls.push(options);
      if (mode === 'timeout') throw new Error('RPC timeout');
      const token = options.args.expected_token;
      if (mode !== 'wrong_balance' && mode !== 'refund') {
        const k = `${token}|${options.args.payee}`;
        balances.set(k, (balances.get(k) || 0n) + BigInt(options.args.amount));
      }
      const receiptStatus = mode === 'unknown_receipt' ? 'Unknown' : mode === 'unresolved_token_receipt' ? { SuccessReceiptId: 'next' } : { SuccessValue: '' };
      const receipts = [{ outcome: { executor_id: token, status: receiptStatus, logs: [] } }];
      if (mode === 'refund') receipts.push({ outcome: { executor_id: token, status: { Failure: 'failed transfer' }, logs: [] } });
      return { final_execution_status: mode === 'not_final' ? 'EXECUTED_OPTIMISTIC' : mode === 'no_final_field' ? undefined : 'FINAL',
        status: mode === 'missing_success' ? 'Unknown' : mode === 'invalid_success' ? { SuccessValue: null } : { SuccessValue: '' },
        transaction_outcome: { id: `tx-${calls.length}` }, receipts_outcome: receipts };
    },
  };
  return { provider, account, calls, journal: new MemoryJournal(), setMode: value => { mode = value; } };
}
const run = (f, opts = {}) => runProcurement({
  plan: basePlan(), provider: f.provider, account: f.account, publicKey, journal: f.journal,
  execute: true, log: () => {}, ...opts,
});

test('runner submits three resource-labelled payments using a mock transport, then skips duplicates', async () => {
  const f = fixture();
  assert.deepEqual(await run(f), { paid: 3, blocked: 0, skipped: 0, ready: 0 });
  assert.deepEqual(f.calls.map(x => x.args.expected_token), ['wrap.testnet', 'storage-token.testnet', 'api-token.testnet']);
  assert.ok(f.calls.every(x => x.deposit === 0n && x.methodName === 'execute' && x.waitUntil === 'FINAL'));
  assert.deepEqual(await run(f), { paid: 0, blocked: 0, skipped: 3, ready: 0 });
  assert.equal(f.calls.length, 3);
});

test('dry run performs preflight only and does not write journal entries', async () => {
  const f = fixture();
  assert.deepEqual(await run(f, { execute: false }), { paid: 0, blocked: 0, skipped: 0, ready: 3 });
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.entries.size, 0);
});

test('rejects an RPC that does not report testnet before reading policies or paying', async () => {
  const f = fixture();
  let otherCalls = 0;
  f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  f.provider.callFunction = async () => { otherCalls++; return 'bouncer-agent-v4'; };
  await assert.rejects(() => run(f), /RPC must report the NEAR testnet chain/);
  assert.equal(otherCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.entries.size, 0);
});

test('never uses a full-access or over-broad key', async () => {
  const f = fixture();
  for (const mode of ['full_key', 'extra_method']) {
    f.setMode(mode);
    await assert.rejects(() => run(f), /function-call key scoped ONLY to execute/);
  }
  assert.equal(f.calls.length, 0);
});

test('rejects a mismatched policy token and an ungranted key before sending', async () => {
  const f = fixture();
  const wrong = basePlan(); wrong.requests[0].token = 'different.testnet';
  await assert.rejects(() => run(f, { plan: wrong }), /expected token does not match/);
  f.setMode('not_granted');
  await assert.rejects(() => run(f), /not granted/);
  assert.equal(f.calls.length, 0);
});

test('a blocked preflight is visible and never submits a transaction', async () => {
  const f = fixture(); f.setMode('blocked');
  assert.deepEqual(await run(f), { paid: 0, blocked: 3, skipped: 0, ready: 0 });
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal.entries.size, 0);
});

test('a timeout leaves the request pending and a second run refuses to retry', async () => {
  const f = fixture(); f.setMode('timeout');
  await assert.rejects(() => run(f), /journal may be pending or uncertain/);
  assert.equal(f.journal.get('compute-1').status, 'pending');
  f.setMode('');
  await assert.rejects(() => run(f), /unresolved pending payment/);
  assert.equal(f.calls.length, 1);
});

test('failed, incomplete or unknown receipts and incorrect balances remain pending with a transaction hash', async () => {
  for (const mode of ['refund', 'wrong_balance', 'unknown_receipt', 'unresolved_token_receipt', 'not_final', 'no_final_field', 'missing_success', 'invalid_success']) {
    const f = fixture(); f.setMode(mode);
    await assert.rejects(() => run(f), /payment could not be confirmed/);
    assert.equal(f.journal.get('compute-1').status, 'pending');
    assert.equal(f.journal.get('compute-1').tx_hash, 'tx-1');
  }
});

test('rejects duplicate IDs and unsafe amount representations', () => {
  const duplicate = basePlan(); duplicate.requests[1].id = duplicate.requests[0].id;
  assert.throws(() => validatePlan(duplicate), /duplicate/);
  for (const value of ['-1', '0', '1.5', '1e6', 100, (1n << 128n).toString()]) {
    const plan = basePlan(); plan.requests[0].amount = value;
    assert.throws(() => validatePlan(plan), /amount/);
  }
});

test('file journal syncs its file and containing directory before returning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-journal-sync-'));
  const journal = new FileJournal(path.join(dir, 'state.json'), 'bouncer.testnet', 'owner.testnet');
  const sync = fs.fsyncSync, kinds = [];
  try {
    fs.fsyncSync = fd => { kinds.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return sync(fd); };
    journal.put('order1', { fingerprint: 'abc', status: 'pending' });
    assert.deepEqual(kinds, ['file', 'directory']);
  } finally { fs.fsyncSync = sync; journal.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('journal sync failure blocks the first broadcast, even after an atomic rename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-journal-fail-'));
  const file = path.join(dir, 'state.json');
  const journal = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
  const f = fixture(); f.journal = journal;
  const sync = fs.fsyncSync; let syncs = 0;
  try {
    fs.fsyncSync = fd => { if (++syncs === 2) throw new Error('directory sync failed'); return sync(fd); };
    await assert.rejects(run(f), /directory sync failed/);
    assert.equal(f.calls.length, 0);
    assert.throws(() => journal.get('compute-1'), /failed write.*reopen/);
    await assert.rejects(run(f), /failed write.*reopen/);
    assert.equal(f.calls.length, 0, 'a poisoned in-memory journal cannot be reused to pay');
  } finally { fs.fsyncSync = sync; journal.close(); }
  try {
    const reopened = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
    assert.equal(reopened.get('compute-1').status, 'pending', 'a rename may have succeeded even if directory sync failed');
    await assert.rejects(run({ ...f, journal: reopened }), /unresolved pending/);
    assert.equal(f.calls.length, 0);
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sync failure after payment poisons the journal; reopening never repays a recorded completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-journal-after-pay-'));
  const file = path.join(dir, 'state.json');
  const journal = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
  const f = fixture(); f.journal = journal;
  const one = basePlan(); one.requests = one.requests.slice(0, 1);
  const sync = fs.fsyncSync; let syncs = 0;
  try {
    // Pending, transaction hash, then completed: fail after the final rename.
    fs.fsyncSync = fd => { if (++syncs === 6) throw new Error('directory sync failed after payment'); return sync(fd); };
    await assert.rejects(run(f, { plan: one }), /journal may be pending or uncertain/);
    assert.equal(f.calls.length, 1);
    await assert.rejects(run(f, { plan: one }), /failed write.*reopen/);
    assert.equal(f.calls.length, 1);
  } finally { fs.fsyncSync = sync; journal.close(); }
  try {
    const reopened = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
    assert.equal(reopened.get('compute-1').status, 'completed');
    const outcome = await run({ ...f, journal: reopened }, { plan: one });
    assert.equal(outcome.skipped, 1); assert.equal(outcome.paid, 0);
    assert.equal(f.calls.length, 1);
    reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file journal persists atomically and blocks a concurrent runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-journal-'));
  const file = path.join(dir, 'state.json');
  try {
    const first = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
    first.put('order1', { fingerprint: 'abc', status: 'pending' });
    assert.throws(() => new FileJournal(file, 'bouncer.testnet', 'owner.testnet'), /EEXIST/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    first.close();
    const second = new FileJournal(file, 'bouncer.testnet', 'owner.testnet');
    assert.equal(second.get('order1').status, 'pending');
    second.close();
    assert.throws(() => new FileJournal(file, 'other.testnet', 'owner.testnet'), /different contract/);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
