import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROGRAM, ORACLE_NEAR_INPUT, validateOracleGoal, verifyOracleResult, assertOracleFreshForUse,
  runOracleGoal, recoverOracleGoal } from '../agent/oracle-outlayer.mjs';

const key = 'ed25519:agent', hashBytes = Buffer.alloc(32, 42), hash = nearApi.utils.serialize.base_encode(hashBytes);
const blockHash = 'B'.repeat(44), bouncerReceipt = '6'.repeat(44), requestReceipt = '7'.repeat(44);
const completedReceipt = '8'.repeat(44), refundReceipt = '9'.repeat(44), stamp = 1_700_000_000;
const goal = { id: 'oracle-near', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'external-api',
  amount: '100', route: { program: { ...ORACLE_TESTNET_PROGRAM }, input_data: JSON.stringify(ORACLE_NEAR_INPUT),
    route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
const source = () => ({ WasmUrl: { url: goal.route.program.url, hash: goal.route.program.sha256, build_target: goal.route.program.build_target } });
const limits = () => ({ max_instructions: goal.route.program.max_instructions, max_memory_mb: goal.route.program.max_memory_mb,
  max_execution_seconds: goal.route.program.max_execution_seconds });
const signedArgs = () => ({ policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route });
const outlayerArgs = () => ({ source: source(), resource_limits: limits(), input_data: goal.route.input_data,
  secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: null });
const output = () => ({ success: true, token_id: 'near', source: 'coingecko', price_usd: 2.75, timestamp: stamp,
  warning: 'Price from single external API, not verified by oracle consensus' });
function outcome(id, executor_id, status, logs = []) { return { id, block_hash: blockHash, outcome: { executor_id, status, logs } }; }
function receipt(id, predecessor_id, receiver_id, actions) { return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } }; }
function finalResult(data = output()) {
  const encoded = encode(data), request = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount,
    input_data: goal.route.input_data, code_source: source() };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  return { final_execution_status: 'FINAL', status: { SuccessValue: encoded }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_pinned', deposit: '0', args: encode(signedArgs()) } }] },
    receipts_outcome: [
      outcome(bouncerReceipt, goal.contract_id, { SuccessReceiptId: requestReceipt }, ['BOUNCER independent compute initiated; full maximum reserved']),
      outcome(requestReceipt, 'outlayer.testnet', { SuccessReceiptId: completedReceipt }, [event('execution_requested', { request_data: JSON.stringify(request) })]),
      outcome(completedReceipt, 'outlayer.testnet', { SuccessValue: encoded }, [event('execution_completed', completion)]),
      outcome(refundReceipt, goal.owner_account_id, { SuccessValue: '' }),
    ],
    receipts: [
      receipt(requestReceipt, goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: '100', args: encode(outlayerArgs()) } }]),
      receipt(refundReceipt, 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }]),
    ] };
}
function fixture() {
  const entries = new Map(); let sends = 0;
  const journal = { get(id) { return entries.get(id); }, put(id, value) { entries.set(id, structuredClone(value)); } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_pinned'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v8';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: 'native', per_tx_cap: '100', daily_cap: '100' };
      if (method === 'get_outlayer_input') return structuredClone(goal.route);
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async block(query) { assert.deepEqual(query, { blockId: blockHash }); return { header: { hash: blockHash, timestamp_nanosec: `${stamp + 8}000000000` } }; },
    async sendTransactionUntil(signed, wait) {
      sends++; assert.equal(wait, 'FINAL'); assert.deepEqual(signed, { signed: true });
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash);
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(tx, account, wait) { assert.equal(tx, hash); assert.equal(account, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = { accountId: goal.owner_account_id,
    signer: { async getPublicKey() { return key; }, async signTransaction(tx) { assert.deepEqual(tx, { unsigned: true }); return [hashBytes, { signed: true }]; } },
    async createTransaction(receiver, actions, publicKey) {
      assert.equal(receiver, goal.contract_id); assert.equal(publicKey, key); assert.equal(actions.length, 1);
      const call = actions[0].functionCall;
      assert.equal(call.methodName, 'execute_outlayer_pinned'); assert.equal(call.deposit, 0n); assert.equal(call.gas, 300n * 10n ** 12n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), signedArgs()); return { unsigned: true };
    } };
  return { entries, journal, provider, account, sends: () => sends };
}
const run = (f, options = {}) => runOracleGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...options });

test('accepts only a reviewed, version-pinned bounded testnet price goal', () => {
  assert.deepEqual(validateOracleGoal(goal), goal);
  const values = [
    { ...goal, owner_account_id: 'owner.near' }, { ...goal, amount: '0' }, { ...goal, amount: '01' },
    { ...goal, max_age_seconds: 0 }, { ...goal, max_age_seconds: 901 }, { ...goal, extra: true },
    { ...goal, route: { ...goal.route, active: false } }, { ...goal, route: { ...goal.route, route_revision: 0 } },
    { ...goal, route: { ...goal.route, program: { ...goal.route.program, sha256: 'a'.repeat(64) } } },
    { ...goal, route: { ...goal.route, input_data: '{"command":"fetch_external","token_id":"near","source":{"custom":{"url":"https://evil.example"}}}' } },
    { ...goal, route: { ...goal.route, input_data: '{ "command":"fetch_external","token_id":"near","source":"coingecko"}' } },
    { ...goal, route: { ...goal.route, input_data: '{"command":"update_prices","token_id":"near","source":"coingecko"}' } },
    { ...goal, route: { ...goal.route, input_data: '{"command":"fetch_external","token_id":"near","source":"coingecko","extra":true}' } },
    { ...goal, route: { ...goal.route, input_data: '{"command":"fetch_external","token_id":"x","source":"coingecko"}' } },
  ];
  for (const value of values) assert.throws(() => validateOracleGoal(value));
});

