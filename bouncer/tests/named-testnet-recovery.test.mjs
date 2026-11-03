import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { recoverNamedTestnetOnce, validateNamedRecoveryPlan } from '../agent/named-testnet-recovery.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const time = Date.parse('2026-11-02T22:00:00.000Z');
const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 9));
const code = 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z';
const key = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const plan = { version: 1, purpose: 'user-requested-uncreated-testnet-account-recovery', network: 'testnet',
  account_id: 'greatmujey.testnet', public_key: key, circle_token: TOKEN, circle_code_hash: code, observed_circle_atoms: '40000000' };
function fixture() {
  const s = { chain: 'testnet', present: false, balance: '40000000', code, registration: { total: '1250000000000000000000', available: '0' },
    pub: key, helperCalls: 0, fenceCalls: 0, fenceOk: true, lostResponse: false, create: true, beforePost: null };
  const provider = {
    async viewNodeStatus() { return { chain_id: s.chain }; },
    async viewBlock() { return { header: { hash, timestamp_nanosec: String(BigInt(time) * 1_000_000n) } }; },
    async viewTestnetAccountPresenceAt(account, block) {
      assert.equal(account, plan.account_id); assert.equal(block, hash);
      return { block_hash: hash, exists: s.present, account: s.present ? { block_hash: hash,
        code_hash: '11111111111111111111111111111111', amount: '10000000000000000000000000', locked: '0' } : undefined };
    },
    async query(q) {
      assert.equal(q.block_id, hash);
      if (q.account_id === TOKEN) return { block_hash: hash, code_hash: s.code };
      assert.equal(q.account_id, plan.account_id); assert.equal(q.request_type, 'view_access_key_list');
      return { block_hash: hash, keys: [{ public_key: s.pub, access_key: { permission: 'FullAccess' } }] };
    },
    async callFunctionRaw(contract, method, args, options) {
      assert.equal(contract, TOKEN); assert.deepEqual(args, { account_id: plan.account_id }); assert.equal(options.blockId, hash);
      return { block_hash: hash, result: [...Buffer.from(JSON.stringify(method === 'ft_balance_of' ? s.balance : s.registration))] };
    },
  };
  const persistAttempt = async fence => {
    s.fenceCalls++; assert.equal(fence.public_key, key); assert.equal(fence.account_id, plan.account_id);
    assert.equal(fence.before_block_hash, hash); if (s.beforePost) s.beforePost(); return s.fenceOk;
  };
  const fetchImpl = async (url, options) => {
    s.helperCalls++; assert.equal(s.fenceCalls, 1); assert.equal(url, 'https://helper.testnet.near.org/account');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { newAccountId: plan.account_id, newAccountPublicKey: key });
    if (s.create) s.present = true;
    if (s.lostResponse) throw new Error('response lost');
    return new Response('{}');
  };
  return { s, args: { plan, provider, persistAttempt, fetchImpl, now: () => time, pause: async () => {}, maxViews: 3 } };
}

test('one durable fence precedes one helper request, then only exact FINAL public state counts as recovery', async () => {
  const f = fixture(), result = await recoverNamedTestnetOnce(f.args);
  assert.equal(f.s.fenceCalls, 1); assert.equal(f.s.helperCalls, 1);
  assert.equal(result.status, 'NAMED_TESTNET_ACCOUNT_OBSERVED_AT_FINAL');
  assert.equal(result.helper_acknowledgement, 'ACKNOWLEDGED'); assert.equal(result.circle_balance_atoms, '40000000');
  assert.equal(result.full_access_public_key, key); assert.equal(result.off_device_backup_verified, false);
  assert.equal(result.private_key_sent_to_runner, false); assert.equal(result.signed, false); assert.equal(result.sent, false);
  assert.equal(result.do_not_repeat_helper_request, true);
});

test('a lost helper response is reconciled by views and the helper is never repeated', async () => {
  const f = fixture(); f.s.lostResponse = true;
  const result = await recoverNamedTestnetOnce(f.args);
  assert.equal(result.helper_acknowledgement, 'UNKNOWN'); assert.equal(f.s.helperCalls, 1);
  const g = fixture(); g.s.create = false; g.s.lostResponse = true;
  await assert.rejects(recoverNamedTestnetOnce(g.args), /unresolved.*never retry/);
  assert.equal(g.s.helperCalls, 1);
});

test('wrong network, existing name, changed token, missing registration or missing fence stop before helper', async () => {
  for (const mutate of [s => { s.chain = 'mainnet'; }, s => { s.present = true; }, s => { s.balance = '0'; },
    s => { s.code = hash; }, s => { s.registration = null; }, s => { s.fenceOk = false; },
    s => { s.beforePost = () => { s.present = true; }; }, s => { s.beforePost = () => { s.balance = '39999999'; }; }]) {
    const f = fixture(); mutate(f.s); await assert.rejects(recoverNamedTestnetOnce(f.args)); assert.equal(f.s.helperCalls, 0);
  }
});

test('a name created under another key is not reported as recovered or retried', async () => {
  const f = fixture(); f.s.pub = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  await assert.rejects(recoverNamedTestnetOnce(f.args), /public key differs/);
  assert.equal(f.s.helperCalls, 1);
});

test('only the fixed testnet name, Circle identity, amount and canonical public key are accepted', () => {
  assert.deepEqual(validateNamedRecoveryPlan(plan), plan);
  for (const change of [{ account_id: 'greatmujey.near' }, { network: 'mainnet' }, { circle_token: 'other.testnet' },
    { circle_code_hash: hash }, { observed_circle_atoms: '1' }, { public_key: 'ed25519:invalid' }, { extra: 'bad' }]) {
    assert.throws(() => validateNamedRecoveryPlan({ ...plan, ...change }));
  }
});
