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
import { MARKET_SUMMARY_PROGRAM, marketInputFromOracle, priceToMicros, verifyMarketOutput } from '../agent/market-summary.mjs';
import { planNativeObjective } from '../agent/native-mission-planner.mjs';
import { ORACLE_TESTNET_PROJECT, ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { createAuthenticatedNativeMissionService } from '../agent/authenticated-native-mission-service.mjs';
import { createNativeMissionHttpServer } from '../agent/native-mission-http.mjs';
import { nativeMissionApprovalMessage } from '../web-src/native-mission-auth.mjs';
import { createNativeMissionClient } from '../web-src/native-mission-client.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { buildV14PhoneResearchPlan } from '../agent/native-v14-phone-plan.mjs';
import { createV14OriginalWitness, deriveV14OriginalBinding, V14_WITNESS_GENESIS } from '../agent/v14-original-witness.mjs';
import { createV14MissionOriginalCheckpoint, createV14MissionOriginalVerifier } from '../agent/v14-mission-original-checkpoint.mjs';
import { fixture as phoneFixture, scope as witnessScope } from './v14-witness-fixture.mjs';

const owner = 'owner.testnet', vault = 'bouncer.testnet';
const storageCodeHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 42));
// For integrated witness tests only, use the same synthetic Wasm as the phone plan.
const phoneArtifacts = phoneFixture().inputs;
const witnessCodeHash = phoneArtifacts.mission.goals.find(item => item.kind === 'storage').goal.contract_code_hash;
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
const blockHash = 'B'.repeat(44), executionBlockHash = 'A'.repeat(44), requestId = '7'.repeat(44), completeId = '8'.repeat(44), refundId = '9'.repeat(44);

