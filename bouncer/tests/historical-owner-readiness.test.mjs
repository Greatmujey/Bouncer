import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHistoricalOwner } from '../agent/historical-owner-readiness.mjs';
import { PRIOR_OWNER } from '../agent/multiagency-readiness.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z'), BLOCK = mockHash('historical-owner-final');
function fake({ chain = 'testnet', stale = false, mixed = '', unavailable = '', malformedKeys = false, registration = undefined } = {}) {
  const calls = [];
  return { calls, async viewNodeStatus() { calls.push('status'); return { chain_id: chain }; },
    async viewBlock(ref) { calls.push('block'); assert.deepEqual(ref, { finality: 'final' });
      return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW - (stale ? 120_001 : 0)) * 1_000_000n).toString() } }; },
    async query(args) { calls.push(args.request_type); assert.equal(args.block_id, BLOCK); assert.equal(args.account_id, PRIOR_OWNER);
      if (args.request_type === unavailable) throw new Error('unavailable');
      const h = mixed === args.request_type ? mockHash('other') : BLOCK;
      if (args.request_type === 'view_account') return { block_hash: h, amount: '2000000000000000000000000', locked: '0', code_hash: mockHash('code') };
      if (args.request_type === 'view_access_key_list') return { block_hash: h, keys: [{ access_key: { permission: malformedKeys ? 'unexpected' : 'FullAccess' } }] };
      throw new Error('not a view'); },
    async callFunctionRaw(contract, method, args, ref) { calls.push(method); assert.equal(contract, CIRCLE_TESTNET_USDC);
      assert.equal(args.account_id, PRIOR_OWNER); assert.deepEqual(ref, { blockId: BLOCK });
      if (method === unavailable) throw new Error('unavailable');
      const value = method === 'ft_balance_of' ? '3936' : registration === undefined ? { total: '1250', available: '0' } : registration;
      return { block_hash: mixed === method ? mockHash('other') : BLOCK, result: [...Buffer.from(JSON.stringify(value))] }; },
    async sendTransaction() { throw new Error('a read-only snapshot must not sign or send'); },
  };
}
const inspect = p => inspectHistoricalOwner(p, { now: () => NOW });

test('historical owner views share a fresh FINAL block and do not imply key custody', async () => {
  const p = fake(), result = await inspect(p);
  assert.equal(result.account_id, PRIOR_OWNER); assert.equal(result.block_hash, BLOCK);
  assert.equal(result.account.native_balance_yocto, '2000000000000000000000000');
  assert.deepEqual(result.access_keys, { key_count: 1, full_access_key_count: 1 });
  assert.equal(result.circle_balance_atoms, '3936'); assert.equal(result.circle_registration, 'REGISTERED_AT_VIEW');
  assert.equal(result.owner_private_key_available, 'NOT_CHECKED'); assert.equal(result.sent, false); assert.equal(result.private_key_recovered, false);
  assert.deepEqual(new Set(p.calls), new Set(['status', 'block', 'view_account', 'view_access_key_list', 'ft_balance_of', 'storage_balance_of']));
});

test('mainnet and stale blocks fail before account or FT views', async () => {
  for (const opts of [{ chain: 'mainnet' }, { stale: true }]) {
    const p = fake(opts); await assert.rejects(inspect(p));
    assert.equal(p.calls.some(call => call === 'view_account' || call === 'ft_balance_of'), false);
  }
  let calls = 0;
  await assert.rejects(inspectHistoricalOwner(fake(), { now: () => calls++ ? NOW + 120_001 : NOW }), /FINAL block is stale/);
});

test('mismatched, unavailable, or malformed public views remain unknown, never proof of absence', async () => {
  for (const item of ['view_account', 'view_access_key_list', 'ft_balance_of', 'storage_balance_of']) {
    const result = await inspect(fake({ mixed: item }));
    assert.equal(item === 'view_account' ? result.account : item === 'view_access_key_list' ? result.access_keys :
      item === 'ft_balance_of' ? result.circle_balance_atoms : result.circle_registration,
      item === 'storage_balance_of' ? 'UNKNOWN' : null);
  }
  assert.equal((await inspect(fake({ unavailable: 'storage_balance_of' }))).circle_registration, 'UNKNOWN');
  assert.equal((await inspect(fake({ malformedKeys: true }))).access_keys, null);
  assert.equal((await inspect(fake({ registration: null }))).circle_registration, 'NOT_REGISTERED_AT_VIEW');
  assert.equal((await inspect(fake({ registration: { total: '1', available: '2' } }))).circle_registration, 'UNKNOWN');
});