test('verifies the exact pinned request, positive charge, owner refund, result and historical block', async () => {
  const f = fixture(), delivery = await verifyOracleResult(goal, finalResult(), key, f.provider);
  assert.equal(delivery.tx_hash, hash); assert.equal(delivery.charged_yocto, '10');
  assert.equal(delivery.refunded_to_owner_yocto, '90'); assert.equal(delivery.result.price_usd, 2.75);
  assert.equal(delivery.completion_block_timestamp, String(stamp + 8)); assert.match(delivery.verification, /no TEE attestation/);
  assert.equal(assertOracleFreshForUse(delivery, stamp + 300), delivery);
  assert.throws(() => assertOracleFreshForUse(delivery, stamp + 301), /too old/);
  assert.throws(() => assertOracleFreshForUse(delivery, stamp - 31), /future/);
});

test('rejects failed, stale, mismatched, unauthenticated or incomplete evidence', async () => {
  const f = fixture();
  const badPrices = [
    { ...output(), success: false }, { ...output(), token_id: 'bitcoin' }, { ...output(), source: 'binance' },
    { ...output(), price_usd: 0 }, { ...output(), price_usd: -1 }, { ...output(), price_usd: null },
    { ...output(), timestamp: stamp - 400 }, { ...output(), timestamp: stamp + 40 },
    { ...output(), timestamp: '1700000000' }, { ...output(), error: 'bad' }, { ...output(), extra: true },
  ];
  for (const bad of badPrices) await assert.rejects(verifyOracleResult(goal, finalResult(bad), key, f.provider));
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED'; },
    r => { r.transaction.public_key = 'ed25519:other'; },
    r => { r.transaction.actions[0].FunctionCall.method_name = 'execute_outlayer'; },
    r => { const args = signedArgs(); args.expected_route = { ...args.expected_route, route_revision: 2 }; r.transaction.actions[0].FunctionCall.args = encode(args); },
    r => { const args = outlayerArgs(); args.input_data = '{"command":"arbitrary"}'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(args); },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[2].block_hash = undefined; },
    r => { r.receipts[1].receiver_id = 'attacker.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].Transfer.deposit = '89'; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); await assert.rejects(verifyOracleResult(goal, result, key, f.provider)); }
  f.provider.block = async () => ({ header: { hash: 'wrong', timestamp_nanosec: '1700000008000000000' } });
  await assert.rejects(verifyOracleResult(goal, finalResult(), key, f.provider), /invalid completion block/);
});

test('dry run is read-only; a paid result is journaled before broadcast and recovered without a second send', async () => {
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0);
  const first = await run(f, { execute: true }); assert.equal(first.status, 'FULFILLED'); assert.equal(f.sends(), 1);
  assert.equal(f.journal.get(goal.id).status, 'completed');
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});

test('lost response recovers by hash without a key or second payment', async () => {
  const f = fixture(); let calls = 0;
  f.provider.sendTransactionUntil = async () => { calls++; assert.equal(f.journal.get(goal.id).tx_hash, hash); throw new Error('timeout after possible broadcast'); };
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.journal.get(goal.id).status, 'pending');
  f.provider.viewAccessKey = async () => { throw new Error('key revoked'); };
  f.provider.callFunction = async () => { throw new Error('policy changed'); };
  const recovered = await recoverOracleGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.status, 'REUSED'); assert.equal(recovered.delivery.tx_hash, hash); assert.equal(calls, 1);
  assert.equal(f.journal.get(goal.id).status, 'completed');
});

test('bad paid delivery remains pending; never repays on automatic recovery', async () => {
  const f = fixture(); f.provider.txStatusReceipts = async () => finalResult({ ...output(), success: false });
  await assert.rejects(run(f, { execute: true }), /do not resend automatically/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  await assert.rejects(recoverOracleGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /did not deliver/);
  assert.equal(f.sends(), 1);
});

test('preflight blocks excessive permissions, a changed route, wrong chain and daily cap', async () => {
  const f = fixture();
  f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(run(f, { execute: true }), /testnet/);
  f.provider.viewNodeStatus = async () => ({ chain_id: 'testnet' });
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_pinned', 'execute_outlayer'] } } });
  await assert.rejects(run(f, { execute: true }), /scoped ONLY/);
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_pinned'] } } });
  const call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'get_outlayer_input' ? { ...goal.route, route_revision: 2 } : call(id, method, ...rest);
  await assert.rejects(run(f, { execute: true }), /pinned route/);
  f.provider.callFunction = async (id, method, ...rest) => method === 'check' ? [false, 'daily cap'] : call(id, method, ...rest);
  assert.deepEqual(await run(f, { execute: true }), { status: 'BLOCKED' });
  assert.equal(f.sends(), 0); assert.equal(f.entries.size, 0);
});

test('recovery rejects a different transaction or a tampered completed record', async () => {
  const f = fixture(); await run(f, { execute: true });
  const old = f.journal.get(goal.id); f.journal.put(goal.id, { ...old, delivery: { ...old.delivery, charged_yocto: '11' } });
  await assert.rejects(recoverOracleGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /recorded result differs/);
  assert.equal(f.sends(), 1);
});