function fixture({ stale = false, ambiguous = false, ambiguousGoal = null, samePolicy = false, storage = false, market = false, badMarketOutput = false, withWitness = false } = {}) {
  const vault = withWitness ? `native.${owner}` : 'bouncer.testnet';
  const storageCodeHash = withWitness ? witnessCodeHash : nearApi.utils.serialize.base_encode(Buffer.alloc(32, 42));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-native-mission-'));
  const journalPath = path.join(dir, 'original.json');
  let journal = new FileJournal(journalPath, vault, owner);
  const mission = makeMission();
  mission.contract_id=vault;
  for (const {goal} of mission.goals) goal.contract_id=vault;
  if (samePolicy) mission.goals[1].goal.policy_id = mission.goals[0].goal.policy_id;
  if (market) {
    mission.goals[0] = { kind:'market', goal:{ ...structuredClone(randomGoal), input:{from_goal_id:'price',quantity:10},
      program:structuredClone(MARKET_SUMMARY_PROGRAM) } };
    mission.goals[0].goal.contract_id=vault;
    mission.goals.reverse();
  }
  if (storage) { mission.max_native_amount = '300'; mission.required_resources.push('storage');
    const goal = structuredClone(storageGoal);
    goal.contract_id=vault;goal.contract_code_hash=storageCodeHash;
    if (market) goal.value.from_goal_ids = ['price','compute'];
    mission.goals.push({ kind: 'storage', goal }); }
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
  let storedObject = null, storageReserved = false, deployedCode = storageCodeHash, executedCode = null, vaultKeys = [];
  const timestamp = Math.floor(Date.now() / 1000) - (stale ? 1000 : 0);
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccount(_account, reference) { return { code_hash: reference?.blockId === executionBlockHash ? (executedCode ?? deployedCode) : deployedCode }; },
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
      if (method === 'get_outlayer_program') return structuredClone(reviewed.goals.find(item => ['random','market'].includes(item.kind)).goal.program);
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
      const kind = action.methodName === 'execute_outlayer' ? (market ? 'market' : 'random') :
        action.methodName === 'execute_native_storage' ? 'storage' : 'oracle';
      const template = reviewed.goals.find(item => item.kind === kind).goal;
      const goal = kind === 'market' ? journal.get(template.id).outlayer_goal : template;
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
      const output = project ? { success: true, token_id: 'near', source: 'custom', price_usd: 2.75, timestamp } :
        kind === 'market' ? { value_usd_micros: goal.input.price_usd_micros * goal.input.quantity + (badMarketOutput ? 1 : 0) } : { random_number: 48 };
      const request = { sender_id: owner, predecessor_id: vault, payment: goal.amount, input_data: input, code_source: source,
        ...(project ? { project_id: ORACLE_PROJECT_ID, project_uuid: ORACLE_PROJECT_UUID, attached_usd: '0' } : {}) };
      const completion = { success: true, sender_id: owner, code_source: source, payment_charged: '10', payment_refunded: '90' };
      const limits = { max_instructions: program.max_instructions, max_memory_mb: program.max_memory_mb, max_execution_seconds: program.max_execution_seconds };
      const providerArgs = { source: project ? { Project: { project_id: project.project_id, version_key: project.version_key } } : source,
        resource_limits: limits, input_data: input, secrets_ref: null, response_format: 'Json', payer_account_id: owner, params: null };
      const outcome = (id, executor_id, status, logs = []) => ({ id, block_hash: executor_id === vault ? executionBlockHash : blockHash, outcome: { executor_id, status, logs } });
      const receipt = (id, predecessor_id, receiver_id, actions) => ({ receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } });
      const result = { final_execution_status: 'FINAL', status: { SuccessValue: encode(output) },
        transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: '6'.repeat(44) } } },
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
      if (loseFirst || ambiguousGoal === goal.id) { loseFirst = false; ambiguousGoal = null; throw new Error('synthetic timeout after submission'); }
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
    setCode(value) { deployedCode = value; }, setExecutedCode(value) { executedCode = value; }, setVaultKeys(value) { vaultKeys = value; },
    setBeforeView(fn) { beforeView = fn; }, setBeforeSend(fn) { beforeSend = fn; },
    reopen() { journal.close(); journal = new FileJournal(journalPath, vault, owner, { requireExisting: true }); },
    close() { journal.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function withFixture(fn, options) { const f = fixture(options); try { await fn(f); } finally { f.close(); } }

// These stores and receipt checks are synthetic. They test coordination, not
// independent retention, durability, owner consent, or actual provider delivery.
function checkpointMemoryStore() {
  let snapshot={revision:0,head_sha256:V14_WITNESS_GENESIS,events:[]},loseNext=false;
  return {
    read:async()=>structuredClone(snapshot),
    append:async({expected_revision,expected_head_sha256,record})=>{
      if(snapshot.revision!==expected_revision||snapshot.head_sha256!==expected_head_sha256)throw new Error('synthetic CAS conflict');
      snapshot={revision:snapshot.revision+1,head_sha256:crypto.createHash('sha256').update(record).digest('hex'),events:[...snapshot.events,record]};
      if(loseNext){loseNext=false;throw new Error('synthetic acknowledgement lost after commit');}
      return structuredClone(snapshot);
    },
    loseNext:()=>{loseNext=true;},
  };
}
const syntheticHash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
async function missionCheckpoint(f,{verifyMissionReceipt}={}) {
  const inputs={...phoneArtifacts,mission:f.mission,agentPublicKeys:Object.fromEntries(
    Object.entries(f.signers).map(([id,signer])=>[id,String(signer.publicKey)]))};
  const review=buildV14PhoneResearchPlan(inputs).review;
  const binding=deriveV14OriginalBinding({scopeId:witnessScope,...inputs,review,trustedReviewSha256:review.review_sha256});
  const local=checkpointMemoryStore(),independent=checkpointMemoryStore();
  const syntheticSetupReceipt=async({txHash})=>({tx_hash:txHash,final_block_hash:syntheticHash(250)});
  const syntheticMissionReceipt=async({txHash})=>{
    const receipt=await f.provider.txStatusReceipts(txHash,owner,'FINAL');
    if(receipt.final_execution_status!=='FINAL'||receipt.transaction.hash!==txHash)throw new Error('synthetic receipt not final');
    return {tx_hash:txHash,final_block_hash:blockHash};
  };
  const witness=createV14OriginalWitness({binding,localStore:local,independentStore:independent,
    verifySetupReceipt:syntheticSetupReceipt,verifyMissionReceipt:verifyMissionReceipt===null?undefined:verifyMissionReceipt??syntheticMissionReceipt});
  await witness.reserve();
  for(let i=0;i<binding.stages.length;i++) {
    const stageId=binding.stages[i].id;
    await witness.claimWalletStage(stageId);
    await witness.retainWalletOriginal({stageId,txHash:syntheticHash(i+1)});
    await witness.verifyWalletOriginal({stageId,proof:{synthetic:true}});
  }
  return {binding,witness,local,independent,hooks:{beforeOriginalBroadcast:createV14MissionOriginalCheckpoint({witness}),
    afterOriginalVerified:createV14MissionOriginalVerifier({witness})}};
}

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

test('browser approval reaches all three actual guarded runners and original-only recovery on a synthetic chain', () => withFixture(async f => {
  const site = 'https://bouncer.example', ownerPair = nearApi.KeyPair.fromRandom('ed25519');
  const ownerPublicKey = String(ownerPair.getPublicKey()); let saved, prompts = 0;
  const auth = {
    async issue(action) {
      const issued = Date.now(), expires = issued + 120_000, nonce = crypto.randomBytes(32);
      const challenge = { challenge_id:'1'.repeat(32), nonce_base64:nonce.toString('base64'), recipient:'bouncer.example', expires_at_ms:expires,
        message:nativeMissionApprovalMessage(action,crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'),site,issued,expires) };
      saved = {action:structuredClone(action),challenge,nonce,used:false}; return challenge;
    },
    async authenticate({action,evidence}) {
      if (!saved || saved.used || JSON.stringify(action)!==JSON.stringify(saved.action) || evidence?.challenge_id!==saved.challenge.challenge_id ||
          evidence.accountId!==owner || evidence.publicKey!==ownerPublicKey) return false;
      const payload=nep413Payload({message:saved.challenge.message,nonce:new Uint8Array(saved.nonce),recipient:saved.challenge.recipient});
      const digest=crypto.createHash('sha256').update(payload).digest();
      if (!ownerPair.getPublicKey().verify(digest,Buffer.from(evidence.signature,'base64'))) return false;
      saved.used=true; return true;
    },
  };
  const service=createAuthenticatedNativeMissionService({mission:f.mission,provider:f.provider,signers:f.signers,journal:f.journal,auth});
  const server=createNativeMissionHttpServer({service,siteOrigin:site});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const local=`http://127.0.0.1:${server.address().port}`;
  const fetchForBrowser=(url,options={}) => url==='https://test.rpc.fastnear.com'
    ? Promise.resolve(new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})))
    : fetch(`${local}${url}`,{...options,headers:{...options.headers,origin:site}});
  const wallet={manifest:{id:'meteor-wallet'},async signMessage({message,nonce,recipient,signerId}){
    prompts++; assert.equal(signerId,owner); const payload=nep413Payload({message,nonce,recipient});
    const digest=crypto.createHash('sha256').update(payload).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(ownerPair.sign(digest).signature).toString('base64')};
  }};
  const client=createNativeMissionClient({wallet,accountId:owner,ownerPublicKey,location:{origin:site,host:'bouncer.example'},
    crypto:crypto.webcrypto,fetch:fetchForBrowser});
  try {
    const {review,preview}=await client.preview(); assert.equal(preview.status,'READY'); assert.equal(f.sends,0); assert.equal(prompts,0);
    const result=await client.approve(review); assert.equal(result.status,'FULFILLED'); assert.equal(result.new_payments,3);
    assert.equal(f.sends,3); assert.equal(prompts,1);
    assert.deepEqual(result.deliveries.map(item=>item.kind),['random','oracle','storage']);
    const stored=JSON.parse(result.deliveries[2].delivery.result.value);
    assert.deepEqual(stored.resources.map(item=>item.goal_id),['compute','price']);
    assert.deepEqual(stored.resources.map(item=>item.tx_hash),result.deliveries.slice(0,2).map(item=>item.delivery.tx_hash));
    const originals=await client.originals(review); assert.equal(originals.originals.length,3);
    assert.deepEqual(originals.originals.map(item=>item.status),['completed','completed','completed']);
    const recovered=await client.recover(review); assert.equal(recovered.status,'RECOVERED'); assert.equal(recovered.new_payments,0);
    assert.deepEqual(recovered.deliveries.map(item=>item.delivery.tx_hash),result.deliveries.map(item=>item.delivery.tx_hash));
    assert.equal(f.sends,3); assert.equal(prompts,1);
    await assert.rejects(client.approve(review),/UNAVAILABLE/); assert.equal(f.sends,3);
  } finally { await new Promise(resolve=>server.close(resolve)); }
}, {storage:true}));

