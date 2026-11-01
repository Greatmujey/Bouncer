// Entirely offline. Source, chain transactions and receipts below are synthetic;
// signed FT transactions, the journal, seller SDK and development provider are real code paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { httpResourceProvider } from '../agent/resource-agent.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { expectedBurnChecksum } from '../agent/outlayer-project.mjs';
import { validateWorkflow, materializeWorkflowStep, runWorkflow } from '../agent/workflow.mjs';
import { makeOracleDependentWorkflow, runDependentLiveProof } from '../agent/dependent-live-proof.mjs';
import { createResourceProvider, orderMemo } from '../services/resource-provider.mjs';
import { computeResult } from './mock-delivery.mjs';
import { mockHash, mockGuardedPayment } from './mock-guarded-payment.mjs';
import { attachSyntheticOracle } from './mock-oracle-workflow.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', token = 'wrap.testnet', payee = 'vendor.testnet';
const sourceHash = mockHash('synthetic-oracle');
const makeOracle = () => ({ id: 'price', contract_id: contract, owner_account_id: owner, policy_id: 'oracle', amount: '100',
  route: { project: { ...ORACLE_TESTNET_PROJECT }, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 });
const step = (id, resource, input) => ({ id, resource, policy_id: 'resources', token, payee, max_amount: '100', input });
function makeWorkflow(origin) {
  return { version: 1, id: 'research', source: { kind: 'oracle', goal: makeOracle() }, provider_url: origin, steps: [
    step('compute', 'compute', { text: { from: 'price' }, rounds: 2 }),
    step('storage', 'storage', { name: 'result_json', content: { from: 'compute' } }),
    step('api', 'api', { text: { from: 'storage' } }),
  ] };
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-workflow-'));
  let sends = 0, sourcePays = 0, receiptReads = 0, quoteCalls = [], sourcePreviews = 0, nonce = 0, spent = 0n, readsFail = false, ambiguous = false;
  let dailyCap = 1000n, balance = 1000n, beforeQuote, beforeFulfill;
  const events = [], transactions = new Map(), keypair = nearApi.KeyPair.fromRandom('ed25519');
  const publicKey = keypair.getPublicKey(), signer = new nearApi.KeyPairSigner(keypair);
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_contract, method) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_policy') return { token, per_tx_cap: '100', daily_cap: dailyCap.toString() };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'daily_spent') return spent.toString();
      if (method === 'vault_balance') return balance.toString();
      if (method === 'ft_balance_of') return spent.toString();
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed) {
      const tx = signed.transaction, hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
      const args = JSON.parse(Buffer.from(tx.actions[0].functionCall.args).toString());
      const result = mockGuardedPayment({ hash, owner, contract, publicKey: String(publicKey), args, gas: String(tx.actions[0].functionCall.gas) });
      sends++; events.push(`pay:${args.memo}`); spent += BigInt(args.amount); balance -= BigInt(args.amount); transactions.set(hash, result);
      if (ambiguous) { ambiguous = false; throw new Error('synthetic timeout after broadcast'); }
      return structuredClone(result);
    },
    async txStatusReceipts(hash, accountId) {
      receiptReads++;
      if (readsFail) throw new Error('synthetic archival RPC unavailable');
      assert.equal(accountId, owner); const result = transactions.get(hash);
      if (!result) throw new Error('unknown synthetic hash');
      return structuredClone(result);
    },
  };
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, providedKey) {
    return nearApi.transactions.createTransaction(owner, providedKey, receiver, BigInt(++nonce), actions, Buffer.alloc(32, 7));
  } };
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource, { policy_id: 'resources', token, payee, amount: '10' }]));
  const service = createResourceProvider({ rpcProvider: provider, contractId: contract, ownerAccountId: owner, products, dataDir: path.join(dir, 'provider') });
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${service.server.address().port}`, client = httpResourceProvider(origin);
  const resources = { account, publicKey,
    async getQuote(order, context) { quoteCalls.push({ order: structuredClone(order), id: context.goalId }); events.push(`quote:${context.goalId}`);
      if (beforeQuote) await beforeQuote(order, context); return client.getQuote(order); },
    async fulfill(order, context) { events.push(`fulfill:${context.goalId}`); const result = await client.fulfill(order, context);
      return beforeFulfill ? beforeFulfill(result, order, context) : result; },
    readStorage: client.readStorage,
  };
  const delivery = { tx_hash: sourceHash, result: { success: true, token_id: 'near', source: 'custom', price_usd: 4.25,
    timestamp: Math.floor(Date.now() / 1000), warning: 'provider text is not forwarded' }, max_age_seconds: 300 };
  const runners = {
    async source({ goal, journal, execute }) {
      if (!execute) { sourcePreviews++; events.push('source:preview'); return { status: 'READY' }; }
      sourcePays++; events.push('source:pay');
      journal.put(goal.id, { status: 'completed', fingerprint: 'synthetic-source', tx_hash: sourceHash });
      return { status: 'FULFILLED', delivery: structuredClone(delivery) };
    },
    async recoverSource({ goal }) { events.push('source:recover'); assert.equal(goal.id, 'price'); return { status: 'REUSED', delivery: structuredClone(delivery) }; },
  };
  const journalPath = path.join(dir, 'journal.json');
  let journal = new FileJournal(journalPath, contract, owner);
  const workflow = makeWorkflow(origin);
  const invoke = (options = {}) => runWorkflow({ workflow, source: { account, publicKey }, resources, provider, journal, execute: true, runners, log: () => {}, ...options });
  return { dir, service, workflow, resources, runners, provider, account, publicKey, delivery, events, transactions, journalPath, invoke,
    get journal() { return journal; }, get sends() { return sends; }, get sourcePays() { return sourcePays; }, get sourcePreviews() { return sourcePreviews; },
    get receiptReads() { return receiptReads; }, get quotes() { return quoteCalls; },
    setDailyCap(n) { dailyCap = BigInt(n); }, setBalance(n) { balance = BigInt(n); }, setReadFailure(v) { readsFail = v; },
    setAmbiguous() { ambiguous = true; }, setBeforeQuote(fn) { beforeQuote = fn; }, setBeforeFulfill(fn) { beforeFulfill = fn; },
    reopen() { journal.close(); journal = new FileJournal(journalPath, contract, owner); },
    async close() { journal?.close(); await service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function withFixture(fn) { const f = await fixture(); try { await fn(f); } finally { await f.close(); } }

test('verified independent data flows through real offline compute, storage and API orders, then key-free replay', () => withFixture(async f => {
  const result = await f.invoke();
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.new_source_payments, 1); assert.equal(result.new_resource_payments, 3);
  assert.equal(f.sourcePays, 1); assert.equal(f.sends, 3); assert.equal(f.quotes.length, 3);
  const [compute, storage, api] = f.quotes.map(q => q.order);
  const sourceArtifact = JSON.parse(compute.input.text);
  assert.deepEqual(sourceArtifact, { version: 1, kind: 'oracle', goal_id: 'price', tx_hash: sourceHash,
    result: { token_id: 'near', source: 'custom', price_usd: 4.25, timestamp: f.delivery.result.timestamp } });
  assert.equal(compute.resource, 'compute');
  assert.deepEqual(JSON.parse(storage.input.content).result, computeResult(compute.input));
  assert.equal(JSON.parse(api.input.text).result.object_id, result.deliveries[1].result.object_id);
  for (let i = 0; i < 3; i++) {
    const entry = f.journal.get(f.workflow.steps[i].id);
    assert.equal(entry.request.memo, orderMemo(f.workflow.steps[i].resource, f.quotes[i].order.input));
    assert.equal(entry.request.payee, payee); assert.equal(entry.request.amount, '10');
    assert.equal(entry.payment_version, 'direct-signed-v1'); assert.equal(entry.delivery.status, 'verified');
  }
  const hashes = f.workflow.steps.map(s => f.journal.get(s.id).tx_hash);
  f.reopen();
  const noKeys = { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage,
    getQuote: async () => { throw new Error('recovery must not quote'); } };
  const recovered = await f.invoke({ source: {}, resources: noKeys, execute: false, recoverOnly: true });
  assert.equal(recovered.status, 'RECOVERED'); assert.equal(recovered.new_payments, 0); assert.equal(recovered.next, null);
  assert.equal(f.sends, 3); assert.equal(f.sourcePays, 1); assert.equal(f.quotes.length, 3);
  assert.deepEqual(f.workflow.steps.map(s => f.journal.get(s.id).tx_hash), hashes);
  const again = await f.invoke(); assert.equal(again.status, 'FULFILLED');
  assert.equal(again.new_source_payments, 0); assert.equal(again.new_resource_payments, 0); assert.equal(f.sends, 3);
}));

test('conservative maximum-cost aggregate preview blocks before the independent purchase or quotes', () => withFixture(async f => {
  f.setDailyCap(250); // three maximums total 300, although the later actual quotes would have totaled 30
  const result = await f.invoke();
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'budget-preview'); assert.ok(result.preview.payments.blocked > 0);
  assert.equal(f.sourcePays, 0); assert.equal(f.sends, 0); assert.equal(f.quotes.length, 0);
  assert.equal(f.journal.get('workflow:research'), undefined);
}));

test('unverified paid compute blocks later stages; restart reuses hash and pays only the remaining steps', () => withFixture(async f => {
  f.setBeforeFulfill((result, _order, { goalId }) => goalId === 'compute' ? { ...result, result: '0'.repeat(64) } : result);
  await assert.rejects(f.invoke(), /verification failed after confirmed payment/);
  const originalHash = f.journal.get('compute').tx_hash;
  assert.equal(f.sends, 1); assert.equal(f.sourcePays, 1); assert.equal(f.journal.get('compute').delivery.status, 'unverified');
  assert.equal(f.journal.get('storage'), undefined); assert.equal(f.journal.get('api'), undefined);
  f.setBeforeFulfill(null); f.reopen();
  const result = await f.invoke();
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.new_source_payments, 0); assert.equal(result.new_resource_payments, 2);
  assert.equal(f.sends, 3); assert.equal(f.sourcePays, 1); assert.equal(f.journal.get('compute').tx_hash, originalHash);
  assert.equal(f.quotes.filter(q => q.id === 'compute').length, 1);
}));

test('ambiguous signed send stays pending; failed key-free recovery cannot send, then reconciles exact hash', () => withFixture(async f => {
  f.setAmbiguous();
  await assert.rejects(f.invoke(), /payment could not be confirmed.*do not retry automatically/);
  const hash = f.journal.get('compute').tx_hash;
  assert.equal(f.journal.get('compute').status, 'pending'); assert.equal(f.sends, 1); assert.equal(f.journal.get('storage'), undefined);
  f.reopen(); f.setReadFailure(true);
  await assert.rejects(f.invoke({ source: {}, resources: {}, execute: false, recoverOnly: true }), /archival RPC unavailable/);
  assert.equal(f.sends, 1); assert.equal(f.sourcePays, 1); assert.equal(f.journal.get('compute').tx_hash, hash);
  f.setReadFailure(false);
  const recovered = await f.invoke({ source: {}, resources: { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage }, execute: false, recoverOnly: true });
  assert.equal(recovered.status, 'RECOVERED'); assert.equal(recovered.next, 'storage'); assert.equal(recovered.new_payments, 0);
  assert.equal(f.journal.get('compute').tx_hash, hash); assert.equal(f.journal.get('compute').delivery.status, 'verified');
  const resumed = await f.invoke(); assert.equal(resumed.status, 'FULFILLED'); assert.equal(f.sends, 3); assert.equal(f.sourcePays, 1);
}));

test('changed or missing workflow intent is rejected before receipt queries, provider calls or further sends', () => withFixture(async f => {
  f.setAmbiguous(); await assert.rejects(f.invoke(), /payment could not be confirmed/);
  f.reopen(); const reads = f.receiptReads, quotes = f.quotes.length;
  for (const change of [w => { w.steps[1].payee = 'attacker.testnet'; }, w => { w.steps[1].max_amount = '99'; },
    w => { w.steps[1].input.content = { from: 'price' }; }, w => { w.provider_url = 'https://attacker.example'; },
    w => { w.source.goal.amount = '101'; }]) {
    const changed = structuredClone(f.workflow); change(changed);
    await assert.rejects(f.invoke({ workflow: changed }), /journal does not match/);
  }
  assert.equal(f.receiptReads, reads); assert.equal(f.quotes.length, quotes); assert.equal(f.sends, 1);
  f.journal.close();
  const saved = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
  saved.entries = saved.entries.filter(item => item.id !== 'workflow:research');
  fs.writeFileSync(f.journalPath, JSON.stringify(saved));
  // Reopen via a distinct journal, then ensure no source recovery or new spend.
  const missing = new FileJournal(f.journalPath, contract, owner);
  try { await assert.rejects(f.invoke({ journal: missing }), /original workflow manifest is missing/); }
  finally { missing.close(); }
  assert.equal(f.receiptReads, reads); assert.equal(f.sends, 1);
}));

test('owner spec is snapshotted before async provider code can mutate later financial authority', () => withFixture(async f => {
  f.setBeforeQuote((_order, { goalId }) => { if (goalId === 'compute') f.workflow.steps[1].payee = 'attacker.testnet'; });
  const result = await f.invoke(); assert.equal(result.status, 'FULFILLED');
  assert.equal(f.journal.get('storage').request.payee, payee); assert.equal(f.sends, 3);
  await assert.rejects(f.invoke(), /journal does not match/);
}));

test('oracle is checked again after an asynchronous guard and before signing is broadcast', () => withFixture(async f => {
  f.workflow.source.goal.max_age_seconds = 1; f.delivery.max_age_seconds = 1;
  const clock = Date.now;
  Date.now = () => f.delivery.result.timestamp * 1000;
  f.resources.beforePayment = async () => { Date.now = () => (f.delivery.result.timestamp + 3) * 1000; };
  try { await assert.rejects(f.invoke(), /too old/); } finally { Date.now = clock; }
  assert.equal(f.sends, 0); assert.equal(f.sourcePays, 1); assert.equal(f.journal.get('compute'), undefined);
}));

test('manifest accepts only backward data bindings and disallows dynamic financial authority', () => {
  const valid = makeWorkflow('https://provider.example');
  assert.ok(Object.isFrozen(validateWorkflow(valid).steps[0].input.text));
  const invalid = [
    w => { w.steps[0].input.text = { from: 'storage' }; },
    w => { w.steps[0].input.text = { from: 'compute' }; },
    w => { w.steps[0].input.text = { from: 'price', format: 'raw' }; },
    w => { w.steps[1].payee = { from: 'price' }; },
    w => { w.steps[2].provider_url = { from: 'price' }; },
    w => { w.steps[1].input.name = { from: 'price' }; },
    w => { w.steps[1].max_amount = '01'; },
    w => { w.steps[1].quote_amount = '101'; },
    w => { w.steps[2].id = 'price'; },
    w => { w.steps[0].arbitrary = true; },
    w => { w.steps[0].input.rounds = 1_000_000; },
    w => { w.steps[2].input = { repo: { from: 'price' } }; },
  ];
  for (const mutate of invalid) { const changed = structuredClone(valid); mutate(changed); assert.throws(() => validateWorkflow(changed)); }
  const normalized = validateWorkflow(valid);
  assert.throws(() => materializeWorkflowStep(normalized.steps[0], new Map()), /unavailable/);
  assert.throws(() => materializeWorkflowStep(normalized.steps[0], new Map([['price', 'x'.repeat(1025)]])), /compute needs text/);
});

test('real oracle runner and signed resource runners compose end-to-end against synthetic FINAL receipts', () => withFixture(async f => {
  const oracle = attachSyntheticOracle({ provider: f.provider, goal: f.workflow.source.goal, journal: f.journal, events: f.events });
  const result = await f.invoke({ source: oracle, runners: {} });
  assert.equal(result.status, 'FULFILLED'); assert.equal(oracle.sends, 1); assert.equal(f.sends, 3);
  assert.equal(result.independent.delivery.charged_yocto, '10'); assert.equal(result.independent.delivery.refunded_to_owner_yocto, '90');
  const input = JSON.parse(f.quotes[0].order.input.text);
  assert.equal(input.tx_hash, oracle.hash); assert.equal(input.result.price_usd, 2.75);
  assert.equal(f.journal.get('workflow:research').tx_hash, oracle.hash);
  f.reopen();
  const replay = await f.invoke({ source: {}, resources: { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage },
    execute: false, recoverOnly: true, runners: {} });
  assert.equal(replay.status, 'RECOVERED'); assert.equal(replay.new_payments, 0); assert.equal(oracle.sends, 1); assert.equal(f.sends, 3);
}));

test('ambiguous real-oracle runner response is recovered by its signed hash without a second source send', () => withFixture(async f => {
  const oracle = attachSyntheticOracle({ provider: f.provider, goal: f.workflow.source.goal, journal: f.journal, events: f.events, ambiguous: true });
  await assert.rejects(f.invoke({ source: oracle, runners: {} }), /do not resend automatically/);
  assert.equal(oracle.sends, 1); assert.equal(f.sends, 0); assert.equal(f.journal.get('price').status, 'pending');
  assert.equal(f.journal.get('price').tx_hash, oracle.hash); f.reopen();
  const recovered = await f.invoke({ source: {}, resources: {}, execute: false, recoverOnly: true, runners: {} });
  assert.equal(recovered.status, 'RECOVERED'); assert.equal(recovered.next, 'compute'); assert.equal(recovered.new_payments, 0);
  assert.equal(f.journal.get('price').status, 'completed'); assert.equal(f.journal.get('price').tx_hash, oracle.hash);
  const resumed = await f.invoke({ source: {}, runners: {} });
  assert.equal(resumed.status, 'FULFILLED'); assert.equal(oracle.sends, 1); assert.equal(f.sends, 3);
}));

test('a changed quote or order memo is rejected before any FT payment', async () => {
  for (const change of [q => ({ ...q, payee: 'attacker.testnet' }), q => ({ ...q, amount: '101' }), q => ({ ...q, memo: 'different' })]) {
    await withFixture(async f => {
      const original = f.resources.getQuote;
      f.resources.getQuote = async (...args) => change(await original(...args));
      await assert.rejects(f.invoke(), /quote|permitted/);
      assert.equal(f.sourcePays, 1); assert.equal(f.sends, 0); assert.equal(f.journal.get('compute'), undefined);
    });
  }
});

test('an execution-time policy block after compute prevents payment for storage and API', () => withFixture(async f => {
  const call = f.provider.callFunction;
  f.setBeforeQuote((_order, { goalId }) => {
    if (goalId === 'storage') f.provider.callFunction = async (receiver, method, ...args) => method === 'check'
      ? [false, 'policy changed'] : call(receiver, method, ...args);
  });
  const result = await f.invoke();
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'storage');
  assert.equal(f.sends, 1); assert.equal(f.journal.get('compute').delivery.status, 'verified');
  assert.equal(f.journal.get('storage'), undefined); assert.equal(f.journal.get('api'), undefined);
}));

test('actual project preflight blocks unmet prepaid funding without initiating funding or any payment', () => withFixture(async f => {
  const project = { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64), usd_policy_id: 'api-token',
    token: 'usdc.fakes.testnet', attached_usd: '15000', input_data: '{"operation":"fetch"}',
    max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 };
  const route = { project, route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1,
    native_payee_revision: 1, usd_payee_revision: 1, active: true };
  f.workflow.source = { kind: 'project', goal: { id: 'price', contract_id: contract, owner_account_id: owner,
    native_policy_id: 'api-native', amount: '100', route, expected_author: 'zavodil.testnet' } };
  f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: { receiver_id: contract, method_names: ['execute_outlayer_project'] } } });
  const previousCall = f.provider.callFunction;
  f.provider.callFunction = async (receiver, method, args, ...rest) => {
    if (method === 'get_owner') return owner;
    if (method === 'get_outlayer_project') return route;
    if (method === 'get_policy') return args.policy_id === 'api-native' ? { token: 'native', per_tx_cap: '100', daily_cap: '200' }
      : { token: project.token, per_tx_cap: '15000', daily_cap: '30000' };
    if (method === 'outlayer_prepaid_balance') return '0';
    if (method === 'get_payment_token_contract') return project.token;
    if (method === 'get_project_pricing') return { author_account_id: 'zavodil.testnet', operations: [{ operation: 'fetch', price_usd: '15000', developer_share_bp: 10000 }] };
    if (method === 'get_version') return { wasm_hash: project.version_key, source: { WasmUrl: { hash: project.version_key, build_target: 'wasm32-wasip2' } } };
    return previousCall(receiver, method, args, ...rest);
  };
  const result = await f.invoke({ runners: {} });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'source-preflight'); assert.equal(result.independent.shortfall, '15000');
  assert.equal(f.sourcePays, 0); assert.equal(f.sends, 0); assert.equal(f.quotes.length, 0);
  assert.equal(f.journal.get('workflow:research'), undefined);
}));

test('a workflow intent write failure stops before the independent send', () => withFixture(async f => {
  const put = f.journal.put.bind(f.journal);
  f.journal.put = (id, entry) => { if (id.startsWith('workflow:')) throw new Error('synthetic fsync failure'); return put(id, entry); };
  await assert.rejects(f.invoke(), /fsync failure/); assert.equal(f.sourcePays, 0); assert.equal(f.sends, 0);
}));

test('random and bounded project sources yield restricted artifacts, not financial authority', async () => {
  for (const kind of ['random', 'project']) await withFixture(async f => {
    let independentResult;
    if (kind === 'random') {
      f.workflow.source = { kind, goal: { id: 'price', contract_id: contract, owner_account_id: owner, policy_id: 'random', amount: '100',
        input: { min: 1, max: 100 }, program: { url: 'https://example.test/random.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip2',
          max_instructions: 1_000_000, max_memory_mb: 128, max_execution_seconds: 10 } } };
      independentResult = { random_number: 42 };
    } else {
      f.workflow.source = { kind, goal: { id: 'price', contract_id: contract, owner_account_id: owner, native_policy_id: 'api-native', amount: '100',
        expected_author: 'zavodil.testnet', route: { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64),
          usd_policy_id: 'api-token', token: 'usdc.fakes.testnet', attached_usd: '10000', input_data: '{"operation":"burn","rounds":1}',
          max_instructions: 1_000_000, max_memory_mb: 128, max_execution_seconds: 10 }, route_revision: 1, native_policy_revision: 1,
          usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true } } };
      independentResult = { operation: 'burn', rounds_done: 1, hashes: 1000, checksum: expectedBurnChecksum(1) };
      const call = f.provider.callFunction;
      f.provider.callFunction = async (receiver, method, ...args) => method === 'get_user_stablecoin_balance' ? '10000' : call(receiver, method, ...args);
    }
    f.runners.source = async ({ goal, journal, execute }) => {
      if (!execute) return { status: 'READY' };
      journal.put(goal.id, { status: 'completed', fingerprint: 'synthetic-source', tx_hash: sourceHash });
      return { status: 'FULFILLED', delivery: { tx_hash: sourceHash, result: independentResult } };
    };
    const result = await f.invoke(); assert.equal(result.status, 'FULFILLED');
    const value = JSON.parse(f.quotes[0].order.input.text);
    assert.equal(value.kind, kind); assert.deepEqual(value.result, independentResult);
    assert.equal(f.journal.get('compute').request.payee, payee); assert.equal(f.sends, 3);
  });
});

test('prepaid project and later FT steps sharing a policy cannot separately overcommit its daily cap', () => withFixture(async f => {
  const project = { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64), usd_policy_id: 'resources',
    token: 'usdc.fakes.testnet', attached_usd: '15000', input_data: '{"operation":"fetch"}',
    max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 };
  const route = { project, route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1,
    native_payee_revision: 1, usd_payee_revision: 1, active: true };
  f.workflow.source = { kind: 'project', goal: { id: 'price', contract_id: contract, owner_account_id: owner,
    native_policy_id: 'api-native', amount: '100', route, expected_author: 'zavodil.testnet' } };
  for (const stage of f.workflow.steps) stage.token = project.token;
  const sourcePublicKey = { toString: () => 'source-key' };
  f.provider.viewAccessKey = async (_owner, key) => ({ permission: { FunctionCall: { receiver_id: contract,
    method_names: [String(key) === 'source-key' ? 'execute_outlayer_project' : 'execute'] } } });
  const previousCall = f.provider.callFunction;
  f.provider.callFunction = async (receiver, method, args, ...rest) => {
    if (method === 'get_owner') return owner;
    if (method === 'get_outlayer_project') return route;
    if (method === 'get_policy') return args.policy_id === 'api-native' ? { token: 'native', per_tx_cap: '100', daily_cap: '200' }
      : { token: project.token, per_tx_cap: '15000', daily_cap: '15150' };
    if (method === 'outlayer_prepaid_balance' || method === 'get_user_stablecoin_balance') return '15000';
    if (method === 'get_payment_token_contract') return project.token;
    if (method === 'get_project_pricing') return { author_account_id: 'zavodil.testnet', operations: [{ operation: 'fetch', price_usd: '15000', developer_share_bp: 10000 }] };
    if (method === 'get_version') return { wasm_hash: project.version_key, source: { WasmUrl: { hash: project.version_key, build_target: 'wasm32-wasip2' } } };
    return previousCall(receiver, method, args, ...rest);
  };
  const result = await f.invoke({ source: { account: f.account, publicKey: sourcePublicKey }, runners: {} });
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'budget-preview');
  assert.ok(result.preview.checks.some(item => item.status === 'BLOCKED' && /rolling daily budget/.test(item.reason)));
  assert.equal(f.sends, 0); assert.equal(f.quotes.length, 0); assert.equal(f.journal.get('workflow:research'), undefined);
}));

test('prepaid project checks the provider-held balance again after budget preview before any send', () => withFixture(async f => {
  f.workflow.source = { kind: 'project', goal: { id: 'price', contract_id: contract, owner_account_id: owner, native_policy_id: 'api-native', amount: '100',
    expected_author: 'zavodil.testnet', route: { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64),
      usd_policy_id: 'api-token', token: 'usdc.fakes.testnet', attached_usd: '15000', input_data: '{"operation":"fetch"}',
      max_instructions: 1_000_000, max_memory_mb: 128, max_execution_seconds: 10 }, route_revision: 1, native_policy_revision: 1,
      usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true } } };
  let reads = 0; const call = f.provider.callFunction;
  f.provider.callFunction = async (receiver, method, ...args) => method === 'get_user_stablecoin_balance' ? (++reads === 1 ? '15000' : '14999') : call(receiver, method, ...args);
  const result = await f.invoke();
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.stage, 'source-provider-credit'); assert.equal(reads, 2);
  assert.equal(f.sourcePays, 0); assert.equal(f.sends, 0); assert.equal(f.journal.get('workflow:research'), undefined);
}));

test('dry run previews owner maximums without quotes, payments or a workflow intent write', () => withFixture(async f => {
  const result = await f.invoke({ execute: false });
  assert.equal(result.status, 'READY'); assert.equal(f.sourcePreviews, 1);
  assert.equal(f.sourcePays, 0); assert.equal(f.sends, 0); assert.equal(f.quotes.length, 0);
  assert.equal(f.journal.get('workflow:research'), undefined);
}));

test('historical oracle results can replay paid work, but stale data cannot trigger a new payment', () => withFixture(async f => {
  f.setBeforeFulfill((result, _order, { goalId }) => goalId === 'compute' ? { ...result, result: '0'.repeat(64) } : result);
  await assert.rejects(f.invoke(), /verification failed/); assert.equal(f.sends, 1); f.reopen(); f.setBeforeFulfill(null);
  const clock = Date.now; Date.now = () => (f.delivery.result.timestamp + 301) * 1000;
  try {
    const replay = await f.invoke({ execute: false, recoverOnly: true, source: {}, resources: { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage } });
    assert.equal(replay.status, 'RECOVERED'); assert.equal(replay.next, 'storage');
    await assert.rejects(f.invoke(), /too old/);
  } finally { Date.now = clock; }
  assert.equal(f.sends, 1); assert.equal(f.sourcePays, 1); assert.equal(f.journal.get('storage'), undefined);
}));

test('a corrupted paid-stage receipt blocks the rest of the workflow before another payment', () => withFixture(async f => {
  f.setBeforeQuote((_order, { goalId }) => { if (goalId === 'storage') throw new Error('synthetic quote outage'); });
  await assert.rejects(f.invoke(), /quote outage/); assert.equal(f.sends, 1); f.journal.close();
  const saved = JSON.parse(fs.readFileSync(f.journalPath, 'utf8'));
  saved.entries.find(entry => entry.id === 'compute').delivery.receipt.result.result = 'f'.repeat(64);
  fs.writeFileSync(f.journalPath, JSON.stringify(saved));
  const bad = new FileJournal(f.journalPath, contract, owner);
  try { await assert.rejects(f.invoke({ journal: bad }), /compute result|delivery receipt/); }
  finally { bad.close(); }
  assert.equal(f.sends, 1); assert.equal(f.sourcePays, 1);
}));

test('out-of-order journal entries fail before recovering the source or paying', () => withFixture(async f => {
  f.setAmbiguous(); await assert.rejects(f.invoke(), /payment could not be confirmed/);
  const { id: _id, ...compute } = f.journal.get('compute');
  f.journal.put('storage', { ...compute, request: undefined, status: 'pending' });
  const eventsBefore = f.events.length;
  await assert.rejects(f.invoke(), /out-of-order/); assert.equal(f.events.length, eventsBefore); assert.equal(f.sends, 1);
}));

test('oracle expiry during journal fsync rejects before broadcast and keeps the signed hash pending', () => withFixture(async f => {
  f.workflow.source.goal.max_age_seconds = 1; f.delivery.max_age_seconds = 1;
  const clock = Date.now, put = f.journal.put.bind(f.journal);
  Date.now = () => f.delivery.result.timestamp * 1000;
  f.journal.put = (id, entry) => {
    const result = put(id, entry);
    if (id === 'compute' && entry.status === 'pending') Date.now = () => (f.delivery.result.timestamp + 3) * 1000;
    return result;
  };
  try { await assert.rejects(f.invoke(), /pre-broadcast guard.*no payment was sent/); }
  finally { Date.now = clock; }
  assert.equal(f.sourcePays, 1); assert.equal(f.sends, 0);
  const pending = f.journal.get('compute'); assert.equal(pending.status, 'pending'); assert.ok(pending.tx_hash);
  await assert.rejects(f.invoke(), /unknown synthetic hash/); assert.equal(f.sends, 0);
}));

test('dependent live-proof harness verifies chained artifacts and hash-only recovery against synthetic FINAL receipts', () => withFixture(async f => {
  const workflow = makeOracleDependentWorkflow({ goal: f.workflow.source.goal, token, payee, policyId: 'resources',
    price: '100', providerUrl: f.workflow.provider_url });
  const oracle = attachSyntheticOracle({ provider: f.provider, goal: workflow.source.goal, journal: f.journal,
    events: f.events, workflowId: workflow.id });
  const source = { account: oracle.account, publicKey: oracle.publicKey };
  const noKeys = { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage,
    getQuote: async () => { throw new Error('recovery must not quote'); } };
  const proof = await runDependentLiveProof({ workflow, provider: f.provider, source, resources: f.resources,
    getJournal: () => f.journal, recoverWithoutKeys: async () => {
      f.reopen();
      return runWorkflow({ workflow, provider: f.provider, source: {}, resources: noKeys, journal: f.journal, recoverOnly: true });
    } });
  assert.equal(proof.sourceBroadcasts, 1); assert.equal(proof.resourceBroadcasts, 3);
  assert.equal(oracle.sends, 1); assert.equal(f.sends, 3);
  assert.equal(proof.firstHash, f.journal.get('dependent-compute').tx_hash);
  assert.equal(f.journal.get('workflow:live-dependent-oracle').status, 'completed');
  assert.deepEqual(proof.quoted.map(o => o.resource), ['compute', 'storage', 'api']);
}));

test('dependent proof stops after recovery failure, leaving the first hash pending and never paying later stages', () => withFixture(async f => {
  const workflow = makeOracleDependentWorkflow({ goal: f.workflow.source.goal, token, payee, policyId: 'resources',
    price: '100', providerUrl: f.workflow.provider_url });
  const oracle = attachSyntheticOracle({ provider: f.provider, goal: workflow.source.goal, journal: f.journal,
    events: f.events, workflowId: workflow.id });
  await assert.rejects(runDependentLiveProof({ workflow, provider: f.provider, source: { account: oracle.account, publicKey: oracle.publicKey },
    resources: f.resources, getJournal: () => f.journal, recoverWithoutKeys: async () => { throw new Error('archival RPC unavailable'); } }), /archival RPC unavailable/);
  assert.equal(oracle.sends, 1); assert.equal(f.sends, 1);
  assert.equal(f.journal.get('dependent-compute').status, 'pending');
  assert.equal(f.journal.get('dependent-storage'), undefined); assert.equal(f.journal.get('dependent-api'), undefined);
  await assert.rejects(runDependentLiveProof({ workflow, provider: f.provider, source: {}, resources: f.resources,
    getJournal: () => f.journal, recoverWithoutKeys: async () => { throw new Error('should not run'); } }), /refusing to run a fresh proof/);
  assert.equal(oracle.sends, 1); assert.equal(f.sends, 1);
}));

test('dependent proof recovers in the real key-free CLI with a restarted local provider and synthetic RPC', () => withFixture(async f => {
  const workflow = makeOracleDependentWorkflow({ goal: f.workflow.source.goal, token, payee, policyId: 'resources',
    price: '100', providerUrl: 'http://127.0.0.1:0' });
  const oracle = attachSyntheticOracle({ provider: f.provider, goal: workflow.source.goal, journal: f.journal,
    events: f.events, workflowId: workflow.id });
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
    { policy_id: 'resources', token, payee, amount: '10' }]));
  const config = { contract_id: contract, owner_account_id: owner, products, data_dir: path.join(f.dir, 'provider'), port: 0 };
  const configPath = path.join(f.dir, 'config.json'), workflowPath = path.join(f.dir, 'workflow.json');
  fs.writeFileSync(configPath, JSON.stringify(config)); fs.writeFileSync(workflowPath, JSON.stringify(workflow));
  const rpcCalls = [], rpcServer = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); rpcCalls.push(body.method);
      let result;
      if (body.method === 'status') result = { chain_id: 'testnet' };
      else if (body.method === 'EXPERIMENTAL_tx_status') result = await f.provider.txStatusReceipts(body.params.tx_hash, body.params.sender_account_id, 'FINAL');
      else if (body.method === 'block') result = await f.provider.block(body.params);
      else throw new Error(`unexpected RPC ${body.method}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => rpcServer.listen(0, '127.0.0.1', resolve));
  let restarted;
  try {
    const rpc = `http://127.0.0.1:${rpcServer.address().port}`;
    const previousPort = Number(new URL(f.workflow.provider_url).port);
    const proof = await runDependentLiveProof({ workflow, provider: f.provider,
      source: { account: oracle.account, publicKey: oracle.publicKey }, resources: f.resources, getJournal: () => f.journal,
      recoverWithoutKeys: async ({ firstHash }) => {
        await f.service.close(); f.journal.close();
        try {
          const cli = fileURLToPath(new URL('../agent/workflow.mjs', import.meta.url));
          const output = await promisify(execFile)(process.execPath, [cli, '--workflow', workflowPath, '--journal', f.journalPath,
            '--rpc', rpc, '--local-provider', configPath, '--recover-only'], { timeout: 20_000, env: { ...process.env, NEAR_TESTNET_RPC: rpc } });
          assert.match(output.stdout, /\[workflow\] RECOVERED/);
          assert.match(output.stdout, /Next unpaid step: dependent-storage/);
          assert.ok(output.stdout.includes(firstHash));
        } finally { f.reopen(); }
        restarted = createResourceProvider({ rpcProvider: f.provider, contractId: contract, ownerAccountId: owner,
          products, dataDir: config.data_dir });
        await new Promise((resolve, reject) => { restarted.server.once('error', reject); restarted.server.listen(previousPort, '127.0.0.1', resolve); });
        return { status: 'RECOVERED', next: 'dependent-storage', new_payments: 0 };
      } });
    assert.equal(proof.result.status, 'FULFILLED'); assert.equal(oracle.sends, 1); assert.equal(f.sends, 3);
    assert.ok(rpcCalls.includes('EXPERIMENTAL_tx_status')); assert.ok(rpcCalls.includes('block'));
    assert.ok(rpcCalls.every(method => ['status', 'EXPERIMENTAL_tx_status', 'block'].includes(method)), 'key-free CLI cannot send transactions');
  } finally {
    if (restarted) await restarted.close();
    await new Promise(resolve => rpcServer.close(resolve));
  }
}));
