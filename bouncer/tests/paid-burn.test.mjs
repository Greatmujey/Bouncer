import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { assertProjectRegistry, expectedBurnChecksum, validateProjectGoal, verifyProjectResult, runProjectGoal, recoverProjectGoal } from '../agent/outlayer-project.mjs';

const projectId = 'connectors.outlayer.testnet/connector-probe', key = 'ed25519:agent';
const hashBytes = Buffer.alloc(32, 31), hash = nearApi.utils.serialize.base_encode(hashBytes);
const ids = ['6', '7', '8', '9'].map(n => n.repeat(44));
const goal = { id: 'independent-burn', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  native_policy_id: 'compute-native', amount: '100', expected_author: 'zavodil.testnet',
  route: { project: { project_id: projectId, version_key: 'a'.repeat(64), usd_policy_id: 'compute-token',
    token: 'usdc.fakes.testnet', attached_usd: '10000', input_data: '{"operation":"burn","rounds":1}',
    max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
  route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true } };
// Golden vectors from the documented Rust/sha2 algorithm. These u64s exceed
// Number.MAX_SAFE_INTEGER; encoding them with JSON.stringify(Number(...)) is wrong.
const checksum1 = '15658707147005546673', checksum5 = '9633144095910904511';
const output = checksum => `{"ok":true,"operation":"burn","detail":"burned one round","rounds_done":1,"checksum":${checksum}}`;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const raw64 = value => Buffer.from(value).toString('base64');
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
const source = () => ({ WasmUrl: { url: 'https://example.test/pinned.wasm', hash: goal.route.project.version_key, build_target: 'wasm32-wasip2' } });
const signedArgs = () => ({ native_policy_id: goal.native_policy_id, amount: goal.amount, expected_route: goal.route });
const providerArgs = () => ({ source: { Project: { project_id: projectId, version_key: goal.route.project.version_key } },
  resource_limits: { max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
  input_data: goal.route.project.input_data, secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id,
  params: { attached_usd: '10000' } });
const split = `Split 10000 stablecoin for project ${projectId}: 3333 to author ${goal.expected_author}, 6667 to owner connectors.outlayer.testnet (attached=10000, refund=0)`;
const outcome = (id, executor_id, status, logs = []) => ({ id, outcome: { executor_id, status, logs } });
const receipt = (id, predecessor_id, receiver_id, actions) => ({ receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } });
function finalResult(raw = output(checksum1)) {
  const value = raw64(raw);
  const requestData = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount, attached_usd: '10000',
    input_data: goal.route.project.input_data, project_id: projectId, code_source: source() };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_project', deposit: '0', args: encode(signedArgs()) } }] },
    receipts_outcome: [outcome(ids[0], goal.contract_id, { SuccessReceiptId: ids[1] }, ['BOUNCER independent paid project initiated; native and prepaid maxima reserved']),
      outcome(ids[1], 'outlayer.testnet', { SuccessReceiptId: ids[2] }, [event('execution_requested', { request_data: JSON.stringify(requestData) })]),
      outcome(ids[2], 'outlayer.testnet', { SuccessValue: value }, [split, event('execution_completed', completion)]),
      outcome(ids[3], goal.owner_account_id, { SuccessValue: '' })],
    receipts: [receipt(ids[1], goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: goal.amount, args: encode(providerArgs()) } }]),
      receipt(ids[3], 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }])],
  };
}
function fixture() {
  let sends = 0;
  const entries = new Map(), journal = { get: id => entries.get(id), put: (id, value) => entries.set(id, structuredClone(value)) };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_project'] } } }; },
    async callFunction(_, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_outlayer_project') return structuredClone(goal.route);
      if (method === 'get_policy') return args.policy_id === goal.native_policy_id ? { token: 'native', per_tx_cap: '100', daily_cap: '100' } : { token: goal.route.project.token, per_tx_cap: '10000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'outlayer_prepaid_balance') return '10000';
      if (method === 'daily_spent') return '0';
      if (method === 'get_payment_token_contract') return goal.route.project.token;
      if (method === 'get_project_pricing') return { author_account_id: goal.expected_author, operations: [{ operation: 'burn', price_usd: '10000', developer_share_bp: 3333 }] };
      if (method === 'get_version') return { wasm_hash: goal.route.project.version_key, source: source() };
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) { sends++; assert.equal(wait, 'FINAL'); assert.deepEqual(signed, { signed: true });
      assert.equal(journal.get(goal.id).status, 'pending'); assert.equal(journal.get(goal.id).tx_hash, hash); return { transaction_outcome: { id: hash } }; },
    async txStatusReceipts(tx, owner, wait) { assert.equal(tx, hash); assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL'); return finalResult(); },
  };
  const account = { accountId: goal.owner_account_id,
    signer: { async getPublicKey() { return key; }, async signTransaction(tx) { assert.deepEqual(tx, { unsigned: true }); return [hashBytes, { signed: true }]; } },
    async createTransaction(receiver, actions, publicKey) {
      assert.equal(receiver, goal.contract_id); assert.equal(publicKey, key); const call = actions[0].functionCall;
      assert.equal(call.methodName, 'execute_outlayer_project'); assert.equal(call.deposit, 0n);
      assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), signedArgs()); return { unsigned: true };
    } };
  return { provider, account, journal, entries, sends: () => sends };
}
const run = (f, options = {}) => runProjectGoal({ goal, provider: f.provider, account: f.account, publicKey: key, journal: f.journal, log: () => {}, ...options });

