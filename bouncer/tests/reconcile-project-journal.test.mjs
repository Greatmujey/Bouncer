import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import nearApi from 'near-api-js';
import { validateProjectGoal } from '../agent/outlayer-project.mjs';
import { selectJournalProject, reconcileProject } from '../scripts/reconcile-project-journal.mjs';

const goal = validateProjectGoal({ id: 'paid-burn', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', native_policy_id: 'near',
  amount: '100000000000000000000000', expected_author: 'zavodil.testnet', route: { active: true, route_revision: 1,
    native_policy_revision: 1, native_payee_revision: 1, usd_policy_revision: 1, usd_payee_revision: 1,
    project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9',
      usd_policy_id: 'credit', token: 'usdc.fakes.testnet', attached_usd: '10000', input_data: '{"operation":"burn","rounds":5}',
      max_instructions: 5_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 } } });
const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 31));
const publicKey = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
const entry = { id: goal.id, status: 'pending', project_goal: goal, agent_public_key: publicKey, tx_hash: hash,
  fingerprint: crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex') };
const journal = () => ({ version: 1, contract_id: goal.contract_id, owner_account_id: goal.owner_account_id, entries: [structuredClone(entry)] });
const base64 = value => Buffer.from(JSON.stringify(value)).toString('base64');
const chain = () => ({ final_execution_status: 'FINAL', transaction_outcome: { id: hash }, status: { Failure: { sample: 'failed' } },
  transaction: { hash, signer_id: goal.owner_account_id, receiver_id: goal.contract_id, public_key: publicKey,
    actions: [{ FunctionCall: { method_name: 'execute_outlayer_project', deposit: '0', args: base64({ native_policy_id: goal.native_policy_id,
      amount: goal.amount, expected_route: goal.route }) } }] } });
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

test('selects exactly the original reviewed project without changing the journal', () => {
  const source = journal(), before = JSON.stringify(source);
  const selected = selectJournalProject(goal, source);
  assert.equal(selected.entry.tx_hash, hash); assert.equal(JSON.stringify(source), before);
  for (const mutate of [j => { j.owner_account_id = 'other.testnet'; }, j => { j.entries.push(j.entries[0]); },
    j => { j.entries[0].tx_hash = 'invalid'; }, j => { j.entries[0].fingerprint = '0'.repeat(64); },
    j => { j.entries[0].project_goal.route.project.attached_usd = '15000'; },
    j => { j.entries[0].agent_public_key = 'ed25519:not-a-key'; }]) {
    const invalid = journal(); mutate(invalid); assert.throws(() => selectJournalProject(goal, invalid));
  }
});

test('unknown transaction remains unresolved after bounded read-only RPC calls', async () => {
  await withServer(body => body.method === 'status' ? { result: { chain_id: 'testnet' } } : { error: { message: 'UNKNOWN_TRANSACTION' } }, async (endpoint, requests) => {
    await assert.rejects(reconcileProject({ goal, entry, endpoints: [endpoint] }), /remains unresolved; never resend/);
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status']);
    assert.equal(requests[1].params.tx_hash, hash); assert.equal(requests[1].params.wait_until, 'NONE');
  });
});

test('a malformed RPC result remains unresolved with a useful error', async () => {
  await withServer(body => body.method === 'status' ? { result: { chain_id: 'testnet' } } : {}, async (endpoint, requests) => {
    await assert.rejects(reconcileProject({ goal, entry, endpoints: [endpoint] }), /missing result/);
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status']);
  });
});

test('a different chain, transaction or unfinalized response is never treated as evidence', async () => {
  await withServer(() => ({ result: { chain_id: 'mainnet' } }), async (endpoint, requests) => {
    await assert.rejects(reconcileProject({ goal, entry, endpoints: [endpoint] }), /RPC must report testnet/);
    assert.deepEqual(requests.map(r => r.method), ['status']);
  });
  for (const mutate of [c => { c.final_execution_status = 'EXECUTED'; }, c => { c.transaction.hash = 'other'; },
    c => { c.transaction.public_key = 'ed25519:other'; }, c => { c.transaction.actions[0].FunctionCall.args = base64({}); }]) {
    const result = chain(); mutate(result);
    await withServer(body => ({ result: body.method === 'status' ? { chain_id: 'testnet' } : result }), async endpoint => {
      await assert.rejects(reconcileProject({ goal, entry, endpoints: [endpoint] }), /remains unresolved/);
    });
  }
});

test('a matching FINAL failure is reported without claiming that downstream payment was absent', async () => {
  await withServer(body => {
    const result = chain(); result.status.Failure.secret = 'rpc-token-should-not-appear';
    return { result: body.method === 'status' ? { chain_id: 'testnet' } : result };
  }, async (endpoint, requests) => {
    const report = await reconcileProject({ goal, entry, endpoints: [`${endpoint}/rpc-token-should-not-appear`] });
    assert.equal(report.status, 'FINAL_FAILED'); assert.equal(report.tx_hash, hash); assert.match(report.warning, /does not prove/);
    assert.equal(report.endpoint, 'RPC 1'); assert.doesNotMatch(JSON.stringify(report), /rpc-token-should-not-appear/);
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status']);
  });
});

test('a non-final immediate response is followed by one bounded FINAL status read', async () => {
  await withServer(body => ({ result: body.method === 'status' ? { chain_id: 'testnet' } :
    body.params.wait_until === 'NONE' ? { final_execution_status: 'EXECUTED' } : chain() }), async (endpoint, requests) => {
    const report = await reconcileProject({ goal, entry, endpoints: [endpoint] });
    assert.equal(report.status, 'FINAL_FAILED');
    assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_tx_status']);
    assert.deepEqual(requests.slice(1).map(r => r.params.wait_until), ['NONE', 'FINAL']);
    assert.ok(requests.slice(1).every(r => r.params.tx_hash === hash));
  });
});

test('RPC URL paths and untrusted error payloads never appear in reconciliation errors', async () => {
  const secret = 'rpc-token-should-not-appear';
  await withServer(body => body.method === 'status' ? { result: { chain_id: 'testnet' } } : { error: { message: secret } }, async endpoint => {
    await assert.rejects(reconcileProject({ goal, entry, endpoints: [`${endpoint}/${secret}`] }), error => {
      assert.match(error.message, /remains unresolved; never resend/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  });
});

test('RPC redirects are not followed', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/other` }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await assert.rejects(reconcileProject({ goal, entry, endpoints: [`http://127.0.0.1:${server.address().port}/rpc-secret`] }), error => {
      assert.doesNotMatch(error.message, /rpc-secret/); return true;
    });
    assert.equal(requests, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
