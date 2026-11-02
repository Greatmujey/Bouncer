import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { validateAcquisitionSnapshot, signOwnerAcquisition, verifySignedOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';

const NOW = Date.parse('2026-11-02T16:40:00Z'), key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
const input = '10000000000000000000000';
function snapshot(overrides = {}) {
  return { version: 1, chain: 'testnet', owner: plan.account_id, public_key: pub, owner_key_count: 1,
    block_hash: mockHash('acquisition-final'), block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(),
    owner_native_yocto: '10000000000000000000000000', owner_key_nonce: '100',
    circle_token: CIRCLE, circle_registration: 'REGISTERED_AT_VIEW', circle_symbol: 'USDC', circle_decimals: 6,
    circle_code_hash: mockHash('circle-code'), circle_balance_atoms: '0',
    wrap_token: WRAP, wrap_symbol: 'wNEAR', wrap_decimals: 24, wrap_code_hash: mockHash('wrap-code'),
    wrap_storage_min_yocto: '1250000000000000000000', owner_wrap_registration: 'NOT_REGISTERED_AT_VIEW', owner_wrap_balance_yocto: '0',
    ref_exchange: REF, ref_wrap_registration: 'REGISTERED_AT_VIEW', ref_circle_registration: 'REGISTERED_AT_VIEW',
    acquisition_input_yocto: input, max_usdc_atoms: '100000', selected: { pool_id: 1845, quote_atoms: '6500', min_output_atoms: '6175' },
    signed: false, sent: false, ...overrides };
}

test('wrap signs only exact owner registration and 0.01 test NEAR deposit', async () => {
  const e = await signOwnerAcquisition({ plan, snapshot: snapshot(), kind: 'wrap', keyPair: key, nowMs: NOW });
  const signed = verifySignedOwnerAcquisition(e, plan), actions = signed.transaction.actions.map(a => a.functionCall);
  assert.equal(signed.transaction.receiverId, WRAP); assert.equal(actions.length, 2);
  assert.equal(actions[0].methodName, 'storage_deposit'); assert.equal(String(actions[0].deposit), e.wrap_storage_min_yocto);
  assert.deepEqual(JSON.parse(Buffer.from(actions[0].args).toString()), { account_id: plan.account_id, registration_only: true });
  assert.equal(actions[1].methodName, 'near_deposit'); assert.equal(String(actions[1].deposit), input);
  assert.equal(JSON.stringify(e).includes(key.toString()), false);
  const already = await signOwnerAcquisition({ plan, snapshot: snapshot({ owner_wrap_registration: 'REGISTERED_AT_VIEW' }), kind: 'wrap', keyPair: key, nowMs: NOW });
  assert.deepEqual(verifySignedOwnerAcquisition(already, plan).transaction.actions.map(a => a.functionCall.methodName), ['near_deposit']);
});

test('swap signs a single 1-yocto transfer-call with fixed Ref, Circle, pool, input and slippage floor', async () => {
  const s = snapshot({ owner_wrap_registration: 'REGISTERED_AT_VIEW', owner_wrap_balance_yocto: input });
  const e = await signOwnerAcquisition({ plan, snapshot: s, kind: 'swap', keyPair: key, nowMs: NOW });
  const signed = verifySignedOwnerAcquisition(e, plan), action = signed.transaction.actions[0].functionCall;
  assert.equal(signed.transaction.actions.length, 1); assert.equal(action.methodName, 'ft_transfer_call'); assert.equal(action.deposit, 1n);
  const args = JSON.parse(Buffer.from(action.args).toString());
  assert.equal(args.receiver_id, REF); assert.equal(args.amount, input);
  assert.deepEqual(JSON.parse(args.msg), { force: 0, actions: [{ pool_id: 1845, token_in: WRAP,
    token_out: CIRCLE, amount_in: input, min_amount_out: '6175' }] });
});

test('wrong network, stale views, unregistered/mismatched tokens, unsafe amounts or nonzero prior Circle balance fail before signing', async () => {
  const cases = [snapshot({ chain: 'mainnet' }), snapshot({ circle_registration: 'NOT_REGISTERED_AT_VIEW' }),
    snapshot({ circle_decimals: 18 }), snapshot({ wrap_symbol: 'bad' }), snapshot({ ref_exchange: 'attacker.testnet' }),
    snapshot({ selected: null }), snapshot({ owner_key_nonce: '9007199254740992' }),
    snapshot({ selected: { pool_id: 12, quote_atoms: '6500', min_output_atoms: '6175' } }),
    snapshot({ selected: { pool_id: 1845, quote_atoms: '200000', min_output_atoms: '190000' } }),
    snapshot({ selected: { pool_id: 1845, quote_atoms: '6500', min_output_atoms: '1' } }),
    snapshot({ wrap_storage_min_yocto: '10000000000000000000001' }), snapshot({ owner_wrap_balance_yocto: '1' })];
  for (const s of cases) assert.throws(() => validateAcquisitionSnapshot(s, plan, 'wrap', NOW));
  assert.throws(() => validateAcquisitionSnapshot(snapshot(), plan, 'wrap', NOW + 120_001), /FINAL block is stale/);
  assert.throws(() => validateAcquisitionSnapshot(snapshot({ owner_wrap_registration: 'REGISTERED_AT_VIEW', owner_wrap_balance_yocto: input,
    circle_balance_atoms: '1' }), plan, 'swap', NOW));
  await assert.rejects(signOwnerAcquisition({ plan, snapshot: snapshot(), kind: 'wrap', keyPair: nearApi.KeyPair.fromRandom('ed25519'), nowMs: NOW }), /does not match/);
});

test('independent verification rejects changed or malicious bearer bytes and action terms', async () => {
  const e = await signOwnerAcquisition({ plan, snapshot: snapshot(), kind: 'wrap', keyPair: key, nowMs: NOW });
  for (const change of [{ receiver: 'attacker.testnet' }, { input_yocto: '1' }, { wrap_storage_min_yocto: '1' },
    { nonce: '102' }, { pool_id: 12 }, { expected_wrap_registration: 'REGISTERED_AT_VIEW' },
    { block_hash: mockHash('other') }, { tx_hash: mockHash('other-tx') }, { signed_tx_base64: 'bad!' }]) {
    assert.throws(() => verifySignedOwnerAcquisition({ ...e, ...change }, plan));
  }
  const bytes = Buffer.from(e.signed_tx_base64, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => verifySignedOwnerAcquisition({ ...e, signed_tx_base64: bytes.toString('base64') }, plan));
});
