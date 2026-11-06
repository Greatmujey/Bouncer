import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRefCirclePaths } from '../agent/ref-circle-discovery.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, HASH = mockHash('ref-route-block'), OTHER = mockHash('other-block');
const NANO = String(BigInt(NOW) * 1_000_000n), MIDDLE = 'middle.testnet';
const pool = (a, b, x, y) => ({ pool_kind: 'SIMPLE_POOL', token_account_ids: [a, b], amounts: [x, y], total_fee: 25 });
function fixture(o = {}) {
  const one = 10n ** 24n, data = [pool(WRAP, CIRCLE, String(100n * one), '100000000'),
    pool(WRAP, MIDDLE, String(100n * one), '1000000000000'), pool(MIDDLE, CIRCLE, '1000000000000', '120000000'),
    pool('wrong.near', CIRCLE, '900000', '3000000'), { pool_kind: 'STABLE_SWAP' }];
  const calls = [];
  return { calls, now: () => NOW, provider: {
    async viewNodeStatus() { calls.push('status'); return { chain_id: o.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock(ref) { calls.push(['block', ref]); return { header: { hash: HASH, height: 20,
      timestamp_nanosec: o.stale ? String(BigInt(NOW - 121_000) * 1_000_000n) : NANO } }; },
    async callFunctionRaw(account, method, args, ref) {
      calls.push([method, args, ref]); assert.equal(account, REF); assert.deepEqual(ref, { blockId: HASH });
      let result;
      if (method === 'get_number_of_pools') result = data.length;
      else if (method === 'get_pools') result = o.shortPage ? [] : data.slice(args.from_index, args.from_index + args.limit);
      else if (method === 'get_return') result = args.pool_id === 0 ? '900000' : args.pool_id === 1 ? '100' : '7000000';
      else throw Error('unexpected call');
      return { block_hash: o.mixed === method ? OTHER : HASH, result: [...Buffer.from(JSON.stringify(result))] };
    },
  } };
}

test('finds and quotes only representative testnet direct and two-hop paths at one block', async () => {
  const f = fixture(), result = await inspectRefCirclePaths(f);
  assert.equal(result.enumeration_complete, true); assert.equal(result.pools_total, 5); assert.equal(result.simple_pools_valid, 3);
  assert.equal(result.direct_paths_observed, 1); assert.equal(result.total_direct_and_two_hop_paths_observed, 2);
  assert.equal(result.top_indicative_paths[0].output_atoms, '7000000');
  assert.deepEqual(result.top_indicative_paths[0].pool_ids, [1, 2]);
  assert.deepEqual(result.top_indicative_paths[0].tokens, [WRAP, MIDDLE, CIRCLE]);
  assert.equal(result.execution_authorized, false); assert.equal(result.signed, false); assert.equal(result.sent, false);
  assert(f.calls.every(c => c === 'status' || ['block', 'get_number_of_pools', 'get_pools', 'get_return'].includes(c[0])));
});

test('mainnet, stale snapshots and malformed or mixed count fail closed', async () => {
  for (const o of [{ mainnet: true }, { stale: true }, { mixed: 'get_number_of_pools' }]) {
    await assert.rejects(inspectRefCirclePaths(fixture(o)));
  }
});

test('missing or mixed pages are marked incomplete rather than proof of no paths', async () => {
  for (const o of [{ shortPage: true }, { mixed: 'get_pools' }]) {
    const result = await inspectRefCirclePaths(fixture(o));
    assert.equal(result.enumeration_complete, false); assert.equal(result.failed_page_count, 1);
    assert.deepEqual(result.top_indicative_paths, []); assert.equal(result.execution_authorized, false);
  }
});

test('a mixed or failed return quote is unavailable rather than an executable price', async () => {
  const result = await inspectRefCirclePaths(fixture({ mixed: 'get_return' }));
  assert.equal(result.enumeration_complete, true);
  assert(result.top_indicative_paths.every(p => p.output_atoms === null));
});
