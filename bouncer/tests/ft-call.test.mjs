import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { validateFtCallGoal, verifyFtCallSettlement, runFtCallGoal, recoverFtCallGoal } from '../agent/ft-call.mjs';

const key = 'ed25519:agent';
const hashBytes = Buffer.alloc(32, 44), hash = nearApi.utils.serialize.base_encode(hashBytes);
const initReceipt = '6'.repeat(44), tokenReceipt = '7'.repeat(44), callbackReceipt = '8'.repeat(44);
const goal = { id: 'api-credit', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'api',
  payee: 'vendor.testnet', token: 'usdc.fakes.testnet', amount: '100', msg: '{"action":"deposit_balance"}',
  policy_revision: 1, route_revision: 2 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const signedArgs = () => ({ policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
  expected_msg: goal.msg, expected_policy_revision: goal.policy_revision, expected_route_revision: goal.route_revision });
const transferArgs = () => ({ receiver_id: goal.payee, amount: goal.amount, memo: 'bouncer:guarded-ft-call', msg: goal.msg });
const callbackArgs = () => ({ policy_id: goal.policy_id, token: goal.token, amount: goal.amount, bucket: 24, policy_revision: goal.policy_revision });
function outcome(id, executor_id, status, logs = [], receipt_ids = []) { return { id, outcome: { executor_id, status, logs, receipt_ids } }; }
function receipt(id, predecessor_id, receiver_id, name, args, deposit) {
  return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions: [{ FunctionCall: { method_name: name, args: encode(args), deposit } }] } } };
}
function finalResult(used = '60') {
  const value = encode(used), unused = (100n - BigInt(used)).toString();
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_ft_call', deposit: '0', args: encode(signedArgs()) } }] },
    receipts_outcome: [
      outcome(initReceipt, goal.contract_id, { SuccessReceiptId: callbackReceipt }, ['BOUNCER guarded ft_transfer_call initiated; full amount reserved'], [tokenReceipt, callbackReceipt]),
      outcome(tokenReceipt, goal.token, { SuccessReceiptId: '9'.repeat(44) }),
      outcome(callbackReceipt, goal.contract_id, { SuccessValue: value }, [`BOUNCER ft_transfer_call settled; used=${used}; unused=${unused}`]),
    ],
    receipts: [receipt(tokenReceipt, goal.contract_id, goal.token, 'ft_transfer_call', transferArgs(), '1'),
      receipt(callbackReceipt, goal.contract_id, goal.contract_id, 'after_execute_ft_call', callbackArgs(), '0')],
  };
}
function fixture() {
  const state = new Map();
  const journal = { get(id) { return state.get(id); }, put(id, entry) { state.set(id, structuredClone(entry)); } };
  let sends = 0, reads = 0;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_ft_call'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v6';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: goal.token, per_tx_cap: '100', daily_cap: '300' };
      if (method === 'get_ft_call_route') return { token: goal.token, msg: goal.msg, policy_revision: goal.policy_revision, route_revision: goal.route_revision, active: true };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) {
      sends++; assert.deepEqual(signed, { signed: true }); assert.equal(wait, 'FINAL');
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash);
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(tx, owner, wait) { reads++; assert.equal(tx, hash); assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = { accountId: goal.owner_account_id,
    signer: { async getPublicKey() { return key; }, async signTransaction(tx) { assert.deepEqual(tx, { unsigned: true }); return [hashBytes, { signed: true }]; } },
    async createTransaction(receiver, actions, publicKey) {
      assert.equal(receiver, goal.contract_id); assert.equal(publicKey, key); assert.equal(actions.length, 1);
      const call = actions[0].functionCall;
      assert.equal(call.methodName, 'execute_ft_call'); assert.equal(call.deposit, 0n); assert.equal(call.gas, 300n * 10n ** 12n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), signedArgs());
      return { unsigned: true };
    },
  };
  return { provider, account, journal, state, sends: () => sends, reads: () => reads };
}
const run = (f, opts = {}) => runFtCallGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...opts });

test('FT goal is a bounded owner-pinned testnet order, including exact revisions and message', () => {
  assert.deepEqual(validateFtCallGoal(goal), goal);
  const invalid = [{ ...goal, amount: '0' }, { ...goal, amount: '-1' }, { ...goal, amount: '01' }, { ...goal, token: 'native' },
    { ...goal, payee: 'vendor.near' }, { ...goal, policy_revision: 0 }, { ...goal, route_revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...goal, msg: 'x'.repeat(2049) }, { ...goal, extra: true }, { ...goal, id: '../x' }];
  for (const item of invalid) assert.throws(() => validateFtCallGoal(item));
  assert.equal(validateFtCallGoal({ ...goal, msg: '' }).msg, '');
  assert.equal(validateFtCallGoal({ ...goal, token: 'a'.repeat(64) }).token, 'a'.repeat(64));
});

