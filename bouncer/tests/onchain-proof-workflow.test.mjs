// Synthetic chain and local sellers only. No test below sends a real payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { httpResourceProvider } from '../agent/resource-agent.mjs';
import { validateWorkflow, runWorkflow } from '../agent/workflow.mjs';
import { validateOnchainProofOutput, projectOnchainProofResponse, assertOnchainProofResponseFresh } from '../agent/onchain-proof-workflow.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { loadPipRailTestSdk } from '../scripts/piprail-test-adapter.mjs';
import { createResourceProvider } from '../services/resource-provider.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const owner = 'owner.testnet', contract = 'bouncer.testnet', seller = 'vendor.testnet', sourceSeller = 'api-vendor.testnet';
const log = () => {};
const output = { path: ['data', 'value'], type: 'number', max_age_seconds: 300, accept_untrusted_data_risk: true };
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
const response = (value, content_type = 'application/json; charset=utf-8') => ({ content_type, body_base64: encoded(value) });

test('owner-reviewed source projection rejects hostile paths, unbounded data and noncanonical responses', () => {
  assert.deepEqual(validateOnchainProofOutput(output), output);
  const invalidSpecs = [
    { ...output, accept_untrusted_data_risk: false }, { ...output, type: 'object' }, { ...output, extra: 1 },
    { ...output, max_age_seconds: 0 }, { ...output, max_age_seconds: 901 },
    { ...output, path: ['constructor'] }, { ...output, path: ['__proto__'] },
    { ...output, path: ['data', 'x'.repeat(41)] }, { ...output, path: [0] },
    { ...output, path: ['a', 'b', 'c', 'd', 'e', 'f'] },
  ];
  for (const spec of invalidSpecs) assert.throws(() => validateOnchainProofOutput(spec));
  assert.deepEqual(projectOnchainProofResponse(response({ data: { value: 42, payee: 'evil.testnet' } }), output), { value: 42 });
  for (const bad of [
    response({ data: { value: '42' } }), response({ data: { value: null } }), response({ data: { value: Number.MAX_SAFE_INTEGER + 1 } }),
    response({ data: [{ value: 42 }] }),
    response({ data: { value: 42 } }, 'text/html'), { content_type: 'application/json', body_base64: '???' },
    { content_type: 'application/json', body_base64: Buffer.from([0xff]).toString('base64') },
    { content_type: 'application/json', body_base64: Buffer.from('{').toString('base64') },
    { content_type: 'application/json', body_base64: Buffer.alloc(65537, 32).toString('base64') },
  ]) assert.throws(() => projectOnchainProofResponse(bad, output));
  const str = { ...output, type: 'string' };
  for (const value of ['x'.repeat(513), 'bad\nline', 'text\u202eevil']) assert.throws(() => projectOnchainProofResponse(response({ data: { value } }), str));
  assert.deepEqual(projectOnchainProofResponse(response({ data: { value: 'hello' } }), str), { value: 'hello' });
  const now = Date.now();
  assert.doesNotThrow(() => assertOnchainProofResponseFresh({ received_at: new Date(now - 300_000).toISOString() }, output, now));
  assert.throws(() => assertOnchainProofResponseFresh({ received_at: new Date(now - 300_001).toISOString() }, output, now), /stale/);
  assert.throws(() => assertOnchainProofResponseFresh({ received_at: new Date(now + 1001).toISOString() }, output, now), /stale/);
  assert.throws(() => assertOnchainProofResponseFresh({ received_at: 'yesterday' }, output, now), /invalid/);
});

