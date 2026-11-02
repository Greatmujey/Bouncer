import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { inspectCircleOwnerAcquisition, ACQUISITION_INPUT_YOCTO } from '../agent/circle-owner-acquisition-readiness.mjs';

const NOW = Date.parse('2026-11-02T16:30:00Z'), BLOCK = mockHash('acquisition-block');
const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
const registration = { total: '1250000000000000000000', available: '0' };
function make(o = {}) {
  const calls = [];
  return { calls, async viewNodeStatus() { return { chain_id: o.chain ?? 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW - (o.stale ? 120_001 : 0)) * 1_000_000n).toString() } }; },
    async query(q) {
      calls.push([q.account_id, q.request_type]); assert.equal(q.block_id, BLOCK);
      const hash = o.mixed === q.account_id ? mockHash('other') : BLOCK;
      if (q.request_type === 'view_account') return { block_hash: hash,
        code_hash: q.account_id === plan.account_id ? '11111111111111111111111111111111' : mockHash(`code-${q.account_id}`),
        amount: '10000000000000000000000000', locked: '0' };
      const permission = { nonce: 50, permission: 'FullAccess' };
      if (q.request_type === 'view_access_key_list') return { block_hash: hash, keys: [{ public_key: pub, access_key: permission }] };
      if (q.request_type === 'view_access_key') return { block_hash: hash, ...permission };
      throw Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args, ref) {
      calls.push([contract, method]); assert.deepEqual(ref, { blockId: BLOCK }); let value;
      if (method === 'ft_metadata') value = contract === WRAP ? { symbol: o.wrapSymbol ?? 'wNEAR', decimals: 24 } : { symbol: 'USDC', decimals: 6 };
      else if (method === 'storage_balance_bounds') value = { min: o.storageMin ?? '1250000000000000000000', max: null };
      else if (method === 'storage_balance_of') value = contract === CIRCLE ? (args.account_id === REF && o.refCircleMissing ? null : registration) :
        args.account_id === REF ? (o.refWrapMissing ? null : registration) : o.ownerWrapRegistered ? registration : null;
      else if (method === 'ft_balance_of') value = contract === WRAP ? (o.wrapBalance ?? '0') : '0';
      else if (method === 'get_pool') value = o.badPools ? {} : { pool_kind: 'SIMPLE_POOL', token_account_ids: [WRAP, CIRCLE], amounts: ['1000', '2000'] };
      else if (method === 'get_return') { assert.equal(args.amount_in, ACQUISITION_INPUT_YOCTO); value = o.quote ?? (args.pool_id === 1845 ? '6580' : '4800'); }
      else throw Error('not a view');
      return { block_hash: o.mixed === method ? mockHash('other') : BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
    } };
}
const inspect = o => inspectCircleOwnerAcquisition({ plan, provider: make(o), now: () => NOW });

test('owner and Circle/wNEAR/Ref views share a FINAL block and select only bounded indications', async () => {
  const p = make(), s = await inspectCircleOwnerAcquisition({ plan, provider: p, now: () => NOW });
  assert.equal(s.block_hash, BLOCK); assert.equal(s.circle_registration, 'REGISTERED_AT_VIEW');
  assert.equal(s.owner_wrap_registration, 'NOT_REGISTERED_AT_VIEW'); assert.equal(s.owner_wrap_balance_yocto, '0');
  assert.equal(s.ref_wrap_registration, 'REGISTERED_AT_VIEW'); assert.equal(s.ref_circle_registration, 'REGISTERED_AT_VIEW');
  assert.deepEqual(s.selected, { pool_id: 1845, quote_atoms: '6580', min_output_atoms: '6251' });
  assert.equal(s.acquisition_input_yocto, '10000000000000000000000'); assert.equal(s.signed, false); assert.equal(s.sent, false);
  assert.ok(p.calls.every(([contract]) => [plan.account_id, CIRCLE, WRAP, REF].includes(contract)));
});

test('stale, mixed, missing registration and malformed wNEAR observations fail closed', async () => {
  for (const o of [{ chain: 'mainnet' }, { stale: true }, { mixed: WRAP }, { mixed: 'ft_metadata' },
    { refCircleMissing: true }, { refWrapMissing: true }, { wrapSymbol: 'NEAR' }, { storageMin: '10000000000000000000001' }]) {
    await assert.rejects(inspect(o));
  }
});

test('unreviewable or out-of-bound quotes stay unavailable; a registered owner is distinguished', async () => {
  assert.equal((await inspect({ badPools: true })).selected, null);
  assert.equal((await inspect({ quote: '10000000' })).selected, null);
  assert.equal((await inspect({ quote: '1' })).selected, null);
  assert.equal((await inspect({ ownerWrapRegistered: true })).owner_wrap_registration, 'REGISTERED_AT_VIEW');
});
