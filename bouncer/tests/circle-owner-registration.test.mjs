import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { inspectCircleOwnerRegistration, validateRegistrationSnapshot, signCircleOwnerRegistration,
  verifySignedCircleRegistration, OWNER_REGISTRATION_GAS, MAX_OWNER_REGISTRATION_DEPOSIT } from '../agent/circle-owner-registration.mjs';

const NOW = Date.parse('2026-11-02T16:12:00Z'), BLOCK = mockHash('circle-owner-final'), CODE = mockHash('circle-owner-token-code');
const ownerKey = nearApi.KeyPair.fromRandom('ed25519');
const publicKey = String(ownerKey.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: publicKey };
function provider(o = {}) {
  const calls = [];
  const p = { calls, async viewNodeStatus() { calls.push('status'); return { chain_id: o.chain ?? 'testnet' }; },
    async viewBlock(ref) { assert.deepEqual(ref, { finality: 'final' }); calls.push('block');
      return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW - (o.stale ? 120_001 : 0)) * 1_000_000n).toString() } }; },
    async query(q) {
      calls.push(q.request_type); assert.equal(q.block_id, BLOCK);
      const h = o.mixed === q.request_type ? mockHash('different-block') : BLOCK;
      if (q.request_type === 'view_account' && q.account_id === plan.account_id) return { block_hash: h,
        code_hash: o.ownerCode ? CODE : '11111111111111111111111111111111', amount: o.ownerBalance ?? '10000000000000000000000000', locked: '0' };
      if (q.request_type === 'view_account' && q.account_id === CIRCLE_TESTNET_USDC) return { block_hash: h, code_hash: CODE };
      const item = { public_key: o.wrongKey ? 'ed25519:wrong' : publicKey, access_key: { nonce: 100, permission: 'FullAccess' } };
      if (q.request_type === 'view_access_key_list') return { block_hash: h, keys: o.extraKeys ? [item, item] : [item] };
      if (q.request_type === 'view_access_key') return { block_hash: h, nonce: o.badNonce ? 101 : 100, permission: 'FullAccess' };
      throw new Error('not a view');
    },
    async callFunctionRaw(contract, method, args, ref) {
      calls.push(method); assert.equal(contract, CIRCLE_TESTNET_USDC); assert.deepEqual(ref, { blockId: BLOCK });
      const values = { storage_balance_bounds: { min: o.min ?? '1250000000000000000000', max: null },
        storage_balance_of: Object.hasOwn(o, 'storage') ? o.storage : null,
        ft_metadata: { symbol: o.symbol ?? 'USDC', decimals: o.decimals ?? 6 }, ft_balance_of: '0' };
      if (!(method in values)) throw new Error('not a view');
      return { block_hash: o.mixed === method ? mockHash('different-block') : BLOCK, result: [...Buffer.from(JSON.stringify(values[method]))] };
    } };
  return p;
}
const inspect = o => inspectCircleOwnerRegistration({ plan, provider: provider(o), now: () => NOW });

test('read-only testnet registration preflight pins account, key nonce, Circle views and reserve to one FINAL block', async () => {
  const p = provider(), s = await inspectCircleOwnerRegistration({ plan, provider: p, now: () => NOW });
  assert.equal(s.block_hash, BLOCK); assert.equal(s.owner_key_nonce, '100');
  assert.equal(s.circle_code_hash, CODE); assert.equal(s.circle_storage_min_yocto, '1250000000000000000000');
  assert.equal(s.circle_registration, 'NOT_REGISTERED_AT_VIEW'); assert.equal(s.circle_balance_atoms, '0');
  assert.equal(s.signed, false); assert.equal(s.sent, false); assert.equal(s.backup_export_verified, false);
  assert.equal(validateRegistrationSnapshot(s, plan, NOW).deposit, 1250000000000000000000n);
  assert.equal(p.calls.filter(x => x === 'storage_balance_of').length, 1);
});

test('preflight fails closed for wrong chain, stale/mixed state, unsafe account, nonce, token and storage', async () => {
  const variants = [{ chain: 'mainnet' }, { stale: true }, { mixed: 'view_access_key' }, { mixed: 'ft_metadata' },
    { ownerCode: true }, { wrongKey: true }, { extraKeys: true }, { badNonce: true }, { symbol: 'wrong' },
    { decimals: 18 }, { min: '0' }, { min: (MAX_OWNER_REGISTRATION_DEPOSIT + 1n).toString() },
    { ownerBalance: '1000' }, { storage: { total: '1', available: '2' } }];
  for (const o of variants) await assert.rejects(inspect(o));
  const registered = await inspect({ storage: { total: '1250', available: '0' } });
  assert.equal(registered.circle_registration, 'REGISTERED_AT_VIEW');
  assert.throws(() => validateRegistrationSnapshot(registered, plan, NOW), /not eligible/);
});

test('offline signature is exactly one bounded registration to Circle for this owner and is independently verified', async () => {
  const snapshot = await inspect(), envelope = await signCircleOwnerRegistration({ plan, snapshot, keyPair: ownerKey, nowMs: NOW });
  assert.equal(envelope.nonce, '101'); assert.equal(envelope.deposit_yocto, snapshot.circle_storage_min_yocto);
  assert.equal(envelope.gas, OWNER_REGISTRATION_GAS.toString()); assert.equal(envelope.do_not_blindly_resend, true);
  const signed = verifySignedCircleRegistration(envelope, plan);
  assert.equal(signed.transaction.receiverId, CIRCLE_TESTNET_USDC);
  assert.equal(signed.transaction.actions[0].functionCall.methodName, 'storage_deposit');
  assert.equal(JSON.stringify(envelope).includes(ownerKey.toString()), false);
  await assert.rejects(signCircleOwnerRegistration({ plan, snapshot, keyPair: nearApi.KeyPair.fromRandom('ed25519'), nowMs: NOW }), /does not match/);
  await assert.rejects(signCircleOwnerRegistration({ plan, snapshot, keyPair: ownerKey, nowMs: NOW + 120_001 }), /FINAL block is stale/);
});

test('signed action verifier rejects tampered metadata, noncanonical bytes and forged signature', async () => {
  const snapshot = await inspect(), envelope = await signCircleOwnerRegistration({ plan, snapshot, keyPair: ownerKey, nowMs: NOW });
  for (const change of [{ owner: 'attacker.testnet' }, { token: 'other.testnet' }, { method: 'ft_transfer' },
    { deposit_yocto: '1' }, { deposit_yocto: (MAX_OWNER_REGISTRATION_DEPOSIT + 1n).toString() }, { gas: '1' },
    { nonce: '102' }, { block_hash: mockHash('different-block') }, { tx_hash: mockHash('other-hash') },
    { signed_tx_base64: '!!' }, { do_not_blindly_resend: false }]) {
    assert.throws(() => verifySignedCircleRegistration({ ...envelope, ...change }, plan));
  }
  const bytes = Buffer.from(envelope.signed_tx_base64, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => verifySignedCircleRegistration({ ...envelope, signed_tx_base64: bytes.toString('base64') }, plan));
});
