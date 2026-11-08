// Synthetic RPC and disposable in-memory keys only; no live chain activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateNativeStorageGoal, verifyNativeStorageResult, runNativeStorageGoal, recoverNativeStorageGoal } from '../agent/native-storage.mjs';

const owner = 'owner.testnet', vault = 'vault.testnet';
const route = { prefix: 'mission-', max_value_bytes: 128, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
const makeGoal = () => ({ id: 'storage', contract_id: vault, owner_account_id: owner, policy_id: 'store', amount: '100',
  object_id: 'mission-001', value: 'public value', route: structuredClone(route) });
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
const actionId = '7'.repeat(44), block = 'B'.repeat(44);
function memoryJournal() {
  const entries = new Map();
  return { get: id => entries.get(id), put: (id, entry) => entries.set(id, structuredClone(entry)), entries };
}
function fixture({ timeout = false } = {}) {
  const goal = makeGoal(), pair = nearApi.KeyPair.fromRandom('ed25519'), publicKey = pair.getPublicKey(), signer = new nearApi.KeyPairSigner(pair);
  const account = { accountId: owner, signer, async createTransaction(receiver, actions, key) {
    return nearApi.transactions.createTransaction(owner, key, receiver, 1n, actions, Buffer.alloc(32, 8));
  } };
  const journal = memoryJournal(), chains = new Map();
  let sent = 0, lost = timeout, object = null, reserved = false, chainId = 'testnet', method = 'execute_native_storage',
    routeView = structuredClone(route), verdict = [true, 'ok'], beforeSend;
  const provider = {
    async viewNodeStatus() { return { chain_id: chainId }; },
    async viewAccessKey() { return { permission: { FunctionCall: { receiver_id: vault, method_names: [method] } } }; },
    async callFunction(receiver, view) {
      assert.equal(receiver, vault);
      if (view === 'contract_version') return 'bouncer-agent-v14-native-storage-testnet';
      if (view === 'get_owner') return owner;
      if (view === 'get_policy') return { token: 'native', per_tx_cap: '100', daily_cap: '500' };
      if (view === 'get_native_storage_route') return structuredClone(routeView);
      if (view === 'is_agent_key_allowed') return true;
      if (view === 'check') return verdict;
      if (view === 'native_storage_id_reserved') return reserved;
      if (view === 'get_native_storage_object') return structuredClone(object);
      throw Error(`unexpected view ${view}`);
    },
    async sendTransactionOnce(signed, until) {
      assert.equal(until, 'FINAL');
      const action = signed.transaction.actions[0].functionCall, args = JSON.parse(Buffer.from(action.args).toString());
      const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(signed.transaction)).digest());
      assert.equal(journal.get(goal.id).tx_hash, hash); assert.equal(journal.get(goal.id).status, 'pending');
      if (beforeSend) await beforeSend({ hash, args });
      sent++; reserved = true;
      object = { policy_id: goal.policy_id, object_id: goal.object_id, value: goal.value,
        value_sha256: crypto.createHash('sha256').update(goal.value).digest('hex'), value_bytes: Buffer.byteLength(goal.value), stake_yocto: '50' };
      const fc = { method_name: 'execute_native_storage', deposit: '0', args: enc(args), gas: action.gas.toString() };
      const result = { final_execution_status: 'FINAL', status: { SuccessValue: enc(object) },
        transaction_outcome: { id: hash, outcome: { status: { SuccessReceiptId: actionId } } },
        transaction: { hash, signer_id: owner, receiver_id: vault, public_key: String(publicKey), actions: [{ FunctionCall: fc }] },
        receipts_outcome: [{ id: actionId, block_hash: block, outcome: { executor_id: vault, status: { SuccessValue: enc(object) },
          logs: ['BOUNCER public native storage written; stake reserved'] } }],
        receipts: [{ receipt_id: actionId, predecessor_id: owner, receiver_id: vault, receipt: { Action: { actions: [{ FunctionCall: fc }] } } }] };
      chains.set(hash, result);
      if (lost) { lost = false; throw Error('synthetic timeout after send'); }
      return { transaction_outcome: { id: hash } };
    },
    async txStatusReceipts(hash, accountId, until) {
      assert.equal(accountId, owner); assert.equal(until, 'FINAL');
      if (!chains.has(hash)) throw Error('synthetic receipt unavailable');
      return structuredClone(chains.get(hash));
    },
  };
  return { goal, account, publicKey, journal, provider, chains, get sent() { return sent; },
    setChain(v) { chainId = v; }, setMethod(v) { method = v; }, setRoute(v) { routeView = v; }, setVerdict(v) { verdict = v; },
    setObject(v) { object = v; }, setReserved(v) { reserved = v; }, setBeforeSend(fn) { beforeSend = fn; },
    run(opts = {}) { return runNativeStorageGoal({ goal, account, publicKey, journal, provider, log: () => {}, ...opts }); },
    recover(opts = {}) { return recoverNativeStorageGoal({ goal, journal, provider, log: () => {}, ...opts }); } };
}

