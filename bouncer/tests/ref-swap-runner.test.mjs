import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { runRefSwap, runRefSweepOnly, recoverRefSwap, checkRefRouter } from '../agent/ref-swap.mjs';
import { inspectCompletedRefSwap } from '../agent/ref-swap-reinspection.mjs';
import { createSweepHandoffRequest, sealSweepHandoff, openSweepHandoff } from '../agent/ref-sweep-handoff.mjs';
import { REF_SWAP_INPUT, REF_SWAP_OUTPUT, REF_SWAP_EXCHANGE, REF_SWAP_INPUT_MESSAGE, REF_SWEEP_GAS } from '../agent/ref-swap-evidence.mjs';
import { goal, ftGoal, signing, key, inputHash, swapResult, sweepResult, id } from './ref-swap-fixture.mjs';

function sweepSigner() {
  const pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = pair.getPublicKey(), signer = new nearApi.KeyPairSigner(pair);
  const create = (receiver, actions) => nearApi.transactions.createTransaction(goal.owner_account_id, publicKey, receiver, 1n, actions, Buffer.alloc(32, 3));
  const expected = create(goal.router_id, [nearApi.transactions.functionCall('sweep_output', { amount: '70' }, REF_SWEEP_GAS, 0n)]);
  const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(expected)).digest());
  return { publicKey: publicKey.toString(), secret: pair.toString(), hash, account: { accountId: goal.owner_account_id, signer,
    async createTransaction(receiver, actions, keyArg) {
      assert.equal(receiver, goal.router_id); assert.equal(String(keyArg), publicKey.toString()); assert.equal(actions.length, 1);
      const call = actions[0].functionCall; assert.equal(call.methodName, 'sweep_output'); assert.equal(call.gas, REF_SWEEP_GAS);
      assert.equal(call.deposit, 0n); assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { amount: '70' });
      return create(receiver, actions);
    } } };
}
function fixture() {
  const entries = new Map(), sweep = sweepSigner(), sends = [];
  let failWrite = '', failSend = '', failLookup = '', mutateSwap = x => x, mutateSweep = x => x;
  let started = false, codeHash = goal.router_code_hash, accessKeys = [], routeOverrides = {}, storage = { total: '1250000000000000000000', available: '0' },
    sweepPermission = { FunctionCall: { receiver_id: goal.router_id, method_names: ['sweep_output'] } }, chain = 'testnet';
  const journal = { get(id) { return entries.get(id); }, put(id, entry) {
    if (failWrite === id) throw new Error('simulated durable write failure');
    entries.set(id, structuredClone({ ...entry, id }));
  } };
  const provider = {
    async viewNodeStatus() { return { chain_id: chain }; },
    async query(q) {
      if (q.request_type === 'view_account') return { code_hash: codeHash, amount: '200000000000000000000000' };
      if (q.request_type === 'view_access_key_list') return { keys: accessKeys };
      throw new Error('unexpected query');
    },
    async viewAccessKey(_owner, publicKey) {
      if (String(publicKey) === key) return { permission: { FunctionCall: { receiver_id: goal.contract_id, method_names: ['execute_ft_call'] } } };
      if (String(publicKey) === sweep.publicKey) return { permission: sweepPermission };
      throw new Error('unexpected key');
    },
    async callFunction(_receiver, method) {
      if (method === 'get_route') return { version: 'bouncer-ref-router-v1', owner: goal.owner_account_id, vault: goal.contract_id,
        exchange: REF_SWAP_EXCHANGE, token_in: REF_SWAP_INPUT, token_out: REF_SWAP_OUTPUT, pool_id: goal.pool_id,
        amount_in: goal.input_amount, min_amount_out: goal.min_output, input_message: REF_SWAP_INPUT_MESSAGE,
        started, input_state: started ? 'inner_settled' : 'ready', inner_used: started ? goal.input_amount : null, ...routeOverrides };
      if (method === 'storage_balance_of') return storage;
      if (method === 'contract_version') return 'bouncer-agent-v9';
      if (method === 'get_owner') return goal.owner_account_id;
      if (method === 'get_policy') return { token: REF_SWAP_INPUT };
      if (method === 'get_ft_call_route') return { token: REF_SWAP_INPUT, msg: REF_SWAP_INPUT_MESSAGE,
        policy_revision: goal.policy_revision, route_revision: goal.route_revision, active: true };
      if (method === 'is_agent_key_allowed') return true;
      if (method === 'check') return [true, 'ok'];
      throw new Error(`unexpected view ${method}`);
    },
    async sendTransactionUntil(signed, wait) {
      assert.equal(wait, 'FINAL');
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      if (hash === inputHash) {
        assert.equal(journal.get(`${goal.id}-route`).status, 'pending');
        assert.equal(journal.get(ftGoal.id).tx_hash, hash); assert.equal(journal.get(ftGoal.id).status, 'pending');
        started = true; sends.push(hash);
        if (failSend === 'input') throw new Error('input response lost');
      } else if (hash === sweep.hash) {
        assert.equal(journal.get(`${goal.id}-sweep`).tx_hash, hash); assert.equal(journal.get(`${goal.id}-sweep`).status, 'pending');
        sends.push(hash);
        if (failSend === 'sweep') throw new Error('sweep response lost');
      } else throw new Error('unreviewed transaction');
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, owner, wait) {
      assert.equal(owner, goal.owner_account_id); assert.equal(wait, 'FINAL');
      if ((failLookup === 'input' && hash === inputHash) || (failLookup === 'sweep' && hash === sweep.hash)) throw new Error('temporarily missing');
      if (hash === inputHash && sends.includes(hash)) return mutateSwap(swapResult());
      if (hash === sweep.hash && sends.includes(hash)) return mutateSweep(sweepResult({ hash, publicKey: sweep.publicKey }));
      throw new Error('transaction not found');
    },
  };
  const opts = { goal, provider, account: signing.newAccount(), publicKey: key, sweepAccount: sweep.account,
    sweepPublicKey: sweep.publicKey, journal, execute: true, log: () => {} };
  return { opts, provider, journal, entries, sends, sweep,
    failWrite(v) { failWrite = v; }, failSend(v) { failSend = v; }, failLookup(v) { failLookup = v; },
    mutateSwap(fn) { mutateSwap = fn; }, mutateSweep(fn) { mutateSweep = fn; }, setCode(v) { codeHash = v; }, setKeys(v) { accessKeys = v; },
    setRoute(v) { routeOverrides = v; }, setStorage(v) { storage = v; }, setSweepPermission(v) { sweepPermission = v; }, setChain(v) { chain = v; } };
}

