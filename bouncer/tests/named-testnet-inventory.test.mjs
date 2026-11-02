import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectNamedTestnetAccount } from '../agent/named-testnet-inventory.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';

const nowMs = Date.parse('2026-11-02T22:00:00.000Z');
const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 9));
const other = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 8));
const target = 'greatmujey.testnet';
function fixture() {
  const state = { chain: 'testnet', present: false, unknown: false, mixed: false, balance: '40000000',
    registration: { total: '1250000000000000000000', available: '0' }, tokenCode: hash, time: nowMs };
  const provider = {
    async viewNodeStatus() { return { chain_id: state.chain }; },
    async viewBlock() { return { header: { hash, timestamp_nanosec: String(BigInt(state.time) * 1_000_000n) } }; },
    async viewTestnetAccountPresenceAt(account, block) {
      assert.equal(account, target); assert.equal(block, hash);
      if (state.unknown) throw new Error('synthetic RPC error');
      return { exists: state.present, block_hash: state.mixed ? other : hash,
        account: state.present ? { block_hash: hash, amount: '100', locked: '0', code_hash: hash } : undefined };
    },
    async query(q) {
      assert.equal(q.block_id, hash);
      if (q.account_id === TOKEN) return { block_hash: state.mixed ? other : hash, code_hash: state.tokenCode };
      assert.equal(q.account_id, target); assert.equal(q.request_type, 'view_access_key_list');
      return { block_hash: state.mixed ? other : hash, keys: [{ access_key: { permission: 'FullAccess' } }] };
    },
    async callFunctionRaw(contract, method, args, options) {
      assert.equal(contract, TOKEN); assert.equal(args.account_id, target); assert.equal(options.blockId, hash);
      const data = method === 'ft_balance_of' ? state.balance : state.registration;
      return { block_hash: state.mixed ? other : hash, result: [...Buffer.from(JSON.stringify(data))] };
    },
  };
  return { state, provider, args: { provider, accountId: target, now: () => nowMs } };
}

test('an absent named account can have registered Circle tokens; no key custody or action is claimed', async () => {
  const f = fixture(), result = await inspectNamedTestnetAccount(f.args);
  assert.equal(result.account_status, 'ABSENT_AT_FINAL'); assert.equal(result.native, null); assert.equal(result.access_keys, null);
  assert.equal(result.circle_balance_atoms, '40000000'); assert.equal(result.circle_registration, 'REGISTERED_AT_VIEW');
  assert.equal(result.circle_code_hash, hash); assert.equal(result.private_key_custody, 'NOT_CHECKED');
  assert.equal(result.signed, false); assert.equal(result.sent, false);
});

test('a present account reports native balance and only summarizes same-block public keys', async () => {
  const f = fixture(); f.state.present = true;
  const result = await inspectNamedTestnetAccount(f.args);
  assert.equal(result.account_status, 'PRESENT_AT_FINAL'); assert.equal(result.native.balance_yocto, '100');
  assert.deepEqual(result.access_keys, { count: 1, full_access_count: 1 });
});

test('unavailable and mixed-block reads remain unknown rather than false absence or balance', async () => {
  for (const field of ['unknown', 'mixed']) {
    const f = fixture(); f.state[field] = true;
    const result = await inspectNamedTestnetAccount(f.args);
    assert.equal(result.account_status, 'UNKNOWN'); assert.equal(result.native, null); assert.equal(result.access_keys, null);
    if (field === 'mixed') {
      assert.equal(result.circle_balance_atoms, null); assert.equal(result.circle_registration, 'UNKNOWN');
      assert.equal(result.circle_code_hash, null);
    }
  }
  const f = fixture(); f.state.balance = '-1'; f.state.registration = { total: '0', available: '0' };
  const result = await inspectNamedTestnetAccount(f.args);
  assert.equal(result.circle_balance_atoms, null); assert.equal(result.circle_registration, 'UNKNOWN');
});

test('non-testnet, invalid account and stale FINAL blocks fail before a balance result', async () => {
  const f = fixture();
  await assert.rejects(inspectNamedTestnetAccount({ ...f.args, accountId: 'greatmujey.near' }));
  f.state.chain = 'mainnet'; await assert.rejects(inspectNamedTestnetAccount(f.args), /testnet/);
  f.state.chain = 'testnet'; f.state.time = nowMs - 121_000; await assert.rejects(inspectNamedTestnetAccount(f.args), /stale/);
});
