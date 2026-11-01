import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateProjectGoal, verifyProjectResult, runProjectGoal, recoverProjectGoal, assertProjectRegistry } from '../agent/outlayer-project.mjs';
import { signingFixture } from './signing-fixture.mjs';

const pair = crypto.generateKeyPairSync('ed25519');
const vrfKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const projectId = 'connectors.outlayer.testnet/connector-probe', seed = 'fresh_vrf_20261101';
const route = { project: { project_id: projectId, version_key: 'a'.repeat(64), usd_policy_id: 'api-token', token: 'usdc.fakes.testnet',
  attached_usd: '10000', input_data: JSON.stringify({ operation: 'vrf', seed }), max_instructions: 1_000_000_000,
  max_memory_mb: 256, max_execution_seconds: 60 }, route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1,
  native_payee_revision: 1, usd_payee_revision: 1, active: true };
const goal = { id: 'diagnostic-vrf', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', native_policy_id: 'api-native',
  amount: '100', route, expected_author: 'zavodil.testnet', expected_vrf_pubkey: vrfKey };
const signedArgs = () => ({ native_policy_id: goal.native_policy_id, amount: goal.amount, expected_route: goal.route });
const signing = signingFixture({ ownerId: goal.owner_account_id, contractId: goal.contract_id, method: 'execute_outlayer_project', args: signedArgs() });
const { key, hash } = signing, ids = ['6', '7', '8', '9'].map(x => x.repeat(44));
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
const event = (name, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event: name, data: [data] })}`;
const source = () => ({ WasmUrl: { url: 'https://example.test/version.wasm', hash: route.project.version_key, build_target: 'wasm32-wasip2' } });
const out = (id, executor_id, status, logs = [], receipt_ids = []) => ({ id, outcome: { executor_id, status, logs, receipt_ids } });
const receipt = (id, predecessor_id, receiver_id, actions) => ({ receipt_id: id, predecessor_id, receiver_id, receipt: { Action: { actions } } });
const alpha = `vrf:42:${goal.owner_account_id}:${seed}`, signature = crypto.sign(null, Buffer.from(alpha), pair.privateKey);
const vrf = { ok: true, operation: 'vrf', vrf_alpha: alpha, vrf_pubkey: vrfKey, vrf_signature: signature.toString('hex'),
  vrf_output: crypto.createHash('sha256').update(signature).digest('hex') };
const split = `Split 10000 stablecoin for project ${projectId}: 0 to author ${goal.expected_author}, 10000 to owner connectors.outlayer.testnet (attached=10000, refund=0)`;
function finalResult(output = vrf) {
  const value = enc(output), requestData = { request_id: 42, sender_id: goal.owner_account_id, predecessor_id: goal.contract_id,
    payment: goal.amount, attached_usd: '10000', input_data: route.project.input_data, project_id: projectId, code_source: source() };
  const completion = { success: true, sender_id: goal.owner_account_id, code_source: source(), payment_charged: '10', payment_refunded: '90' };
  const providerArgs = { source: { Project: { project_id: projectId, version_key: route.project.version_key } },
    resource_limits: { max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
    input_data: route.project.input_data, payer_account_id: goal.owner_account_id, response_format: 'Json', secrets_ref: null, params: { attached_usd: '10000' } };
  return { final_execution_status: 'FINAL', status: { SuccessValue: value }, transaction_outcome: { id: hash, outcome: { receipt_ids: [ids[0]] } },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_project', deposit: '0', gas: '300000000000000', args: enc(signedArgs()) } }] },
    receipts_outcome: [out(ids[0], goal.contract_id, { SuccessReceiptId: ids[1] }, ['BOUNCER independent paid project initiated; native and prepaid maxima reserved'], [ids[1]]),
      out(ids[1], 'outlayer.testnet', { SuccessReceiptId: ids[2] }, [event('execution_requested', { request_data: JSON.stringify(requestData) })]),
      out(ids[2], 'outlayer.testnet', { SuccessValue: value }, [split, event('execution_completed', completion)]),
      out(ids[3], goal.owner_account_id, { SuccessValue: '' })],
    receipts: [receipt(ids[1], goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: goal.amount, args: enc(providerArgs) } }]),
      receipt(ids[3], 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }])] };
}
function fixture() {
  const entries = new Map(), journal = { get(id) { return entries.get(id); }, put(id, entry) { entries.set(id, structuredClone(entry)); } };
  let sends = 0, unavailable = false;
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_outlayer_project'] } } }; },
    async callFunction(_, method, args) {
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_outlayer_project') return route;
      if (method === 'get_policy') return args.policy_id === goal.native_policy_id ? { token: 'native' } : { token: route.project.token, per_tx_cap: '10000', daily_cap: '10000' };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      if (method === 'outlayer_prepaid_balance') return '10000';
      if (method === 'daily_spent') return '0';
      if (method === 'get_payment_token_contract') return route.project.token;
      if (method === 'get_project_pricing') return { author_account_id: goal.expected_author, operations: [{ operation: 'vrf', price_usd: '10000', developer_share_bp: 0 }] };
      if (method === 'get_version') return { wasm_hash: route.project.version_key, source: source() };
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(_signed, wait) { sends++; assert.equal(wait, 'FINAL'); assert.equal(journal.get(goal.id).status, 'pending'); return { transaction_outcome: { id: hash } }; },
    async txStatusReceipts(tx) { assert.equal(tx, hash); if (unavailable) throw new Error('temporarily missing'); return finalResult(); },
  };
  return { journal, provider, sends: () => sends, unavailable(value) { unavailable = value; },
    opts: { goal, provider, account: signing.newAccount(), publicKey: key, journal, execute: true, log: () => {} } };
}

test('a VRF goal pins the exact seed, fake-token price and independent public key', () => {
  assert.deepEqual(validateProjectGoal(goal), goal);
  for (const change of [
    g => { delete g.expected_vrf_pubkey; }, g => { g.expected_vrf_pubkey = 'BAD'; },
    g => { g.route.project.input_data = JSON.stringify({ operation: 'vrf', seed: 'bad:seed' }); },
    g => { g.route.project.input_data = JSON.stringify({ seed, operation: 'vrf' }); },
    g => { g.route.project.input_data = JSON.stringify({ operation: 'vrf', seed, extra: true }); },
    g => { g.route.project.attached_usd = '9999'; }, g => { g.route.project.token = 'other.testnet'; },
  ]) { const g = structuredClone(goal); change(g); assert.throws(() => validateProjectGoal(g)); }
  const base = { project: route.project, expectedAuthor: goal.expected_author, configuredToken: route.project.token,
    pricing: { author_account_id: goal.expected_author, operations: [{ operation: 'vrf', price_usd: '10000', developer_share_bp: 0 }] },
    versionInfo: { wasm_hash: route.project.version_key, source: source() } };
  assert.doesNotThrow(() => assertProjectRegistry(base));
  assert.throws(() => assertProjectRegistry({ ...base, pricing: { ...base.pricing, operations: [{ operation: 'vrf', price_usd: '10001', developer_share_bp: 0 }] } }));
});

test('a linked paid diagnostic result verifies its Ed25519 signature and binds the on-chain request', () => {
  const result = verifyProjectResult(goal, finalResult(), key);
  assert.equal(result.tx_hash, hash); assert.equal(result.prepaid_charged, '10000'); assert.equal(result.result.request_id, 42);
  assert.equal(result.result.output_hex, vrf.vrf_output); assert.match(result.verification, /no TEE/);
  for (const mutation of [
    r => { r.transaction.actions[0].FunctionCall.gas = '1'; },
    r => { r.transaction_outcome.outcome.receipt_ids = []; }, r => { r.receipts_outcome[0].outcome.receipt_ids = []; },
    r => { r.receipts_outcome[1].outcome.status.SuccessReceiptId = '2'.repeat(44); },
    r => { const data = JSON.parse(r.receipts_outcome[1].outcome.logs[0].slice('EVENT_JSON:'.length));
      const req = JSON.parse(data.data[0].request_data); req.request_id = 43; data.data[0].request_data = JSON.stringify(req);
      r.receipts_outcome[1].outcome.logs[0] = `EVENT_JSON:${JSON.stringify(data)}`; },
    r => { r.receipts_outcome[2].outcome.logs[0] = r.receipts_outcome[2].outcome.logs[0].replace('0 to author', '1 to author'); },
  ]) { const r = finalResult(); mutation(r); assert.throws(() => verifyProjectResult(goal, r, key)); }
  for (const bad of [{ ...vrf, vrf_output: '00'.repeat(32) }, { ...vrf, vrf_signature: '00'.repeat(64) },
    { ...vrf, vrf_alpha: `vrf:42:attacker.testnet:${seed}` }, { ...vrf, vrf_pubkey: '00'.repeat(32) }]) {
    assert.throws(() => verifyProjectResult(goal, finalResult(bad), key));
  }
});

test('a lost diagnostic result remains pending and key-free recovery uses the original payment', async () => {
  const f = fixture(); f.unavailable(true); await assert.rejects(runProjectGoal(f.opts), /paid project unresolved/);
  assert.equal(f.sends(), 1); assert.equal(f.journal.get(goal.id).status, 'pending');
  f.unavailable(false);
  const result = await recoverProjectGoal({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(result.status, 'REUSED'); assert.equal(result.delivery.result.output_hex, vrf.vrf_output); assert.equal(f.sends(), 1);
  await assert.rejects(recoverProjectGoal({ goal: { ...goal, expected_vrf_pubkey: '00'.repeat(32) }, provider: f.provider, journal: f.journal, log: () => {} }), /journal/);
});
