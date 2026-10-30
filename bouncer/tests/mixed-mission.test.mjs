import test from 'node:test';
import assert from 'node:assert/strict';
import { runMixedMission } from '../agent/mixed-mission.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';

const goal = { id: 'independent-1', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  policy_id: 'independent', amount: '100', input: { min: 1, max: 100 },
  program: { url: 'https://example.org/program.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip1',
    max_instructions: 10000000, max_memory_mb: 128, max_execution_seconds: 60 } };
function fixture() {
  const entries = new Map(), calls = [];
  const journal = { get: id => entries.get(id), put: (id, entry) => entries.set(id, entry) };
  const runners = {
    async outlayer({ execute }) {
      calls.push(execute ? 'external-send' : 'external-preview');
      if (!execute) return { status: 'READY' };
      journal.put(goal.id, { status: 'completed', delivery: { tx_hash: 'independent-tx' } });
      return { status: 'FULFILLED', delivery: { tx_hash: 'independent-tx' } };
    },
    async recover({ update }) { calls.push(`external-recover:${update}`); return { status: 'REUSED', delivery: { tx_hash: 'independent-tx' } }; },
    async resources({ execute }) {
      calls.push(execute ? 'ft-execute' : 'ft-preview');
      return { payments: { blocked: 0 }, deliveries: execute ? [{ id: 'storage-1' }, { id: 'api-1' }] : [] };
    },
  };
  const options = { outlayer: { goal }, resources: { contractId: goal.contract_id, ownerAccountId: goal.owner_account_id,
    goals: [{ id: 'storage-1' }, { id: 'api-1' }] }, provider: {}, journal, runners, log: () => {} };
  return { options, calls, entries, runners };
}

test('dry run previews both asset paths and never sends', async () => {
  const f = fixture();
  assert.equal((await runMixedMission(f.options)).status, 'READY');
  assert.deepEqual(f.calls, ['external-preview', 'ft-preview']);
  assert.equal(f.entries.size, 0);
});

test('live mission preflights both, verifies independent compute, then executes FT resources', async () => {
  const f = fixture();
  assert.equal((await runMixedMission({ ...f.options, execute: true })).status, 'FULFILLED');
  assert.deepEqual(f.calls, ['external-preview', 'ft-preview', 'external-send', 'ft-execute']);
});

test('durable direct-payment option reaches both resource preview and execution', async () => {
  const f = fixture(), seen = [], original = f.runners.resources;
  f.runners.resources = async options => { seen.push([options.execute, options.durablePayment]); return original(options); };
  assert.equal((await runMixedMission({ ...f.options, resources: { ...f.options.resources, durablePayment: true }, execute: true })).status, 'FULFILLED');
  assert.deepEqual(seen, [[false, true], [true, true]]);
});

test('either blocked preflight prevents both payment paths', async () => {
  let f = fixture();
  f.runners.outlayer = async () => { f.calls.push('external-blocked'); return { status: 'BLOCKED' }; };
  assert.equal((await runMixedMission({ ...f.options, execute: true })).stage, 'independent-preflight');
  assert.deepEqual(f.calls, ['external-blocked']);
  f = fixture();
  f.runners.resources = async () => { f.calls.push('ft-blocked'); return { payments: { blocked: 1 }, deliveries: [] }; };
  assert.equal((await runMixedMission({ ...f.options, execute: true })).stage, 'ft-preflight');
  assert.deepEqual(f.calls, ['external-preview', 'ft-blocked']);
});

test('an unverified independent result stops before all FT payments', async () => {
  const f = fixture();
  f.runners.outlayer = async ({ execute }) => {
    f.calls.push(execute ? 'external-send-failed-verification' : 'external-preview');
    if (execute) throw new Error('paid but unverified');
    return { status: 'READY' };
  };
  await assert.rejects(runMixedMission({ ...f.options, execute: true }), /paid but unverified/);
  assert.deepEqual(f.calls, ['external-preview', 'ft-preview', 'external-send-failed-verification']);
});

test('recovering an independent payment requires no new external send before resuming FTs', async () => {
  const f = fixture();
  f.entries.set(goal.id, { status: 'pending', tx_hash: 'existing-tx' });
  f.entries.set('storage-1', { status: 'completed', delivery: { status: 'unverified' } });
  assert.equal((await runMixedMission({ ...f.options, execute: true })).status, 'FULFILLED');
  assert.deepEqual(f.calls, ['external-recover:true', 'ft-preview', 'ft-execute']);
});

