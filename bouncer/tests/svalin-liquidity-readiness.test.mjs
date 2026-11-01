import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSvalinLiquidity } from '../agent/svalin-liquidity-readiness.mjs';
import { CIRCLE_TESTNET_USDC, REF_TESTNET, WRAP_TESTNET } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = Date.parse('2026-11-01T19:25:00Z'), BLOCK = mockHash('liquidity-final');
const pool = () => ({ pool_kind: 'SIMPLE_POOL', token_account_ids: [WRAP_TESTNET, CIRCLE_TESTNET_USDC], amounts: ['1000', '2000'] });
function provider(overrides = {}) {
  const calls = [];
  return { calls, async viewNodeStatus() { return { chain_id: overrides.chain ?? 'testnet' }; },
    async viewBlock(final) { assert.deepEqual(final, { finality: 'final' });
      return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(overrides.blockTime ?? NOW) * 1_000_000n).toString() } }; },
    async callFunctionRaw(contract, method, args, final) {
      calls.push({ contract, method, args, final }); let value;
      if (method === 'storage_balance_of') {
        if (overrides.storageError) throw new Error('unavailable');
        value = Object.hasOwn(overrides, 'storage') ? overrides.storage : { total: '1250', available: '0' };
      } else if (method === 'get_pool') {
        if (overrides.poolError) throw new Error('unavailable');
        value = overrides.pool ?? pool();
      } else if (method === 'get_return') {
        if (overrides.quoteError) throw new Error('unavailable');
        value = overrides.quote ?? '5000001';
      } else throw new Error('unexpected mutation');
      return { block_hash: overrides.mixed === method ? mockHash('other-block') : BLOCK,
        result: [...Buffer.from(JSON.stringify(value))] };
    } };
}
const inspect = p => inspectSvalinLiquidity(p, { now: () => NOW });

test('bounded registration and five funding indications use one fresh FINAL block, never sign or send', async () => {
  const p = provider(), result = await inspect(p);
  assert.equal(result.chain, 'testnet'); assert.equal(result.block_hash, BLOCK);
  assert.equal(result.block_timestamp, new Date(NOW).toISOString());
  assert.equal(result.seller_usdc_storage, 'REGISTERED_AT_VIEW');
  assert.equal(result.pools.length, 2); assert.equal(result.pools[0].quotes.length, 5);
  assert.deepEqual(result.pools[0].quotes.map(q => q.wrap_input_yocto), [1n, 5n, 10n, 15n, 20n].map(n => (n * 10n ** 24n).toString()));
  assert.equal(result.pools[0].quotes[0].usdc_output_atoms, '5000001');
  assert.equal(result.wallet_balance_checked, false); assert.equal(result.sent, false);
  assert.deepEqual(p.calls.map(c => c.method), ['storage_balance_of', 'get_pool', ...Array(5).fill('get_return'),
    'get_pool', ...Array(5).fill('get_return')]);
  assert.equal(p.calls[0].contract, CIRCLE_TESTNET_USDC); assert.equal(p.calls[0].args.account_id, SVALIN_PAYEE);
  for (const call of p.calls.slice(1)) assert.equal(call.contract, REF_TESTNET);
  for (const call of p.calls) assert.deepEqual(call.final, { blockId: BLOCK });
  assert.match(result.scope, /not funding, a tradable quote/);
});

test('mainnet or stale FINAL state is rejected before any account or pool view', async () => {
  for (const overrides of [{ chain: 'mainnet' }, { blockTime: NOW - 120_001 }, { blockTime: NOW + 30_001 }]) {
    const p = provider(overrides); await assert.rejects(inspect(p)); assert.equal(p.calls.length, 0);
  }
  const p = provider(); let tick = 0;
  await assert.rejects(inspectSvalinLiquidity(p, { now: () => tick++ ? NOW + 120_001 : NOW }), /FINAL block is stale/);
});

test('unknown responses, mixed block views and unreviewed pools fail closed without implying absence', async () => {
  const unavailable = await inspect(provider({ storageError: true, poolError: true }));
  assert.equal(unavailable.seller_usdc_storage, 'UNKNOWN');
  assert.ok(unavailable.pools.every(p => p.status === 'UNAVAILABLE' && !p.quotes.length));
  const mixed = await inspect(provider({ mixed: 'storage_balance_of' }));
  assert.equal(mixed.seller_usdc_storage, 'UNKNOWN');
  const mixedPool = await inspect(provider({ mixed: 'get_pool' }));
  assert.ok(mixedPool.pools.every(p => p.status === 'UNAVAILABLE'));
  const mixedQuote = await inspect(provider({ mixed: 'get_return' }));
  assert.ok(mixedQuote.pools.every(p => p.quotes.every(q => q.usdc_output_atoms === null)));
  const absent = await inspect(provider({ storage: null, quoteError: true }));
  assert.equal(absent.seller_usdc_storage, 'NOT_REGISTERED_AT_VIEW');
  assert.ok(absent.pools.every(p => p.quotes.every(q => q.usdc_output_atoms === null)));
  const malformed = await inspect(provider({ storage: { total: '-1', available: '0' },
    pool: { ...pool(), token_account_ids: ['other.testnet', CIRCLE_TESTNET_USDC] } }));
  assert.equal(malformed.seller_usdc_storage, 'UNKNOWN');
  assert.ok(malformed.pools.every(p => p.status === 'UNREVIEWED_POOL' && !p.quotes.length));
  const excess = await inspect(provider({ storage: { total: '1', available: '2' }, pool: { ...pool(), amounts: ['0', '5'] } }));
  assert.equal(excess.seller_usdc_storage, 'UNKNOWN'); assert.ok(excess.pools.every(p => p.status === 'UNREVIEWED_POOL'));
  const wrong = await inspect(provider({ quote: '1e7' }));
  assert.ok(wrong.pools.every(p => p.quotes.every(q => q.usdc_output_atoms === null)));
});
