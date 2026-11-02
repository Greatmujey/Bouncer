/**
 * Experimental generated WASM on a deliberately incomplete synthetic host.
 * No nearcore, Circle token, escrow, network, signed transaction or delivery.
 * The forwarder is not audited or ready for live deployment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { readExactArtifact, SyntheticNearHost, OWNER, VAULT, AGENT_PK, AGENT_BYTES, TIME_NS } from './fixtures/v11-synthetic-host.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { PAYPERCALL_TESTNET_ESCROW as ESCROW } from '../agent/paypercall-inspect.mjs';

const ADAPTER = 'forward.owner.testnet', NOW = Number(TIME_NS / 1_000_000n), MAX = ((1n << 128n) - 1n).toString();
const FORWARDER_BYTES = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 9)]);
const FORWARDER_PK = `ed25519:${nearApi.utils.serialize.base_encode(FORWARDER_BYTES.subarray(1))}`;
const terms = overrides => ({ owner: OWNER, vault: VAULT, adapter: ADAPTER, forwarder_agent_public_key: FORWARDER_PK,
  vault_agent_public_key: AGENT_PK, policy_id: 'forward', intent_id: 'forward-1',
  amount: '100', service_id: 7, request: 'wrap.testnet', expires_at_ms: NOW + 60_000,
  native_return_cap: '1000000000000000000000000', native_reserve: '1000000000000000000000000', ...overrides });
const build = overrides => buildExperimentalForwarder(terms(overrides), { nowMs: NOW });
const agent = overrides => ({ current: ADAPTER, predecessor: OWNER, signer: OWNER, signerPk: FORWARDER_BYTES,
  deposit: 0n, timestamp: TIME_NS, balance: 10n ** 26n, ...overrides });
const owner = overrides => agent({ deposit: 1n, signerPk: Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 8)]), ...overrides });
function host(wasm) {
  const h = new SyntheticNearHost(wasm);
  h.env.promise_batch_action_transfer = (index, ptr) => {
    const p = h.promises[Number(index)], bytes = h.read(ptr, 16);
    assert.ok(p); const amount = bytes.readBigUInt64LE(0) + (bytes.readBigUInt64LE(8) << 64n);
    p.actions.push({ method: '$native_transfer', amount: amount.toString() });
  };
  return h;
}

test('deterministic experimental WASM pins terms, exposes no deploy or arbitrary-call capability', async () => {
  const a = await build(), b = await build();
  assert.deepEqual(a.wasm, b.wasm); assert.equal(a.wasm_sha256, b.wasm_sha256);
  assert.equal(a.review.token, TOKEN); assert.equal(a.review.escrow, ESCROW);
  assert.equal(a.review.signed, false); assert.equal(a.review.sent, false);
  assert.equal(a.imports.some(x => /deploy|delete|add_key|delegate|create_account/i.test(x)), false);
  const h = host(a.wasm);
  assert.deepEqual(h.call('configuration', {}, agent()).value, a.review);
  assert.equal(h.call('opened', {}, agent()).value, false);
  const changed = await build({ amount: '101' });
  assert.notEqual(changed.wasm_sha256, a.wasm_sha256);
  assert.notEqual(changed.review.review_sha256, a.review.review_sha256);
});

test('strict bounded terms reject account, key, token injection, price, expiry and request errors', async () => {
  for (const bad of [
    { owner: 'owner.near' }, { vault: 'other.testnet' }, { adapter: VAULT }, { adapter: 'x.y.owner.testnet' },
    { token: 'attacker.testnet' }, { forwarder_agent_public_key: 'ed25519:bad' },
    { forwarder_agent_public_key: AGENT_PK }, { vault_agent_public_key: 'ed25519:bad' },
    { policy_id: 'bad policy' }, { intent_id: 'bad/intent' }, { amount: '0' }, { amount: '01' },
    { amount: (1n << 128n).toString() }, { native_reserve: '0' }, { native_reserve: '999999999999999999999999' }, { native_return_cap: '-1' },
    { expires_at_ms: NOW }, { expires_at_ms: NOW + 73 * 3600 * 1000 + 1 }, { service_id: 2 ** 32 },
    { request: '' }, { request: 'x'.repeat(257) }, { request: '\ud800' }, { escrow: 'attacker.testnet' },
  ]) await assert.rejects(build(bad));
  let getterCalls = 0;
  const malicious = terms();
  Object.defineProperty(malicious, 'amount', { enumerable: true, get() { getterCalls++; return '100'; } });
  await assert.rejects(buildExperimentalForwarder(malicious, { nowMs: NOW }));
  assert.equal(getterCalls, 0, 'builder must not evaluate accessors while checking public terms');
  const escaped = await build({ request: 'x"},"receiver_id":"attacker.testnet' });
  const sent = host(escaped.wasm).call('open', {}, agent()).promises[0].actions[0].args;
  assert.equal(sent.receiver_id, ESCROW);
  assert.equal(JSON.parse(sent.msg).request, 'x"},"receiver_id":"attacker.testnet');
});

test('one-shot open requires the fixed owner, exact agent key, zero deposit, correct account and live expiry', async () => {
  const artifact = await build();
  for (const bad of [{ predecessor: 'attacker.testnet' }, { signer: 'attacker.testnet' },
    { current: 'other.owner.testnet' }, { signerPk: Buffer.alloc(33) }, { signerPk: AGENT_BYTES }, { deposit: 1n },
    { timestamp: BigInt(NOW + 60_001) * 1_000_000n }]) {
    const h = host(artifact.wasm);
    assert.throws(() => h.call('open', {}, agent(bad)), /FORWARDER BLOCKED/);
    assert.equal(h.call('opened', {}, agent()).value, false); assert.equal(h.promises.length, 0);
  }
  const h = host(artifact.wasm), call = h.call('open', { payee: 'attacker.testnet', amount: '999' }, agent());
  assert.equal(call.promises.length, 1); assert.equal(call.returnedPromise, 0);
  assert.equal(call.promises[0].receiver, TOKEN); assert.equal(call.promises[0].actions[0].method, 'ft_transfer_call');
  assert.equal(call.promises[0].actions[0].deposit, '1');
  assert.deepEqual(call.promises[0].actions[0].args, { receiver_id: ESCROW, amount: '100',
    memo: 'bouncer:experimental-forwarder', msg: JSON.stringify({ service_id: 7, request: 'wrap.testnet', referrer: null, max_price: '100' }) });
  assert.equal(h.call('opened', {}, agent()).value, true);
  assert.throws(() => h.call('open', {}, agent()), /FORWARDER BLOCKED/);
  assert.equal(h.call('opened', {}, agent()).value, true);
});

test('a dispatched open remains consumed without a downstream callback; only a fixed recovery can be issued', async () => {
  const h = host((await build()).wasm);
  const dispatched = h.call('open', {}, agent());
  assert.equal(dispatched.promises.length, 1);
  // Synthetic fault: do not execute the token/escrow promise or provide any
  // callback. This shows the marker's behavior, NOT that tokens were refunded.
  assert.equal(h.call('opened', {}, agent()).value, true);
  assert.throws(() => h.call('open', {}, agent()), /FORWARDER BLOCKED/);
  const recovery = h.call('return_tokens', { amount: '100' }, owner()).promises[0];
  assert.equal(recovery.receiver, TOKEN);
  assert.deepEqual(recovery.actions[0].args, { receiver_id: VAULT, amount: '100',
    memo: 'bouncer:forwarder-return', msg: 'bouncer:forwarder-return' });
});

test('token return is bounded and cannot redirect, alter token or escalate the policy', async () => {
  const artifact = await build(), h = host(artifact.wasm);
  for (const bad of ['0', '01', '-1', '101', '1e2', '1","receiver_id":"attacker.testnet', '', '9'.repeat(40)]) {
    assert.throws(() => h.call('return_tokens', { amount: bad }, agent()), /FORWARDER BLOCKED/);
    assert.equal(h.promises.length, 0);
  }
  assert.throws(() => h.call('return_tokens', { amount: '10', receiver_id: 'attacker.testnet' }, agent()), /FORWARDER BLOCKED/);
  for (const bad of [{ predecessor: 'attacker.testnet' }, { signerPk: Buffer.alloc(33) }, { deposit: 2n }]) {
    assert.throws(() => h.call('return_tokens', { amount: '10' }, agent(bad)), /FORWARDER BLOCKED/);
  }
  for (const context of [agent(), owner()]) {
    const result = h.call('return_tokens', { amount: '99' }, context), promise = result.promises[0];
    assert.equal(promise.receiver, TOKEN); assert.equal(promise.actions[0].method, 'ft_transfer_call');
    assert.equal(promise.actions[0].deposit, '1');
    assert.deepEqual(promise.actions[0].args, { receiver_id: VAULT, amount: '99',
      memo: 'bouncer:forwarder-return', msg: 'bouncer:forwarder-return' });
  }
  assert.equal(h.call('opened', {}, agent()).value, false, 'return does not fake an open');
});

test('claim and storage withdrawal target only the fixed escrow, with owner-only 1-yocto storage guard', async () => {
  const h = host((await build()).wasm);
  const claimed = h.call('claim', {}, agent()).promises[0];
  assert.equal(claimed.receiver, ESCROW); assert.equal(claimed.actions[0].method, 'claim');
  assert.deepEqual(claimed.actions[0].args, { token: TOKEN }); assert.equal(claimed.actions[0].deposit, '0');
  assert.throws(() => h.call('withdraw_storage', {}, agent()), /FORWARDER BLOCKED/);
  assert.throws(() => h.call('withdraw_storage', {}, owner({ deposit: 2n })), /FORWARDER BLOCKED/);
  const withdrawn = h.call('withdraw_storage', {}, owner()).promises[0];
  assert.equal(withdrawn.receiver, ESCROW); assert.equal(withdrawn.actions[0].method, 'storage_withdraw');
  assert.deepEqual(withdrawn.actions[0].args, {}); assert.equal(withdrawn.actions[0].deposit, '0');
});

test('owner-only native return checks u128 conversion, reserve and a fixed owner recipient', async () => {
  const reserve = 10n ** 24n, artifact = await build({ native_return_cap: MAX, native_reserve: reserve.toString() }), h = host(artifact.wasm);
  for (const n of [1n, 123456n, (1n << 32n) + 42n, (1n << 64n) - 1n, 1n << 64n, (1n << 96n) + 12345n,
    (1n << 128n) - 1n - reserve]) {
    const r = h.call('return_native', { amount: n.toString() }, owner({ balance: (1n << 128n) - 1n }));
    assert.equal(r.promises[0].receiver, OWNER); assert.equal(r.promises[0].actions[0].method, '$native_transfer');
    assert.equal(r.promises[0].actions[0].amount, n.toString());
  }
  assert.throws(() => h.call('return_native', { amount: MAX }, owner({ balance: (1n << 128n) - 1n })), /FORWARDER BLOCKED/);
  assert.throws(() => h.call('return_native', { amount: '1' }, owner({ balance: reserve })), /FORWARDER BLOCKED/);
  assert.throws(() => h.call('return_native', { amount: '1' }, agent()), /FORWARDER BLOCKED/);
  assert.throws(() => h.call('return_native', { amount: '1' }, owner({ predecessor: 'attacker.testnet' })), /FORWARDER BLOCKED/);
});
test('decimal native returns agree with BigInt across deterministic u128 vectors', async () => {
  const reserve = 10n ** 24n, max = (1n << 128n) - 1n, available = max - reserve;
  const h = host((await build({ native_return_cap: MAX, native_reserve: reserve.toString() })).wasm);
  for (let i = 0; i < 120; i++) {
    const digest = crypto.createHash('sha256').update(`synthetic-decimal-${i}`).digest('hex');
    const amount = BigInt(`0x${digest}`) % available + 1n;
    const call = h.call('return_native', { amount: amount.toString() }, owner({ balance: max }));
    assert.equal(call.promises[0].actions[0].amount, amount.toString());
  }
  assert.throws(() => h.call('return_native', { amount: (available + 1n).toString() }, owner({ balance: max })), /FORWARDER BLOCKED/);
});

const v11Path = process.env.BOUNCER_V11_WASM_PATH;
test('V11 and generated forwarder bytecode compose under a synthetic partial and late refund model',
  { skip: v11Path ? false : 'set BOUNCER_V11_WASM_PATH to the hash-pinned V11 artifact' }, async () => {
  const artifact = await build(), forwarder = host(artifact.wasm), vault = new SyntheticNearHost(readExactArtifact(v11Path));
  const ownerCall = { predecessor: OWNER, deposit: 1n }, agentCall = { predecessor: OWNER, signerPk: AGENT_BYTES };
  vault.call('new', { owner: OWNER });
  vault.call('set_policy', { policy_id: 'forward', token: TOKEN, per_tx_cap: '100', daily_cap: '200' }, ownerCall);
  vault.call('allow_payee', { policy_id: 'forward', payee: ADAPTER }, ownerCall);
  vault.call('grant_agent_key', { policy_id: 'forward', public_key: AGENT_PK }, ownerCall);
  vault.call('lock_ft_policy_to_intents', { policy_id: 'forward' }, ownerCall);
  // Model the trusted FT's transfer-call deposit separately from its ledger.
  const balances = new Map([[VAULT, 100n], [ADAPTER, 0n], [ESCROW, 0n]]);
  vault.call('ft_on_transfer', { sender_id: OWNER, amount: '100', msg: '' }, { predecessor: TOKEN });
  vault.call('set_exact_ft_intent', { intent_id: 'forward-1', policy_id: 'forward', expected_token: TOKEN,
    payee: ADAPTER, amount: '100', memo: artifact.review.intent_memo, review_hash: artifact.review.review_sha256,
    expires_at_ms: String(NOW + 60_000), agent_public_key: AGENT_PK }, ownerCall);

  assert.throws(() => vault.call('execute_exact_ft', { intent_id: 'forward-1' },
    { ...agentCall, signerPk: FORWARDER_BYTES }), /wrong exact FT agent key/);
  const transfer = vault.call('execute_exact_ft', { intent_id: 'forward-1' }, agentCall);
  assert.equal(transfer.promises[0].receiver, TOKEN);
  assert.deepEqual(transfer.promises[0].actions[0].args, { receiver_id: ADAPTER, amount: '100', memo: artifact.review.intent_memo });
  balances.set(VAULT, 0n); balances.set(ADAPTER, 100n);
  vault.call('after_exact_ft_transfer', transfer.promises[1].actions[0].args,
    { predecessor: VAULT, promiseResult: 'success' });
  assert.equal(vault.call('vault_balance', { token: TOKEN }).value, '0');
  assert.equal(vault.call('daily_spent', { policy_id: 'forward' }).value, '100');

  const open = forwarder.call('open', {}, agent());
  const action = open.promises[0].actions[0];
  assert.equal(open.promises[0].receiver, TOKEN); assert.equal(action.method, 'ft_transfer_call');
  assert.equal(action.args.receiver_id, ESCROW); assert.equal(action.args.amount, '100');
  assert.deepEqual(JSON.parse(action.args.msg), { service_id: 7, request: 'wrap.testnet', referrer: null, max_price: '100' });
  // Pure model: price 60 is accepted by an imaginary escrow; an FT resolver
  // immediately returns unused 40 to the forwarder, not to the V11 vault.
  balances.set(ADAPTER, 40n); balances.set(ESCROW, 60n);
  function modelReturn(amount) {
    const returned = forwarder.call('return_tokens', { amount: String(amount) }, agent());
    const p = returned.promises[0], a = p.actions[0];
    assert.equal(p.receiver, TOKEN); assert.equal(a.method, 'ft_transfer_call');
    assert.equal(a.args.receiver_id, VAULT); assert.equal(a.args.amount, String(amount));
    assert.ok(balances.get(ADAPTER) >= BigInt(amount));
    balances.set(ADAPTER, balances.get(ADAPTER) - BigInt(amount));
    balances.set(VAULT, balances.get(VAULT) + BigInt(amount));
    assert.equal(vault.call('ft_on_transfer', { sender_id: ADAPTER, amount: String(amount), msg: a.args.msg },
      { predecessor: TOKEN }).value, '0');
  }
  modelReturn(40);
  assert.equal(vault.call('vault_balance', { token: TOKEN }).value, '40');
  // Pure model of a later plain-FT rejection refund: no V11 hook has fired.
  balances.set(ESCROW, 0n); balances.set(ADAPTER, 60n);
  assert.equal(vault.call('vault_balance', { token: TOKEN }).value, '40');
  modelReturn(60);
  assert.equal(balances.get(VAULT), 100n); assert.equal(balances.get(ADAPTER), 0n);
  assert.equal(vault.call('vault_balance', { token: TOKEN }).value, '100');
  assert.equal(vault.call('daily_spent', { policy_id: 'forward' }).value, '100', 'prior spend stays conservative');
  assert.throws(() => vault.call('execute_exact_ft', { intent_id: 'forward-1' }, agentCall), /consumed, cancelled, expired or stale/);
  assert.throws(() => forwarder.call('open', {}, agent()), /FORWARDER BLOCKED/);
});