test('mission service can be restarted without any agent keys or auth solely to recover originals', () => withFixture(async f => {
  const completed = await f.invoke({execute:true}); assert.equal(completed.status,'FULFILLED'); assert.equal(f.sends,3);
  const service = createAuthenticatedNativeMissionService({mission:f.mission,provider:f.provider,journal:f.journal});
  const hash = service.getReview().mission_sha256;
  assert.equal((await service.preview({missionSha256:hash})).preview.stage,'recovery-only');
  assert.equal((await service.originals({missionSha256:hash})).originals.length,3);
  const recovered = await service.recover({missionSha256:hash}); assert.equal(recovered.status,'RECOVERED'); assert.equal(recovered.new_payments,0);
  await assert.rejects(service.issue({missionSha256:hash,ownerPublicKey:'anything'}),/reconcile/);
  await assert.rejects(service.execute({missionSha256:hash,ownerPublicKey:'anything',evidence:{}}),/reconcile/);
  assert.equal(f.sends,3);
}, {storage:true}));

test('execution-block V14 mismatch stops subsequent legs and cannot be bypassed during recovery', () => withFixture(async f => {
  f.setExecutedCode(nearApi.utils.serialize.base_encode(Buffer.alloc(32, 43)));
  await assert.rejects(f.invoke({execute:true}),/code hash or keyless/);
  assert.equal(f.sends,1); assert.equal(f.journal.get('compute').status,'completed');
  await assert.rejects(f.invoke({recoverOnly:true,signers:{}}),/code hash or keyless/);
  assert.equal(f.sends,1); assert.equal(f.journal.get('price'),undefined); assert.equal(f.journal.get('store'),undefined);
  f.setExecutedCode(null);
  assert.equal((await f.invoke({execute:true})).status,'FULFILLED'); assert.equal(f.sends,3);
}, {storage:true}));

