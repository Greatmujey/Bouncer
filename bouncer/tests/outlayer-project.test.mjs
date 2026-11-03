import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectGoal, verifyProjectResult, runProjectGoal, recoverProjectGoal } from '../agent/outlayer-project.mjs';
import { signingFixture } from './signing-fixture.mjs';
const initId = '6'.repeat(44), requestId = '7'.repeat(44), completeId = '8'.repeat(44), refundId = '9'.repeat(44);
const route = { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64),
  usd_policy_id: 'api-token', token: 'usdc.fakes.testnet', attached_usd: '15000', input_data: '{"operation":"fetch"}',
  max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
  route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true };
const goal = { id: 'paid-fetch', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', native_policy_id: 'api-native',
  amount: '100', route, expected_author: 'zavodil.testnet' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
const source = () => ({ WasmUrl: { url: 'https://example.test/pinned.wasm', hash: route.project.version_key, build_target: 'wasm32-wasip2' } });
const limits = () => ({ max_instructions: route.project.max_instructions, max_memory_mb: route.project.max_memory_mb, max_execution_seconds: route.project.max_execution_seconds });
const signedArgs = () => ({ native_policy_id: goal.native_policy_id, amount: goal.amount, expected_route: goal.route });
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_outlayer_project', args: signedArgs() });
const { key, hash } = signing;
const providerArgs = () => ({ source: { Project: { project_id: route.project.project_id, version_key: route.project.version_key } },
  resource_limits: limits(), input_data: route.project.input_data, secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: { attached_usd: '15000' } });
const split = `Split 15000 stablecoin for project ${route.project.project_id}: 15000 to author ${goal.expected_author}, 0 to owner connectors.outlayer.testnet (attached=15000, refund=0)`;
function outcome(id, executor_id, status, logs = [], receipt_ids = []) { return { id, outcome: { executor_id, status, logs, receipt_ids } }; }
function receipt(id, predecessor_id, receiver_id, actions) { return { receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } }; }
function finalResult() {
  const output = encode({ ok: true, operation: 'fetch', http_status: 200, detail: 'declared host reachable' });
  const requestData = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount, attached_usd: '15000',
    input_data: route.project.input_data, project_id: route.project.project_id, code_source: source() };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  return { final_execution_status: 'FINAL', status: { SuccessValue: output }, transaction_outcome: { id: hash, outcome: { receipt_ids: [initId] } },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_project', deposit: '0', gas: '300000000000000', args: encode(signedArgs()) } }] },
    receipts_outcome: [outcome(initId, goal.contract_id, { SuccessReceiptId: requestId }, ['BOUNCER independent paid project initiated; native and prepaid maxima reserved'], [requestId]),
      outcome(requestId, 'outlayer.testnet', { SuccessReceiptId: completeId }, [event('execution_requested', { request_data: JSON.stringify(requestData) })]),
      outcome(completeId, 'outlayer.testnet', { SuccessValue: output }, [split, event('execution_completed', completion)]),
      outcome(refundId, goal.owner_account_id, { SuccessValue: '' })],
    receipts: [receipt(requestId, goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: goal.amount, args: encode(providerArgs()) } }]),
      receipt(refundId, 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }])],
  };
}
function fixture() {
  const state = new Map(), journal = { get(id) { return state.get(id); }, put(id, entry) { state.set(id, structuredClone(entry)); } };
  let sends = 0;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_project'] } } }; },
    async callFunction(_, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v7';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_outlayer_project') return structuredClone(route);
      if (method === 'get_policy') return args.policy_id === goal.native_policy_id ? { token: 'native', per_tx_cap: '100', daily_cap: '200' } : { token: route.project.token, per_tx_cap: '15000', daily_cap: '30000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'outlayer_prepaid_balance') return '15000';
      if (method === 'daily_spent') return '0';
      if (method === 'get_payment_token_contract') return route.project.token;
      if (method === 'get_project_pricing') return { author_account_id: goal.expected_author, operations: [{ operation: 'fetch', price_usd: '15000', developer_share_bp: 10000 }] };
      if (method === 'get_version') return { wasm_hash: route.project.version_key, source: source() };
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) { sends++; assert.equal(wait, 'FINAL'); assert.equal(signed.transaction.receiverId, goal.contract_id);
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash); return { transaction_outcome: { id: hash } }; },
    async txStatusReceipts(tx, owner, wait) { assert.equal(tx, hash); assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = signing.newAccount();
  return { provider, account, journal, state, sends: () => sends };
}
const run = (f, opts = {}) => runProjectGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...opts });

