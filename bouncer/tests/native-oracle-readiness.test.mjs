import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNativeOracleReadiness } from '../agent/native-oracle-readiness.mjs';
import { ORACLE_TESTNET_PROGRAM, ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID } from '../agent/oracle-outlayer.mjs';
import { NATIVE_ORACLE_V9_BYTES, NATIVE_ORACLE_VAULT_FUNDING, NATIVE_ORACLE_TRIAL_MAX } from '../agent/native-oracle-wallet-plan.mjs';
import { V11_SELECTED_WASM_FEATURES } from '../agent/svalin-setup-preflight.mjs';
import { V3_OWNER } from '../agent/v3-faucet-github-fence.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const NOW = 1_800_000_000_000, BLOCK = mockHash('native-ready-block'), OTHER = mockHash('other-block'), ONE = 10n ** 24n;
const OWNER = 'buyer.testnet', VAULT = 'native.buyer.testnet', OUTLAYER = 'outlayer.testnet';
const nanos = String(BigInt(NOW) * 1_000_000n);
function fixture(o = {}) {
  const calls = [], version = { wasm_hash: ORACLE_TESTNET_PROGRAM.sha256, source: { WasmUrl: {
    url: ORACLE_TESTNET_PROGRAM.url, hash: ORACLE_TESTNET_PROGRAM.sha256, build_target: ORACLE_TESTNET_PROGRAM.build_target } } };
  const project = { project_id: ORACLE_PROJECT_ID, uuid: ORACLE_PROJECT_UUID, owner: 'zavodil2.testnet' };
  return { owner: OWNER, vault: VAULT, now: () => NOW, calls, provider: {
    async viewNodeStatus() { calls.push('status'); return { chain_id: o.mainnet ? 'mainnet' : 'testnet' }; },
    async viewBlock(ref) { calls.push('block'); assert.deepEqual(ref, { finality: 'final' });
      return { header: { hash: BLOCK, height: 123, timestamp_nanosec: o.stale ? String(BigInt(NOW - 121_000) * 1_000_000n) : nanos } }; },
    async query(q) {
      calls.push('query'); assert.equal(q.block_id, BLOCK); const h = o.mixed ? OTHER : BLOCK;
      if (q.request_type === 'view_account' && q.account_id === OWNER) return { block_hash: h,
        code_hash: o.ownerCode ? mockHash('code') : NO_LOCAL_CONTRACT_HASH, amount: String((o.lowNear ? 2n : 16n) * ONE), storage_usage: 264 };
      if (q.request_type === 'view_access_key_list' && q.account_id === OWNER) return { block_hash: h,
        keys: [{ access_key: { permission: o.restricted ? { FunctionCall: {} } : 'FullAccess' } }] };
      if (q.request_type === 'view_account' && q.account_id === OUTLAYER) return { block_hash: h, code_hash: mockHash('outlayer-code') };
      if (q.request_type === 'view_access_key_list' && q.account_id === OUTLAYER) return { block_hash: h, keys: [{ access_key: { permission: 'FullAccess' } }] };
      throw Error('unexpected query');
    },
    async viewTestnetAccountPresenceAt(id, hash) { calls.push('presence'); assert.equal(id, VAULT); assert.equal(hash, BLOCK);
      return { block_hash: BLOCK, exists: !!o.exists }; },
    async experimental_protocolConfig(ref) { calls.push('protocol'); assert.deepEqual(ref, { blockId: BLOCK });
      return { chain_id: 'testnet', protocol_version: 90, runtime_config: { storage_amount_per_byte: o.highStorage ? '100000000000000000000' : '10000000000000000000',
        wasm_config: Object.fromEntries(V11_SELECTED_WASM_FEATURES.map(f => [f, !o.featureOff])) } }; },
    async gasPrice(hash) { calls.push('gas'); assert.equal(hash, BLOCK); return { gas_price: o.highGas ? '2000000000' : '100000000' }; },
    async callFunctionRaw(account, method, args, ref) { calls.push('view'); assert.equal(account, OUTLAYER); assert.deepEqual(ref, { blockId: BLOCK });
      assert.equal(args.project_id, ORACLE_PROJECT_ID); let result;
      if (method === 'get_project') result = o.changedProject ? { ...project, owner: 'other.testnet' } : project;
      else if (method === 'get_version') result = o.changedVersion ? { ...version, wasm_hash: 'a'.repeat(64) } : version;
      else if (method === 'get_project_pricing') result = o.pricing ? { price: '1' } : null;
      else throw Error('unexpected view');
      return { block_hash: o.mixedView ? OTHER : BLOCK, result: [...Buffer.from(JSON.stringify(result))] };
    },
  } };
}

test('fresh pinned public readiness reports estimates without claiming consent or delivery', async () => {
  const f = fixture(), r = await inspectNativeOracleReadiness(f);
  assert.deepEqual(r.blockers, []); assert.equal(r.owner, OWNER); assert.equal(r.candidate_vault, VAULT);
  assert.equal(r.planned_vault_storage_funding_yocto, NATIVE_ORACLE_VAULT_FUNDING);
  assert.equal(r.maximum_trial_deposit_yocto, NATIVE_ORACLE_TRIAL_MAX);
  assert.equal(r.estimated_vault_minimum_yocto, ((BigInt(NATIVE_ORACLE_V9_BYTES) + 50_000n) * 10n ** 19n + ONE / 10n).toString());
  assert.equal(r.outlayer_has_full_access_key, true); assert.equal(r.wallet_control_proven, false);
  assert.equal(r.wallet_approval_obtained, false); assert.equal(r.signed, false); assert.equal(r.sent, false);
  assert.equal(r.provider_execution_requested, false); assert.equal(r.independent_delivery_verified, false);
  assert(f.calls.every(call => ['status', 'block', 'query', 'presence', 'protocol', 'gas', 'view'].includes(call)));
});

test('insufficient funds, existing child, gas, features or changed project are explicit blockers', async () => {
  for (const [o, key] of [[{ lowNear: true }, 'owner_native_estimate'], [{ exists: true }, 'new_direct_child_absent'],
    [{ ownerCode: true }, 'named_owner_has_no_local_or_global_code'], [{ restricted: true }, 'owner_has_full_access_key'],
    [{ featureOff: true }, 'protocol_and_selected_features'], [{ highStorage: true }, 'vault_storage_estimate'],
    [{ highGas: true }, 'agent_gas_allowance_estimate'], [{ changedProject: true }, 'pinned_project_identity_and_native_pricing'],
    [{ changedVersion: true }, 'pinned_project_identity_and_native_pricing'], [{ pricing: true }, 'pinned_project_identity_and_native_pricing']]) {
    const r = await inspectNativeOracleReadiness(fixture(o)); assert.equal(r.checks[key], false, key); assert(r.blockers.includes(key));
  }
});

test('mixed, stale, mainnet, invalid relationships and the unresolved V3 owner fail closed', async () => {
  for (const o of [{ mainnet: true }, { stale: true }, { mixed: true }, { mixedView: true }]) await assert.rejects(inspectNativeOracleReadiness(fixture(o)));
  const f = fixture(); f.vault = 'a.b.buyer.testnet'; await assert.rejects(inspectNativeOracleReadiness(f));
  f.owner = V3_OWNER; f.vault = `native.${V3_OWNER}`; await assert.rejects(inspectNativeOracleReadiness(f));
  const badGas = fixture(); badGas.gasAllowanceYocto = '0'; await assert.rejects(inspectNativeOracleReadiness(badGas));
});
