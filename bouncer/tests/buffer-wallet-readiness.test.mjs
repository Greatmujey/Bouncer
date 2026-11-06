import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectBufferWalletReadiness } from '../agent/buffer-wallet-readiness.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../agent/keyless-vault-v12-readiness.mjs';
import { V11_SELECTED_WASM_FEATURES } from '../agent/svalin-setup-preflight.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, BLOCK = mockHash('wallet-buffer-block'), OTHER = mockHash('wallet-buffer-other');
const NANO = String(BigInt(NOW) * 1_000_000n), ONE = 10n ** 24n;
const OWNER = 'buyer.testnet', VAULT = 'vault.buyer.testnet';
const REG = { total: '1250000000000000000000', available: '0' };
function fixture(o = {}) {
  const calls = [];
  const config = { owner: 'seller.testnet', agent: 'agent.testnet', owner_payout: 'payout.testnet',
    contributor: 'contrib.testnet', token_id: o.wrongToken ? 'mock.testnet' : CIRCLE, paused: !!o.paused, policy_version: 1 };
  const product = { price: o.price || '20000000', max_expense: '10000000', active: !o.inactive };
  return { owner: OWNER, vault: VAULT, now: () => NOW, calls, provider: {
    async viewNodeStatus() { calls.push(['status']); return { chain_id: o.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock() { calls.push(['block']); return { header: { hash: BLOCK, height: 300, timestamp_nanosec: o.stale ? String(BigInt(NOW - 121_000) * 1_000_000n) : NANO } }; },
    async query(q) {
      calls.push(['query', q]); assert.equal(q.block_id, BLOCK);
      const h = o.mixedAccount ? OTHER : BLOCK;
      if (q.request_type === 'view_account' && q.account_id === OWNER) return { block_hash: h, code_hash: o.ownerCode ? mockHash('code') : NO_LOCAL_CONTRACT_HASH,
        amount: String((o.lowNear ? 2n : 16n) * ONE), storage_usage: 264 };
      if (q.request_type === 'view_access_key_list' && q.account_id === OWNER) return { block_hash: BLOCK,
        keys: [{ access_key: { permission: o.restrictedOnly ? {} : 'FullAccess' } }] };
      if (q.request_type === 'view_account' && q.account_id === CIRCLE) return { block_hash: BLOCK,
        code_hash: o.wrongCircle ? mockHash('wrong-circle') : CIRCLE_TESTNET_CODE_HASH };
      if (q.request_type === 'view_account' && q.account_id === SELLER) return { block_hash: BLOCK, code_hash: mockHash('seller-code') };
      if (q.request_type === 'view_access_key_list' && q.account_id === SELLER) return { block_hash: BLOCK, keys: [] };
      throw Error('unexpected query');
    },
    async viewTestnetAccountPresenceAt(id, hash) {
      calls.push(['presence', id]); assert.equal(id, VAULT); assert.equal(hash, BLOCK);
      return { block_hash: BLOCK, exists: !!o.exists };
    },
    async experimental_protocolConfig(ref) {
      assert.deepEqual(ref, { blockId: BLOCK }); calls.push(['protocol']);
      return { chain_id: 'testnet', protocol_version: 90, runtime_config: { storage_amount_per_byte: '10000000000000000000',
        wasm_config: Object.fromEntries(V11_SELECTED_WASM_FEATURES.map(f => [f, !o.featureOff])) } };
    },
    async callFunctionRaw(account, method, args, ref) {
      calls.push(['view', account, method]); assert.deepEqual(ref, { blockId: BLOCK }); let data;
      if (account === CIRCLE && method === 'ft_balance_of') data = o.balance || '20000000';
      else if (account === CIRCLE && method === 'storage_balance_of') {
        data = args.account_id === OWNER ? (o.unregistered ? null : REG) : args.account_id === VAULT ? (o.registeredVault ? REG : null) : REG;
      } else if (account === CIRCLE && method === 'storage_balance_bounds') data = { min: REG.total, max: REG.total };
      else if (account === CIRCLE && method === 'ft_metadata') data = { decimals: 6, symbol: 'USDC' };
      else if (account === SELLER && method === 'get_config') data = config;
      else if (account === SELLER && method === 'get_products') data = [['weekly-market-brief', product]];
      else if (account === SELLER && method === 'get_quote_rules') data = [['custom-brief', { min_price: '5000000', max_price: '50000000',
        max_expense_bps: 5000, active: true }]];
      else throw Error('unexpected view');
      return { block_hash: o.mixedView ? OTHER : BLOCK, result: [...Buffer.from(JSON.stringify(data))] };
    },
  } };
}

test('same-block wallet and fixed-price readiness never claims approval or payment', async () => {
  const f = fixture(), r = await inspectBufferWalletReadiness(f);
  assert.equal(r.owner_circle_atoms, '20000000'); assert.equal(r.seller.fixed_products[0].price_atoms, '20000000');
  assert.deepEqual(r.blockers, []); assert.equal(r.candidate_vault, VAULT);
  assert.equal(r.wallet_control_proven, false); assert.equal(r.wallet_approval_obtained, false);
  assert.equal(r.signed, false); assert.equal(r.sent, false); assert.equal(r.vault_deployed, false);
  assert.equal(r.quote_or_order_created, false); assert.equal(r.independently_fulfilled, false);
  assert(f.calls.every(c => ['status', 'block', 'query', 'presence', 'view', 'protocol'].includes(c[0])));
});

test('specific changed or insufficient conditions block readiness, never mutate', async () => {
  for (const [o, key] of [[{ balance: '19999999' }, 'owner_balance_covers_fixed_price'], [{ lowNear: true }, 'owner_native_estimate'],
    [{ ownerCode: true }, 'named_owner_has_no_local_or_global_code'], [{ restrictedOnly: true }, 'owner_has_full_access_key'],
    [{ wrongCircle: true }, 'reviewed_circle_code_and_metadata'], [{ wrongToken: true }, 'buffer_accepts_circle_and_is_registered'],
    [{ paused: true }, 'buffer_accepts_circle_and_is_registered'], [{ unregistered: true }, 'owner_circle_registered'],
    [{ registeredVault: true }, 'child_not_already_circle_registered'], [{ exists: true }, 'new_direct_child_absent'],
    [{ featureOff: true }, 'protocol_and_selected_features'], [{ inactive: true }, 'fixed_product_active']]) {
    const r = await inspectBufferWalletReadiness(fixture(o));
    assert.equal(r.checks[key], false, key); assert(r.blockers.includes(key));
  }
});

test('mainnet, wrong vault relationship, stale or mixed views fail closed', async () => {
  for (const o of [{ mainnet: true }, { stale: true }, { mixedAccount: true }, { mixedView: true }]) {
    await assert.rejects(inspectBufferWalletReadiness(fixture(o)));
  }
  const f = fixture(); f.vault = 'vault.other.testnet'; await assert.rejects(inspectBufferWalletReadiness(f));
  f.vault = 'a.b.buyer.testnet'; await assert.rejects(inspectBufferWalletReadiness(f));
});
