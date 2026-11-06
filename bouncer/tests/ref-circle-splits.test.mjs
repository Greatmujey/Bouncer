import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRefCircleSplits } from '../agent/ref-circle-discovery.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, HASH = mockHash('ref-split-block'), OTHER = mockHash('other-block');
const NANO = String(BigInt(NOW) * 1_000_000n), NEAR = 10n ** 24n, MIDDLE = 'ref.fakes.testnet';
const makePool = (a, b, x, y) => ({ pool_kind: 'SIMPLE_POOL', token_account_ids: [a, b], amounts: [String(x), String(y)], total_fee: 25 });
function fixture(o = {}) {
  const pools = {
    17: makePool(WRAP, MIDDLE, 100n * NEAR, 10n ** 18n),
    2527: makePool(MIDDLE, CIRCLE, 10n ** 12n, 3_000_000n),
    1845: makePool(WRAP, CIRCLE, 20n * NEAR, 10_000_000n),
    2206: makePool(WRAP, CIRCLE, 20n * NEAR, 7_000_000n),
  };
  if (o.badTokens) pools[17].token_account_ids[1] = 'other.testnet';
  const calls = [];
  return { calls, now: () => NOW, provider: {
    async viewNodeStatus() { return { chain_id: o.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock() { return { header: { hash: HASH, height: 20, timestamp_nanosec: o.stale ? String(BigInt(NOW - 121_000) * 1_000_000n) : NANO } }; },
    async callFunctionRaw(account, method, args, ref) {
      assert.equal(account, REF); assert.deepEqual(ref, { blockId: HASH }); calls.push([method, args]);
      let data;
      if (method === 'get_pool') data = pools[args.pool_id];
      else if (method === 'get_return') {
        if (o.failedQuote && args.pool_id === 2527) throw new Error('unavailable');
        const p = pools[args.pool_id], i = p.token_account_ids.indexOf(args.token_in);
        assert(i >= 0); assert.equal(p.token_account_ids[1 - i], args.token_out);
        const input = BigInt(args.amount_in) * 9975n / 10000n;
        data = String(BigInt(p.amounts[1 - i]) * input / (BigInt(p.amounts[i]) + input));
      } else throw new Error('unexpected method');
      return { block_hash: o.mixed === method ? OTHER : HASH, result: [...Buffer.from(JSON.stringify(data))] };
    },
  } };
}

test('fixed disjoint split estimates are quoted at the same testnet block with no signer', async () => {
  const f = fixture(), out = await inspectRefCircleSplits(f);
  assert.equal(out.scenarios.length, 8); assert.equal(out.execution_authorized, false);
  assert.equal(out.signed, false); assert.equal(out.sent, false);
  assert.deepEqual(out.routes.map(r => r.pool_ids), [[17, 2527], [1845], [2206]]);
  for (const s of out.scenarios) {
    assert.equal(s.quote_complete, true);
    assert.equal(s.legs.reduce((v, l) => v + BigInt(l.input_yocto), 0n).toString(), s.input_yocto);
    assert.equal(s.legs.reduce((v, l) => v + BigInt(l.output_atoms), 0n).toString(), s.observed_sum_atoms);
    assert.equal(s.observed_sum_atoms, s.estimate_atoms);
  }
  assert(f.calls.every(([method]) => ['get_pool', 'get_return'].includes(method)));
});

test('untrusted network, stale snapshot and changed pool tokens fail closed', async () => {
  for (const o of [{ mainnet: true }, { stale: true }, { mixed: 'get_pool' }, { badTokens: true }]) {
    await assert.rejects(inspectRefCircleSplits(fixture(o)));
  }
});

test('a failed or mixed return makes a scenario incomplete rather than a spendable estimate', async () => {
  for (const o of [{ failedQuote: true }, { mixed: 'get_return' }]) {
    const out = await inspectRefCircleSplits(fixture(o));
    assert(out.scenarios.some(s => !s.quote_complete));
    for (const s of out.scenarios.filter(s => !s.quote_complete)) assert.equal(s.observed_sum_atoms, null);
  }
});
