import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROJECT, ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, validateOracleGoal } from '../agent/oracle-outlayer.mjs';
import { selectJournalOracle, reconcileOracle } from '../scripts/reconcile-oracle-journal.mjs';

const goal = validateOracleGoal({ id: 'price', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', policy_id: 'oracle', amount: '100',
  route: { project: { ...ORACLE_TESTNET_PROJECT }, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 });
const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 17)), publicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const entry = { id: goal.id, status: 'pending', oracle_goal: goal, tx_hash: hash, agent_public_key: publicKey,
  fingerprint: crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex') };
const journal = () => ({ version: 1, contract_id: goal.contract_id, owner_account_id: goal.owner_account_id, entries: [structuredClone(entry)] });
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64'), blockHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 27));
const event = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'near-outlayer', version: '1.0.0', event, data: [data] })}`;
function finalResult() {
  const p = goal.route.project, source = { WasmUrl: { url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: 'wasm32-wasip2' } };
  const limits = { max_instructions: p.max_instructions, max_memory_mb: p.max_memory_mb, max_execution_seconds: p.max_execution_seconds };
  const args = { policy_id: goal.policy_id, amount: goal.amount, expected_route: goal.route };
  const outlayerArgs = { source: { Project: { project_id: ORACLE_PROJECT_ID, version_key: p.version_key } }, resource_limits: limits,
    input_data: p.input_data, secrets_ref: null, response_format: 'Json', payer_account_id: goal.owner_account_id, params: null };
  const request = { sender_id: goal.owner_account_id, predecessor_id: goal.contract_id, payment: goal.amount, input_data: p.input_data,
    code_source: source, project_id: ORACLE_PROJECT_ID, project_uuid: ORACLE_PROJECT_UUID, attached_usd: '0' };
  const output = encode({ success: true, token_id: 'near', source: 'custom', price_usd: 4.25, timestamp: 1_700_000_000 });
  const outcome = (id, executor_id, status, logs = []) => ({ id, block_hash: blockHash, outcome: { executor_id, status, logs } });
  const receipt = (id, from, to, actions) => ({ receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: { actions } } });
  return { final_execution_status: 'FINAL', status: { SuccessValue: output }, transaction_outcome: { id: hash },
    transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: publicKey,
      actions: [{ FunctionCall: { method_name: 'execute_outlayer_native_project', deposit: '0', args: encode(args) } }] },
    receipts_outcome: [outcome('bouncer', goal.contract_id, { SuccessReceiptId: 'request' }, ['BOUNCER independent native project initiated; full maximum reserved']),
      outcome('request', 'outlayer.testnet', { SuccessReceiptId: 'completion' }, [event('execution_requested', { request_data: JSON.stringify(request) })]),
      outcome('completion', 'outlayer.testnet', { SuccessValue: output }, [event('execution_completed', { success: true, sender_id: goal.owner_account_id,
        code_source: source, payment_charged: '10', payment_refunded: '90' })]),
      outcome('refund', goal.owner_account_id, { SuccessValue: '' })],
    receipts: [receipt('request', goal.contract_id, 'outlayer.testnet', [{ FunctionCall: { method_name: 'request_execution', deposit: '100', args: encode(outlayerArgs) } }]),
      receipt('refund', 'outlayer.testnet', goal.owner_account_id, [{ Transfer: { deposit: '90' } }])] };
}
async function withServer(reply, operation) {
  const requests = [], server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply(body)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await operation(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('selects the exact journaled oracle without changing its private contents', () => {
  const original = journal(), before = JSON.stringify(original);
  assert.equal(selectJournalOracle(goal, original).entry.tx_hash, hash); assert.equal(JSON.stringify(original), before);
  for (const mutate of [j => { j.owner_account_id = 'other.testnet'; }, j => { j.entries.push(j.entries[0]); },
    j => { j.entries[0].tx_hash = 'invalid'; }, j => { j.entries[0].fingerprint = '0'.repeat(64); },
    j => { j.entries[0].oracle_goal.amount = '101'; }, j => { j.entries[0].agent_public_key = 'ed25519:invalid'; }]) {
    const invalid = journal(); mutate(invalid); assert.throws(() => selectJournalOracle(goal, invalid));
  }
});

test('checks the original FINAL transaction, provider result and historical block using read-only RPCs', async () => {
  await withServer(body => ({ result: body.method === 'status' ? { chain_id: 'testnet' }
    : body.method === 'EXPERIMENTAL_tx_status' ? finalResult() : { header: { hash: blockHash, timestamp_nanosec: '1700000008000000000' } } }), async (endpoint, requests) => {
    const report = await reconcileOracle({ goal, entry, endpoints: [endpoint] });
    assert.equal(report.status, 'VERIFIED'); assert.equal(report.delivery.tx_hash, hash); assert.equal(report.delivery.result.price_usd, 4.25);
    assert.equal(report.delivery.charged_yocto, '10'); assert.equal(report.delivery.refunded_to_owner_yocto, '90');
    assert.match(report.warning, /does not make.*fresh/);
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status', 'block']);
    assert.equal(requests[1].params.wait_until, 'FINAL'); assert.equal(requests[1].params.tx_hash, hash);
    assert.deepEqual(requests[2].params, { block_id: blockHash });
  });
});

test('unknown, mismatched, failed or wrong-chain transactions are never treated as verified delivery', async () => {
  await withServer(body => body.method === 'status' ? { result: { chain_id: 'testnet' } } : { error: { message: 'UNKNOWN_TRANSACTION' } }, async (endpoint, requests) => {
    await assert.rejects(reconcileOracle({ goal, entry, endpoints: [endpoint] }), /remains unresolved; never resend/);
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status']);
  });
  for (const mutate of [c => { c.final_execution_status = 'EXECUTED'; }, c => { c.transaction.hash = 'wrong'; },
    c => { c.transaction.public_key = 'ed25519:other'; }, c => { c.transaction.actions[0].FunctionCall.args = encode({}); },
    c => { c.receipts_outcome[3].outcome.status = { Failure: {} }; }]) {
    const result = finalResult(); mutate(result);
    await withServer(body => ({ result: body.method === 'status' ? { chain_id: 'testnet' } : result }), async endpoint => {
      await assert.rejects(reconcileOracle({ goal, entry, endpoints: [endpoint] }), /remains unresolved/);
    });
  }
  await withServer(() => ({ result: { chain_id: 'mainnet' } }), async (endpoint, requests) => {
    await assert.rejects(reconcileOracle({ goal, entry, endpoints: [endpoint] }), /RPC must report testnet/);
    assert.deepEqual(requests.map(r => r.method), ['status']);
  });
  const failed = finalResult(); failed.status = { Failure: { sample: 'failure' } };
  await withServer(body => ({ result: body.method === 'status' ? { chain_id: 'testnet' } : failed }), async endpoint => {
    const report = await reconcileOracle({ goal, entry, endpoints: [endpoint] });
    assert.equal(report.status, 'FINAL_FAILED'); assert.match(report.warning, /does not prove/);
  });
});