test('dependent market example binds the earlier oracle, pinned code, quantity and public storage', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../examples/native-market-mission.example.json', import.meta.url), 'utf8'));
  const mission = validateNativeMission(example);
  assert.deepEqual(mission.goals.map(item => item.kind), ['oracle','market','storage']);
  assert.deepEqual(mission.goals[1].goal.input, {from_goal_id:'price',quantity:10});
  assert.deepEqual(mission.goals[2].goal.value.from_goal_ids, ['price','compute']);
  for (const change of [
    m => { m.goals.reverse(); },
    m => { m.goals[1].goal.input.from_goal_id = 'compute'; },
    m => { m.goals[1].goal.input.from_goal_id = 'missing'; },
    m => { m.goals[1].goal.input.quantity = 0; },
    m => { m.goals[1].goal.input.quantity = 1001; },
    m => { m.goals[1].goal.input.quantity = 1.5; },
    m => { m.goals[1].goal.input.price_usd_micros = 1; },
    m => { m.goals[1].goal.program.sha256 = 'a'.repeat(64); },
    m => { m.goals[1].goal.program.build_target = 'wasm32-wasip2'; },
    m => { m.goals[2].goal.value.from_goal_ids = ['storage']; },
  ]) { const altered = structuredClone(example); change(altered); assert.throws(() => validateNativeMission(altered)); }
});

test('verified oracle prices round deterministically and market results are independently recalculated', () => {
  for (const [price,expected] of [[2.75,2750000],[1.2345674,1234567],[1.2345675,1234568],
    [0.0000005,1],[999999.9999999,1000000000000],[1e6,1000000000000]]) assert.equal(priceToMicros(price), expected);
  for (const price of [0,-1,NaN,Infinity,0.0000004,1000000.000001]) assert.throws(() => priceToMicros(price));
  const oracle = {tx_hash:nearApi.utils.serialize.base_encode(Buffer.alloc(32,1)),result:{price_usd:2.75}};
  const input = marketInputFromOracle(10,oracle);
  assert.deepEqual(input, {price_usd_micros:2750000,quantity:10,oracle_tx_hash:oracle.tx_hash});
  assert.deepEqual(verifyMarketOutput(input,{value_usd_micros:27500000}),{value_usd_micros:27500000});
  for (const output of [{value_usd_micros:27500001},{value_usd_micros:'27500000'},
    {value_usd_micros:27500000,extra:true},{random_number:48}]) assert.throws(() => verifyMarketOutput(input,output));
  assert.throws(() => marketInputFromOracle(10,{...oracle,tx_hash:'invalid'}));
});

test('dependent synthetic mission stores the oracle and calculated result and recovers originals without another send', () => withFixture(async f => {
  const preview = await f.invoke();
  assert.equal(preview.status,'READY'); assert.equal(f.sends,0);
  const result = await f.invoke({execute:true});
  assert.equal(result.status,'FULFILLED'); assert.equal(result.new_payments,3); assert.equal(f.sends,3);
  assert.deepEqual(result.deliveries.map(item=>item.kind),['oracle','market','storage']);
  const [oracle, market, storage] = result.deliveries;
  assert.deepEqual(market.delivery.result,{value_usd_micros:27500000});
  const actual = f.journal.get('compute').outlayer_goal.input;
  assert.deepEqual(actual,{price_usd_micros:2750000,quantity:10,oracle_tx_hash:oracle.delivery.tx_hash});
  const saved = JSON.parse(storage.delivery.result.value);
  assert.deepEqual(saved.resources.map(x=>x.tx_hash),[oracle.delivery.tx_hash,market.delivery.tx_hash]);
  assert.deepEqual(saved.resources.map(x=>x.kind),['oracle','market']);
  assert.deepEqual(saved.resources[1].result,{value_usd_micros:27500000});
  f.reopen();
  const recovery = await f.invoke({recoverOnly:true,signers:{}});
  assert.equal(recovery.status,'RECOVERED'); assert.equal(recovery.new_payments,0); assert.equal(f.sends,3);
  assert.deepEqual(recovery.deliveries.map(x=>x.delivery.tx_hash),result.deliveries.map(x=>x.delivery.tx_hash));
  const service = createAuthenticatedNativeMissionService({mission:f.mission,provider:f.provider,journal:f.journal});
  const review = service.getReview(), originals = await service.originals({missionSha256:review.mission_sha256});
  assert.equal(originals.status,'LOCAL_ORIGINALS');
  assert.deepEqual(originals.originals.map(x=>x.original_hash),result.deliveries.map(x=>x.delivery.tx_hash));
}, {market:true,storage:true}));

