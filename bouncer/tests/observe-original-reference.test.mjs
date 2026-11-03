import test from 'node:test';
import assert from 'node:assert/strict';
import { observeOriginalReference } from '../agent/observe-original-reference.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
const now = Date.parse('2026-11-03T14:00:00Z'), reference = mockHash('reference'), head = mockHash('head');
function rpc({ network = 'testnet', age = 1000, validity = 800, canonical = reference, stale = false } = {}) {
  return { async viewNodeStatus() { return { chain_id: network }; },
    async viewBlock({ finality, blockId }) {
      if (finality === 'final') return { header: { hash: head, height: 10000,
        timestamp_nanosec: String(BigInt(now - (stale ? 200000 : 1000)) * 1000000n) } };
      if (blockId === reference) return { header: { hash: reference, height: 10000 - age } };
      if (blockId === 10000 - age) return { header: { hash: canonical, height: 10000 - age } };
      throw new Error('unexpected view');
    }, async experimental_protocolConfig() { return { chain_id: network, transaction_validity_period: validity }; } };
}
test('canonical age observation never claims historical execution and retains original fence', async () => {
  const value = await observeOriginalReference({ provider: rpc(), referenceHash: reference, nowMs: now });
  assert.equal(value.age_blocks, 1000); assert.equal(value.observed_validity_period_blocks, 800);
  assert.equal(value.outside_observed_window_with_100_block_margin, true);
  assert.equal(value.historical_execution_known, false); assert.equal(value.do_not_resend_original, true);
  assert.equal(typeof rpc().sendTransactionOnce, 'undefined');
});
test('boundary, noncanonical, stale, malformed and wrong-network observations fail closed', async () => {
  assert.equal((await observeOriginalReference({ provider: rpc({ age: 900 }), referenceHash: reference, nowMs: now })).outside_observed_window_with_100_block_margin, false);
  for (const provider of [rpc({ network: 'mainnet' }), rpc({ canonical: mockHash('fork') }), rpc({ stale: true }), rpc({ validity: 0 })]) {
    await assert.rejects(observeOriginalReference({ provider, referenceHash: reference, nowMs: now }));
  }
  await assert.rejects(observeOriginalReference({ provider: rpc(), referenceHash: 'invalid', nowMs: now }));
});