test('settlement uses NEP-141 amount USED and explicitly does not imply delivery', () => {
  assert.deepEqual(verifyFtCallSettlement(goal, finalResult(), key), { tx_hash: hash, token: goal.token, receiver: goal.payee,
    requested: '100', used: '60', unused: '40', verification: 'NEP-141 settlement via trusted RPC, token and Bouncer; no provider delivery verified' });
  const refund = finalResult('0');
  refund.receipts_outcome.push(outcome('9'.repeat(44), goal.payee, { Failure: { error: 'receiver refused' } }));
  assert.equal(verifyFtCallSettlement(goal, refund, key).unused, '100');
  assert.equal(verifyFtCallSettlement(goal, finalResult('100'), key).unused, '0');
});

test('new callback binds prepaid accounting to the reviewed payee and message, while legacy receipts remain recoverable', () => {
  const current = finalResult();
  current.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ ...callbackArgs(), payee: goal.payee, msg: goal.msg });
  assert.equal(verifyFtCallSettlement(goal, current, key).used, '60');
  current.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode({ ...callbackArgs(), payee: 'attacker.testnet', msg: goal.msg });
  assert.throws(() => verifyFtCallSettlement(goal, current, key), /callback/);
});

test('mismatched, malformed or unbound transaction and callback evidence fail closed', () => {
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.status.SuccessValue = encode(null); },
    r => { r.status.SuccessValue = encode('101'); }, r => { r.transaction.signer_id = 'attacker.testnet'; },
    r => { r.transaction.public_key = 'ed25519:other'; }, r => { r.transaction.actions.push(r.transaction.actions[0]); },
    r => { r.transaction.actions[0].FunctionCall.deposit = '1'; },
    r => { const a = signedArgs(); a.expected_msg = 'stolen'; r.transaction.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[0].outcome.logs = []; }, r => { r.receipts_outcome[0].outcome.receipt_ids = [tokenReceipt]; },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '0'; },
    r => { const a = transferArgs(); a.receiver_id = 'attacker.testnet'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { const a = transferArgs(); a.msg = 'stolen'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { const a = callbackArgs(); a.policy_revision++; r.receipts[1].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[2].outcome.logs = []; }, r => { r.receipts_outcome[2].outcome.status = { Failure: {} }; },
    r => { delete r.receipts; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); assert.throws(() => verifyFtCallSettlement(goal, result, key)); }
});

test('dry run checks exact route and spends nothing', async () => {
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('route changes and unsafe access keys block before signing or broadcast', async () => {
  for (const mutate of [
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (c, m, a, o) => m === 'get_ft_call_route' ? { token: goal.token, msg: 'other', policy_revision: 1, route_revision: 2, active: true } : original(c, m, a, o); },
    f => { const original = f.provider.callFunction; f.provider.callFunction = async (c, m, a, o) => m === 'get_ft_call_route' ? { token: goal.token, msg: goal.msg, policy_revision: 1, route_revision: 2, active: false } : original(c, m, a, o); },
    f => { f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_ft_call', 'set_policy'] } } }); },
  ]) { const f = fixture(); mutate(f); await assert.rejects(run(f, { execute: true })); assert.equal(f.sends(), 0); }
});

test('one broadcast is persisted first; key-free recovery verifies the same transaction', async () => {
  const f = fixture(), first = await run(f, { execute: true });
  assert.equal(first.status, 'SETTLED'); assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'completed');
  const again = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(again.status, 'REUSED'); assert.equal(again.settlement.tx_hash, hash); assert.equal(f.sends(), 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});

test('uncertain receipt leaves pending payment and recovery never resends', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => { const result = await read(...args); return { ...result, receipts: [] }; };
  await assert.rejects(run(f, { execute: true }), /FT call unresolved/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  f.provider.txStatusReceipts = read;
  const recovered = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.settlement.used, '60'); assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'completed');
});

test('send errors remain pending and changed goals or recorded settlements are never repaid', async () => {
  const f = fixture(); f.provider.sendTransactionUntil = async () => { throw new Error('timeout'); };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.journal.get(goal.id).status, 'pending');
  await assert.rejects(recoverFtCallGoal({ goal: { ...goal, amount: '99' }, provider: f.provider, journal: f.journal, log: () => {} }), /does not match/);
  const recovered = await recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.status, 'REUSED');
  const prior = f.journal.get(goal.id); f.journal.put(goal.id, { ...prior, settlement: { ...prior.settlement, used: '61' } });
  await assert.rejects(recoverFtCallGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /differs/);
});