test('storage goal strictly binds public value, prefix, size, cap and active route', () => {
  const g = makeGoal(); assert.deepEqual(validateNativeStorageGoal(g), g);
  for (const mutate of [g => { g.extra = 1; }, g => { g.value = ''; }, g => { g.value = '🦀'.repeat(33); },
    g => { g.object_id = 'elsewhere'; }, g => { g.route.active = false; }, g => { g.route.route_revision = 0; },
    g => { g.owner_account_id = 'owner.near'; }, g => { g.amount = '0100'; }, g => { g.object_id = 'mission-/' }]) {
    const bad = structuredClone(g); mutate(bad); assert.throws(() => validateNativeStorageGoal(bad));
  }
});

test('storage preflight is read-only and rejects wrong chain, broad keys, stale routes and reserved IDs', async () => {
  const f = fixture(); assert.equal((await f.run()).status, 'READY'); assert.equal(f.sent, 0); assert.equal(f.journal.entries.size, 0);
  f.setChain('mainnet'); await assert.rejects(f.run(), /testnet/); f.setChain('testnet');
  f.setMethod('execute_outlayer'); await assert.rejects(f.run(), /scoped ONLY/); f.setMethod('execute_native_storage');
  f.setRoute({ ...route, route_revision: 2 }); await assert.rejects(f.run(), /route/); f.setRoute(route);
  f.setReserved(true); await assert.rejects(f.run(), /unused object ID/); f.setReserved(false);
  f.setVerdict([false, 'cap exceeded']); assert.equal((await f.run({ execute: true })).status, 'BLOCKED');
  assert.equal(f.sent, 0); assert.equal(f.journal.entries.size, 0);
});

test('one storage original is journaled before send and recovered without keys or another transaction', async () => {
  const f = fixture(); const result = await f.run({ execute: true });
  assert.equal(result.status, 'FULFILLED'); assert.equal(f.sent, 1); assert.equal(result.delivery.stake_yocto, '50');
  assert.equal(f.journal.get('storage').status, 'completed');
  const recovered = await f.recover(); assert.equal(recovered.status, 'REUSED'); assert.deepEqual(recovered.delivery, result.delivery);
  assert.equal(f.sent, 1); assert.match(recovered.delivery.verification, /self-hosted/);
});

test('lost response and unavailable or changed object remain reconciliation-only', async () => {
  const f = fixture({ timeout: true });
  await assert.rejects(f.run({ execute: true }), /unresolved/); assert.equal(f.sent, 1);
  const hash = f.journal.get('storage').tx_hash; assert.equal(f.journal.get('storage').status, 'pending');
  f.setObject(null); await assert.rejects(f.recover(), /differs/); assert.equal(f.sent, 1);
  const chain = f.chains.get(hash); f.setObject(JSON.parse(Buffer.from(chain.status.SuccessValue, 'base64').toString()));
  assert.equal((await f.recover()).status, 'REUSED'); assert.equal(f.journal.get('storage').tx_hash, hash); assert.equal(f.sent, 1);
});

test('rejects forged receipt, altered action, final result, public readback, amount and original identity', async () => {
  const f = fixture(); const delivered = await f.run({ execute: true });
  const chain = f.chains.get(delivered.delivery.tx_hash);
  for (const change of [
    c => { c.final_execution_status = 'EXECUTED'; },
    c => { c.transaction.receiver_id = 'other.testnet'; },
    c => { c.transaction.public_key = 'ed25519:bad'; },
    c => { c.transaction.actions[0].FunctionCall.deposit = '1'; },
    c => { c.transaction_outcome.outcome.status.SuccessReceiptId = '9'.repeat(44); },
    c => { c.receipts_outcome[0].outcome.logs = []; },
    c => { c.receipts[0].predecessor_id = 'other.testnet'; },
    c => { c.receipts_outcome[0].outcome.status = { Failure: {} }; },
    c => { const object = JSON.parse(Buffer.from(c.status.SuccessValue, 'base64')); object.stake_yocto = '101'; c.status.SuccessValue = enc(object); },
    c => { const object = JSON.parse(Buffer.from(c.status.SuccessValue, 'base64')); object.value_sha256 = '0'.repeat(64); c.status.SuccessValue = enc(object); },
  ]) { const bad = structuredClone(chain); change(bad); await assert.rejects(verifyNativeStorageResult(f.goal, bad, f.publicKey, f.provider)); }
  f.setObject({ ...delivered.delivery.result, value: 'changed' });
  await assert.rejects(f.recover(), /differs/); assert.equal(f.sent, 1);
});

test('changed original during final guard and a failing write stop before broadcast', async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(f.run({ execute: true, beforeBroadcast() {
    if (++calls === 2) f.journal.put('storage', { ...f.journal.get('storage'), tx_hash: 'A'.repeat(44) });
  } }), /unresolved/);
  assert.equal(f.sent, 0);
  const g = fixture(); g.journal.put = () => { throw Error('disk full'); };
  await assert.rejects(g.run({ execute: true }), /disk full/); assert.equal(g.sent, 0);
});