test('dry-run recovery is read-only', async () => {
  const f = fixture(); f.entries.set(goal.id, { status: 'pending', tx_hash: 'existing-tx' });
  assert.equal((await runMixedMission(f.options)).status, 'READY');
  assert.deepEqual(f.calls, ['external-recover:false', 'ft-preview']);
  assert.equal(f.entries.get(goal.id).status, 'pending');
});

test('earlier uncertain FT work blocks a new independent payment', async () => {
  for (const entry of [{ status: 'pending' }, { status: 'completed', delivery: { status: 'unverified' } }, { status: 'completed' }]) {
    const f = fixture(); f.entries.set('storage-1', entry);
    await assert.rejects(runMixedMission({ ...f.options, execute: true }), /recover the earlier FT payment/);
    assert.deepEqual(f.calls, []);
  }
});

test('partial FT execution is explicitly incomplete, not a successful mission', async () => {
  const f = fixture();
  f.runners.resources = async ({ execute }) => execute ? { payments: { blocked: 1 }, deliveries: [{ id: 'storage-1' }] } : { payments: { blocked: 0 }, deliveries: [] };
  assert.equal((await runMixedMission({ ...f.options, execute: true })).status, 'INCOMPLETE');
});

test('rejects cross-contract, cross-owner and colliding goal IDs before preflight', async () => {
  const f = fixture();
  await assert.rejects(runMixedMission({ ...f.options, resources: { ...f.options.resources, contractId: 'other.testnet' } }), /share the reviewed/);
  await assert.rejects(runMixedMission({ ...f.options, resources: { ...f.options.resources, ownerAccountId: 'other.testnet' } }), /share the reviewed/);
  await assert.rejects(runMixedMission({ ...f.options, resources: { ...f.options.resources, goals: [{ id: goal.id }] } }), /distinct/);
  assert.deepEqual(f.calls, []);
});

function oracleFixture(timestamp = Math.floor(Date.now() / 1000)) {
  const f = fixture();
  const oracle = { id: 'market-price', contract_id: goal.contract_id, owner_account_id: goal.owner_account_id,
    policy_id: 'oracle-data', amount: '100', route: { project: { ...ORACLE_TESTNET_PROJECT },
      route_revision: 1, policy_revision: 1, payee_revision: 1, active: true }, max_age_seconds: 300 };
  const delivery = { tx_hash: 'oracle-tx', result: { timestamp, price_usd: 2.5 }, max_age_seconds: 300 };
  f.options.outlayer = { kind: 'oracle', goal: oracle };
  f.runners.outlayer = async ({ execute }) => {
    f.calls.push(execute ? 'oracle-send' : 'oracle-preview');
    if (!execute) return { status: 'READY' };
    f.entries.set(oracle.id, { status: 'completed', delivery });
    return { status: 'FULFILLED', delivery };
  };
  f.runners.recover = async () => { f.calls.push('oracle-recover'); return { status: 'REUSED', delivery }; };
  return { ...f, oracle };
}

test('oracle-led multi-resource mission verifies independent delivery before FT payments', async () => {
  const f = oracleFixture();
  const result = await runMixedMission({ ...f.options, execute: true });
  assert.equal(result.status, 'FULFILLED'); assert.equal(result.independent.delivery.result.price_usd, 2.5);
  assert.deepEqual(f.calls, ['oracle-preview', 'ft-preview', 'oracle-send', 'ft-execute']);
});

test('an expired recovered price cannot authorize later resource payments', async () => {
  const f = oracleFixture(Math.floor(Date.now() / 1000) - 301);
  f.entries.set(f.oracle.id, { status: 'completed' });
  await assert.rejects(runMixedMission({ ...f.options, execute: true }), /too old/);
  assert.deepEqual(f.calls, ['oracle-recover', 'ft-preview']);
});

test('a future price or failed independent result cannot trigger FT execution', async () => {
  const f = oracleFixture(Math.floor(Date.now() / 1000) + 31);
  await assert.rejects(runMixedMission({ ...f.options, execute: true }), /future/);
  assert.deepEqual(f.calls, ['oracle-preview', 'ft-preview', 'oracle-send']);
  const g = oracleFixture();
  g.runners.outlayer = async ({ execute }) => execute ? Promise.reject(new Error('unverified oracle result')) : { status: 'READY' };
  await assert.rejects(runMixedMission({ ...g.options, execute: true }), /unverified oracle/);
  assert.deepEqual(g.calls, ['ft-preview']);
});
