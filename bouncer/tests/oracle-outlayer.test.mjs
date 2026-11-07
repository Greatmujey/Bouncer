import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORACLE_TESTNET_PROGRAM, ORACLE_NEAR_INPUT, ORACLE_COINBASE_NEAR_INPUT, ORACLE_TESTNET_PROJECT, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, validateOracleGoal, verifyOracleResult, assertOracleFreshForUse,
  runOracleGoal, recoverOracleGoal } from '../agent/oracle-outlayer.mjs';
import { signingFixture } from './signing-fixture.mjs';
import { runNativeResource, runMixedMission } from '../agent/mixed-mission.mjs';
import { FileJournal, runProcurement } from '../agent/procurement.mjs';
import { runResourceAgent } from '../agent/resource-agent.mjs';
const blockHash = 'B'.repeat(44), bouncerReceipt = '6'.repeat(44), requestReceipt = '7'.repeat(44);
const completedReceipt = '8'.repeat(44), refundReceipt = '9'.repeat(44), stamp = 1_700_000_000;
const goal = { id: 'oracle-near', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'external-api',
  amount: '100', route: { project: { ...ORACLE_TESTNET_PROJECT },
    route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
const source = () => ({ WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } });
const limits = () => ({ max_instructions: goal.route.project.max_instructions, max_memory_mb: goal.route.project.max_memory_mb,
  max_execution_seconds: goal.route.project.max_execution_seconds });
const signedArgs = () => ({ policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route });
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_outlayer_native_project', args: signedArgs() });
const { key, hash } = signing;
const outlayerArgs = () => ({ source: { Project: { project_id: ORACLE_PROJECT_ID, version_key: ORACLE_TESTNET_PROJECT.version_key } }, resource_limits: limits(), input_data: goal.route.project.input_data,
  secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: null });
const output = () => ({ success: true, token_id: 'near', source: 'custom', price_usd: 2.75, timestamp: stamp,
  warning: 'Price from single external API, not verified by oracle consensus' });
function outcome(id, executor_id, status, logs = []) { return { id, block_hash: blockHash, outcome: { executor_id, status, logs } }; }
function receipt(id, predecessor_id, receiver_id, actions) { return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } }; }
function finalResult(data = output()) {
  const encoded = encode(data), request = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount,
    input_data: goal.route.project.input_data, code_source: source(), project_id: ORACLE_PROJECT_ID, project_uuid: ORACLE_PROJECT_UUID, attached_usd: '0' };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  return { final_execution_status: 'FINAL', status: { SuccessValue: encoded }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_native_project', deposit: '0', args: encode(signedArgs()) } }] },
    receipts_outcome: [
      outcome(bouncerReceipt, goal.contract_id, { SuccessReceiptId: requestReceipt }, ['BOUNCER independent native project initiated; full maximum reserved']),
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
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_native_project'] } } }; },
    async callFunction(_, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: 'native', per_tx_cap: '100', daily_cap: '100' };
      if (method === 'get_outlayer_native_project') return structuredClone(goal.route);
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'get_project') return { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
      if (method === 'get_version') return { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source: source() };
      if (method === 'get_project_pricing') return null;
      throw new Error(`unexpected view ${method}`);
    },
    async block(query) { assert.deepEqual(query, { blockId: blockHash }); return { header: { hash: blockHash, timestamp_nanosec: `${stamp + 8}000000000` } }; },
    async sendTransactionOnce(signed, wait) {
      sends++; assert.equal(wait, 'FINAL'); assert.equal(signed.transaction.receiverId, goal.contract_id);
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash);
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(tx, account, wait) { assert.equal(tx, hash); assert.equal(account, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = signing.newAccount();
  return { entries, journal, provider, account, sends: () => sends };
}
const run = (f, options = {}) => runOracleGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...options });