test('paid project goal only admits a specific testnet connectivity probe, bounded versions and two policies', () => {
  assert.deepEqual(validateProjectGoal(goal), goal);
  const changes = [
    g => { g.owner_account_id = 'owner.near'; }, g => { g.route.project.input_data = '{"operation":"other"}'; },
    g => { g.route.project.attached_usd = '15001'; }, g => { g.route.project.token = 'usdc.near'; },
    g => { g.route.project.version_key = 'x'.repeat(64); }, g => { g.route.project.usd_policy_id = g.native_policy_id; },
    g => { g.route.active = false; }, g => { g.route.route_revision = 0; }, g => { g.route.project.max_instructions = 0; },
  ];
  for (const change of changes) { const g = structuredClone(goal); change(g); assert.throws(() => validateProjectGoal(g)); }
});

test('verifies a paid provider request, token split, native refund and bounded probe output', () => {
  const result = verifyProjectResult(goal, finalResult(), key);
  assert.equal(result.prepaid_charged, '15000'); assert.equal(result.near_charged, '10'); assert.equal(result.near_refunded_to_owner, '90');
  assert.deepEqual(result.result, { operation: 'fetch', http_status: 200 }); assert.match(result.verification, /no independent HTTP or TEE proof/);
});

test('rejects misleading, incomplete, mutated or unbound paid-provider evidence', () => {
  const mutations = [
    r => { r.final_execution_status = 'EXECUTED'; }, r => { r.transaction.signer_id = 'attacker.testnet'; },
    r => { r.transaction.public_key = 'ed25519:other'; }, r => { r.transaction.actions[0].FunctionCall.deposit = '1'; },
    r => { r.transaction.actions[0].FunctionCall.gas = '1'; },
    r => { r.transaction_outcome.outcome.receipt_ids = []; }, r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
    r => { r.receipts_outcome[0].outcome.status.SuccessReceiptId = '2'.repeat(44); },
    r => { r.receipts_outcome[1].outcome.status.SuccessReceiptId = '2'.repeat(44); },
    r => { const a = signedArgs(); a.expected_route = structuredClone(a.expected_route); a.expected_route.project.input_data = '{}'; r.transaction.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[0].outcome.logs = []; }, r => { r.receipts_outcome[1].outcome.status = { Failure: {} }; },
    r => { r.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = '101'; },
    r => { const a = providerArgs(); a.params.attached_usd = '15001'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
    r => { r.receipts_outcome[1].outcome.logs = []; }, r => { r.receipts_outcome[2].outcome.logs = r.receipts_outcome[2].outcome.logs.filter(l => l !== split); },
    r => { r.receipts[1].receiver_id = 'attacker.testnet'; }, r => { r.receipts[1].receipt.Action.actions[0].Transfer.deposit = '89'; },
    r => { const val = encode({ ok: false, operation: 'fetch', http_status: 200 }); r.status.SuccessValue = val; r.receipts_outcome[2].outcome.status.SuccessValue = val; },
    r => { delete r.receipts; },
  ];
  for (const mutate of mutations) { const r = finalResult(); mutate(r); assert.throws(() => verifyProjectResult(goal, r, key)); }
});

test('dry run checks both policy grants, provider price/version and prepaid credit without spending', async () => {
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('provider repricing, stale routes, insufficient credit and dangerous key scopes block before broadcast', async () => {
  for (const [method, replacement, pattern] of [
    ['get_project_pricing', { author_account_id: goal.expected_author, operations: [{ operation: 'fetch', price_usd: '15001', developer_share_bp: 10000 }] }, /changed/],
    ['get_outlayer_project', { ...route, active: false }, /changed/],
    ['get_version', { wasm_hash: 'b'.repeat(64) }, /changed/],
  ]) {
    const f = fixture(), original = f.provider.callFunction;
    f.provider.callFunction = async (c, m, a, o) => m === method ? replacement : original(c, m, a, o);
    await assert.rejects(run(f, { execute: true }), pattern); assert.equal(f.sends(), 0);
  }
  const f = fixture(), original = f.provider.callFunction;
  f.provider.callFunction = async (c, m, a, o) => m === 'outlayer_prepaid_balance' ? '14999' : original(c, m, a, o);
  assert.deepEqual(await run(f), { status: 'FUNDING_REQUIRED', shortfall: '1' });
  assert.deepEqual(await run(f, { execute: true }), { status: 'BLOCKED' }); assert.equal(f.sends(), 0);
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_project', 'set_policy'] } } });
  await assert.rejects(run(f, { execute: true }), /scoped ONLY/);
});

test('records the transaction before one send and recovers without a signer or a second payment', async () => {
  const f = fixture(), first = await run(f, { execute: true }); assert.equal(first.status, 'FULFILLED'); assert.equal(f.sends(), 1);
  assert.equal(f.journal.get(goal.id).status, 'completed');
  const again = await recoverProjectGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(again.status, 'REUSED'); assert.equal(again.delivery.tx_hash, hash); assert.equal(f.sends(), 1);
});

test('dry-run of a pending paid project verifies the hash without rewriting its journal', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => ({ ...await read(...args), receipts: [] });
  await assert.rejects(run(f, { execute: true }), /paid project unresolved/);
  const pending = structuredClone(f.journal.get(goal.id)); f.provider.txStatusReceipts = read;
  f.journal.put(goal.id, { ...pending, status: 'invalid' });
  await assert.rejects(run(f), /invalid journal status/); f.journal.put(goal.id, pending);
  assert.equal((await run(f)).status, 'REUSED');
  assert.deepEqual(f.journal.get(goal.id), pending); assert.equal(f.sends(), 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED');
  assert.equal(f.journal.get(goal.id).status, 'completed'); assert.equal(f.sends(), 1);
});

test('uncertain project result remains pending and key-free recovery never resends', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => ({ ...await read(...args), receipts: [] });
  await assert.rejects(run(f, { execute: true }), /paid project unresolved/); assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  f.provider.txStatusReceipts = read;
  assert.equal((await recoverProjectGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} })).status, 'REUSED');
  assert.equal(f.sends(), 1);
});

