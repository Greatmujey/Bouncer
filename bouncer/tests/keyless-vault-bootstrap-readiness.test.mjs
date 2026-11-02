import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { inspectKeylessVaultBootstrap, newTestnetVaultId, V11_EXPECTED_SHA256 } from '../agent/keyless-vault-bootstrap-readiness.mjs';

const NOW = Date.parse('2026-11-02T17:00:00Z'), BLOCK = mockHash('vault-preflight');
const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
function provider(opts = {}) {
  const access = { nonce: 100, permission: opts.badKey ? 'FunctionCall' : 'FullAccess' };
  return {
    async viewNodeStatus() { return { chain_id: opts.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock() { return { header: { hash: BLOCK, timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString() } }; },
    async query(q) {
      assert.equal(q.block_id, BLOCK);
      if (q.request_type === 'view_account') return { block_hash: BLOCK,
        code_hash: q.account_id === plan.account_id ? '11111111111111111111111111111111' : mockHash('circle-code'),
        amount: opts.native ?? '9990000000000000000000000', locked: '0', storage_usage: 150 };
      if (q.request_type === 'view_access_key_list') return { block_hash: BLOCK, keys: [{ public_key: pub, access_key: access }] };
      if (q.request_type === 'view_access_key') return { block_hash: BLOCK, ...access };
      throw new Error('unexpected query');
    },
    async callFunctionRaw(contract, method, args, at) {
      assert.equal(contract, CIRCLE); assert.equal(at.blockId, BLOCK);
      let value;
      if (method === 'ft_metadata') value = { symbol: 'USDC', decimals: 6 };
      else if (method === 'storage_balance_bounds') value = { min: '1250000000000000000000', max: null };
      else if (method === 'storage_balance_of') value = args.account_id === plan.account_id || opts.preRegistered ?
        { total: '1250000000000000000000', available: '0' } : null;
      else if (method === 'ft_balance_of') value = opts.balance ?? '6917';
      else throw new Error('unexpected view');
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(value))] };
    },
    async viewTestnetAccountPresenceAt(id, hash) { assert.equal(id, newTestnetVaultId(plan)); assert.equal(hash, BLOCK);
      return { block_hash: opts.mixed ? mockHash('other') : BLOCK, exists: !!opts.exists }; },
    async experimental_protocolConfig(at) { assert.equal(at.blockId, BLOCK); return { chain_id: 'testnet', protocol_version: opts.version ?? 90,
      runtime_config: { storage_amount_per_byte: opts.cost ?? '10000000000000000000', wasm_config: {
        global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: !opts.missingFeature } } }; },
  };
}

test('provider-neutral vault bootstrap reads one FINAL block, bounded estimates and current owner USDC', async () => {
  const p = provider(), s = await inspectKeylessVaultBootstrap({ plan, provider: p, now: () => NOW });
  assert.equal(s.status, 'READ_ONLY_BOOTSTRAP_INDICATED'); assert.deepEqual(s.blockers, []);
  assert.equal(s.vault, `vault.${plan.account_id}`); assert.equal(s.owner_test_usdc_atoms, '6917');
  assert.equal(s.v11_sha256, V11_EXPECTED_SHA256); assert.equal(s.planned_vault_native_yocto, '6000000000000000000000000');
  assert.equal(s.artifact_checked, false); assert.equal(s.backup_export_verified, false); assert.equal(s.signed, false);
});

test('existing vault, stale/mixed views, low balance, unsupported features and insufficient storage fail closed', async () => {
  for (const opts of [{ exists: true }, { mixed: true }, { balance: '2999' }, { preRegistered: true }, { version: 87 },
    { missingFeature: true }, { native: '6000000000000000000000000' }, { cost: '20000000000000000000' }]) {
    const s = await inspectKeylessVaultBootstrap({ plan, provider: provider(opts), now: () => NOW });
    assert.equal(s.status, 'BLOCKED_OR_UNKNOWN'); assert.ok(s.blockers.length > 0);
  }
  await assert.rejects(inspectKeylessVaultBootstrap({ plan, provider: provider({ mainnet: true }), now: () => NOW }), /testnet/);
  await assert.rejects(inspectKeylessVaultBootstrap({ plan, provider: provider({ badKey: true }), now: () => NOW }), /full-access/);
  await assert.rejects(inspectKeylessVaultBootstrap({ plan, provider: provider(), now: () => NOW + 120_001 }), /stale/);
});
