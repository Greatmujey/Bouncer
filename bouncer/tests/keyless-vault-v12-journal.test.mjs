import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { signOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';
import { signAndJournalVaultBootstrap } from '../agent/keyless-vault-v12-journal.mjs';
import { newTestnetVaultId, V12_EXPECTED_BYTES, V12_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-v12-readiness.mjs';

const NOW = Date.parse('2026-11-02T17:15:00Z'), artifact = process.env.BOUNCER_V12_WASM || '/home/user/bouncer-tools/v12-review/bouncer-v12.wasm';
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'circle_code_pinned', 'vault_not_pre_registered_for_circle',
  'testnet_protocol_floor', 'selected_v12_wasm_features', 'owner_native_estimate', 'vault_native_estimate'].map(x => [x, 'PASS']));
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-vault-original-')); fs.chmodSync(dir, 0o700);
  const key = nearApi.KeyPair.fromRandom('ed25519'), pub = String(key.getPublicKey()),
    plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
      account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
  const paths = Object.fromEntries(['primary', 'backup', 'snapshot', 'swapJournal', 'journal', 'evidence', 'lock'].map(n => [n, path.join(dir, n)]));
  paths.wasm = path.join(dir, 'wasm'); fs.copyFileSync(artifact, paths.wasm);
  const cred = { network_id: 'testnet', account_id: plan.account_id, public_key: pub, private_key: key.toString() };
  for (const name of ['primary', 'backup']) fs.writeFileSync(paths[name], JSON.stringify(cred), { mode: 0o600 });
  const common = { version: 1, owner: plan.account_id, public_key: pub, block_hash: mockHash('vault-journal-block'),
    block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(), owner_native_yocto: '9990000000000000000000000',
    circle_token: CIRCLE, circle_code_hash: 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z' };
  const input = '10000000000000000000000';
  const acq = { ...common, chain: 'testnet', owner_key_count: 1, owner_key_nonce: '99', circle_registration: 'REGISTERED_AT_VIEW',
    circle_symbol: 'USDC', circle_decimals: 6, circle_balance_atoms: '0', wrap_token: WRAP, wrap_symbol: 'wNEAR', wrap_decimals: 24,
    wrap_code_hash: mockHash('wrap-code'), wrap_storage_min_yocto: '1250000000000000000000', owner_wrap_registration: 'REGISTERED_AT_VIEW',
    owner_wrap_balance_yocto: input, ref_exchange: REF, ref_wrap_registration: 'REGISTERED_AT_VIEW', ref_circle_registration: 'REGISTERED_AT_VIEW',
    acquisition_input_yocto: input, max_usdc_atoms: '100000', selected: { pool_id: 1845, quote_atoms: '6917', min_output_atoms: '6571' },
    signed: false, sent: false };
  const swap = await signOwnerAcquisition({ plan, snapshot: acq, kind: 'swap', keyPair: key, nowMs: NOW });
  fs.writeFileSync(paths.swapJournal, JSON.stringify({ version: 1, status: 'ORIGINAL_FINAL_VERIFIED', envelope: swap,
    final_verification: { status: 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL', owner: plan.account_id, network: 'testnet',
      tx_hash: swap.tx_hash, circle_funding_verified: true, owner_circle_balance_atoms: '6917',
      receipt: { tx_hash: swap.tx_hash, circle_transfer: { amount_atoms: '6917', transfer_event_verified: true } } } }), { mode: 0o600 });
  const snapshot = { ...common, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', vault: newTestnetVaultId(plan),
    owner_key_nonce: '100', owner_test_usdc_atoms: '6917', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO,
    v12_sha256: V12_EXPECTED_SHA256, v12_bytes: V12_EXPECTED_BYTES, observed_protocol_version: 88,
    selected_v12_wasm_features: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true },
    checks: { ...checks }, blockers: [], signed: false, sent: false, vault_deployed: false };
  fs.writeFileSync(paths.snapshot, JSON.stringify(snapshot), { mode: 0o600 });
  return { dir, key, plan, paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('vault original is fsynced before bearer export, cannot be replaced, and restores exact original bytes', { skip: !fs.existsSync(artifact) }, async () => {
  const f = await fixture();
  try {
    const result = await signAndJournalVaultBootstrap({ plan: f.plan, paths: f.paths, nowMs: NOW });
    const journal = JSON.parse(fs.readFileSync(f.paths.journal)), evidence = JSON.parse(fs.readFileSync(f.paths.evidence));
    assert.equal(result.tx_hash, journal.envelope.tx_hash); assert.deepEqual(evidence, journal.envelope);
    assert.equal((fs.statSync(f.paths.journal).mode & 0o777), 0o600); assert.equal(JSON.stringify(evidence).includes(f.key.toString()), false);
    assert.equal(result.keyless_storage_may_be_irreversible, true);
    await assert.rejects(signAndJournalVaultBootstrap({ plan: f.plan, paths: f.paths, nowMs: NOW }), /already journaled/);
    fs.unlinkSync(f.paths.evidence);
    const restored = await signAndJournalVaultBootstrap({ plan: f.plan, paths: f.paths, restore: true });
    assert.equal(restored.tx_hash, result.tx_hash); assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), evidence);
  } finally { f.cleanup(); }
});

test('unverified funding, missing backup or already held lock blocks before a vault signature', { skip: !fs.existsSync(artifact) }, async () => {
  for (const scenario of ['swap', 'backup', 'lock']) {
    const f = await fixture();
    try {
      if (scenario === 'swap') fs.writeFileSync(f.paths.swapJournal, JSON.stringify({ version: 1, status: 'pending' }));
      if (scenario === 'backup') fs.writeFileSync(f.paths.backup, '{}');
      if (scenario === 'lock') fs.mkdirSync(f.paths.lock);
      await assert.rejects(signAndJournalVaultBootstrap({ plan: f.plan, paths: f.paths, nowMs: NOW }));
      assert.equal(fs.existsSync(f.paths.journal), false); assert.equal(fs.existsSync(f.paths.evidence), false);
    } finally { f.cleanup(); }
  }
});
