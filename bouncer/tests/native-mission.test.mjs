// Entirely synthetic chain/provider receipts. No live wallet or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { runNativeResource } from '../agent/mixed-mission.mjs';
import { runNativeMission, validateNativeMission } from '../agent/native-mission.mjs';
import { ORACLE_TESTNET_PROJECT, ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';

const owner = 'owner.testnet', vault = 'bouncer.testnet';
const storageCodeHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 42));
const randomGoal = { id: 'compute', contract_id: vault, owner_account_id: owner, policy_id: 'compute-policy', amount: '100',
  input: { min: 1, max: 100 }, program: { url: 'https://example.test/random.wasm', sha256: 'a'.repeat(64),
    build_target: 'wasm32-wasip1', max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 } };
const oracleGoal = { id: 'price', contract_id: vault, owner_account_id: owner, policy_id: 'api-policy', amount: '100',
  route: { project: { ...ORACLE_TESTNET_PROJECT }, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 };
const storageGoal = { id: 'store', contract_id: vault, contract_code_hash: storageCodeHash, owner_account_id: owner, policy_id: 'storage-policy', amount: '100',
  object_id: 'mission-results', value: { from_goal_ids: ['compute', 'price'] },
  route: { prefix: 'mission-', max_value_bytes: 4096, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true } };
const makeMission = () => ({ version: 1, id: 'partial-native', contract_id: vault, owner_account_id: owner, max_native_amount: '200',
  required_resources: ['compute', 'api'], goals: [{ kind: 'random', goal: structuredClone(randomGoal) }, { kind: 'oracle', goal: structuredClone(oracleGoal) }] });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const event = (name, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event: name, data: [data] })}`;
const blockHash = 'B'.repeat(44), requestId = '7'.repeat(44), completeId = '8'.repeat(44), refundId = '9'.repeat(44);

function fixture({ stale = false, ambiguous = false, samePolicy = false, storage = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-mission-'));
  const journalPath = path.join(dir, 'original.json');
  let journal = new FileJournal(journalPath, vault, owner);
  const mission = makeMission();
  if (samePolicy) mission.goals[1].goal.policy_id = mission.goals[0].goal.policy_id;
  if (storage) { mission.max_native_amount = '300'; mission.required_resources.push('storage');
    mission.goals.push({ kind: 'storage', goal: structuredClone(storageGoal) }); }
  const reviewed = structuredClone(mission);
  const keys = Object.fromEntries(mission.goals.map(({ goal }) => [goal.id, nearApi.KeyPair.fromRandom('ed25519')]));
  const signers = Object.fromEntries(mission.goals.map(({ goal }) => {
    const keypair = keys[goal.id], signer = new nearApi.KeyPairSigner(keypair), publicKey = keypair.getPublicKey();
    return [goal.id, { publicKey, account: { accountId: owner, signer, async createTransaction(receiver, actions, key) {
      return nearApi.transactions.createTransaction(owner, key, receiver, 1n, actions, Buffer.alloc(32, 3));
    } } }];
  }));
  const transactions = new Map(), spent = new Map(), events = [];
  let balance = 1000n, daily = 1000n, perTx = 100n, loseFirst = ambiguous, denyReceipts = false, beforeSend, beforeView, sends = 0;
  let storedObject = null, storageReserved = false, deployedCode = storageCodeHash, vaultKeys = [];
  const timestamp = Math.floor(Date.now() / 1000) - (stale ? 1000 : 0);
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccount() { return { code_hash: deployedCode }; },
    async viewAccessKeyList() { return { keys: vaultKeys }; },
    async viewAccessKey(account, key) {
      assert.equal(account, owner);
      const id = Object.keys(signers).find(id => String(signers[id].publicKey) === String(key));
      if (!id) throw new Error('unknown synthetic agent key');
      const method = id === 'compute' ? 'execute_outlayer' : id === 'store' ? 'execute_native_storage' : 'execute_outlayer_native_project';
      return { permission: { FunctionCall: { receiver_id: vault, method_names: [method] } } };
    },
    async callFunction(receiver, method, args) {
      events.push(`view:${method}${args?.policy_id ? `:${args.policy_id}` : ''}`);
      if (beforeView) await beforeView({ receiver, method, args });
      if (method === 'contract_version') return storage ? 'bouncer-agent-v14-native-storage-testnet' : 'bouncer-agent-v9';
      if (method === 'get_owner') return owner;
      if (method === 'get_policy') return { token: 'native', per_tx_cap: perTx.toString(), daily_cap: daily.toString() };
      if (method === 'daily_spent') return (spent.get(args.policy_id) ?? 0n).toString();
      if (method === 'vault_balance') { assert.deepEqual(args, { token: 'native' }); return balance.toString(); }
      if (method === 'get_outlayer_program') return structuredClone(randomGoal.program);
      if (method === 'get_outlayer_native_project') return structuredClone(reviewed.goals.find(item => item.kind === 'oracle').goal.route);
      if (method === 'get_native_storage_route') return structuredClone(reviewed.goals.find(item => item.kind === 'storage').goal.route);
      if (method === 'native_storage_id_reserved') return storageReserved;
      if (method === 'get_native_storage_object') return structuredClone(storedObject);
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'get_project') return { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
      if (method === 'get_version') return { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256,
        source: { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } } };
      if (method === 'get_project_pricing') return null;
      throw new Error(`unexpected synthetic view ${method}`);
    },
    async block() { return { header: { hash: blockHash, timestamp_nanosec: `${timestamp}000000000` } }; },
    async sendTransactionOnce(signed, wait) {
      assert.equal(wait, 'FINAL');
      const action = signed.transaction.actions[0].functionCall;
      const kind = action.methodName === 'execute_outlayer' ? 'random' :
        action.methodName === 'execute_native_storage' ? 'storage' : 'oracle';
      const goal = reviewed.goals.find(item => item.kind === kind).goal;
      const args = JSON.parse(Buffer.from(action.args).toString());
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(`native-mission:${mission.id}`).status, 'pending');
      assert.equal(journal.get(goal.id).status, 'pending');
      assert.equal(journal.get(goal.id).tx_hash, hash);
      if (beforeSend) await beforeSend({ kind, goal, hash });
      sends++; events.push(`send:${goal.id}`);
      spent.set(goal.policy_id, (spent.get(goal.policy_id) ?? 0n) + BigInt(goal.amount)); balance -= BigInt(goal.amount);
      if (kind === 'storage') {
        const value = args.value;
        storedObject = { policy_id: goal.policy_id, object_id: goal.object_id, value,
          value_sha256: crypto.createHash('sha256').update(value).digest('hex'), value_bytes: Buffer.byteLength(value), stake_yocto: '50' };
        storageReserved = true;
        const fc = { method_name: action.methodName, deposit: '0', args: encode(args) };
        transactions.set(hash, { final_execution_status: 'FINAL', status: { SuccessValue: encode(storedObject) },
          transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: requestId } } },
          transaction: { hash, signer_id: owner, receiver_id: vault, public_key: String(signers[goal.id].publicKey), actions: [{ FunctionCall: fc }] },
          receipts_outcome: [{ id: requestId, block_hash: blockHash, outcome: { executor_id: vault,
            status: { SuccessValue: encode(storedObject) }, logs: ['BOUNCER public native storage written; stake reserved'] } }],
          receipts: [{ receipt_id: requestId, predecessor_id: owner, receiver_id: vault, receipt: { Action: { actions: [{ FunctionCall: fc }] } } }] });
        return { transaction_outcome: { id: hash } };
      }
      const project = kind === 'oracle' ? goal.route.project : null;
      const program = project ? { ...ORACLE_TESTNET_PROGRAM, max_instructions: project.max_instructions,
        max_memory_mb: project.max_memory_mb, max_execution_seconds: project.max_execution_seconds } : goal.program;
      const input = project ? project.input_data : JSON.stringify(goal.input);
      const source = { WasmUrl: { url: program.url, hash: program.sha256, build_target: program.build_target } };
      const output = project ? { success: true, token_id: 'near', source: 'custom', price_usd: 2.75, timestamp } : { random_number: 48 };
      const request = { sender_id: owner, predecessor_id: vault, payment: goal.amount, input_data: input, code_source: source,
        ...(project ? { project_id: ORACLE_PROJECT_ID, project_uuid: ORACLE_PROJECT_UUID, attached_usd: '0' } : {}) };
      const completion = { success: true, sender_id: owner, code_source: source, payment_charged: '10', payment_refunded: '90' };
      const limits = { max_instructions: program.max_instructions, max_memory_mb: program.max_memory_mb, max_execution_seconds: program.max_execution_seconds };
      const providerArgs = { source: project ? { Project: { project_id: project.project_id, version_key: project.version_key } } : source,
        resource_limits: limits, input_data: input, secrets_ref: null, response_format: 'Json', payer_account_id: owner, params: null };
      const outcome = (id, executor_id, status, logs = []) => ({ id, block_hash: blockHash, outcome: { executor_id, status, logs } });
      const receipt = (id, predecessor_id, receiver_id, actions) => ({ receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } });
      const result = { final_execution_status: 'FINAL', status: { SuccessValue: encode(output) }, transaction_outcome: { id: hash },
        transaction: { hash, signer_id: owner, receiver_id: vault, public_key: String(signers[goal.id].publicKey),
          actions: [{ FunctionCall: { method_name: action.methodName, deposit: '0', args: encode(args) } }] },
        receipts_outcome: [
          outcome('6'.repeat(44), vault, { SuccessReceiptId: requestId }, [project ? 'BOUNCER independent native project initiated; full maximum reserved' : 'BOUNCER independent compute initiated; full maximum reserved']),
          outcome(requestId, 'outlayer.testnet', { SuccessReceiptId: completeId }, [event('execution_requested', { request_data: JSON.stringify(request) })]),
          outcome(completeId, 'outlayer.testnet', { SuccessValue: encode(output) }, [event('execution_completed', completion)]),
          outcome(refundId, owner, { SuccessValue: '' }) ],
        receipts: [receipt(requestId, vault, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: goal.amount, args: encode(providerArgs) } }]),
          receipt(refundId, 'outlayer.testnet', owner, [{ Transfer: { deposit: '90' } }])] };
      transactions.set(hash, result);
      if (loseFirst) { loseFirst = false; throw new Error('synthetic timeout after submission'); }
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, account, wait) {
      events.push(`receipt:${hash}`); assert.equal(account, owner); assert.equal(wait, 'FINAL');
      if (denyReceipts || !transactions.has(hash)) throw new Error('synthetic archival receipts unavailable');
      return structuredClone(transactions.get(hash));
    },
  };
  const invoke = (options = {}) => runNativeMission({ mission, signers, provider, journal, log: () => {}, ...options });
  return { mission, signers, provider, events, invoke, transactions, get journal() { return journal; },
    get sends() { return sends; }, setDaily(value) { daily = BigInt(value); }, setPerTx(value) { perTx = BigInt(value); },
    setBalance(value) { balance = BigInt(value); }, setReceiptFailure(value) { denyReceipts = value; },
    setCode(value) { deployedCode = value; }, setVaultKeys(value) { vaultKeys = value; },
    setBeforeView(fn) { beforeView = fn; }, setBeforeSend(fn) { beforeSend = fn; },
    reopen() { journal.close(); journal = new FileJournal(journalPath, vault, owner, { requireExisting: true }); },
    close() { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function withFixture(fn, options) { const f = fixture(options); try { await fn(f); } finally { f.close(); } }

test('strict native manifest binds one owner, unique goals, required types and the aggregate maximum', () => {
  const m = makeMission(); const validated = validateNativeMission(m);
  assert.ok(Object.isFrozen(validated.goals[0].goal.program));
  for (const mutate of [
    v => { v.max_native_amount = '199'; }, v => { v.max_native_amount = '0200'; },
    v => { v.goals[1].goal.id = v.goals[0].goal.id; }, v => { v.goals[1].goal.owner_account_id = 'other.testnet'; },
    v => { v.goals[1].goal.contract_id = 'other.testnet'; }, v => { v.goals[0].kind = 'storage'; },
    v => { v.required_resources.push('compute'); }, v => { v.extra = true; },
  ]) { const changed = structuredClone(m); mutate(changed); assert.throws(() => validateNativeMission(changed)); }
});

test('checked-in example is unsigned, illustrative and includes a public storage goal', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../examples/native-mission.example.json', import.meta.url), 'utf8'));
  const mission = validateNativeMission(example);
  assert.deepEqual(mission.required_resources, ['compute', 'storage', 'api']);
  assert.equal(JSON.stringify(mission).includes('private_key'), false);
  assert.equal(mission.owner_account_id, 'great_mujey.testnet');
  assert.deepEqual(mission.goals.map(item => item.kind), ['random','oracle','storage']);
  assert.deepEqual(mission.goals[2].goal.value.from_goal_ids, ['compute','price']);
});

test('a full mission requiring storage blocks before reads, signing or payments', () => withFixture(async f => {
  f.mission.required_resources.push('storage');
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'unsupported-resources');
  assert.deepEqual(result.missing_resources, ['storage']); assert.equal(f.events.length, 0);
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
}));

test('partial preview is read-only and aggregate rolling/vault caps block before the first payment', () => withFixture(async f => {
  const preview = await f.invoke();
  assert.equal(preview.status, 'READY_PARTIAL'); assert.equal(preview.budget.required_yocto, '200');
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
  f.setDaily(150);
  const blocked = await f.invoke({ execute: true });
  assert.equal(blocked.stage, 'budget'); assert.equal(blocked.budget.reason, 'rolling-budget');
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
  f.setDaily(1000); f.setBalance(199);
  assert.equal((await f.invoke({ execute: true })).budget.reason, 'native-vault-balance');
  f.setBalance(1000); f.setDaily(0);
  assert.equal((await f.invoke({ execute: true })).budget.reason, 'rolling-budget-required');
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
}, { samePolicy: true }));

test('real native runners sequence synthetic compute and oracle, then recover both without keys or new sends', () => withFixture(async f => {
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'FULFILLED_PARTIAL'); assert.equal(result.new_payments, 2); assert.equal(f.sends, 2);
  assert.deepEqual(result.missing_resources, ['storage']); assert.equal(result.deliveries.length, 2);
  const firstSend = f.events.indexOf('send:compute');
  assert.ok(f.events.slice(0, firstSend).includes('view:check:compute-policy'));
  assert.ok(f.events.slice(0, firstSend).includes('view:check:api-policy'));
  const hashes = f.mission.goals.map(item => f.journal.get(item.goal.id).tx_hash);
  assert.equal(f.journal.get('native-mission:partial-native').status, 'pending');
  f.reopen();
  const replay = await f.invoke({ execute: false, recoverOnly: true, signers: {} });
  assert.equal(replay.status, 'RECOVERED_PARTIAL'); assert.equal(replay.new_payments, 0); assert.equal(f.sends, 2);
  assert.deepEqual(f.mission.goals.map(item => f.journal.get(item.goal.id).tx_hash), hashes);
  assert.equal((await f.invoke({ execute: true })).new_payments, 0);
}));

test('a changed V14 vault stops later compute/API legs even after storage completed', () => withFixture(async f => {
  const [compute, oracle, storage] = f.mission.goals;
  storage.goal.value = {from_goal_ids:['compute']}; f.mission.goals = [compute, storage, oracle];
  const log = message => { if (String(message).includes('[storage] FULFILLED')) f.setVaultKeys([{public_key:'ed25519:synthetic'}]); };
  await assert.rejects(f.invoke({execute:true,log}), /code hash or keyless/);
  assert.equal(f.sends,2); assert.equal(f.journal.get('store').status,'completed'); assert.equal(f.journal.get('price'),undefined);
  f.setVaultKeys([]); f.setCode(nearApi.utils.serialize.base_encode(Buffer.alloc(32,43)));
  await assert.rejects(f.invoke({execute:true}), /code hash or keyless/); assert.equal(f.sends,2);
}, {storage:true}));

test('lost original is never resent; unresolved receipts stop before later payments', () => withFixture(async f => {
  await assert.rejects(f.invoke({ execute: true }), /unresolved/);
  const original = f.journal.get('compute').tx_hash;
  assert.equal(f.journal.get('compute').status, 'pending'); assert.equal(f.sends, 1);
  f.setReceiptFailure(true);
  await assert.rejects(f.invoke({ execute: true }), /receipts unavailable/);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('price'), undefined);
  f.setReceiptFailure(false);
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'FULFILLED_PARTIAL'); assert.equal(result.new_payments, 1);
  assert.equal(f.journal.get('compute').tx_hash, original); assert.equal(f.sends, 2);
}, { ambiguous: true }));

test('changed or missing reviewed intent and out-of-order originals fail before receipt reads or sends', () => withFixture(async f => {
  await f.invoke({ execute: true });
  const before = f.events.length;
  const changed = structuredClone(f.mission); changed.max_native_amount = '201';
  await assert.rejects(f.invoke({ mission: changed }), /does not match the reviewed manifest/);
  const missingIntent = { ...f.mission, id: 'different-intent' };
  await assert.rejects(f.invoke({ mission: missingIntent }), /manifest is missing/);
  const record = structuredClone(f.journal.get('native-mission:partial-native'));
  const later = structuredClone(f.journal.get('price'));
  const outOfOrder = { get(id) { return id === record.id ? record : id === 'price' ? later : undefined; }, put() {} };
  await assert.rejects(f.invoke({ journal: outOfOrder }), /out-of-order/);
  assert.equal(f.events.length, before); assert.equal(f.sends, 2);
  const saved = f.journal.get('native-mission:partial-native');
  f.journal.put('native-mission:partial-native', { ...saved, fingerprint: 'bad' });
  await assert.rejects(f.invoke(), /does not match the reviewed manifest/);
}));

test('stale historical oracle blocks subsequent native payment but remains recoverable', () => withFixture(async f => {
  f.mission.goals.reverse();
  const result = await f.invoke({ execute: true });
  assert.equal(result.stage, 'stale-oracle'); assert.equal(result.new_payments, 1);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('compute'), undefined);
  const recovered = await f.invoke({ recoverOnly: true, signers: {} });
  assert.equal(recovered.status, 'RECOVERED_PARTIAL'); assert.equal(recovered.deliveries[0].oracle_fresh_for_use, false);
  assert.equal(f.sends, 1);
}, { stale: true }));

test('a budget change after the first non-atomic leg blocks the second payment', () => withFixture(async f => {
  f.setBeforeSend(({ kind }) => { if (kind === 'random') f.setBalance(100); });
  const result = await f.invoke({ execute: true });
  assert.equal(result.stage, 'budget'); assert.equal(result.budget.reason, 'native-vault-balance');
  assert.equal(result.new_payments, 1); assert.equal(f.sends, 1); assert.equal(f.journal.get('price'), undefined);
}));

test('oracle freshness expiring while the next transaction is signed prevents broadcast and retains its hash', () => withFixture(async f => {
  f.mission.goals.reverse(); f.mission.goals[0].goal.max_age_seconds = 1;
  const realNow = Date.now; let now = realNow();
  const signer = f.signers.compute.account.signer, originalSign = signer.signTransaction.bind(signer);
  signer.signTransaction = async tx => { now += 5000; return originalSign(tx); };
  Date.now = () => now;
  try {
    await assert.rejects(f.invoke({ execute: true }), /oracle result is too old/);
    assert.equal(f.sends, 1); assert.equal(f.journal.get('price').status, 'completed');
    assert.equal(f.journal.get('compute').status, 'pending'); assert.ok(f.journal.get('compute').tx_hash);
  } finally { Date.now = realNow; }
}));

test('tampering with a completed original from a callback stops before the next payment', () => withFixture(async f => {
  const log = message => {
    if (String(message).includes('[outlayer] FULFILLED compute')) {
      const original = f.journal.get('compute');
      f.journal.put('compute', { ...original, fingerprint: 'tampered' });
    }
  };
  await assert.rejects(f.invoke({ execute: true, log }), /original or verified delivery changed/);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('price'), undefined);
}));

test('a signer cannot alter the mission manifest during signing and still broadcast the next leg', () => withFixture(async f => {
  f.mission.goals.reverse();
  const signer = f.signers.compute.account.signer, originalSign = signer.signTransaction.bind(signer);
  signer.signTransaction = async tx => {
    const intent = f.journal.get('native-mission:partial-native');
    f.journal.put(intent.id, { ...intent, fingerprint: 'changed-by-signer' });
    return originalSign(tx);
  };
  await assert.rejects(f.invoke({ execute: true }), /manifest changed/);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('compute').status, 'pending');
}));

test('a manifest write failure stops before any native payment', () => withFixture(async f => {
  const put = f.journal.put.bind(f.journal);
  f.journal.put = (id, entry) => { if (id.startsWith('native-mission:')) throw new Error('synthetic disk failure'); return put(id, entry); };
  await assert.rejects(f.invoke({ execute: true }), /synthetic disk failure/);
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
}));

test('raw manifest edits inside asynchronous provider callbacks cannot change the reviewed goals', () => withFixture(async f => {
  let changed = false;
  f.setBeforeView(async () => { if (!changed) { changed = true; f.mission.goals[0].goal.amount = '999'; f.mission.max_native_amount = '999'; } });
  // Only the raw caller object changes; actual signed arguments remain 100.
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'FULFILLED_PARTIAL'); assert.equal(f.sends, 2);
  assert.equal(f.journal.get('compute').outlayer_goal.amount, '100');
  assert.equal(f.journal.get('native-mission:partial-native').mission.max_native_amount, '200');
}));

test('a second workflow and standalone native payment cannot overlap the same journal', () => withFixture(async f => {
  let entered, release; const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  let firstCall = true;
  const injected = { async native(options) {
    assert.equal(Object.hasOwn(options, 'exclusiveJournalScope'), false);
    if (firstCall) { firstCall = false; entered(); await gate; }
    return { status: 'BLOCKED' };
  } };
  const first = f.invoke({ runners: injected });
  try {
    await ready;
    await assert.rejects(f.invoke(), /another payment operation is already running/);
    await assert.rejects(runNativeResource({ journal: f.journal }), /another payment operation is already running/);
    assert.equal(f.sends, 0);
  } finally { release(); await first.catch(() => {}); }
  assert.equal((await first).stage, 'native-preflight');
}));
test('three real guarded runners store verified compute and API results, then recover original hashes without signing', () => withFixture(async f => {
  const preview = await f.invoke();
  assert.equal(preview.status, 'READY'); assert.equal(preview.budget.required_yocto, '300'); assert.equal(f.sends, 0);
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.new_payments, 3); assert.equal(f.sends, 3);
  const [compute, oracle, storage] = result.deliveries;
  const stored = JSON.parse(storage.delivery.result.value);
  assert.equal(stored.schema, 'bouncer-public-mission-results-v1');
  assert.deepEqual(stored.resources.map(row => row.goal_id), ['compute', 'price']);
  assert.equal(stored.resources[0].tx_hash, compute.delivery.tx_hash);
  assert.deepEqual(stored.resources[0].result, compute.delivery.result);
  assert.equal(stored.resources[1].tx_hash, oracle.delivery.tx_hash);
  assert.deepEqual(stored.resources[1].result, oracle.delivery.result);
  assert.equal(storage.delivery.stake_yocto, '50');
  f.reopen();
  const replay = await f.invoke({ recoverOnly: true, signers: {} });
  assert.equal(replay.status, 'RECOVERED'); assert.equal(replay.new_payments, 0); assert.equal(f.sends, 3);
  assert.deepEqual(replay.deliveries, result.deliveries);
}, { storage: true }));

test('storage references are only earlier verified goals and require a bounded public route', () => {
  const m = makeMission(); m.max_native_amount = '300'; m.required_resources.push('storage');
  m.goals.push({ kind: 'storage', goal: structuredClone(storageGoal) });
  assert.deepEqual(validateNativeMission(m).goals[2].goal.value.from_goal_ids, ['compute', 'price']);
  for (const mutate of [
    v => { v.goals[2].goal.value.from_goal_ids = ['missing']; },
    v => { v.goals[2].goal.value.from_goal_ids = ['store']; },
    v => { v.goals[2].goal.value.from_goal_ids = ['compute', 'compute']; },
    v => { v.goals[2].goal.value.from_goal_ids = ['price', 'compute', 'price']; },
    v => { v.goals[2].goal.value.extra = true; },
    v => { v.goals[2].goal.route.max_value_bytes = 128; },
    v => { v.goals.reverse(); },
  ]) { const changed = structuredClone(m); mutate(changed); assert.throws(() => validateNativeMission(changed)); }
});

test('stale API data prevents the dependent public storage transaction', () => withFixture(async f => {
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'stale-oracle');
  assert.equal(f.sends, 2); assert.equal(f.journal.get('store'), undefined);
}, { storage: true, stale: true }));

test('a lost preceding original prevents dependent storage until original-hash recovery succeeds', () => withFixture(async f => {
  await assert.rejects(f.invoke({ execute: true }), /unresolved/);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('store'), undefined);
  f.setReceiptFailure(true);
  await assert.rejects(f.invoke({ execute: true }), /unavailable/);
  assert.equal(f.sends, 1); assert.equal(f.journal.get('store'), undefined);
  f.setReceiptFailure(false);
  const result = await f.invoke({ execute: true });
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.new_payments, 2); assert.equal(f.sends, 3);
}, { storage: true, ambiguous: true }));
