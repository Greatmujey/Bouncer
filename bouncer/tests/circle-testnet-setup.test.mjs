import test from 'node:test';
import assert from 'node:assert/strict';
import { CIRCLE_TESTNET_USDC, WRAP_TESTNET, REF_TESTNET, OWNER_SETUP_INPUT, selectOwnerSetupQuote } from '../scripts/circle-testnet-setup.mjs';

function fixture() {
  const calls = [], pools = new Map([1845, 2206].map(id => [id, { pool_kind: 'SIMPLE_POOL',
    token_account_ids: [WRAP_TESTNET, CIRCLE_TESTNET_USDC], amounts: ['10000000000000000000000', '1000000'] }]));
  const quotes = new Map([[1845, '7000'], [2206, '5000']]);
  const provider = {
    async viewNodeStatus() { return { chain_id: 'testnet' }; },
    async callFunction(id, method, args, final) {
      calls.push({ id, method, args, final }); assert.equal(id, REF_TESTNET); assert.deepEqual(final, { finality: 'final' });
      if (method === 'get_pool') return pools.get(args.pool_id);
      if (method === 'get_return') return quotes.get(args.pool_id);
      throw new Error('unexpected read');
    },
  };
  return { calls, pools, quotes, provider };
}

test('owner setup selects only the best reviewed Circle pool and fixes 5% slippage', async () => {
  const f = fixture(), q = await selectOwnerSetupQuote(f.provider);
  assert.equal(q.pool_id, 1845); assert.equal(q.quoted_output, '7000'); assert.equal(q.min_output, '6650');
  assert.equal(q.input_amount, OWNER_SETUP_INPUT.toString());
  assert.deepEqual(JSON.parse(q.msg), { force: 0, actions: [{ pool_id: 1845, token_in: WRAP_TESTNET,
    token_out: CIRCLE_TESTNET_USDC, amount_in: OWNER_SETUP_INPUT.toString(), min_amount_out: '6650' }] });
  assert.deepEqual(f.calls.map(c => c.method), ['get_pool', 'get_return', 'get_pool', 'get_return']);
});

test('setup refuses mainnet, different pairs, invalid amounts and bad quotes without signing', async () => {
  let f = fixture(); f.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(selectOwnerSetupQuote(f.provider), /testnet/); assert.equal(f.calls.length, 0);
  for (const mutate of [
    p => { p.token_account_ids[1] = 'usdc.fakes.testnet'; },
    p => { p.token_account_ids.push(CIRCLE_TESTNET_USDC); },
    p => { p.amounts[0] = '0'; },
    p => { p.amounts[0] = '9'.repeat(100); },
    p => { p.pool_kind = 'OTHER'; },
  ]) {
    f = fixture(); for (const pool of f.pools.values()) mutate(pool);
    await assert.rejects(selectOwnerSetupQuote(f.provider), /no bounded owner-setup/);
    assert(f.calls.every(c => c.method === 'get_pool'));
  }
  for (const value of ['0', '3157', '100001', '-1', '01', 7000, '9'.repeat(40)]) {
    f = fixture(); f.quotes.set(1845, value); f.quotes.set(2206, value);
    await assert.rejects(selectOwnerSetupQuote(f.provider), /no bounded owner-setup/);
  }
});

test('read-only outage in one pool falls back only to the other pinned pool', async () => {
  const f = fixture(), call = f.provider.callFunction;
  f.provider.callFunction = async (id, method, args, final) => {
    if (args.pool_id === 1845) throw new Error('unavailable');
    return call(id, method, args, final);
  };
  const q = await selectOwnerSetupQuote(f.provider);
  assert.equal(q.pool_id, 2206); assert.equal(q.min_output, '4750');
});
