import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForNewTestnetKey } from '../shared/testnet-ready.mjs';

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