async function fixture({ useSdk = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-dependent-'));
  const transactions = new Map(), spent = new Map(), received = new Map();
  let nonce = 0, sends = 0, quotes = 0, redemptions = 0, resourceQuotes = [], balance = 10_000n, daily = 10_000n;
  let loseSourceBroadcast = false, loseSourceHttp = false, paidBody = '{"data":{"value":42},"payee":"evil.testnet"}';
  const kp = nearApi.KeyPair.fromRandom('ed25519'), key = kp.getPublicKey(), signer = new nearApi.KeyPairSigner(kp);
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, publicKey) {
    return nearApi.transactions.createTransaction(owner, publicKey, receiver, BigInt(++nonce), actions, Buffer.alloc(32, 8));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: contract, method_names: ['execute'] } } }; },
    async callFunction(_address, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return owner;
      if (method === 'get_policy') return { token: TOKEN, per_tx_cap: '1000', daily_cap: String(daily) };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'storage_balance_of') return { total: '1', available: '0' };
      if (method === 'daily_spent') return String(spent.get(args.policy_id) ?? 0n);
      if (method === 'vault_balance') return String(balance);
      if (method === 'ft_balance_of') return String(received.get(args.account_id) ?? 0n);
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed) {
      const tx = signed.transaction, args = JSON.parse(Buffer.from(tx.actions[0].functionCall.args).toString());
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
      const result = mockGuardedPayment({ hash, owner, contract, publicKey: String(key), args, gas: String(tx.actions[0].functionCall.gas) });
      result.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: contract, new_owner_id: args.payee, amount: args.amount, memo: args.memo }] })];
      transactions.set(hash, result); sends++; balance -= BigInt(args.amount);
      spent.set(args.policy_id, (spent.get(args.policy_id) ?? 0n) + BigInt(args.amount));
      received.set(args.payee, (received.get(args.payee) ?? 0n) + BigInt(args.amount));
      if (args.policy_id === 'source' && loseSourceBroadcast) { loseSourceBroadcast = false; throw new Error('synthetic lost source RPC response'); }
      return structuredClone(result);
    },
    async txStatusReceipts(hash, accountId) {
      assert.equal(accountId, owner); const item = transactions.get(hash);
      if (!item) throw new Error('unknown synthetic transaction');
      return structuredClone(item);
    },
  };
  const products = Object.fromEntries(['compute', 'storage', 'api'].map(resource => [resource,
    { policy_id: 'resources', token: TOKEN, payee: seller, amount: '10' }]));
  // Seller-v3 signs the actual canonical origin. Reserve a port before
  // constructing it rather than advertising the placeholder port zero.
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port, origin = `http://127.0.0.1:${port}`;
  await new Promise(resolve => reservation.close(resolve));
  const sellerOptions = { rpcProvider: provider, contractId: contract, ownerAccountId: owner, products,
    dataDir: path.join(dir, 'seller'), sellerOrigin: origin };
  let service = createResourceProvider(sellerOptions);
  await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); });
  const client = httpResourceProvider(origin, (url, options) => fetch(url, { ...options, headers: { ...options.headers, connection: 'close' } }));
  const resources = { account, publicKey: key,
    async getQuote(order, context) { resourceQuotes.push({ id: context.goalId, order: structuredClone(order) }); return client.getQuote(order); },
    fulfill: client.fulfill, readStorage: client.readStorage };
  const sourceGoal = { version: 1, id: 'data', contract_id: contract, owner_account_id: owner, policy_id: 'source',
    token: TOKEN, payee: sourceSeller, max_amount: '100', resource_url: 'https://seller.example/api',
    max_quote_age_seconds: 120, accept_public_proof_risk: true, accept_unbound_resource_risk: true };
  const step = (id, resource, input) => ({ id, resource, input, policy_id: 'resources', token: TOKEN, payee: seller,
    max_amount: '100', order_binding: 'seller-v3' });
  const workflow = { version: 1, id: 'x402-dependent', source: { kind: 'onchain-proof', goal: sourceGoal, output: structuredClone(output) },
    provider_url: origin, steps: [step('compute', 'compute', { text: { from: 'data' }, rounds: 2 }),
      step('storage', 'storage', { name: 'report', content: { from: 'compute' } }),
      step('api', 'api', { text: { from: 'storage' } })] };
  const offer = { scheme: 'onchain-proof', network: 'near:testnet', amount: '10', asset: TOKEN, payTo: sourceSeller,
    maxTimeoutSeconds: 600, extra: { nonce: 'fixture-source-nonce', decimals: 6, minConfirmations: 1, amountFormatted: '0.00001' } };
  let rpc;
  let handler;
  if (useSdk) {
    const sdk = await loadPipRailTestSdk(process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT);
    rpc = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body), param = call.params;
      const hash = typeof param?.tx_hash === 'string' ? param.tx_hash : Array.isArray(param) ? param[0] : undefined;
      const result = transactions.get(hash);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: call.id, result } :
        { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'unknown synthetic transaction' } }));
    });
    await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
    const gate = sdk.createPaymentGate({ chain: 'near', token: { contractId: TOKEN, decimals: 6, symbol: 'USDC' },
      amount: '0.00001', payTo: sourceSeller, rpcUrl: `http://127.0.0.1:${rpc.address().port}`, generateNonce: () => 'fixture-source-nonce' });
    handler = sdk.toFetchHandler(gate, async () => new Response(paidBody, { headers: { 'content-type': 'application/json' } }));
  }
  async function fetchSource(url, options) {
    assert.equal(url, sourceGoal.resource_url);
    if (!options.headers?.['payment-signature']) {
      quotes++;
      if (handler) return handler(new Request(url, options));
      return new Response('', { status: 402, headers: { 'payment-required': encoded({ x402Version: 2, resource: { url }, accepts: [offer] }) } });
    }
    redemptions++;
    if (loseSourceHttp) throw new Error('synthetic lost seller response');
    if (handler) return handler(new Request(url, options));
    const proof = JSON.parse(Buffer.from(options.headers['payment-signature'], 'base64').toString());
    assert.equal(proof.payload.nonce, offer.extra.nonce);
    const hash = proof.payload.txHash.slice(owner.length + 1);
    assert.ok(transactions.has(hash));
    return new Response(paidBody, { headers: { 'content-type': 'application/json' } });
  }
  const journalPath = path.join(dir, 'journal.json');
  let journal = new FileJournal(journalPath, contract, owner);
  const invoke = (options = {}) => runWorkflow({ workflow, source: { account, publicKey: key, fetchImpl: fetchSource },
    resources, provider, journal, execute: true, log, ...options });
  return { workflow, resources, provider, account, key, invoke, fetchSource, transactions,
    get journal() { return journal; }, get sends() { return sends; }, get quotes() { return quotes; },
    get redemptions() { return redemptions; }, get resourceQuotes() { return resourceQuotes; },
    setDaily(v) { daily = BigInt(v); }, setBalance(v) { balance = BigInt(v); },
    loseBroadcast() { loseSourceBroadcast = true; }, loseHttp() { loseSourceHttp = true; }, setBody(v) { paidBody = v; },
    reopen() { journal.close(); journal = new FileJournal(journalPath, contract, owner); },
    async restartSeller() { await service.close(); service = createResourceProvider(sellerOptions);
      await new Promise((resolve, reject) => { service.server.once('error', reject); service.server.listen(port, '127.0.0.1', resolve); }); },
    async close() { journal.close(); await service.close(); if (rpc) await new Promise(resolve => rpc.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
async function withFixture(fn, options) { const f = await fixture(options); try { await fn(f); } finally { await f.close(); } }

test('x402 JSON source drives authenticated compute → storage → API and key-free replay', () => withFixture(async f => {
  const dry = await f.invoke({ execute: false });
  assert.equal(dry.status, 'READY'); assert.equal(f.sends, 0); assert.equal(f.redemptions, 0); assert.equal(f.journal.list().length, 0);
  const result = await f.invoke();
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.new_source_payments, 1); assert.equal(result.new_resource_payments, 3);
  assert.equal(f.sends, 4); assert.equal(f.redemptions, 1); assert.equal(f.resourceQuotes.length, 3);
  const first = JSON.parse(f.resourceQuotes[0].order.input.text);
  assert.equal(first.kind, 'onchain-proof'); assert.deepEqual(first.result, { value: 42 });
  assert.equal(JSON.stringify(first).includes('evil.testnet'), false);
  assert.equal(f.resourceQuotes[0].order.order_binding, 'seller-v3');
  assert.equal(JSON.parse(f.resourceQuotes[1].order.input.content).kind, 'compute');
  assert.equal(JSON.parse(f.resourceQuotes[2].order.input.text).kind, 'storage');
  const hashes = ['data', 'compute', 'storage', 'api'].map(id => f.journal.get(id).tx_hash);
  assert.ok(f.workflow.steps.every(stage => f.journal.get(stage.id).delivery.status === 'verified'));
  f.reopen(); await f.restartSeller();
  const recovered = await f.invoke({ execute: false, recoverOnly: true,
    source: { fetchImpl: () => { throw new Error('recovery must not contact source seller'); } },
    resources: { fulfill: f.resources.fulfill, readStorage: f.resources.readStorage } });
  assert.equal(recovered.status, 'RECOVERED'); assert.equal(recovered.new_payments, 0); assert.equal(recovered.next, null);
  assert.equal(f.sends, 4); assert.equal(f.redemptions, 1);
  assert.deepEqual(['data', 'compute', 'storage', 'api'].map(id => f.journal.get(id).tx_hash), hashes);
}));

test('source callback cannot mutate the frozen output selection or later financial authority', () => withFixture(async f => {
  let changed = false;
  const fetchImpl = async (url, options) => {
    if (!changed) { changed = true; f.workflow.source.output.path = ['payee']; f.workflow.steps[0].payee = 'attacker.testnet'; }
    return f.fetchSource(url, options);
  };
  const result = await f.invoke({ source: { account: f.account, publicKey: f.key, fetchImpl } });
  assert.equal(result.status, 'FULFILLED');
  assert.deepEqual(JSON.parse(f.resourceQuotes[0].order.input.text).result, { value: 42 });
  assert.equal(f.journal.get('compute').request.payee, seller);
  assert.deepEqual(f.journal.get('workflow:x402-dependent').workflow.source.output.path, ['data', 'value']);
}));

test('x402 source maximum reserves the same policy budget and shared vault before any payment', () => withFixture(async f => {
  // Different policies, same FT vault: 100 source + 3 x 100 resources > 399.
  f.setBalance(399);
  const vault = await f.invoke();
  assert.equal(vault.status, 'BLOCKED'); assert.equal(vault.stage, 'budget-preview');
  assert.match(vault.preview.checks.at(-1).reason, /token vault balance/);
  assert.equal(f.sends, 0); assert.equal(f.redemptions, 0); assert.equal(f.resourceQuotes.length, 0);
  f.setBalance(1000); f.setDaily(399);
  f.workflow.source.goal.policy_id = 'resources';
  const daily = await f.invoke();
  assert.equal(daily.status, 'BLOCKED'); assert.match(daily.preview.checks.at(-1).reason, /daily budget/);
  assert.equal(f.sends, 0); assert.equal(f.journal.list().length, 0);
}));

test('ambiguous source payment reconciles without keys; first redemption requires explicit opt-in and never repays', () => withFixture(async f => {
  f.loseBroadcast();
  await assert.rejects(f.invoke(), /unresolved.*never resend automatically/);
  const hash = f.journal.get('data').tx_hash;
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 0); assert.equal(f.journal.get('data').status, 'pending');
  f.reopen();
  const before = structuredClone(f.journal.get('data'));
  const dry = await f.invoke({ execute: false, source: { fetchImpl: f.fetchSource } });
  assert.equal(dry.status, 'RECOVERY_REQUIRED'); assert.deepEqual(f.journal.get('data'), before); // no dry-run write
  const withheld = await f.invoke({ execute: false, recoverOnly: true, source: { fetchImpl: f.fetchSource }, resources: {} });
  assert.equal(withheld.status, 'RECOVERY_REQUIRED'); assert.equal(withheld.independent.redemption_status, 'not_started');
  assert.equal(f.redemptions, 0); assert.equal(f.journal.get('data').status, 'completed');
  const first = await f.invoke({ execute: false, recoverOnly: true, redeemSource: true, source: { fetchImpl: f.fetchSource }, resources: {} });
  assert.equal(first.status, 'RECOVERED'); assert.equal(first.next, 'compute'); assert.equal(first.new_payments, 0);
  assert.equal(f.journal.get('data').tx_hash, hash); assert.equal(f.sends, 1); assert.equal(f.redemptions, 1);
  const resumed = await f.invoke({ source: { fetchImpl: f.fetchSource } });
  assert.equal(resumed.status, 'FULFILLED'); assert.equal(resumed.new_source_payments, 0); assert.equal(f.sends, 4);
  assert.equal(f.redemptions, 1);
}));

test('ambiguous seller response and invalid paid data never cause a retry, repayment or later purchase', async () => {
  await withFixture(async f => {
    f.loseHttp(); await assert.rejects(f.invoke(), /redemption was attempted.*never repay or retry/);
    assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.journal.get('data').redemption.status, 'attempted');
    const recovered = await f.invoke({ execute: false, recoverOnly: true, redeemSource: true, source: { fetchImpl: f.fetchSource }, resources: {} });
    assert.equal(recovered.status, 'RECOVERY_REQUIRED'); assert.equal(recovered.independent.redemption_status, 'attempted');
    assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.journal.get('compute'), undefined);
  });
  await withFixture(async f => {
    f.setBody('{"data":{"value":"not a number"}}');
    await assert.rejects(f.invoke(), /reviewed primitive type/);
    assert.equal(f.journal.get('data').redemption.status, 'delivered'); assert.equal(f.sends, 1); assert.equal(f.redemptions, 1);
    await assert.rejects(f.invoke({ execute: false, recoverOnly: true, source: { fetchImpl: f.fetchSource }, resources: {} }), /reviewed primitive type/);
    assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.journal.get('compute'), undefined);
  });
});

