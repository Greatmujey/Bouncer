import test from 'node:test';
import assert from 'node:assert/strict';
import { runPaidProjectMission } from '../agent/paid-mission.mjs';

const project = { id: 'independent', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet', native_policy_id: 'native', amount: '100', expected_author: 'zavodil.testnet',
  route: { project: { project_id: 'connectors.outlayer.testnet/connector-probe', version_key: 'a'.repeat(64), usd_policy_id: 'paid', token: 'usdc.fakes.testnet',
    attached_usd: '15000', input_data: '{"operation":"fetch"}', max_instructions: 100_000_000, max_memory_mb: 256, max_execution_seconds: 60 },
  route_revision: 1, native_policy_revision: 1, usd_policy_revision: 1, native_payee_revision: 1, usd_payee_revision: 1, active: true } };
const funding = { id: 'funding', contract_id: project.contract_id, owner_account_id: project.owner_account_id, policy_id: 'fund', payee: 'outlayer.testnet',
  token: project.route.project.token, amount: '15000', msg: '{"action":"deposit_balance"}', policy_revision: 1, route_revision: 1 };
const settlement = { token: funding.token, receiver: funding.payee, requested: '15000', used: '15000', unused: '0', tx_hash: 'fund-tx' };
function fixture() {
  let credit = '0';
  const entries = new Map(), calls = [], journal = { get: id => entries.get(id), put: (id, value) => entries.set(id, value) };
  const runners = {
    async funding({ execute }) { calls.push(execute ? 'fund-send' : 'fund-preview');
      if (!execute) return { status: 'READY' };
      journal.put(funding.id, { status: 'completed', settlement }); credit = '15000'; return { status: 'SETTLED', settlement }; },
    async recoverFunding({ update }) { calls.push(`fund-recover:${update}`); return { status: 'REUSED', settlement }; },
    async project({ execute }) { calls.push(execute ? 'project-send' : 'project-preview');
      if (!execute) return { status: 'FUNDING_REQUIRED', shortfall: '15000' };
      journal.put(project.id, { status: 'completed', delivery: { tx_hash: 'paid-tx' } });
      return { status: 'FULFILLED', delivery: { tx_hash: 'paid-tx' } }; },
    async recoverProject({ update }) { calls.push(`project-recover:${update}`); return { status: 'REUSED', delivery: { tx_hash: 'paid-tx' } }; },
    async resources({ execute }) { calls.push(execute ? 'resources-send' : 'resources-preview');
      return { payments: { blocked: 0 }, deliveries: execute ? [{ id: 'compute' }, { id: 'storage' }, { id: 'api' }] : [] }; },
  };
  const provider = { async callFunction(id, method, args) { calls.push('provider-credit'); assert.equal(id, 'outlayer.testnet');
    assert.equal(method, 'get_user_stablecoin_balance'); assert.equal(args.account_id, project.contract_id); return credit; } };
  const resources = { contractId: project.contract_id, ownerAccountId: project.owner_account_id,
    goals: [{ id: 'compute' }, { id: 'storage' }, { id: 'api' }] };
  return { entries, calls, runners, journal, provider, setCredit: value => { credit = value; },
    options: { funding: { goal: funding }, project: { goal: project }, resources, provider, journal, runners, log: () => {} } };
}

test('preview checks project, planned funding and all resource tasks without sending', async () => {
  const f = fixture(), result = await runPaidProjectMission(f.options);
  assert.equal(result.status, 'READY'); assert.match(result.note, /do not reserve/);
  assert.deepEqual(f.calls, ['project-preview', 'provider-credit', 'fund-preview', 'resources-preview']); assert.equal(f.entries.size, 0);
});

test('live mission gates funding, provider credit, paid delivery and three resource tasks', async () => {
  const f = fixture(), result = await runPaidProjectMission({ ...f.options, execute: true });
  assert.equal(result.status, 'FULFILLED');
  assert.deepEqual(f.calls, ['project-preview', 'provider-credit', 'fund-preview', 'resources-preview', 'fund-send', 'provider-credit', 'project-send', 'resources-send']);
});

test('durable direct-payment option reaches resource preview and execution', async () => {
  const f = fixture(), seen = [], original = f.runners.resources;
  f.runners.resources = async options => { seen.push([options.execute, options.durablePayment]); return original(options); };
  assert.equal((await runPaidProjectMission({ ...f.options, resources: { ...f.options.resources, durablePayment: true }, execute: true })).status, 'FULFILLED');
  assert.deepEqual(seen, [[false, true], [true, true]]);
});

test('blocked future resource or changed provider/project preflight stops every payment', async () => {
  let f = fixture(); f.runners.resources = async () => { f.calls.push('resources-blocked'); return { payments: { blocked: 1 }, deliveries: [] }; };
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'resource-preflight');
  assert.deepEqual(f.calls, ['project-preview', 'provider-credit', 'fund-preview', 'resources-blocked']);
  f = fixture(); f.runners.project = async () => { f.calls.push('project-blocked'); return { status: 'BLOCKED' }; };
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'project-preflight'); assert.deepEqual(f.calls, ['project-blocked']);
});

test('partial funding and insufficient independent-provider credit block the project and all resources', async () => {
  let f = fixture(); const original = f.runners.funding;
  f.runners.funding = async args => args.execute ? { status: 'SETTLED', settlement: { ...settlement, used: '14999', unused: '1' } } : original(args);
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'funding-settlement');
  assert(!f.calls.includes('project-send')); assert(!f.calls.includes('resources-send'));
  f = fixture(); let reads = 0; f.provider.callFunction = async () => { f.calls.push('provider-credit'); return ++reads === 1 ? '0' : '14999'; };
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'provider-credit');
  assert(!f.calls.includes('project-send')); assert(!f.calls.includes('resources-send'));
});

