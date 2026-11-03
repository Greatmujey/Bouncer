/**
 * Actual, hash-pinned V11 WASM in a deliberately incomplete synthetic host.
 * No token contract, PayPerCall contract, chain, real receipt scheduling,
 * access-key admission or network is simulated. This is not live compatibility
 * or delivery evidence; it exposes the current vault boundary before any spend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayPerCallMessage } from '../agent/paypercall-inspect.mjs';
import { OWNER, VAULT, TOKEN, AGENT_PK, AGENT_BYTES, readExactArtifact,
  SyntheticNearHost } from './fixtures/v11-synthetic-host.mjs';

const file = process.env.BOUNCER_V11_WASM_PATH;
const skip = file ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned recovered artifact';
const ESCROW = 'devx-paypercall.testnet', POLICY = 'paypercall';
const owner = { predecessor: OWNER, deposit: 1n }, agent = { predecessor: OWNER, signerPk: AGENT_BYTES };
const msg = buildPayPerCallMessage({ service_id: 7, request: 'wrap.testnet', max_price: '100' }).msg;
const args = { policy_id: POLICY, payee: ESCROW, amount: '100', expected_token: TOKEN,
  expected_msg: msg, expected_policy_revision: 1, expected_route_revision: 1 };
function setup({ locked = false } = {}) {
  const h = new SyntheticNearHost(readExactArtifact(file));
  h.call('new', { owner: OWNER });
  h.call('set_policy', { policy_id: POLICY, token: TOKEN, per_tx_cap: '100', daily_cap: '200' }, owner);
  h.call('allow_payee', { policy_id: POLICY, payee: ESCROW }, owner);
  h.call('grant_agent_key', { policy_id: POLICY, public_key: AGENT_PK }, owner);
  h.call('set_ft_call_message', { policy_id: POLICY, payee: ESCROW, msg }, owner);
  h.call('ft_on_transfer', { sender_id: OWNER, amount: '1000', msg: '' }, { predecessor: TOKEN });
  if (locked) h.call('lock_ft_policy_to_intents', { policy_id: POLICY }, owner);
  return h;
}
const balance = h => h.call('vault_balance', { token: TOKEN }).value;
const spent = h => h.call('daily_spent', { policy_id: POLICY }).value;

test('actual V11 artifact blocks a PayPerCall FT call under an exact-intent-locked policy', { skip }, () => {
  const h = setup({ locked: true });
  assert.equal(h.call('is_exact_ft_policy_locked', { policy_id: POLICY }).value, true);
  assert.throws(() => h.call('execute_ft_call', args, agent), /policy requires exact FT intents/);
  assert.equal(balance(h), '1000'); assert.equal(spent(h), '0');
});

test('unlocked V11 route pins message and immediate NEP-141 refund but is not one-shot', { skip }, () => {
  const h = setup();
  assert.throws(() => h.call('set_ft_call_message', { policy_id: POLICY, payee: ESCROW, msg: 'changed' }, agent),
    /owner-only method requires exactly 1 yoctoNEAR/);
  assert.throws(() => h.call('execute_ft_call', { ...args, expected_msg: 'changed' }, agent), /route changed since review/);
  const first = h.call('execute_ft_call', args, agent);
  assert.equal(balance(h), '900'); assert.equal(spent(h), '100');
  assert.equal(first.promises.length, 2);
  assert.equal(first.promises[0].receiver, TOKEN); assert.equal(first.promises[0].actions[0].method, 'ft_transfer_call');
  assert.deepEqual(first.promises[0].actions[0].args, { receiver_id: ESCROW, amount: '100',
    memo: 'bouncer:guarded-ft-call', msg });
  assert.equal(first.promises[0].actions[0].deposit, '1');
  const callback = first.promises[1].actions[0];
  assert.equal(callback.method, 'after_execute_ft_call');
  // Mock NEP-141 result says 60 was used, so 40 was immediately unused.
  const resolved = h.call(callback.method, callback.args, { predecessor: VAULT, promiseResult: 'success',
    promiseValue: Buffer.from(JSON.stringify('60')) });
  assert.equal(resolved.value, '60'); assert.equal(balance(h), '940'); assert.equal(spent(h), '60');
  // The generic route can repeat, up to its on-chain rolling budget. It is not
  // the consume-once exact intent, even if client software has a journal.
  h.call('execute_ft_call', args, agent);
  assert.equal(balance(h), '840'); assert.equal(spent(h), '160');
  assert.throws(() => h.call('execute_ft_call', args, agent), /daily cap exceeded/);
});

test('V11 credits a receiver callback, while a later plain FT transfer supplies no such callback', { skip }, () => {
  const h = setup(), tx = h.call('execute_ft_call', args, agent), callback = tx.promises[1].actions[0];
  h.call(callback.method, callback.args, { predecessor: VAULT, promiseResult: 'success',
    promiseValue: Buffer.from(JSON.stringify('100')) });
  assert.equal(balance(h), '900'); assert.equal(spent(h), '100');
  // A plain NEP-141 ft_transfer updates the token's own balance without
  // calling the receiving contract. This host does not emulate that token;
  // the unchanged internal value is not a claim a live refund occurred.
  assert.equal(balance(h), '900');
  assert.throws(() => h.call('withdraw', { token: TOKEN, amount: '1000' }, owner), /insufficient vault balance/);
  // Simulate a separate ft_transfer_call receiver callback from the token.
  h.call('ft_on_transfer', { sender_id: ESCROW, amount: '100', msg: 'refund' }, { predecessor: TOKEN });
  assert.equal(balance(h), '1000');
  assert.equal(spent(h), '100', 'later incoming tokens do not release the conservative budget');
});

test('ambiguous FT-call callbacks and external callback forgery never recredit the reservation', { skip }, () => {
  for (const mock of [{ promiseResult: 'failed' }, { promiseResult: 'success', promiseValue: Buffer.from('not-json') },
    { promiseResult: 'success', promiseValue: Buffer.from(JSON.stringify('101')) }]) {
    const h = setup(), sent = h.call('execute_ft_call', args, agent), callback = sent.promises[1].actions[0];
    assert.throws(() => h.call(callback.method, callback.args, { predecessor: 'attacker.testnet', ...mock }), /private|unreachable/i);
    assert.equal(balance(h), '900'); assert.equal(spent(h), '100');
    assert.equal(h.call(callback.method, callback.args, { predecessor: VAULT, ...mock }).value, null);
    assert.equal(balance(h), '900'); assert.equal(spent(h), '100');
  }
});