test('expired local x402 receipt blocks new stages; changed manifest cannot redirect money', () => withFixture(async f => {
  // Finish the source, then interrupt before the first resource quote.
  const bad = { ...f.resources, getQuote: async () => { throw new Error('pause after source'); } };
  await assert.rejects(f.invoke({ resources: bad }), /pause after source/);
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 1);
  for (const change of [w => { w.source.output.path = ['payee']; }, w => { w.source.output.max_age_seconds = 1; },
    w => { w.steps[0].payee = 'attacker.testnet'; }, w => { w.source.goal.resource_url = 'https://evil.example/api'; }]) {
    const changed = structuredClone(f.workflow); change(changed);
    await assert.rejects(f.invoke({ workflow: changed }), /journal does not match/);
  }
  const entry = f.journal.get('data');
  f.journal.put('data', { ...entry, redemption: { ...entry.redemption, received_at: new Date(Date.now() - 301_000).toISOString() } });
  const recovery = await f.invoke({ execute: false, recoverOnly: true, source: { fetchImpl: f.fetchSource }, resources: {} });
  assert.equal(recovery.status, 'RECOVERED'); // historical evidence may still be inspected
  await assert.rejects(f.invoke({ source: { fetchImpl: f.fetchSource } }), /receipt is stale/);
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.journal.get('compute'), undefined);
}));