test('new paid-project sends require the distinct v7 storage layout', async () => {
  const f = fixture(), call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, ...rest) => method === 'contract_version' ? 'bouncer-agent-v6' : call(id, method, ...rest);
  await assert.rejects(run(f), /unsupported Bouncer version/); assert.equal(f.sends(), 0);
});

test('paid-project runner refuses altered prepared and signed calls before journaling or payment', async () => {
  for (const mutate of [
    tx => { tx.receiverId = 'other.testnet'; }, tx => { tx.signerId = 'other.testnet'; },
    tx => { tx.actions[0].functionCall.methodName = 'execute'; }, tx => { tx.actions[0].functionCall.args = Buffer.from('{}'); },
    tx => { tx.actions[0].functionCall.deposit = 1n; }, tx => { tx.actions[0].functionCall.gas = 1n; },
    tx => { tx.actions.push(tx.actions[0]); },
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

test('paid-project runner never broadcasts if the pending journal cannot be persisted', async () => {
  const f = fixture(); f.journal.put = () => { throw new Error('simulated fsync failure'); };
  await assert.rejects(run(f, { execute: true }), /simulated fsync failure/);
  assert.equal(f.sends(), 0); assert.equal(f.state.size, 0);
});

test('project execution prefers the bounded one-shot provider path', async () => {
  const f = fixture(), original = f.provider.sendTransactionUntil.bind(f.provider);
  f.provider.sendTransactionOnce = original;
  f.provider.sendTransactionUntil = async () => { throw new Error('unbounded send path must not run'); };
  assert.equal((await run(f, { execute: true })).status, 'FULFILLED');
  assert.equal(f.sends(), 1);
});

test('concurrent project operations sharing a journal cannot reserve or send twice', async () => {
  const f = fixture(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const check = f.provider.viewNodeStatus.bind(f.provider);
  f.provider.viewNodeStatus = async () => { entered(); await gate; return check(); };
  const first = run(f, { execute: true });
  await started;
  await assert.rejects(run(f, { execute: true }), /another payment operation.*journal/);
  await assert.rejects(recoverProjectGoal({ goal, provider: f.provider, journal: f.journal }), /another payment operation.*journal/);
  release();
  assert.equal((await first).status, 'FULFILLED');
  assert.equal(f.sends(), 1);
});

test('project execution will not overwrite a journal entry inserted while signing', async () => {
  const f = fixture(), create = f.account.createTransaction.bind(f.account);
  f.account.createTransaction = async (...args) => {
    const tx = await create(...args);
    f.journal.put(goal.id, { status: 'pending', tx_hash: 'unrelated reservation' });
    return tx;
  };
  await assert.rejects(run(f, { execute: true }), /entry appeared before broadcast/);
  assert.equal(f.sends(), 0);
  assert.equal(f.journal.get(goal.id).tx_hash, 'unrelated reservation');
});

test('V11 project runner pins vault identity, one-method key, exact locks and provider views before readiness', async () => {
  const { V11_NEAR_CODE_HASH } = await import('../agent/keyless-vault-bootstrap.mjs');
  const { V11_RESOURCE_VERSION } = await import('../agent/v11-resource-preflight.mjs');
  const f=fixture(), original=f.provider.callFunction.bind(f.provider), block='1'.repeat(32);
  let locked=false, code=V11_NEAR_CODE_HASH, keyMethods=['execute_outlayer_project'], providerCredit='15000',allowance='500000000000000000000000';
  f.provider.callFunction=async(account,method,args,ref)=>method==='contract_version'?V11_RESOURCE_VERSION:original(account,method,args,ref);
  f.provider.viewBlock=async()=>({header:{hash:block,timestamp_nanosec:String(BigInt(Date.now())*1_000_000n)}});
  f.provider.gasPrice=async id=>{assert.equal(id,block);return {gas_price:'1000000000'}};
  f.provider.query=async q=>{
    assert.equal(q.block_id,block);
    if(q.request_type==='view_account')return {block_hash:block,code_hash:code};
    if(q.request_type==='view_access_key_list')return {block_hash:block,keys:[]};
    if(q.request_type==='view_access_key')return {block_hash:block,permission:{FunctionCall:{receiver_id:goal.contract_id,method_names:keyMethods,allowance}}};
    throw Error('unexpected query');
  };
  f.provider.callFunctionRaw=async(account,method,args,ref)=>{
    assert.equal(ref.blockId,block);
    const value=method==='is_exact_ft_policy_locked'||method==='is_exact_ft_payee_locked'?locked:
      method==='get_user_stablecoin_balance'?providerCredit:await f.provider.callFunction(account,method,args,ref);
    if(method==='get_user_stablecoin_balance')assert.equal(args.account_id,goal.contract_id);
    return {block_hash:block,result:[...Buffer.from(JSON.stringify(value))]};
  };
  assert.deepEqual(await run(f),{status:'READY'});
  providerCredit='14999';await assert.rejects(run(f),/provider prepaid credit is below/);providerCredit='15000';
  locked=true;await assert.rejects(run(f),/exact-intent lock/);locked=false;
  code='wrong';await assert.rejects(run(f),/vault code/);code=V11_NEAR_CODE_HASH;
  keyMethods=['execute_outlayer_project','execute'];await assert.rejects(run(f),/restricted key/);
  keyMethods=['execute_outlayer_project'];allowance='100000000000000000000000';
  await assert.rejects(run(f,{execute:true}),/gas allowance.*before signing/);
  assert.equal(f.sends(),0);assert.equal(f.journal.get(goal.id),undefined);
});