test('dry-run CLI opens an existing journal and fails closed before network access if it is corrupt', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-swap-cli-dry-'));
  try {
    const goalPath = path.join(dir, 'goal.json'), keyPath = path.join(dir, 'key.json'), journalPath = path.join(dir, 'journal.json');
    fs.writeFileSync(goalPath, JSON.stringify(goal));
    fs.writeFileSync(keyPath, JSON.stringify({ account_id: goal.owner_account_id, private_key: nearApi.KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
    fs.writeFileSync(journalPath, 'invalid JSON', { mode: 0o600 });
    const child = spawnSync(process.execPath, ['agent/ref-swap.mjs', '--goal', goalPath, '--key', keyPath, '--sweep-key', keyPath,
      '--state', journalPath, '--rpc', 'http://127.0.0.1:1'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /file journal is unreadable or has invalid JSON/);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), 'invalid JSON');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep-only CLI refuses a missing original journal and cannot create replacement history', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-sweep-only-cli-'));
  try {
    const goalPath = path.join(dir, 'goal.json'), keyPath = path.join(dir, 'key.json'), journalPath = path.join(dir, 'missing.json');
    fs.writeFileSync(goalPath, JSON.stringify(goal));
    fs.writeFileSync(keyPath, JSON.stringify({ account_id: goal.owner_account_id, private_key: nearApi.KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['agent/ref-swap.mjs', '--goal', goalPath, '--sweep-only', '--sweep-key', keyPath,
      '--state', journalPath, '--rpc', 'http://127.0.0.1:1', '--execute'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.notEqual(child.status, 0); assert.match(child.stderr, /journal.*(missing|not found|does not exist)/i);
    assert.equal(fs.existsSync(journalPath), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('V2 routes require an explicitly pinned V2 immutable router, not a V1 deployment', async () => {
  const f = fixture(), v2 = { ...goal, version: 2 };
  await assert.rejects(checkRefRouter(v2, f.provider, { ready: true }), /immutable configuration/);
  f.setRoute({ version: 'bouncer-ref-router-v2' });
  assert.equal((await checkRefRouter(v2, f.provider, { ready: true })).version, 'bouncer-ref-router-v2');
  await assert.rejects(checkRefRouter(goal, f.provider, { ready: true }), /immutable configuration/);
  assert.deepEqual(f.sends, []);
});

test('dry run verifies immutable router, storage and both key scopes without writes or broadcasts', async () => {
  const f = fixture(), result = await runRefSwap({ ...f.opts, execute: false });
  assert.equal(result.status, 'READY'); assert.equal(f.entries.size, 0); assert.deepEqual(f.sends, []);
});

test('each reviewed hash is durable before its only broadcast; a completed route is reverified without sending', async () => {
  const f = fixture(), result = await runRefSwap(f.opts);
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.swap.output_amount, '70'); assert.equal(result.vault_credit.credited, '70');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  assert.equal(f.journal.get(ftGoal.id).status, 'completed'); assert.equal(f.journal.get(`${goal.id}-sweep`).status, 'completed');
  assert.equal(f.journal.get(`${goal.id}-route`).status, 'completed');
  assert.equal((await runRefSwap(f.opts)).status, 'COMPLETED');
  assert.equal((await recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} })).status, 'COMPLETED');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('dry-run verifies pending input and sweep without changing their durable history', async () => {
  let f = fixture(); f.failSend('input'); await assert.rejects(runRefSwap(f.opts), /FT call unresolved/);
  let before = structuredClone([...f.entries]); f.failSend('');
  assert.equal((await runRefSwap({ ...f.opts, execute: false })).status, 'OUTPUT_RECEIVED');
  assert.deepEqual([...f.entries], before); assert.deepEqual(f.sends, [inputHash]);
  f = fixture(); f.failSend('sweep'); await assert.rejects(runRefSwap(f.opts), /sweep unresolved/);
  before = structuredClone([...f.entries]); f.failSend('');
  assert.equal((await runRefSwap({ ...f.opts, execute: false })).status, 'COMPLETED');
  assert.deepEqual([...f.entries], before); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  assert.equal((await recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} })).status, 'COMPLETED');
  assert.equal(f.journal.get(`${goal.id}-route`).status, 'completed');
});

test('sweep-only recovery needs the original verified input and never signs another swap', async () => {
  let f = fixture();
  const sweepOnly = () => ({ goal, provider: f.provider, sweepAccount: f.sweep.account, sweepPublicKey: f.sweep.publicKey, journal: f.journal, log: () => {} });
  await assert.rejects(runRefSweepOnly({ ...sweepOnly(), execute: true }), /route is missing/); assert.deepEqual(f.sends, []);
  f.failSend('input'); await assert.rejects(runRefSwap(f.opts), /FT call unresolved/); f.failSend('');
  const before = structuredClone([...f.entries]);
  assert.equal((await runRefSweepOnly(sweepOnly())).status, 'OUTPUT_RECEIVED');
  assert.deepEqual([...f.entries], before); assert.deepEqual(f.sends, [inputHash]);
  const done = await runRefSweepOnly({ ...sweepOnly(), execute: true });
  assert.equal(done.status, 'COMPLETED'); assert.equal(done.vault_credit.credited, '70');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  assert.equal((await runRefSweepOnly({ ...sweepOnly(), execute: true })).status, 'COMPLETED');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  f = fixture(); f.failSend('input'); await assert.rejects(runRefSwap(f.opts)); f.failSend('');
  f.setSweepPermission('FullAccess');
  await assert.rejects(runRefSweepOnly({ ...sweepOnly(), execute: true }), /scoped ONLY/);
  assert.deepEqual(f.sends, [inputHash]);
});

test('encrypted scoped-key handoff completes a verified sweep without an input signer', async () => {
  const f = fixture(); f.failSend('input'); await assert.rejects(runRefSwap(f.opts), /FT call unresolved/); f.failSend('');
  const original = await recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(original.status, 'OUTPUT_RECEIVED');
  const context = { owner_account_id: goal.owner_account_id, contract_id: goal.contract_id, router_id: goal.router_id,
    original_hash: inputHash, output_receipt_id: original.swap.output_receipt_id, expected_output: original.swap.output_amount,
    sweep_public_key: f.sweep.publicKey };
  const { request, privateKey } = createSweepHandoffRequest({ runId: '123456', context });
  const response = sealSweepHandoff({ request, expected: context, credentials: { account_id: goal.owner_account_id, private_key: f.sweep.secret } });
  const recovered = openSweepHandoff({ request, expected: context, response, privateKey });
  const sweepAccount = { ...f.sweep.account, signer: new nearApi.KeyPairSigner(recovered) };
  const result = await runRefSweepOnly({ goal, provider: f.provider, sweepAccount, sweepPublicKey: recovered.getPublicKey(),
    journal: f.journal, execute: true, log: () => {} });
  assert.equal(result.status, 'COMPLETED'); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  assert(!JSON.stringify(response).includes(f.sweep.secret));
});

test('completed swap and sweep are reverified without writes, keys or new sends', async () => {
  const f = fixture(), first = await runRefSwap(f.opts), sends = [...f.sends];
  const provider = new Proxy(f.provider, { get(target, property) {
    if (property === 'callFunction') return async (account, method, args, ...rest) => {
      if (method === 'vault_balance') return '70';
      if (method === 'ft_balance_of') return args.account_id === goal.contract_id ? '70' : '0';
      return target.callFunction(account, method, args, ...rest);
    };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const expected = { expectedInput: inputHash, expectedSweep: f.sweep.hash,
    expectedReceipt: first.swap.output_receipt_id, expectedAmount: '70' };
  const result = await inspectCompletedRefSwap({ goal, provider, journal: f.journal, ...expected });
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.sends, 0); assert.equal(result.journal_writes, 0);
  assert.deepEqual(f.sends, sends);
  await assert.rejects(inspectCompletedRefSwap({ goal, provider, journal: f.journal, ...expected, expectedSweep: id(99) }), /expected completed/);
  await assert.rejects(inspectCompletedRefSwap({ goal, provider, journal: f.journal, ...expected, expectedAmount: '71' }), /expected completed/);
  assert.deepEqual(f.sends, sends);
});

test('sweep-only never resends an existing ambiguous sweep', async () => {
  const f = fixture(); f.failSend('sweep'); await assert.rejects(runRefSwap(f.opts), /sweep unresolved/);
  const opts = { goal, provider: f.provider, sweepAccount: f.sweep.account, sweepPublicKey: f.sweep.publicKey, journal: f.journal, execute: true, log: () => {} };
  f.failSend(''); f.failLookup('sweep');
  await assert.rejects(runRefSweepOnly(opts), /temporarily missing/); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  f.failLookup(''); assert.equal((await runRefSweepOnly(opts)).status, 'COMPLETED');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('lost input response recovers the same hash before a single independent sweep', async () => {
  const f = fixture(); f.failSend('input');
  await assert.rejects(runRefSwap(f.opts), /FT call unresolved/);
  assert.deepEqual(f.sends, [inputHash]); assert.equal(f.journal.get(ftGoal.id).status, 'pending');
  f.failSend('');
  const readOnly = await recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} });
  assert.equal(readOnly.status, 'OUTPUT_RECEIVED'); assert.deepEqual(f.sends, [inputHash]);
  assert.equal((await runRefSwap(f.opts)).status, 'COMPLETED'); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('lost sweep response and unavailable lookup never trigger another transfer', async () => {
  const f = fixture(); f.failSend('sweep');
  await assert.rejects(runRefSwap(f.opts), /sweep unresolved/);
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]); assert.equal(f.journal.get(`${goal.id}-sweep`).status, 'pending');
  f.failSend(''); f.failLookup('sweep');
  await assert.rejects(runRefSwap(f.opts), /temporarily missing/);
  await assert.rejects(recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /temporarily missing/);
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
  f.failLookup('');
  assert.equal((await recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} })).status, 'COMPLETED');
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('input settlement without linked Ref delivery never starts a sweep or claims vault credit', async () => {
  const f = fixture(); f.mutateSwap(result => { result.receipts_outcome.find(x => x.outcome.executor_id === REF_SWAP_EXCHANGE).outcome.receipt_ids = []; return result; });
  await assert.rejects(runRefSwap(f.opts), /Ref output/); assert.deepEqual(f.sends, [inputHash]);
  await assert.rejects(runRefSwap(f.opts), /Ref output/); assert.deepEqual(f.sends, [inputHash]);
  assert.equal(f.journal.get(`${goal.id}-sweep`), undefined);
});

test('a missing or failed vault hook leaves the original sweep pending and is never retried', async () => {
  const f = fixture(); f.mutateSweep(result => { result.receipts_outcome.find(x => x.outcome.executor_id === goal.contract_id).outcome.logs = []; return result; });
  await assert.rejects(runRefSwap(f.opts), /sweep unresolved/);
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]); assert.equal(f.journal.get(`${goal.id}-sweep`).status, 'pending');
  await assert.rejects(runRefSwap(f.opts), /deposit accounting log/); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('unreviewed code, deploy keys, mutable routes, storage or broad sweep keys stop before any send', async () => {
  for (const mutate of [
    f => f.setChain('mainnet'), f => f.setCode(id(88)), f => f.setKeys([{ public_key: 'ed25519:unsafe' }]),
    f => f.setRoute({ pool_id: 2206 }), f => f.setRoute({ started: true, input_state: 'inner_pending' }),
    f => f.setStorage(null), f => f.setSweepPermission('FullAccess'),
    f => f.setSweepPermission({ FunctionCall: { receiver_id: goal.router_id, method_names: [] } }),
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(runRefSwap(f.opts)); assert.deepEqual(f.sends, []); assert.equal(f.entries.size, 0);
  }
});

test('durable write failures stop before the relevant broadcast', async () => {
  const f = fixture(); f.failWrite(`${goal.id}-route`);
  await assert.rejects(runRefSwap(f.opts), /write failure/); assert.deepEqual(f.sends, []);
  f.failWrite(`${goal.id}-sweep`);
  await assert.rejects(runRefSwap(f.opts), /write failure/); assert.deepEqual(f.sends, [inputHash]);
  assert.equal(f.journal.get(`${goal.id}-sweep`), undefined);
  f.failWrite(''); assert.equal((await runRefSwap(f.opts)).status, 'COMPLETED'); assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});

test('changed route manifest, missing parent entry and unsupported shared journals fail closed', async () => {
  const f = fixture(); f.failSend('input'); await assert.rejects(runRefSwap(f.opts)); f.failSend('');
  await assert.rejects(runRefSwap({ ...f.opts, goal: { ...goal, min_output: '43' } }), /manifest differs/);
  const entry = f.journal.get(`${goal.id}-route`); f.entries.delete(`${goal.id}-route`);
  await assert.rejects(runRefSwap(f.opts), /without their route manifest/);
  f.entries.set(`${goal.id}-route`, entry);
  await assert.rejects(runRefSwap({ ...f.opts, journal: { ...f.journal, sharedDirectV3: true } }), /does not coordinate/);
  assert.deepEqual(f.sends, [inputHash]);
});

test('key-free recovery requires the original manifest and never signs a new input or sweep', async () => {
  const f = fixture();
  await assert.rejects(recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /route is missing/);
  assert.deepEqual(f.sends, []);
  await assert.rejects(checkRefRouter({ ...goal, pool_id: 4 }, f.provider));
});

test('missing original entries from a completed route never permit a new input or sweep', async () => {
  const f = fixture(); await runRefSwap(f.opts);
  const sweepEntry = f.journal.get(`${goal.id}-sweep`), inputEntry = f.journal.get(ftGoal.id);
  f.entries.delete(`${goal.id}-sweep`);
  await assert.rejects(runRefSwap(f.opts), /missing its original sweep/);
  await assert.rejects(recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /missing its original sweep/);
  f.entries.set(`${goal.id}-sweep`, sweepEntry); f.entries.delete(ftGoal.id);
  await assert.rejects(runRefSwap(f.opts), /missing its original input/);
  await assert.rejects(recoverRefSwap({ goal, provider: f.provider, journal: f.journal, log: () => {} }), /history is incomplete/);
  f.entries.set(ftGoal.id, inputEntry);
  assert.deepEqual(f.sends, [inputHash, f.sweep.hash]);
});