test('source expiry during an asynchronous guard stops before the first resource payment', () => withFixture(async f => {
  f.workflow.source.output.max_age_seconds = 1;
  const resources = { ...f.resources, beforePayment: async () => {
    const entry = f.journal.get('data');
    // Simulate local time moving past the reviewed receipt age during a guard.
    f.journal.put('data', { ...entry, redemption: { ...entry.redemption, received_at: new Date(Date.now() - 2_000).toISOString() } });
  } };
  // The in-memory delivery is a snapshot: mutate the clock instead to model elapsed time.
  const originalNow = Date.now; let shifted = false;
  Date.now = () => originalNow() + (shifted ? 2_000 : 0);
  resources.beforePayment = async () => { shifted = true; };
  try { await assert.rejects(f.invoke({ resources }), /receipt is stale/); }
  finally { Date.now = originalNow; }
  assert.equal(f.sends, 1); assert.equal(f.redemptions, 1); assert.equal(f.journal.get('compute'), undefined);
}));

test('workflow manifest refuses source risk opt-out, dynamic payment authority and incompatible rail', () => withFixture(async f => {
  assert.equal(validateWorkflow(f.workflow).source.kind, 'onchain-proof');
  const example = JSON.parse(fs.readFileSync(new URL('../examples/onchain-proof-workflow.example.json', import.meta.url), 'utf8'));
  assert.throws(() => validateWorkflow(example));
  example.source.goal.accept_public_proof_risk = true; example.source.goal.accept_unbound_resource_risk = true;
  example.source.output.accept_untrusted_data_risk = true;
  assert.equal(validateWorkflow(example).steps.length, 3);
  for (const change of [w => { w.source.output.accept_untrusted_data_risk = false; },
    w => { w.source.goal.accept_public_proof_risk = false; }, w => { w.source.goal.token = 'wrap.testnet'; },
    w => { w.source.goal.payee = { from: 'data' }; }, w => { w.steps[0].max_amount = { from: 'data' }; },
    w => { w.steps[0].input.text = { from: 'storage' }; }, w => { w.source.output.surprise = true; }]) {
    const changed = structuredClone(f.workflow); change(changed);
    assert.throws(() => validateWorkflow(changed));
  }
  assert.equal(f.sends, 0); assert.equal(f.quotes, 0);
}));

const sdkRoot = process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT;
test('published PipRail SDK gate, synthetic NEAR receipts and seller-v3 compose in the workflow',
  { skip: !sdkRoot && 'install the pinned SDK and set BOUNCER_PIPRAIL_PACKAGE_ROOT' }, () => withFixture(async f => {
    const result = await f.invoke();
    assert.equal(result.status, 'FULFILLED'); assert.equal(f.sends, 4); assert.equal(f.redemptions, 1);
    assert.deepEqual(JSON.parse(f.resourceQuotes[0].order.input.text).result, { value: 42 });
  }, { useSdk: true }));