test('stale oracle or incorrect provider calculation stops dependent synthetic work', () => withFixture(async f => {
  const result = await f.invoke({execute:true});
  assert.equal(result.status,'BLOCKED'); assert.equal(result.stage,'stale-oracle');
  assert.equal(result.new_payments,1); assert.equal(f.sends,1);
  assert.equal(f.journal.get('compute'),undefined); assert.equal(f.journal.get('store'),undefined);
}, {market:true,storage:true,stale:true}));

test('bad arithmetic remains pending and neither storage nor a duplicate calculation is sent', () => withFixture(async f => {
  await assert.rejects(f.invoke({execute:true}),/payment\/delivery unresolved/);
  assert.equal(f.sends,2); assert.equal(f.journal.get('compute').status,'pending');
  assert.equal(f.journal.get('store'),undefined);
  await assert.rejects(f.invoke({recoverOnly:true,signers:{}}),/provider market calculation/);
  assert.equal(f.sends,2);
}, {market:true,storage:true,badMarketOutput:true}));

test('lost market response is recovered from its original hash, not resent', () => withFixture(async f => {
  await assert.rejects(f.invoke({execute:true}),/payment\/delivery unresolved/);
  assert.equal(f.sends,2); const original=f.journal.get('compute').tx_hash;
  assert.equal(f.journal.get('compute').status,'pending');
  assert.equal(f.journal.get('store'),undefined);
  f.reopen();
  const recovered=await f.invoke({recoverOnly:true,signers:{}});
  assert.equal(recovered.status,'RECOVERED_PARTIAL'); assert.equal(f.sends,2);
  assert.equal(f.journal.get('compute').tx_hash,original); assert.equal(f.journal.get('compute').status,'completed');
  const finished=await f.invoke({execute:true});
  assert.equal(finished.status,'FULFILLED'); assert.equal(finished.new_payments,1); assert.equal(f.sends,3);
  assert.equal(f.journal.get('compute').tx_hash,original);
}, {market:true,storage:true,ambiguousGoal:'compute'}));

test('each checkpoint authorizes only the next goal and requires a fresh approval to proceed', () => withFixture(async f => {
  assert.equal((await f.invoke()).next_goal_id,'price');
  await assert.rejects(f.invoke({execute:true,checkpointGoalId:'compute'}),/not the next unpaid goal/);
  assert.equal(f.sends,0);
  const first=await f.invoke({execute:true,checkpointGoalId:'price'});
  assert.equal(first.status,'CHECKPOINT'); assert.equal(first.new_payments,1); assert.equal(f.sends,1);
  assert.deepEqual(first.remaining_goal_ids,['compute','store']);
  await assert.rejects(f.invoke({execute:true,checkpointGoalId:'price'}),/not the next unpaid goal/);
  assert.equal(f.sends,1);
  const preview=await f.invoke();
  assert.equal(preview.next_goal_id,'compute'); assert.equal(preview.verified_prior_deliveries[0].delivery.result.price_usd,2.75);
  const second=await f.invoke({execute:true,checkpointGoalId:'compute'});
  assert.equal(second.status,'CHECKPOINT'); assert.equal(second.new_payments,1); assert.equal(f.sends,2);
  assert.deepEqual(second.remaining_goal_ids,['store']);
  const last=await f.invoke({execute:true,checkpointGoalId:'store'});
  assert.equal(last.status,'FULFILLED'); assert.equal(last.new_payments,1); assert.equal(f.sends,3);
  assert.equal((await f.invoke({recoverOnly:true,signers:{}})).status,'RECOVERED'); assert.equal(f.sends,3);
}, {market:true,storage:true}));

