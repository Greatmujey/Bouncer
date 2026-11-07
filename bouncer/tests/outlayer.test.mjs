import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutlayerGoal, verifyOutlayerResult, runOutlayerGoal, recoverOutlayerGoal } from '../agent/outlayer.mjs';
import { signingFixture } from './signing-fixture.mjs';
const bouncerReceipt = '6'.repeat(44), requestReceipt = '7'.repeat(44);
const completedReceipt = '8'.repeat(44), refundReceipt = '9'.repeat(44);
const goal = {
  id: 'random-1', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  policy_id: 'external-compute', amount: '100', input: { min: 1, max: 100 },
  program: { url: 'https://example.org/pinned.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip1',
    max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 },
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
const source = () => ({ WasmUrl: { url: goal.program.url, hash: goal.program.sha256, build_target: goal.program.build_target } });
const limits = () => ({ max_instructions: goal.program.max_instructions, max_memory_mb: goal.program.max_memory_mb,
  max_execution_seconds: goal.program.max_execution_seconds });
const signedArgs = () => ({ policy_id: goal.policy_id, amount: goal.amount, input_data: JSON.stringify(goal.input), expected_program: goal.program });
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_outlayer', args: signedArgs() });
const { key, hash } = signing;
const outlayerArgs = () => ({ source: source(), resource_limits: limits(), input_data: JSON.stringify(goal.input),
  secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: null });
function outcome(id, executor_id, status, logs = []) { return { id, outcome: { executor_id, status, logs } }; }
function receipt(id, predecessor_id, receiver_id, actions) {
  return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } };
}
function finalResult() {
  const output = encode({ random_number: 48 });
  const requestData = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount,
    input_data: JSON.stringify(goal.input), code_source: source() };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  return {
    final_execution_status: 'FINAL', status: { SuccessValue: output }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer', deposit: '0', args: encode(signedArgs()) } }] },
    receipts_outcome: [
      outcome(bouncerReceipt, goal.contract_id, { SuccessReceiptId: requestReceipt }, ['BOUNCER independent compute initiated; full maximum reserved']),
      outcome(requestReceipt, 'outlayer.testnet', { SuccessReceiptId: completedReceipt }, [event('execution_requested', { request_data: JSON.stringify(requestData) })]),
      outcome(completedReceipt, 'outlayer.testnet', { SuccessValue: output }, [event('execution_completed', completion)]),
      outcome(refundReceipt, goal.owner_account_id, { SuccessValue: '' }),
    ],
    receipts: [
      receipt(requestReceipt, goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: '100', args: encode(outlayerArgs()) } }]),
      receipt(refundReceipt, 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }]),
    ],
  };
}
function fixture() {
  const state = new Map();
  const journal = { get(id) { return state.get(id); }, put(id, entry) { state.set(id, structuredClone(entry)); } };
  let sends = 0, reads = 0;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v5';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: 'native', per_tx_cap: '100', daily_cap: '300' };
      if (method === 'get_outlayer_program') return structuredClone(goal.program);
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionOnce(signed, wait) {
      sends++; assert.equal(wait, 'FINAL'); assert.equal(signed.transaction.receiverId, goal.contract_id);
      assert.equal(journal.get(goal.id).status, 'pending');
      assert.equal(journal.get(goal.id).tx_hash, hash); // persisted before broadcast
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(tx, account, wait) { reads++; assert.equal(tx, hash); assert.equal(account, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = signing.newAccount();
  return { provider, account, journal, state, sends: () => sends, reads: () => reads };
}
const run = (f, options = {}) => runOutlayerGoal({ goal, publicKey: key, provider: f.provider, account: f.account, journal: f.journal, log: () => {}, ...options });

test('verifies a guarded provider execution, exact receipt, positive charge and owner refund', () => {
  const result = verifyOutlayerResult(goal, finalResult(), key);
  assert.equal(result.tx_hash, hash);
  assert.equal(result.result.random_number, 48);
  assert.equal(result.charged_yocto, '10');
  assert.equal(result.refunded_to_owner_yocto, '90');
  assert.match(result.verification, /no TEE or randomness proof/);
});

test('rejects misleading, incomplete or mismatched chain evidence', () => {
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED'; },
    r => { r.transaction.signer_id = 'attacker.testnet'; },
    r => { r.transaction.public_key = 'ed25519:other'; },
    r => { r.transaction.actions.push(r.transaction.actions[0]); },
    r => { r.transaction.actions[0].FunctionCall.deposit = '1'; },
    r => { r.receipts_outcome[0].outcome.logs = []; },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '101'; },
    r => { const a = outlayerArgs(); a.payer_account_id = 'attacker.testnet'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { const a = outlayerArgs(); a.source.WasmUrl.hash = 'b'.repeat(64); r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[1].outcome.logs = []; },
    r => { r.receipts_outcome[2].outcome.logs.push(...r.receipts_outcome[1].outcome.logs); r.receipts_outcome[1].outcome.logs = []; },
    r => { r.receipts_outcome[2].outcome.logs = []; },
    r => { r.receipts[1].receiver_id = 'attacker.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].Transfer.deposit = '89'; },
    r => { r.receipts_outcome[3].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[2].outcome.logs = [event('execution_completed', { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '0', payment_refunded: '100' })]; },
    r => { r.status.SuccessValue = encode({ random_number: 101 }); r.receipts_outcome[2].outcome.status.SuccessValue = r.status.SuccessValue; },
    r => { r.status.SuccessValue = encode(null); r.receipts_outcome[2].outcome.status.SuccessValue = r.status.SuccessValue; },
    r => { delete r.receipts; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); assert.throws(() => verifyOutlayerResult(goal, result, key)); }
});

test('validates owner-pinned testnet goals and bounded random tasks', () => {
  assert.deepEqual(validateOutlayerGoal(goal), goal);
  const variants = [
    { ...goal, owner_account_id: 'owner.near' }, { ...goal, contract_id: 'bad' },
    { ...goal, amount: '0' }, { ...goal, amount: '01' }, { ...goal, amount: '-1' },
    { ...goal, input: { min: 100, max: 1 } }, { ...goal, input: { min: 1, max: 100, url: 'evil' } },
    { ...goal, program: { ...goal.program, url: 'http://example.org/a.wasm' } },
    { ...goal, program: { ...goal.program, url: 'https://user:pass@example.org/a' } },
    { ...goal, program: { ...goal.program, sha256: 'A'.repeat(64) } },
    { ...goal, program: { ...goal.program, build_target: 'wasm32-unknown-unknown' } },
    { ...goal, program: { ...goal.program, max_instructions: 0 } }, { ...goal, extra: true },
  ];
  for (const variant of variants) assert.throws(() => validateOutlayerGoal(variant));
});

test('dry run checks all policy bindings and sends nothing', async () => {
  const f = fixture();
  assert.deepEqual(await run(f), { status: 'READY' });
  assert.equal(f.sends(), 0);
  assert.equal(f.state.size, 0);
});

test('one send is journaled before broadcast; recovery reuses the exact transaction', async () => {
  const f = fixture();
  const first = await run(f, { execute: true });
  assert.equal(first.status, 'FULFILLED'); assert.equal(f.sends(), 1);
  assert.equal(f.journal.get(goal.id).status, 'completed');
  const next = await run(f, { execute: true });
  assert.equal(next.status, 'REUSED'); assert.equal(f.sends(), 1); assert.equal(f.reads(), 2);
});

test('dry-run recovery of an existing OutLayer hash is read-only', async () => {
  const f = fixture(); let sends = 0;
  f.provider.sendTransactionOnce = async () => { sends++; throw new Error('response lost'); };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  const pending = structuredClone(f.journal.get(goal.id));
  f.journal.put(goal.id, { ...pending, status: 'invalid' });
  await assert.rejects(run(f), /invalid journal status/); f.journal.put(goal.id, pending);
  assert.equal((await run(f)).status, 'REUSED');
  assert.deepEqual(f.journal.get(goal.id), pending); assert.equal(sends, 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED');
  assert.equal(f.journal.get(goal.id).status, 'completed'); assert.equal(sends, 1);
});

test('ambiguous broadcast has a pre-signed hash and can recover without a signer or another payment', async () => {
  const f = fixture(); let broadcasts = 0;
  f.provider.sendTransactionOnce = async () => {
    broadcasts++; assert.equal(f.journal.get(goal.id).tx_hash, hash);
    throw new Error('network timeout after possible broadcast');
  };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.journal.get(goal.id).status, 'pending');
  assert.equal(f.journal.get(goal.id).tx_hash, hash);
  // Recovery does not query the current access key, contract policy or signer.
  f.provider.viewAccessKey = async () => { throw new Error('key revoked'); };
  f.provider.callFunction = async () => { throw new Error('policy changed'); };
  assert.equal((await recoverOutlayerGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} })).status, 'REUSED');
  assert.equal(f.journal.get(goal.id).status, 'completed');
  assert.equal(broadcasts, 1);
});

