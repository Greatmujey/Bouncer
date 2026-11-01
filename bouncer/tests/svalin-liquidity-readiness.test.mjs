import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSvalinLiquidity } from '../agent/svalin-liquidity-readiness.mjs';
import { CIRCLE_TESTNET_USDC, REF_TESTNET, WRAP_TESTNET } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';

const pool = () => ({ pool_kind: 'SIMPLE_POOL', token_account_ids: [WRAP_TESTNET, CIRCLE_TESTNET_USDC], amounts: ['1000', '2000'] });
function provider(overrides = {}) {
  const calls = [];
  return { calls, async viewNodeStatus() { return { chain_id: overrides.chain ?? 'testnet' }; },
    async callFunction(contract, method, args, final) {
      calls.push({ contract, method, args, final });
      if (method === 'storage_balance_of') {
        if (overrides.storageError) throw new Error('unavailable');
        return Object.hasOwn(overrides, 'storage') ? overrides.storage : { total: '1250', available: '0' };
      }
      if (method === 'get_pool') {
        if (overrides.poolError) throw new Error('unavailable');
        return overrides.pool ?? pool();
      }
      if (method === 'get_return') {
        if (overrides.quoteError) throw new Error('unavailable');
        return overrides.quote ?? '5000001';
      }
      throw new Error('unexpected mutation');
    } };
}

test('bounded testnet registration and price indications never sign or send', async () => {
  const p = provider(), result = await inspectSvalinLiquidity(p);
  assert.equal(result.chain, 'testnet');
  assert.equal(result.seller_usdc_storage, 'REGISTERED_AT_VIEW');
  assert.equal(result.pools.length, 2);
  assert.equal(result.pools[0].quotes.length, 3);
  assert.equal(result.pools[0].quotes[0].usdc_output_atoms, '5000001');
  assert.equal(result.wallet_balance_checked, false);
  assert.equal(result.sent, false);
  assert.deepEqual(p.calls.map(c => c.method), ['storage_balance_of', 'get_pool', 'get_return', 'get_return', 'get_return', 'get_pool', 'get_return', 'get_return', 'get_return']);
  assert.equal(p.calls[0].contract, CIRCLE_TESTNET_USDC);
  assert.equal(p.calls[0].args.account_id, SVALIN_PAYEE);
  for (const call of p.calls.slice(1)) assert.equal(call.contract, REF_TESTNET);
  for (const call of p.calls) assert.deepEqual(call.final, { finality: 'final' });
});

test('mainnet is rejected before any account or pool view', async () => {
  const p = provider({ chain: 'mainnet' });
  await assert.rejects(inspectSvalinLiquidity(p), /testnet/);
  assert.equal(p.calls.length, 0);
});

test('unknown responses, unavailable views and unreviewed pools fail closed without implying failure', async () => {
  const unavailable = await inspectSvalinLiquidity(provider({ storageError: true, poolError: true }));
  assert.equal(unavailable.seller_usdc_storage, 'UNKNOWN');
  assert.ok(unavailable.pools.every(p => p.status === 'UNAVAILABLE' && !p.quotes.length));
  const absent = await inspectSvalinLiquidity(provider({ storage: null, quoteError: true }));
  assert.equal(absent.seller_usdc_storage, 'NOT_REGISTERED_AT_VIEW');
  assert.ok(absent.pools.every(p => p.quotes.every(q => q.usdc_output_atoms === null)));
  const malformed = await inspectSvalinLiquidity(provider({ storage: { total: '-1', available: '0' },
    pool: { ...pool(), token_account_ids: ['other.testnet', CIRCLE_TESTNET_USDC] } }));
  assert.equal(malformed.seller_usdc_storage, 'UNKNOWN');
  assert.ok(malformed.pools.every(p => p.status === 'UNREVIEWED_POOL' && !p.quotes.length));
  const wrong = await inspectSvalinLiquidity(provider({ quote: '1e7' }));
  assert.ok(wrong.pools.every(p => p.quotes.every(q => q.usdc_output_atoms === null)));
});