test('accepts only a reviewed, version-pinned bounded testnet price goal', () => {
  assert.deepEqual(validateOracleGoal(goal), goal);
  assert.equal(goal.route.project.input_data, JSON.stringify(ORACLE_COINBASE_NEAR_INPUT));
  assert.doesNotThrow(() => validateOracleGoal({ ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: JSON.stringify(ORACLE_NEAR_INPUT) } } }));
  const custom = ORACLE_COINBASE_NEAR_INPUT.source.custom;
  const changedCustom = changes => ({ ...goal, route: { ...goal.route, project: { ...goal.route.project,
    input_data: JSON.stringify({ ...ORACLE_COINBASE_NEAR_INPUT, source: { custom: { ...custom, ...changes } } }) } } });
  const values = [
    changedCustom({ url: 'https://evil.test/price' }), changedCustom({ url: `${custom.url}?date=2020-01-01` }),
    changedCustom({ json_path: 'data.base' }), changedCustom({ method: 'POST' }), changedCustom({ headers: [['Authorization', 'secret']] }),
    { ...goal, owner_account_id: 'owner.near' }, { ...goal, amount: '0' }, { ...goal, amount: '01' },
    { ...goal, max_age_seconds: 0 }, { ...goal, max_age_seconds: 901 }, { ...goal, extra: true },
    { ...goal, route: { ...goal.route, active: false } }, { ...goal, route: { ...goal.route, route_revision: 0 } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, version_key: 'a'.repeat(64) } } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: '{"command":"fetch_external","token_id":"near","source":{"custom":{"url":"https://evil.example"}}}' } } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: '{ "command":"fetch_external","token_id":"near","source":"coingecko"}' } } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: '{"command":"update_prices","token_id":"near","source":"coingecko"}' } } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: '{"command":"fetch_external","token_id":"near","source":"coingecko","extra":true}' } } },
    { ...goal, route: { ...goal.route, project: { ...goal.route.project, input_data: '{"command":"fetch_external","token_id":"x","source":"coingecko"}' } } },
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
    r => { const args = outlayerArgs(); args.source.Project.version_key = 'a'.repeat(64); r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(args); },
    r => { const args = outlayerArgs(); args.params = { attached_usd: '1' }; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(args); },
    r => { const e = JSON.parse(r.receipts_outcome[1].outcome.logs[0].slice('EVENT_JSON:'.length)); const data = JSON.parse(e.data[0].request_data); data.project_uuid = 'wrong'; e.data[0].request_data = JSON.stringify(data); r.receipts_outcome[1].outcome.logs[0] = `EVENT_JSON:${JSON.stringify(e)}`; },
    r => { const e = JSON.parse(r.receipts_outcome[1].outcome.logs[0].slice('EVENT_JSON:'.length)); const data = JSON.parse(e.data[0].request_data); data.code_source.WasmUrl.hash = 'a'.repeat(64); e.data[0].request_data = JSON.stringify(data); r.receipts_outcome[1].outcome.logs[0] = `EVENT_JSON:${JSON.stringify(e)}`; },
    r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts_outcome[2].block_hash = undefined; },
    r => { r.receipts[1].receiver_id = 'attacker.testnet'; },
    r => { r.receipts[1].receipt.Action.actions[0].Transfer.deposit = '89'; },
  ];
  for (const mutate of mutations) { const result = finalResult(); mutate(result); await assert.rejects(verifyOracleResult(goal, result, key, f.provider)); }
  f.provider.block = async () => ({ header: { hash: 'wrong', timestamp_nanosec: '1700000008000000000' } });
  await assert.rejects(verifyOracleResult(goal, finalResult(), key, f.provider), /invalid completion block/);
});

test('preflight fails closed if the independent project identity, source or pricing changes', async () => {
  for (const [methodName, value] of [
    ['get_project', { project_id: ORACLE_PROJECT_ID, uuid: 'wrong', owner: 'zavodil2.testnet' }],
    ['get_project', { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'attacker.testnet' }],
    ['get_version', { wasm_hash: 'a'.repeat(64), source: source() }],
    ['get_version', { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source: { WasmUrl: { ...source().WasmUrl, url: 'https://evil.test' } } }],
    ['get_project_pricing', { code_executions: [] }],
  ]) {
    const f = fixture(), original = f.provider.callFunction;
    f.provider.callFunction = async (contract, method, ...rest) => method === methodName ? value : original(contract, method, ...rest);
    await assert.rejects(run(f, { execute: true }), /project identity, pinned source or native-only pricing changed/);
    assert.equal(f.sends(), 0); assert.equal(f.entries.size, 0);
  }
});