test('synthetic browser signs a distinct bounded checkpoint for each dependent leg', () => withFixture(async f => {
  const site='https://bouncer.example', ownerPair=nearApi.KeyPair.fromRandom('ed25519'), ownerPublicKey=String(ownerPair.getPublicKey());
  let saved, prompts=0; const seen=[];
  const auth={
    async issue(action) {
      const issued=Date.now(),expires=issued+120_000,nonce=crypto.randomBytes(32);
      const challenge={challenge_id:crypto.randomBytes(16).toString('hex'),nonce_base64:nonce.toString('base64'),
        recipient:'bouncer.example',expires_at_ms:expires,
        message:nativeMissionApprovalMessage(action,crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'),site,issued,expires)};
      saved={action:structuredClone(action),challenge,nonce,used:false};seen.push(structuredClone(action));return challenge;
    },
    async authenticate({action,evidence}) {
      if(!saved||saved.used||JSON.stringify(action)!==JSON.stringify(saved.action)||evidence?.challenge_id!==saved.challenge.challenge_id||
        evidence.accountId!==owner||evidence.publicKey!==ownerPublicKey)return false;
      const payload=nep413Payload({message:saved.challenge.message,nonce:new Uint8Array(saved.nonce),recipient:saved.challenge.recipient});
      if(!ownerPair.getPublicKey().verify(crypto.createHash('sha256').update(payload).digest(),Buffer.from(evidence.signature,'base64')))return false;
      saved.used=true;return true;
    },
  };
  const service=createAuthenticatedNativeMissionService({mission:f.mission,provider:f.provider,signers:f.signers,journal:f.journal,auth});
  const server=createNativeMissionHttpServer({service,siteOrigin:site});
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const local=`http://127.0.0.1:${server.address().port}`;
  const fetchForBrowser=(url,options={})=>url==='https://test.rpc.fastnear.com'
    ? Promise.resolve(new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})))
    : fetch(`${local}${url}`,{...options,headers:{...options.headers,origin:site}});
  const wallet={manifest:{id:'meteor-wallet'},async signMessage({message,nonce,recipient,signerId}) {
    prompts++;assert.match(message,/I approve only this one Bouncer testnet mission step/);assert.match(message,/Step maximum: 100 yoctoNEAR/);
    const payload=nep413Payload({message,nonce,recipient}),digest=crypto.createHash('sha256').update(payload).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(ownerPair.sign(digest).signature).toString('base64')};
  }};
  const client=createNativeMissionClient({wallet,accountId:owner,ownerPublicKey,location:{origin:site,host:'bouncer.example'},
    crypto:crypto.webcrypto,fetch:fetchForBrowser});
  try {
    let {review,preview}=await client.preview();
    assert.equal(preview.next_goal_id,'price'); assert.equal(f.sends,0);
    await assert.rejects(service.issue({missionSha256:review.mission_sha256,ownerPublicKey}),/reconcile/);
    await assert.rejects(service.issue({missionSha256:review.mission_sha256,ownerPublicKey,goalId:'compute'}),/reconcile/);
    const first=await client.approve(review);assert.equal(first.status,'CHECKPOINT');assert.equal(f.sends,1);assert.equal(prompts,1);
    await assert.rejects(client.approve(review),/UNAVAILABLE/); // must preview again
    ({review,preview}=await client.preview());assert.equal(preview.next_goal_id,'compute');
    assert.equal(preview.verified_prior_deliveries[0].delivery.result.price_usd,2.75);
    const second=await client.approve(review);assert.equal(second.status,'CHECKPOINT');assert.equal(f.sends,2);assert.equal(prompts,2);
    ({review,preview}=await client.preview());assert.equal(preview.next_goal_id,'store');
    assert.equal(preview.verified_prior_deliveries[1].delivery.result.value_usd_micros,27500000);
    const third=await client.approve(review);assert.equal(third.status,'FULFILLED');assert.equal(f.sends,3);assert.equal(prompts,3);
    assert.deepEqual(seen.map(action=>action.goal_id),['price','compute','store']);
    assert.ok(seen.every(action=>action.purpose==='authorize_native_mission_leg'&&action.goal_max_native_yocto==='100'));
    assert.equal((await client.recover(review)).status,'RECOVERED');assert.equal(f.sends,3);
  } finally {await new Promise(resolve=>server.close(resolve));}
}, {market:true,storage:true}));


test('a model-proposed bounded market goal enters the guarded V14 runner in an offline test', () => withFixture(async f => {
  const random=makeMission();random.id='other-native-template';random.max_native_amount='300';random.required_resources.push('storage');
  random.goals.push({kind:'storage',goal:structuredClone(storageGoal)});
  const catalog={version:1,market:{mission:f.mission,max_quantity:20},random:{mission:random,min:0,max:100,max_span:100}};
  const planned=await planNativeObjective({objective:'Value 12 NEAR and record it',catalog,modelClient:async()=>({kind:'market',quantity:12})});
  assert.equal(planned.goals[1].goal.input.quantity,12);assert.equal(f.sends,0);
  const call=checkpointGoalId=>runNativeMission({mission:planned,provider:f.provider,signers:f.signers,journal:f.journal,
    execute:true,checkpointGoalId,log:()=>{}});
  assert.equal((await call('price')).status,'CHECKPOINT');
  const computed=await call('compute');assert.equal(computed.status,'CHECKPOINT');
  assert.equal(computed.deliveries[1].delivery.result.value_usd_micros,33000000);
  assert.equal((await call('store')).status,'FULFILLED');assert.equal(f.sends,3);
}, {market:true,storage:true}));