test('burn checksum matches independent u64 golden vectors without JS precision loss', () => {
  assert.equal(expectedBurnChecksum(1), checksum1);
  assert.equal(expectedBurnChecksum(5), checksum5);
  // Independently calculated with Python hashlib over 50,000 hashes.
  assert.equal(expectedBurnChecksum(50), '11684001528787636706');
  assert(BigInt(checksum1) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(Number(checksum1), Number((BigInt(checksum1) + 1n).toString())); // why floating-point comparison is unsafe
  for (const value of [0, 201, -1, 1.5, '1', NaN]) assert.throws(() => expectedBurnChecksum(value));
});

test('burn input is owner-pinned, canonical and bounded; the fee cannot be substituted', () => {
  assert.deepEqual(validateProjectGoal(goal), goal);
  const badInputs = ['{"operation":"burn","rounds":0}', '{"operation":"burn","rounds":201}', '{"operation":"burn","rounds":1.0}',
    '{"rounds":1,"operation":"burn"}', '{"operation":"burn", "rounds":1}', '{"operation":"burn","rounds":1,"other":1}',
    '{"operation":"burn","rounds":1,"rounds":1}', '{"operation":"burn","rounds":"1"}', '{}', 'x'.repeat(129)];
  for (const input of badInputs) { const g = structuredClone(goal); g.route.project.input_data = input; assert.throws(() => validateProjectGoal(g)); }
  for (const [field, value] of [['attached_usd', '15000'], ['attached_usd', '10001'], ['token', 'circle.testnet'], ['project_id', 'other.testnet/project']]) {
    const g = structuredClone(goal); g.route.project[field] = value; assert.throws(() => validateProjectGoal(g));
  }
  const max = structuredClone(goal); max.route.project.input_data = '{"operation":"burn","rounds":200}'; assert.deepEqual(validateProjectGoal(max), max);
});

test('paid burn checks exact u64 result, operation-specific split, and native refund', () => {
  const delivery = verifyProjectResult(goal, finalResult(), key);
  assert.equal(delivery.prepaid_charged, '10000'); assert.equal(delivery.near_charged, '10'); assert.equal(delivery.near_refunded_to_owner, '90');
  assert.deepEqual(delivery.result, { operation: 'burn', rounds_done: 1, hashes: 1000, checksum: checksum1 });
  assert.match(delivery.verification, /independently recomputed/); assert.match(delivery.verification, /no proof of execution location or TEE/);
  assert.equal(JSON.parse(JSON.stringify(delivery)).result.checksum, checksum1);
});

test('rejects rounded neighbors, malformed u64s, wrong workload and missing payment evidence', () => {
  for (const wrong of [(BigInt(checksum1) + 1n).toString(), '0', '18446744073709551616', '-1', '1e3', '1.0', '"' + checksum1 + '"', 'null']) {
    assert.throws(() => verifyProjectResult(goal, finalResult(output(wrong)), key), wrong);
  }
  for (const raw of [output(checksum1).replace('"rounds_done":1', '"rounds_done":2'), output(checksum1).replace('"ok":true', '"ok":false'),
    output(checksum1).replace('"operation":"burn"', '"operation":"fetch"'), output(checksum1).replace(/,"checksum":\d+/, '')]) {
    assert.throws(() => verifyProjectResult(goal, finalResult(raw), key));
  }
  for (const mutate of [
    r => { r.receipts_outcome[2].outcome.logs[0] = r.receipts_outcome[2].outcome.logs[0].replace('3333 to author', '3334 to author'); },
    r => { r.receipts_outcome[2].outcome.logs[0] = r.receipts_outcome[2].outcome.logs[0].replace('6667 to owner', '6666 to owner'); },
    r => { r.receipts_outcome[2].outcome.status.SuccessValue = raw64(output('0')); },
    r => { r.receipts_outcome[3].id = ids[2]; },
    r => { r.receipts[1].receipt_id = ids[1]; },
    r => { const a = providerArgs(); a.input_data = '{"operation":"burn","rounds":2}'; r.receipts[0].receipt.Action.actions[0].FunctionCall.args = encode(a); },
  ]) { const r = finalResult(); mutate(r); assert.throws(() => verifyProjectResult(goal, r, key)); }
});

test('preflight verifies burn price and author share before any send', async () => {
  for (const row of [
    { operation: 'burn', price_usd: '10000', developer_share_bp: 10000 },
    { operation: 'burn', price_usd: '10001', developer_share_bp: 3333 },
    { operation: 'fetch', price_usd: '10000', developer_share_bp: 3333 },
  ]) {
    const f = fixture(), view = f.provider.callFunction;
    f.provider.callFunction = async (id, method, args) => method === 'get_project_pricing' ? { author_account_id: goal.expected_author, operations: [row] } : view(id, method, args);
    await assert.rejects(run(f, { execute: true }), /provider token, price, author or pinned project version changed/); assert.equal(f.sends(), 0);
  }
  const f = fixture(); assert.deepEqual(await run(f), { status: 'READY' }); assert.equal(f.sends(), 0);
});

test('pre-deposit registry and native estimate checks reject drift and malformed views', () => {
  const terms = { project: goal.route.project, expectedAuthor: goal.expected_author, configuredToken: goal.route.project.token,
    pricing: { author_account_id: goal.expected_author, operations: [{ operation: 'burn', price_usd: '10000', developer_share_bp: 3333 }] },
    versionInfo: { wasm_hash: goal.route.project.version_key, source: source() },
    registry: { project_id: projectId, uuid: 'p0000000000000020', owner: 'connectors.outlayer.testnet', active_version: goal.route.project.version_key },
    estimate: '99', maximumNative: '100' };
  assert.doesNotThrow(() => assertProjectRegistry(terms));
  for (const mutate of [
    t => { t.registry.uuid = 'p0000000000000021'; }, t => { t.registry.owner = 'other.testnet'; },
    t => { t.registry.active_version = 'b'.repeat(64); }, t => { t.registry = null; },
    t => { t.pricing.operations.push({ ...t.pricing.operations[0] }); }, t => { t.pricing.operations = {}; },
    t => { t.versionInfo.source.WasmUrl.hash = 'b'.repeat(64); }, t => { t.versionInfo.source.WasmUrl.build_target = 'wasm32-wasip1'; },
    t => { t.expectedAuthor = 'other.testnet'; }, t => { t.configuredToken = 'circle.testnet'; },
    t => { t.estimate = '101'; }, t => { t.estimate = '0'; }, t => { t.estimate = 99; },
    t => { t.estimate = '01'; }, t => { t.estimate = ((1n << 128n)).toString(); }, t => { delete t.estimate; },
    t => { t.maximumNative = '0'; }, t => { delete t.maximumNative; },
  ]) { const changed = structuredClone(terms); mutate(changed); assert.throws(() => assertProjectRegistry(changed)); }
});

test('one paid burn is journaled before broadcast; uncertainty is recovered without paying again', async () => {
  const f = fixture(), read = f.provider.txStatusReceipts;
  f.provider.txStatusReceipts = async (...args) => ({ ...await read(...args), receipts: [] });
  await assert.rejects(run(f, { execute: true }), /paid project unresolved/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  f.provider.txStatusReceipts = read;
  const recovered = await recoverProjectGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(recovered.status, 'REUSED'); assert.equal(recovered.delivery.result.checksum, checksum1);
  assert.equal(f.journal.get(goal.id).status, 'completed'); assert.equal(f.sends(), 1);
  assert.equal((await run(f, { execute: true })).status, 'REUSED'); assert.equal(f.sends(), 1);
});