test('a prior ambiguous funding payment is recovered by hash and never funded again', async () => {
  const f = fixture(); f.entries.set(funding.id, { status: 'pending', tx_hash: 'fund-tx' }); f.setCredit('15000');
  f.runners.project = async ({ execute }) => { f.calls.push(execute ? 'project-send' : 'project-preview');
    return execute ? { status: 'FULFILLED', delivery: { tx_hash: 'paid-tx' } } : { status: 'READY' }; };
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).status, 'FULFILLED');
  assert.deepEqual(f.calls, ['fund-recover:true', 'project-preview', 'provider-credit', 'resources-preview', 'provider-credit', 'project-send', 'resources-send']);
});

test('existing project recovery never funds or pays it again and then resumes resources', async () => {
  const f = fixture(); f.entries.set(funding.id, { status: 'completed' }); f.entries.set(project.id, { status: 'pending', tx_hash: 'paid-tx' });
  const result = await runPaidProjectMission({ ...f.options, execute: true });
  assert.equal(result.status, 'FULFILLED');
  assert.deepEqual(f.calls, ['fund-recover:true', 'project-recover:true', 'resources-preview', 'resources-send']);
});

test('dry-run recovery does not mutate journal and prior unresolved resources block new independent payments', async () => {
  let f = fixture(); f.entries.set(funding.id, { status: 'pending' }); f.entries.set(project.id, { status: 'pending' });
  assert.equal((await runPaidProjectMission(f.options)).status, 'READY');
  assert.deepEqual(f.calls, ['fund-recover:false', 'project-recover:false', 'resources-preview']);
  f = fixture(); f.entries.set('storage', { status: 'pending' });
  await assert.rejects(runPaidProjectMission({ ...f.options, execute: true }), /recover the earlier FT payment/); assert.deepEqual(f.calls, []);
});

test('already-recorded sufficient provider credit skips a redundant top-up', async () => {
  const f = fixture(); f.setCredit('15000'); f.runners.project = async ({ execute }) => { f.calls.push(execute ? 'project-send' : 'project-preview');
    return execute ? { status: 'FULFILLED', delivery: { tx_hash: 'paid-tx' } } : { status: 'READY' }; };
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).status, 'FULFILLED');
  assert.deepEqual(f.calls, ['project-preview', 'provider-credit', 'resources-preview', 'provider-credit', 'project-send', 'resources-send']);
});

test('unverified independent delivery prevents later resource payments', async () => {
  const f = fixture(), original = f.runners.project;
  f.runners.project = async args => { if (!args.execute) return original(args); f.calls.push('project-unverified'); throw new Error('paid but unverified'); };
  await assert.rejects(runPaidProjectMission({ ...f.options, execute: true }), /paid but unverified/); assert(!f.calls.includes('resources-send'));
});

test('changed owner, provider, amount or duplicate IDs are rejected before previews', async () => {
  for (const changed of [{ ...funding, owner_account_id: 'other.testnet' }, { ...funding, payee: 'other.testnet' },
    { ...funding, amount: '15001' }, { ...funding, msg: 'other' }, { ...funding, id: project.id }]) {
    const f = fixture(); await assert.rejects(runPaidProjectMission({ ...f.options, funding: { goal: changed } })); assert.deepEqual(f.calls, []);
  }
});

test('partial prepaid balance requires the EXACT reviewed shortfall, never a full extra top-up', async () => {
  let f = fixture(); f.setCredit('5000');
  f.runners.project = async ({ execute }) => { f.calls.push(execute ? 'project-send' : 'project-preview');
    return execute ? { status: 'FULFILLED', delivery: { tx_hash: 'paid-tx' } } : { status: 'FUNDING_REQUIRED', shortfall: '10000' }; };
  const blocked = await runPaidProjectMission({ ...f.options, execute: true });
  assert.equal(blocked.stage, 'funding-plan-mismatch'); assert(!f.calls.includes('fund-send'));

  f = fixture(); f.setCredit('5000');
  const partialGoal = { ...funding, amount: '10000' }, partialSettlement = { ...settlement, requested: '10000', used: '10000' };
  f.runners.project = async ({ execute }) => { f.calls.push(execute ? 'project-send' : 'project-preview');
    return execute ? { status: 'FULFILLED', delivery: { tx_hash: 'paid-tx' } } : { status: 'FUNDING_REQUIRED', shortfall: '10000' }; };
  f.runners.funding = async ({ execute }) => { f.calls.push(execute ? 'fund-send' : 'fund-preview');
    if (!execute) return { status: 'READY' }; f.setCredit('15000'); return { status: 'SETTLED', settlement: partialSettlement }; };
  assert.equal((await runPaidProjectMission({ ...f.options, funding: { goal: partialGoal }, execute: true })).status, 'FULFILLED');
  assert(f.calls.includes('fund-send')); assert(f.calls.includes('project-send'));
});

test('mismatched or invalid provider credit blocks before any top-up or project execution', async () => {
  let f = fixture(); f.setCredit('5000'); // internal shortfall is 15000, provider actual shortfall is 10000
  assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'provider-credit-mismatch');
  assert(!f.calls.includes('fund-preview')); assert(!f.calls.includes('fund-send'));
  for (const invalid of ['00', '-1', '1.0', 0, ((1n << 128n)).toString(), '9'.repeat(40)]) {
    f = fixture(); f.setCredit(invalid);
    assert.equal((await runPaidProjectMission({ ...f.options, execute: true })).stage, 'provider-credit');
    assert(!f.calls.includes('fund-send')); assert(!f.calls.includes('project-send'));
  }
});