// End-to-end coordinator checks, with synthetic stores, wallet setup and receipts.
for (const market of [false,true]) test(`V14 witness fences every synthetic ${market?'market':'random'} mission original before its only broadcast`, () => withFixture(async f => {
  const c=await missionCheckpoint(f),sent=[];
  f.setBeforeSend(async({kind,goal,hash})=>{
    const state=await c.witness.inspect();
    assert.equal(state.pending?.type,'mission');assert.equal(state.pending.goal_id,goal.id);
    assert.equal(state.pending.kind,kind);assert.equal(state.pending.tx_hash,hash);
    assert.equal(f.journal.get(goal.id).tx_hash,hash);
    assert.deepEqual(state.mission.map(x=>x.goal_id),sent);
    sent.push(goal.id);
  });
  const result=await f.invoke({execute:true,...c.hooks});
  assert.equal(result.status,'FULFILLED');assert.equal(result.new_payments,3);assert.equal(f.sends,3);
  const state=await c.witness.inspect();
  assert.equal(state.pending,null);assert.equal(state.next_mission_goal,null);assert.equal(state.revision,25);
  assert.deepEqual(state.mission.map(x=>x.goal_id),market?['price','compute','store']:['compute','price','store']);
  assert.deepEqual(state.mission.map(x=>x.kind),market?['oracle','market','storage']:['random','oracle','storage']);
  for(const row of state.mission) {
    assert.equal(row.tx_hash,f.journal.get(row.goal_id).tx_hash);
    assert.equal(row.fingerprint,f.journal.get(row.goal_id).fingerprint);
  }
  assert.deepEqual(await c.local.read(),await c.independent.read());
  if(market) assert.equal(result.deliveries[1].delivery.result.value_usd_micros,27_500_000);
  f.reopen();
  const replay=await f.invoke({recoverOnly:true,signers:{},afterOriginalVerified:c.hooks.afterOriginalVerified});
  assert.equal(replay.status,'RECOVERED');assert.equal(replay.new_payments,0);assert.equal(f.sends,3);
  assert.equal((await c.witness.inspect()).revision,25);
}, {storage:true,market,withWitness:true}));

test('checkpoint hooks are paired for execute and a no-op or mismatched acknowledgement sends nothing', async()=>{
  for(const mode of ['unpaired','noop','mismatch']) await withFixture(async f=>{
    const c=await missionCheckpoint(f);
    let hooks;
    if(mode==='unpaired') hooks={beforeOriginalBroadcast:c.hooks.beforeOriginalBroadcast};
    if(mode==='noop') hooks={beforeOriginalBroadcast:async()=>{},afterOriginalVerified:c.hooks.afterOriginalVerified};
    if(mode==='mismatch') hooks={beforeOriginalBroadcast:async input=>({status:'V14_MISSION_ORIGINAL_RETAINED',
      goal_id:input.goal_id,tx_hash:syntheticHash(99)}),afterOriginalVerified:c.hooks.afterOriginalVerified};
    await assert.rejects(f.invoke({execute:true,...hooks}),mode==='unpaired'?/both native original checkpoint hooks/:/independent original checkpoint is uncertain/);
    assert.equal(f.sends,0);
    assert.equal((await c.witness.inspect()).pending,null);
    if(mode!=='unpaired') assert.equal(f.journal.get('compute').status,'pending');
  },{storage:true,withWitness:true});
});

test('V14 checkpoint binds owner, vault, reviewed mission digest and goal kind',()=>withFixture(async f=>{
  const c=await missionCheckpoint(f),before=c.hooks.beforeOriginalBroadcast;
  const input={goal_id:'compute',kind:'random',tx_hash:syntheticHash(80),fingerprint:'a'.repeat(64),
    owner,vault:`native.${owner}`,mission_sha256:c.binding.mission_sha256};
  for(const changes of [{owner:'other.testnet'},{vault:'other.testnet'},{mission_sha256:'f'.repeat(64)},
    {kind:'market'},{goal_id:'price'},{unexpected:true}]) await assert.rejects(before({...input,...changes}),/uncertain/);
  assert.equal((await c.witness.inspect()).pending,null);assert.equal(f.sends,0);
  // Even the real adapter cannot accept a different mission that happens to
  // reuse the same account, goal ID and kind.
  f.mission.goals[0].goal.input.max=99;
  await assert.rejects(f.invoke({execute:true,...c.hooks}),/independent original checkpoint is uncertain/);
  assert.equal(f.sends,0);assert.equal((await c.witness.inspect()).pending,null);
},{storage:true,withWitness:true}));

