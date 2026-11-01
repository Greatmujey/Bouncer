import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForNewTestnetKey, waitForFinalTestnetAccount } from '../shared/testnet-ready.mjs';

test('new testnet account readiness retries only read-only missing-key views', async () => {
  let queries = 0, delays = 0;
  const provider = { async viewAccessKey(id, key, options) {
    assert.equal(id, 'fresh.testnet'); assert.equal(key, 'ed25519:public'); assert.deepEqual(options, { finality: 'optimistic' });
    if (++queries < 3) throw Object.assign(new Error('not yet visible'), { type: 'AccessKeyDoesNotExist' });
    return { permission: 'FullAccess' };
  } };
  await waitForNewTestnetKey(provider, 'fresh.testnet', 'ed25519:public', { delay: async () => { delays++; } });
  assert.equal(queries, 3); assert.equal(delays, 2);
});

test('readiness stops on unknown failures, wrong access and bounded exhaustion', async () => {
  let calls = 0;
  const provider = { async viewAccessKey() { calls++; throw Object.assign(new Error('outage'), { type: 'Timeout' }); } };
  await assert.rejects(waitForNewTestnetKey(provider, 'fresh.testnet', 'pk', { delay: async () => {} }), /outage/); assert.equal(calls, 1);
  provider.viewAccessKey = async () => ({ permission: { FunctionCall: {} } });
  await assert.rejects(waitForNewTestnetKey(provider, 'fresh.testnet', 'pk', { delay: async () => {} }), /not full access/);
  calls = 0; provider.viewAccessKey = async () => { calls++; throw Object.assign(new Error('missing'), { type: 'AccessKeyDoesNotExist' }); };
  await assert.rejects(waitForNewTestnetKey(provider, 'fresh.testnet', 'pk', { attempts: 3, delay: async () => {} }), /missing/); assert.equal(calls, 3);
});

test('new account becomes FINAL through bounded read-only account and key checks', async () => {
  let queries = 0, keys = 0, delays = 0;
  const provider = {
    async query(request) {
      assert.deepEqual(request, { request_type: 'view_account', account_id: 'fresh.testnet', finality: 'final' });
      if (++queries === 1) throw Object.assign(new Error('account missing at FINAL'), { type: 'AccountDoesNotExist' });
      return { amount: '100000', storage_usage: 10 };
    },
    async viewAccessKey(id, key, options) {
      assert.equal(id, 'fresh.testnet'); assert.equal(key, 'pk'); assert.deepEqual(options, { finality: 'final' });
      if (++keys === 1) throw Object.assign(new Error('key missing at FINAL'), { type: 'AccessKeyDoesNotExist' });
      return { permission: 'FullAccess' };
    },
  };
  assert.deepEqual(await waitForFinalTestnetAccount(provider, 'fresh.testnet', 'pk', { delay: async () => { delays++; } }),
    { amount: '100000', storage_usage: 10 });
  assert.equal(queries, 3); assert.equal(keys, 2); assert.equal(delays, 2);
});

test('final readiness stops on outages, wrong access, malformed balances and exhausted missing reads', async () => {
  let calls = 0;
  const provider = { async query() { calls++; throw Object.assign(new Error('outage'), { type: 'Timeout' }); },
    async viewAccessKey() { return { permission: 'FullAccess' }; } };
  await assert.rejects(waitForFinalTestnetAccount(provider, 'fresh.testnet', 'pk', { delay: async () => {} }), /outage/); assert.equal(calls, 1);
  provider.query = async () => ({ amount: '1', storage_usage: 0 });
  provider.viewAccessKey = async () => ({ permission: { FunctionCall: {} } });
  await assert.rejects(waitForFinalTestnetAccount(provider, 'fresh.testnet', 'pk', { delay: async () => {} }), /invalid finalized/);
  provider.query = async () => ({ amount: '01', storage_usage: 0 }); provider.viewAccessKey = async () => ({ permission: 'FullAccess' });
  await assert.rejects(waitForFinalTestnetAccount(provider, 'fresh.testnet', 'pk', { delay: async () => {} }), /invalid finalized/);
  calls = 0; provider.query = async () => { calls++; throw Object.assign(new Error('missing'), { type: 'AccountDoesNotExist' }); };
  await assert.rejects(waitForFinalTestnetAccount(provider, 'fresh.testnet', 'pk', { attempts: 3, delay: async () => {} }), /missing/); assert.equal(calls, 3);
});