test('unverified result stays pending with its hash; recovery never sends twice', async () => {
  const f = fixture();
  f.provider.txStatusReceipts = async () => { const r = finalResult(); r.receipts[1].receiver_id = 'attacker.testnet'; return r; };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending'); assert.equal(f.journal.get(goal.id).tx_hash, hash);
  f.provider.txStatusReceipts = async () => finalResult();
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});

test('recovery rejects an RPC response for another otherwise matching transaction', async () => {
  const f = fixture();
  f.provider.txStatusReceipts = async () => { const r = finalResult(); r.transaction.hash = 'A'.repeat(44); r.transaction_outcome.id = r.transaction.hash; return r; };
  await assert.rejects(run(f, { execute: true }), /different transaction/);
  assert.equal(f.sends(), 1);
  assert.equal(f.journal.get(goal.id).tx_hash, hash);
  await assert.rejects(recoverOutlayerGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /different transaction/);
  assert.equal(f.sends(), 1);
});

test('stops before payment on wrong chain, excess key permission or altered program', async () => {
  const f = fixture();
  f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(run(f, { execute: true }), /testnet/);
  f.provider.viewNodeStatus = async () => ({ chain_id: 'testnet' });
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer', 'set_policy'] } } });
  await assert.rejects(run(f, { execute: true }), /scoped ONLY/);
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer'] } } });
  const call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'get_outlayer_program' ? { ...goal.program, sha256: 'b'.repeat(64) } : call(id, method, ...rest);
  await assert.rejects(run(f, { execute: true }), /does not match/);
  assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('blocked on-chain policy does not send or create a journal entry', async () => {
  const f = fixture(); const call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'check' ? [false, 'cap exceeded'] : call(id, method, ...rest);
  assert.deepEqual(await run(f, { execute: true }), { status: 'BLOCKED' });
  assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('native OutLayer runner rejects altered transactions and signatures before journal or broadcast', async () => {
  for (const mutate of [
    tx => { tx.receiverId = 'other.testnet'; }, tx => { tx.signerId = 'other.testnet'; },
    tx => { tx.actions[0].functionCall.args = Buffer.from('{}'); }, tx => { tx.actions[0].functionCall.deposit = 1n; },
    tx => { tx.actions[0].functionCall.gas = 1n; }, tx => { tx.actions.push(tx.actions[0]); },
  ]) {
    const f = fixture(), create = f.account.createTransaction;
    f.account.createTransaction = async (...args) => { const tx = await create(...args); mutate(tx); return tx; };
    await assert.rejects(run(f, { execute: true }), /prepared transaction does not match/);
    assert.equal(f.state.size, 0); assert.equal(f.sends(), 0);
  }
  for (const mutate of [
    ([hash]) => { hash[0] ^= 1; }, ([, signed]) => { signed.transaction.receiverId = 'other.testnet'; },
    ([, signed]) => { signed.signature.data[0] ^= 1; },
    ([, signed]) => { signed.signature.enum = 'secp256k1Signature'; },
  ]) {
    const f = fixture(), sign = f.account.signer.signTransaction;
    f.account.signer.signTransaction = async tx => { const result = await sign(tx); mutate(result); return result; };
    await assert.rejects(run(f, { execute: true }), /signed transaction does not match/);
    assert.equal(f.state.size, 0); assert.equal(f.sends(), 0);
  }
});

test('native OutLayer runner does not broadcast if the pending journal write fails', async () => {
  const f = fixture(); f.journal.put = () => { throw new Error('simulated fsync failure'); };
  await assert.rejects(run(f, { execute: true }), /simulated fsync failure/);
  assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('live native execution requires one-shot transport and never falls back to a retrying sender', async () => {
  const f = fixture(); let legacy = 0;
  f.provider.sendTransactionOnce = undefined;
  f.provider.sendTransactionUntil = async () => { legacy++; };
  await assert.rejects(run(f, { execute: true }), /bounded one-shot transaction transport/);
  assert.equal(f.state.size, 0); assert.equal(legacy, 0); assert.equal(f.sends(), 0);
  assert.deepEqual(await run(f), { status: 'READY' });
});