test('lost independent checkpoint acknowledgement quarantines the original before any send',()=>withFixture(async f=>{
  const c=await missionCheckpoint(f);c.independent.loseNext();
  await assert.rejects(f.invoke({execute:true,...c.hooks}),/independent original checkpoint is uncertain/);
  assert.equal(f.sends,0);assert.equal(f.journal.get('compute').status,'pending');
  assert.equal((await c.independent.read()).revision,20);assert.equal((await c.local.read()).revision,19);
  await assert.rejects(c.witness.inspect(),/uncertain/);
  await assert.rejects(f.invoke({execute:true,...c.hooks}),/unresolved|receipts unavailable/);
  assert.equal(f.sends,0);
},{storage:true,withWitness:true}));

test('local journal changes during asynchronous checkpoint or verification block the next send',async()=>{
  for(const phase of ['before','after']) await withFixture(async f=>{
    const c=await missionCheckpoint(f),hooks={...c.hooks};
    if(phase==='before') hooks.beforeOriginalBroadcast=async input=>{
      const ack=await c.hooks.beforeOriginalBroadcast(input);
      f.journal.put(input.goal_id,{...f.journal.get(input.goal_id),tx_hash:syntheticHash(99)});
      return ack;
    };
    if(phase==='after') hooks.afterOriginalVerified=async input=>{
      const ack=await c.hooks.afterOriginalVerified(input);
      f.journal.put(input.goal_id,{...f.journal.get(input.goal_id),fingerprint:'f'.repeat(64)});
      return ack;
    };
    await assert.rejects(f.invoke({execute:true,...hooks}),/original.*changed|pending.*changed|journal.*changed|original.*differs|original journal is uncertain/);
    assert.equal(f.sends,phase==='before'?0:1);assert.equal(f.journal.get('price'),undefined);
  },{storage:true,withWitness:true});
});

test('missing independent FINAL verifier blocks advancement; recovery verifies the original without resending',()=>withFixture(async f=>{
  const c=await missionCheckpoint(f,{verifyMissionReceipt:null});
  await assert.rejects(f.invoke({execute:true,...c.hooks}),/independent original verification is uncertain/);
  assert.equal(f.sends,1);assert.equal(f.journal.get('compute').status,'completed');
  assert.equal((await c.witness.inspect()).pending?.tx_hash,f.journal.get('compute').tx_hash);
  assert.deepEqual((await c.witness.inspect()).mission,[]);assert.equal(f.journal.get('price'),undefined);
  f.reopen();
  await assert.rejects(f.invoke({recoverOnly:true,signers:{},afterOriginalVerified:c.hooks.afterOriginalVerified}),/independent original verification is uncertain/);
  const recovered=createV14OriginalWitness({binding:c.binding,localStore:c.local,independentStore:c.independent,
    verifyMissionReceipt:async({txHash})=>{
      const receipt=await f.provider.txStatusReceipts(txHash,owner,'FINAL');
      assert.equal(receipt.final_execution_status,'FINAL');assert.equal(receipt.transaction.hash,txHash);
      return {tx_hash:txHash,final_block_hash:blockHash};
    }});
  const after=createV14MissionOriginalVerifier({witness:recovered});
  const replay=await f.invoke({recoverOnly:true,signers:{},afterOriginalVerified:after});
  assert.equal(replay.status,'RECOVERED_PARTIAL');assert.equal(replay.new_payments,0);assert.equal(f.sends,1);
  assert.equal((await recovered.inspect()).mission[0].tx_hash,f.journal.get('compute').tx_hash);
  assert.equal((await recovered.inspect()).next_mission_goal,'price');
},{storage:true,withWitness:true}));

test('ambiguous synthetic submission recovers only the retained original and waits for FINAL before advancing',()=>withFixture(async f=>{
  const c=await missionCheckpoint(f);
  await assert.rejects(f.invoke({execute:true,...c.hooks}),/unresolved/);
  const original=f.journal.get('compute').tx_hash;
  assert.equal(f.sends,1);assert.equal((await c.witness.inspect()).pending?.tx_hash,original);
  f.setReceiptFailure(true);
  await assert.rejects(f.invoke({recoverOnly:true,signers:{},afterOriginalVerified:c.hooks.afterOriginalVerified}),/receipts unavailable/);
  assert.equal(f.sends,1);assert.deepEqual((await c.witness.inspect()).mission,[]);
  f.setReceiptFailure(false);f.reopen();
  const result=await f.invoke({recoverOnly:true,signers:{},afterOriginalVerified:c.hooks.afterOriginalVerified});
  assert.equal(result.status,'RECOVERED_PARTIAL');assert.equal(result.new_payments,0);assert.equal(f.sends,1);
  const state=await c.witness.inspect();
  assert.equal(state.pending,null);assert.equal(state.mission[0].tx_hash,original);assert.equal(state.next_mission_goal,'price');
  assert.equal(f.journal.get('price'),undefined);
},{storage:true,withWitness:true,ambiguous:true}));
