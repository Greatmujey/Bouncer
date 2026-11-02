import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshFinalBlock, MAX_FINAL_BLOCK_AGE_MS, MAX_FINAL_BLOCK_FUTURE_SKEW_MS } from '../shared/fresh-final-block.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
const NOW = Date.parse('2026-11-01T21:00:00.000Z'), HASH = mockHash('final');
const block = ms => ({ header: { hash: HASH, timestamp_nanosec: (BigInt(ms) * 1_000_000n).toString() } });

test('FINAL block freshness uses a trusted local clock and exact boundary checks', () => {
  assert.deepEqual(assertFreshFinalBlock(block(NOW), NOW), { hash: HASH, timestamp_ms: NOW });
  assert.equal(assertFreshFinalBlock(block(NOW - MAX_FINAL_BLOCK_AGE_MS), NOW).timestamp_ms, NOW - MAX_FINAL_BLOCK_AGE_MS);
  assert.equal(assertFreshFinalBlock(block(NOW + MAX_FINAL_BLOCK_FUTURE_SKEW_MS), NOW).timestamp_ms, NOW + MAX_FINAL_BLOCK_FUTURE_SKEW_MS);
  assert.throws(() => assertFreshFinalBlock(block(NOW - MAX_FINAL_BLOCK_AGE_MS - 1), NOW), /stale/);
  assert.throws(() => assertFreshFinalBlock(block(NOW + MAX_FINAL_BLOCK_FUTURE_SKEW_MS + 1), NOW), /stale/);
  for (const invalid of [undefined, {}, { header: { hash: HASH } }, { header: { hash: 'x', timestamp_nanosec: '1' } },
    { header: { hash: HASH, timestamp_nanosec: '0' } }, { header: { hash: HASH, timestamp_nanosec: '9'.repeat(21) } },
    { header: { hash: HASH, timestamp_nanosec: 123 } }]) assert.throws(() => assertFreshFinalBlock(invalid, NOW), /invalid/);
  for (const time of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => assertFreshFinalBlock(block(NOW), time), /time/);
});
