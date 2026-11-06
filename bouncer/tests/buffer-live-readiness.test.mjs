import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBufferLiveReadiness, BUFFER_FUNDING_SAMPLE_INPUTS } from '../agent/buffer-live-readiness.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, BLOCK = mockHash('buffer-live-block'), OTHER = mockHash('buffer-live-other');
const IMPLICIT = '26f36567c9a7bd63f340c0c48621ee1257ee28c68211736226caf4efefb8dd84';
const NANO = String(BigInt(NOW) * 1_000_000n), ONE = 10n ** 24n;
const base = { network: 'testnet', block_hash: BLOCK, block_timestamp_nanosec: NANO, owner: 'buyer.testnet',
  vault: 'vault.buyer.testnet', owner_key_nonce: '123', owner_native_yocto: String(9n * ONE),
  owner_circle_atoms: '0', vault_actual_circle_atoms: '6898', vault_tracked_circle_atoms: '6898',
  vault_estimated_available_yocto: String(ONE), circle_token: CIRCLE, signed: false, sent: false };
function fixture(o = {}) {
  const calls = [];
  const config = { owner: 'seller.testnet', agent: IMPLICIT, owner_payout: 'owner.testnet', contributor: 'contrib.testnet',
    token_id: o.token ?? CIRCLE, paused: o.paused ?? false, policy_version: 7 };
  const rule = { min_price: '5000000', max_price: '50000000', max_expense_bps: 5000, active: true };
  const products = [['weekly-market-brief', { price: '20000000', max_expense: '10000000', active: true }],
    ['crosschain-brief', { price: '20000000', max_expense: '15000000', active: true }]];
  const provider = {
    calls,
    async viewBlock(request) {
      calls.push(['block', request]);
      return { header: { hash: o.badBlock ? OTHER : BLOCK, height: 300_000_000,
        timestamp_nanosec: o.stale ? String(BigInt(NOW - 121_000) * 1_000_000n) : NANO } };
    },
    async query(q) {
      calls.push(['query', q]); assert.equal(q.block_id, BLOCK); assert.equal(q.account_id, SELLER);
      if (q.request_type === 'view_account') return { block_hash: o.mixedAccount ? OTHER : BLOCK, code_hash: mockHash('seller-code') };
      if (q.request_type === 'view_access_key_list') return { block_hash: BLOCK, keys: [{ public_key: 'public' }] };
      throw new Error('mutating or unexpected query');
    },
    async callFunctionRaw(account, method, args, ref) {
      calls.push(['view', account, method, args, ref]); assert.deepEqual(ref, { blockId: BLOCK });
      let data;
      if (account === SELLER && method === 'get_config') data = o.badConfig ? { ...config, agent: 'attacker.near' } : config;
      else if (account === SELLER && method === 'get_quote_rules') data = o.duplicateRules ? [['custom-brief', rule], ['custom-brief', rule]] : [['custom-brief', rule]];
      else if (account === SELLER && method === 'get_products') data = products;
      else if (account === CIRCLE && method === 'storage_balance_of') data = o.unregistered ? null : { total: '1000', available: '0' };
      else if (account === REF && method === 'get_pool') data = o.invalidPool && args.pool_id === 1845 ? {} :
        { pool_kind: 'SIMPLE_POOL', token_account_ids: [WRAP, CIRCLE], amounts: ['100000', '50000'] };
      else if (account === REF && method === 'get_return') {
        if (o.failedQuote && args.pool_id === 1845) throw Error('unavailable');
        data = String((BigInt(args.amount_in) / ONE) * (args.pool_id === 1845 ? 1_000_000n : 800_000n));
      } else throw Error('unexpected call');
      return { block_hash: o.mixedView === method ? OTHER : BLOCK, result: [...Buffer.from(JSON.stringify(data))] };
    },
  };
  return { provider, inspectVault: async () => ({ ...base, ...(o.base ?? {}) }), now: () => NOW, plan: {}, calls };
}
const inspect = o => inspectBufferLiveReadiness(fixture(o));

test('pinned testnet snapshot recognizes implicit seller and reports only indicative funding samples', async () => {
  const f = fixture(), result = await inspectBufferLiveReadiness(f);
  assert.equal(result.block_hash, BLOCK); assert.equal(result.seller.agent, IMPLICIT);
  assert.equal(result.seller.accepts_reviewed_circle, true); assert.equal(result.seller.circle_registered, true);
  assert.deepEqual(result.seller.custom_quote, { active: true, min_atoms: '5000000', max_atoms: '50000000', max_expense_bps: 5000 });
  assert.equal(result.minimum_custom_shortfall_atoms, '4993102');
  assert.equal(result.first_sample_covering_minimum_before_other_costs.input_yocto, String(6n * ONE));
  assert.equal(result.first_sample_covering_minimum_before_other_costs.pool_id, 1845);
  assert.equal(result.indicative_ref_pools[0].quotes.length, BUFFER_FUNDING_SAMPLE_INPUTS.length);
  assert.equal(result.payment_authorized, false); assert.equal(result.quote_created, false); assert.equal(result.sent, false);
  assert.equal(result.independent_delivery_verified, false); assert.equal(result.seller_contacted, false);
  assert(f.calls.filter(x => x[0] === 'view').every(x => [SELLER, CIRCLE, REF].includes(x[1])));
  assert(f.calls.every(x => ['block', 'query', 'view'].includes(x[0])));
});

test('changed seller token or pause disables minimum funding indication without implying an offer', async () => {
  for (const o of [{ token: 'wrong.testnet' }, { paused: true }]) {
    const result = await inspect(o);
    assert.equal(result.minimum_custom_shortfall_atoms, null);
    assert.equal(result.first_sample_covering_minimum_before_other_costs, null);
    assert.equal(result.payment_authorized, false);
  }
});

test('mixed or stale blocks, malformed seller, and mainnet or signed base fail closed', async () => {
  for (const o of [{ badBlock: true }, { stale: true }, { mixedAccount: true }, { mixedView: 'get_config' },
    { badConfig: true }, { duplicateRules: true }, { base: { network: 'mainnet' } }, { base: { signed: true } }]) {
    await assert.rejects(inspect(o));
  }
});

test('unavailable pools and partial quotes are not considered spendable evidence', async () => {
  const invalid = await inspect({ invalidPool: true });
  assert.equal(invalid.indicative_ref_pools[0].status, 'POOL_UNAVAILABLE_OR_DIFFERENT');
  assert.notEqual(invalid.first_sample_covering_minimum_before_other_costs?.pool_id, 1845);
  const partial = await inspect({ failedQuote: true });
  assert.equal(partial.indicative_ref_pools[0].status, 'INCOMPLETE');
  assert(partial.indicative_ref_pools[0].quotes.every(q => q.output_atoms === null));
  assert.equal(partial.seller.circle_registered, true);
  const noRegistration = await inspect({ unregistered: true });
  assert.equal(noRegistration.seller.circle_registered, false);
  assert.equal(noRegistration.first_sample_covering_minimum_before_other_costs, null);
  const mismatch = await inspect({ base: { vault_actual_circle_atoms: '6897' } });
  assert.equal(mismatch.vault_balances_match, false);
  assert.equal(mismatch.first_sample_covering_minimum_before_other_costs, null);
});