test('dry run is read-only; a paid result is journaled before broadcast and recovered without a second send', async () => {
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0);
  const first = await run(f, { execute: true }); assert.equal(first.status, 'FULFILLED'); assert.equal(f.sends(), 1);
  assert.equal(f.journal.get(goal.id).status, 'completed');
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});

test('dry-run recovery of a pending oracle hash leaves the journal untouched', async () => {
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

test('lost response recovers by hash without a key or second payment', async () => {
  const f = fixture(); let calls = 0;
  f.provider.sendTransactionOnce = async () => { calls++; assert.equal(f.journal.get(goal.id).tx_hash, hash); throw new Error('timeout after possible broadcast'); };
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
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_native_project', 'execute_outlayer'] } } });
  await assert.rejects(run(f, { execute: true }), /scoped ONLY/);
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_native_project'] } } });
  const call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'get_outlayer_native_project' ? { ...goal.route, route_revision: 2 } : call(id, method, ...rest);
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

test('oracle runner rejects altered transactions and signatures before journal or broadcast', async () => {
  for (const mutate of [
    tx => { tx.receiverId = 'other.testnet'; }, tx => { tx.signerId = 'other.testnet'; },
    tx => { tx.actions[0].functionCall.args = Buffer.from('{}'); }, tx => { tx.actions[0].functionCall.deposit = 1n; },
    tx => { tx.actions[0].functionCall.gas = 1n; }, tx => { tx.actions.push(tx.actions[0]); },
  ]) {
    const f = fixture(), create = f.account.createTransaction;
    f.account.createTransaction = async (...args) => { const tx = await create(...args); mutate(tx); return tx; };
    await assert.rejects(run(f, { execute: true }), /prepared transaction does not match/);
    assert.equal(f.entries.size, 0); assert.equal(f.sends(), 0);
  }
  for (const mutate of [
    ([hash]) => { hash[0] ^= 1; }, ([, signed]) => { signed.transaction.receiverId = 'other.testnet'; },
    ([, signed]) => { signed.signature.data[0] ^= 1; },
    ([, signed]) => { signed.signature.enum = 'secp256k1Signature'; },
  ]) {
    const f = fixture(), sign = f.account.signer.signTransaction;
    f.account.signer.signTransaction = async tx => { const result = await sign(tx); mutate(result); return result; };
    await assert.rejects(run(f, { execute: true }), /signed transaction does not match/);
    assert.equal(f.entries.size, 0); assert.equal(f.sends(), 0);
  }
});

test('oracle runner does not broadcast if the pending journal write fails', async () => {
  const f = fixture(); f.journal.put = () => { throw new Error('simulated fsync failure'); };
  await assert.rejects(run(f, { execute: true }), /simulated fsync failure/);
  assert.equal(f.sends(), 0); assert.equal(f.entries.size, 0);
});

test('live oracle execution requires one-shot transport and never falls back to a retrying sender', async () => {
  const f = fixture(); let legacy = 0;
  f.provider.sendTransactionOnce = undefined;
  f.provider.sendTransactionUntil = async () => { legacy++; };
  await assert.rejects(run(f, { execute: true }), /bounded one-shot transaction transport/);
  assert.equal(f.entries.size, 0); assert.equal(legacy, 0); assert.equal(f.sends(), 0);
  assert.deepEqual(await run(f), { status: 'READY' }); // read-only preview needs no sender
});


test('concurrent native, FT and recovery operations on one journal stop before a second signature or broadcast', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const status = f.provider.viewNodeStatus;
  f.provider.viewNodeStatus = async () => { entered.resolve(); await release.promise; return status(); };
  const first = run(f,{execute:true}); await entered.promise;
  try {
    await assert.rejects(run(f,{execute:true}), /another payment operation is already running/);
    await assert.rejects(recoverOracleGoal({goal,provider:f.provider,journal:f.journal,log:()=>{}}),/another payment operation is already running/);
    await assert.rejects(runProcurement({journal:f.journal}),/another payment operation is already running/);
    await assert.rejects(runResourceAgent({journal:f.journal}),/another payment operation is already running/);
    assert.equal(f.sends(),0); assert.equal(f.entries.size,0);
  } finally { release.resolve(); }
  assert.equal((await first).status,'FULFILLED'); assert.equal(f.sends(),1);
  assert.equal((await run(f,{execute:true})).status,'REUSED'); assert.equal(f.sends(),1);
});

test('real native and mixed orchestration safely nests its private journal scope', async () => {
  const f=fixture();
  const outlayer={kind:'oracle',goal,account:f.account,publicKey:key};
  let leaked=false;
  const preview=await runMixedMission({outlayer,provider:f.provider,journal:f.journal,log:()=>{},
    resources:{contractId:goal.contract_id,ownerAccountId:goal.owner_account_id,goals:[{id:'synthetic-ft'}]},
    runners:{resources:async input=>{leaked ||= Object.hasOwn(input,'exclusiveJournalScope');return {payments:{blocked:0}}}}});
  assert.equal(preview.status,'READY'); assert.equal(f.sends(),0); assert.equal(leaked,false);
  const execution=await runNativeResource({outlayer,provider:f.provider,journal:f.journal,execute:true,log:()=>{}});
  assert.equal(execution.status,'NATIVE_RESOURCE_FULFILLED'); assert.equal(f.sends(),1);
  const reused=await runNativeResource({outlayer,provider:f.provider,journal:f.journal,execute:true,log:()=>{}});
  assert.equal(reused.status,'NATIVE_RESOURCE_REUSED'); assert.equal(f.sends(),1);
});

test('a failed preflight releases the local lock without recording or sending', async () => {
  const f=fixture(), status=f.provider.viewNodeStatus;
  f.provider.viewNodeStatus=async()=>{throw Error('synthetic preflight failure')};
  await assert.rejects(run(f,{execute:true}),/synthetic preflight failure/);
  assert.equal(f.entries.size,0);assert.equal(f.sends(),0);
  f.provider.viewNodeStatus=status;
  assert.equal((await run(f,{execute:true})).status,'FULFILLED');assert.equal(f.sends(),1);
});

test('async or mismatched native journal acknowledgement never authorizes a broadcast', async () => {
  for (const mode of ['async','mismatch']) {
    const f=fixture();
    if (mode==='async') f.journal.put=()=>Promise.reject(Error('synthetic late write failure'));
    else f.journal.put=(id,entry)=>f.entries.set(id,{...structuredClone(entry),tx_hash:'different'});
    await assert.rejects(run(f,{execute:true}),/native original journal is uncertain/);
    assert.equal(f.sends(),0,mode);
  }
});

test('an original inserted while signing cannot be overwritten or broadcast', async () => {
  const f=fixture(), signer=f.account.signer, original=signer.signTransaction.bind(signer);
  const retained={fingerprint:'retained-original',status:'pending',tx_hash:'B'.repeat(44)};
  signer.signTransaction=async transaction=>{const signed=await original(transaction);f.entries.set(goal.id,retained);return signed};
  await assert.rejects(run(f,{execute:true}),/native original journal is uncertain/);
  assert.deepEqual(f.entries.get(goal.id),retained);assert.equal(f.sends(),0);
});

test('uncertain completed-entry readback preserves the pending hash and never triggers another send', async () => {
  const f=fixture(), put=f.journal.put.bind(f.journal);
  f.journal.put=(id,entry)=>{if(entry.status==='completed')return;put(id,entry)};
  await assert.rejects(run(f,{execute:true}),/do not resend automatically/);
  assert.equal(f.sends(),1);assert.equal(f.journal.get(goal.id).status,'pending');assert.equal(f.journal.get(goal.id).tx_hash,hash);
  f.journal.put=put;assert.equal((await recoverOracleGoal({goal,provider:f.provider,journal:f.journal,log:()=>{}})).status,'REUSED');
  assert.equal(f.sends(),1);
});


test('a real local FileJournal records and reads back the original before the synthetic one-shot transport', async () => {
  const f=fixture(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-native-journal-'));
  const file=path.join(dir,'journal.json');let journal=new FileJournal(file,goal.contract_id,goal.owner_account_id),sends=0;
  try {
    f.provider.sendTransactionOnce=async()=>{sends++;assert.equal(journal.get(goal.id).tx_hash,hash);assert.equal(journal.get(goal.id).status,'pending');
      return {transaction_outcome:{id:hash}}};
    assert.equal((await runOracleGoal({goal,provider:f.provider,account:f.account,publicKey:key,journal,execute:true,log:()=>{}})).status,'FULFILLED');
    assert.equal(journal.get(goal.id).status,'completed');journal.close();
    journal=new FileJournal(file,goal.contract_id,goal.owner_account_id,{requireExisting:true});
    assert.equal((await recoverOracleGoal({goal,provider:f.provider,journal,log:()=>{}})).status,'REUSED');assert.equal(sends,1);
  }finally{journal?.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('injected mission runner cannot obtain the private nested journal scope', async () => {
  const f=fixture();let calls=0;
  const result=await runNativeResource({outlayer:{kind:'oracle',goal},provider:f.provider,journal:f.journal,log:()=>{},
    runners:{outlayer:async input=>{
      calls++;assert.equal(Object.hasOwn(input,'exclusiveJournalScope'),false);
      await assert.rejects(run(f),/another payment operation is already running/);
      return {status:'READY'};
    }}});
  assert.equal(result.status,'READY');assert.equal(calls,1);assert.equal(f.sends(),0);
});

test('a FileJournal scoped to a different owner or contract cannot preflight, recover or pay', async () => {
  for (const [contractId,ownerId] of [['other.testnet',goal.owner_account_id],[goal.contract_id,'other.testnet']]) {
    const f=fixture(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-wrong-scope-'));
    const journal=new FileJournal(path.join(dir,'journal.json'),contractId,ownerId);let queries=0;
    f.provider.viewNodeStatus=async()=>{queries++;return {chain_id:'testnet'}};
    try {
      await assert.rejects(runOracleGoal({goal,provider:f.provider,account:f.account,publicKey:key,journal,execute:true}),/different contract\/account/);
      await assert.rejects(recoverOracleGoal({goal,provider:f.provider,journal}),/different contract\/account/);
      await assert.rejects(runNativeResource({outlayer:{kind:'oracle',goal},provider:f.provider,journal}),/different contract\/account/);
      assert.equal(queries,0);assert.equal(f.sends(),0);assert.deepEqual(journal.list(),[]);
    }finally{journal.close();fs.rmSync(dir,{recursive:true,force:true})}
  }
});

test('an asynchronous journal scope assertion cannot authorize a native payment', async () => {
  const f=fixture();let queries=0;
  f.journal.assertScope=()=>Promise.reject(Error('late scope failure'));
  f.provider.viewNodeStatus=async()=>{queries++;return {chain_id:'testnet'}};
  await assert.rejects(run(f,{execute:true}),/scope check must be synchronous/);
  assert.equal(queries,0);assert.equal(f.sends(),0);assert.equal(f.entries.size,0);
});

test('async or malformed native journal reads fail closed without unhandled rejection or broadcast', async () => {
  for (const mode of ['rejected','null','wrong-id']) {
    const f=fixture();f.journal.get=()=>mode==='rejected'?Promise.reject(Error('late read failure')):mode==='null'?null:{id:'other'};
    await assert.rejects(run(f,{execute:true}),/native original journal is uncertain/);
    assert.equal(f.sends(),0);
  }
});

test('an async acknowledgement after writing the original remains recovery-only', async () => {
  const f=fixture(), put=f.journal.put.bind(f.journal);
  f.journal.put=(id,entry)=>{put(id,entry);return Promise.resolve()};
  await assert.rejects(run(f,{execute:true}),/native original journal is uncertain/);
  assert.equal(f.journal.get(goal.id).tx_hash,hash);assert.equal(f.journal.get(goal.id).status,'pending');assert.equal(f.sends(),0);
  f.journal.put=put;f.provider.txStatusReceipts=async()=>{throw Error('synthetic original unavailable')};
  await assert.rejects(run(f,{execute:true}),/synthetic original unavailable/);assert.equal(f.sends(),0);
});
