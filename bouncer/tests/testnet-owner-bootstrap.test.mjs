import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan, requestTestnetOwnerOnce, OWNER_HELPER_URL } from '../agent/testnet-owner-bootstrap.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = Date.parse('2026-11-02T16:00:00Z'), BLOCK = mockHash('fresh-owner-bootstrap');
const publicKey = String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const plan = () => ({ version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: publicKey });
function make({ chain = 'testnet', stale = false, initiallyExists = false, neverAppears = false,
  wrongKey = false, extraKeys = false, badProfile = false, unknownView = false } = {}) {
  let views = 0;
  return { async viewNodeStatus() { return { chain_id: chain }; },
    async viewBlock(ref) { assert.deepEqual(ref, { finality: 'final' });
      return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW - (stale ? 120_001 : 0)) * 1_000_000n).toString() } }; },
    async viewTestnetAccountPresenceAt(accountId, block) {
      assert.equal(accountId, plan().account_id); assert.equal(block, BLOCK);
      if (unknownView) throw new Error('RPC unavailable');
      const exists = initiallyExists || (++views > 1 && !neverAppears);
      return { block_hash: BLOCK, exists, ...(exists ? { account: { block_hash: BLOCK,
        code_hash: badProfile ? mockHash('contract-code') : '11111111111111111111111111111111',
        amount: '10000000000000000000000000', locked: '0' } } : {}) };
    },
    async query(args) { assert.deepEqual(args, { request_type: 'view_access_key_list', account_id: plan().account_id, block_id: BLOCK });
      const item = { public_key: wrongKey ? 'ed25519:wrong' : publicKey, access_key: { permission: 'FullAccess' } };
      return { block_hash: BLOCK, keys: extraKeys ? [item, item] : [item] }; },
  };
}
function deps(options = {}) {
  let requests = 0, fences = 0;
  const provider = make(options);
  return { provider, get requests() { return requests; }, get fences() { return fences; },
    args: { plan: plan(), provider, now: () => NOW, maxViews: 2, pause: async () => {},
      persistAttempt: async record => { fences++; assert.equal(record.before_block_hash, BLOCK); assert.equal(requests, 0); return options.fence !== false; },
      fetchImpl: async (url, init) => {
        requests++; assert.equal(fences, 1); assert.equal(url, OWNER_HELPER_URL); assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
        assert.deepEqual(JSON.parse(init.body), { newAccountId: plan().account_id, newAccountPublicKey: publicKey });
        if (options.lostAck) throw new Error('simulated lost acknowledgement');
        return { ok: true, body: { cancel: async () => {} } };
      } } };
}

test('bootstrap plan is public, bounded and only for a unique new testnet owner', () => {
  assert.deepEqual(validateOwnerBootstrapPlan(plan()), plan());
  for (const change of [{ network: 'mainnet' }, { account_id: 'alice.testnet' }, { account_id: 'bouncer-owner-xyz.testnet' },
    { public_key: 'ed25519:bad' }, { secret_key: 'must never be included' }, { version: 2 }]) {
    assert.throws(() => validateOwnerBootstrapPlan({ ...plan(), ...change }), /invalid public testnet-owner/);
  }
});

test('one helper request occurs only after a durable fence and is verified through fresh public state', async () => {
  const d = deps(), result = await requestTestnetOwnerOnce(d.args);
  assert.equal(d.fences, 1); assert.equal(d.requests, 1); assert.equal(result.status, 'OWNER_OBSERVED_AT_FINAL');
  assert.equal(result.helper_acknowledgement, 'ACKNOWLEDGED'); assert.equal(result.native_balance_yocto, '10000000000000000000000000');
  assert.equal(result.owner_key_count, 1); assert.equal(result.private_key_checked_by_runner, false);
  assert.equal(result.owner_backup_checked_by_runner, false); assert.equal(result.circle_usdc_funded, false);
  assert.equal(result.vault_deployed, false); assert.equal(result.do_not_repeat_helper_request, true);
});

test('a lost acknowledgement is reconciled by the original identity without a second helper request', async () => {
  const d = deps({ lostAck: true }), result = await requestTestnetOwnerOnce(d.args);
  assert.equal(d.requests, 1); assert.equal(result.helper_acknowledgement, 'UNKNOWN');
  assert.equal(result.status, 'OWNER_OBSERVED_AT_FINAL');
  const pending = deps({ lostAck: true, neverAppears: true });
  await assert.rejects(requestTestnetOwnerOnce(pending.args), /original helper request.*unresolved.*never resend/);
  assert.equal(pending.requests, 1);
});

test('wrong chain, stale or unknown state, existing identity and failed durable fence stop before sending', async () => {
  for (const opts of [{ chain: 'mainnet' }, { stale: true }, { unknownView: true }, { initiallyExists: true }, { fence: false }]) {
    const d = deps(opts); await assert.rejects(requestTestnetOwnerOnce(d.args)); assert.equal(d.requests, 0);
  }
});

test('wrong keys, extra keys or unexpected account code stop after the original request with no second POST', async () => {
  for (const opts of [{ wrongKey: true }, { extraKeys: true }, { badProfile: true }]) {
    const d = deps(opts); await assert.rejects(requestTestnetOwnerOnce(d.args), /profile|key list differs/); assert.equal(d.requests, 1);
  }
});
