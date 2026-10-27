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
    async viewAccessKey() {
      return mode === 'full_key' ? { permission: 'FullAccess' } : {
        permission: { FunctionCall: { receiver_id: 'bouncer.testnet', method_names: mode === 'extra_method' ? ['execute', 'set_policy'] : ['execute'] } },
      };
    },
    async callFunction(contract, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v3';
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
      const receipts = [{ outcome: { executor_id: token, status: { SuccessValue: '' }, logs: [] } }];
      if (mode === 'refund') receipts.push({ outcome: { executor_id: token, status: { Failure: 'failed transfer' }, logs: [] } });
      return { transaction_outcome: { id: `tx-${calls.length}` }, receipts_outcome: receipts };
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
  await assert.rejects(() => run(f), /journal remains pending/);
  assert.equal(f.journal.get('compute-1').status, 'pending');
  f.setMode('');
  await assert.rejects(() => run(f), /unresolved pending payment/);
  assert.equal(f.calls.length, 1);
});

test('failed receipts and incorrect vendor balances stay pending with a transaction hash', async () => {
  for (const mode of ['refund', 'wrong_balance']) {
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
