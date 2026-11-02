import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { signOwnerAcquisition } from '../agent/circle-owner-acquisition.mjs';
import { signVaultBootstrap, V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
import { newTestnetVaultId, V11_EXPECTED_BYTES, V11_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-bootstrap-readiness.mjs';
import { signAndJournalVaultCircle } from '../agent/keyless-vault-circle-journal.mjs';
const NOW = Date.parse('2026-11-02T20:30:00Z'), artifact = process.env.BOUNCER_V11_WASM || '/home/user/bouncer-tools/v11-review/bouncer-v11.wasm';
const checks = Object.fromEntries(['new_direct_child_absent','owner_and_circle_ready','vault_not_pre_registered_for_circle',
  'testnet_protocol_floor','selected_v11_wasm_features','owner_native_estimate','vault_native_estimate'].map(x => [x, 'PASS']));
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-circle-vault-journal-')); fs.chmodSync(dir, 0o700);
  const key = nearApi.KeyPair.fromRandom('ed25519'), public_key = String(key.getPublicKey());
  const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key }, vault = newTestnetVaultId(plan);
  const paths = Object.fromEntries(['primary','backup','snapshot','bootstrapJournal','swapJournal','registrationJournal','journal','evidence','lock']
    .map(n => [n, path.join(dir, n)]));
  const credentials = { network_id: 'testnet', account_id: plan.account_id, public_key, private_key: key.toString() };
  for (const n of ['primary','backup']) fs.writeFileSync(paths[n], JSON.stringify(credentials), { mode: 0o600 });
  const common = { version: 1, owner: plan.account_id, public_key, block_hash: mockHash('circle-vault-journal-block'),
    block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(), owner_native_yocto: '9990000000000000000000000',
    circle_token: CIRCLE, circle_code_hash: mockHash('circle-vault-journal-token') };
  const input = '10000000000000000000000';
  const acq = { ...common, chain: 'testnet', owner_key_count: 1, owner_key_nonce: '99', circle_registration: 'REGISTERED_AT_VIEW',
    circle_symbol: 'USDC', circle_decimals: 6, circle_balance_atoms: '0', wrap_token: WRAP, wrap_symbol: 'wNEAR', wrap_decimals: 24,
    wrap_code_hash: mockHash('wrap-code'), wrap_storage_min_yocto: '1250000000000000000000', owner_wrap_registration: 'REGISTERED_AT_VIEW',
    owner_wrap_balance_yocto: input, ref_exchange: REF, ref_wrap_registration: 'REGISTERED_AT_VIEW', ref_circle_registration: 'REGISTERED_AT_VIEW',
    acquisition_input_yocto: input, max_usdc_atoms: '100000', selected: { pool_id: 1845, quote_atoms: '6907', min_output_atoms: '6561' },
    signed: false, sent: false };
  const swap = await signOwnerAcquisition({ plan, snapshot: acq, kind: 'swap', keyPair: key, nowMs: NOW });
  fs.writeFileSync(paths.swapJournal, JSON.stringify({ version: 1, status: 'ORIGINAL_FINAL_VERIFIED', envelope: swap,
    final_verification: { status: 'OWNER_FUNDED_CIRCLE_TEST_USDC_AT_FINAL', owner: plan.account_id, tx_hash: swap.tx_hash,
      circle_funding_verified: true, owner_circle_balance_atoms: '6907',
      receipt: { tx_hash: swap.tx_hash, circle_transfer: { amount_atoms: '6907', transfer_event_verified: true } } } }), { mode: 0o600 });
  const bootstrapSnapshot = { ...common, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', vault, owner_key_nonce: '100',
    owner_test_usdc_atoms: '6907', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO,
    v11_sha256: V11_EXPECTED_SHA256, v11_bytes: V11_EXPECTED_BYTES, observed_protocol_version: 88,
    selected_v11_wasm_features: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true },
    checks, blockers: [], signed: false, sent: false, vault_deployed: false };
  const bootstrap = await signVaultBootstrap({ plan, snapshot: bootstrapSnapshot, wasmBytes: fs.readFileSync(artifact), keyPair: key, nowMs: NOW });
  fs.writeFileSync(paths.bootstrapJournal, JSON.stringify({ version: 1, status: 'ORIGINAL_FINAL_VERIFIED', envelope: bootstrap,
    final_verification: { status: 'ORIGINAL_VAULT_FINAL_VERIFIED', owner: plan.account_id, tx_hash: bootstrap.tx_hash, vault_deployed: true,
      receipt: { tx_hash: bootstrap.tx_hash }, state: { code_hash: V11_NEAR_CODE_HASH, vault_key_count: 0 } } }), { mode: 0o600 });
  const snapshot = { ...common, network: 'testnet', vault, owner_key_nonce: '101', circle_storage_min_yocto: '1250000000000000000000',
    owner_circle_atoms: '6907', vault_code_hash: V11_NEAR_CODE_HASH, vault_key_count: 0,
    vault_circle_registration: 'NOT_REGISTERED_AT_VIEW', vault_actual_circle_atoms: '0', vault_tracked_circle_atoms: '0',
    register_eligible: true, fund_eligible: false, signed: false, sent: false, seller_contacted: false };
  fs.writeFileSync(paths.snapshot, JSON.stringify(snapshot), { mode: 0o600 });
  return { dir, paths, plan, key, snapshot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const skip = !fs.existsSync(artifact);

test('Circle vault registration is journaled before export, never replaced, and restores exact bytes', { skip }, async () => {
  const f = await fixture();
  try {
    const result = await signAndJournalVaultCircle({ plan: f.plan, paths: f.paths, kind: 'register', nowMs: NOW });
    const journal = JSON.parse(fs.readFileSync(f.paths.journal)), evidence = JSON.parse(fs.readFileSync(f.paths.evidence));
    assert.equal(result.tx_hash, journal.envelope.tx_hash); assert.deepEqual(evidence, journal.envelope);
    assert.equal((fs.statSync(f.paths.journal).mode & 0o777), 0o600); assert.equal(JSON.stringify(evidence).includes(f.key.toString()), false);
    await assert.rejects(signAndJournalVaultCircle({ plan: f.plan, paths: f.paths, kind: 'register', nowMs: NOW }), /already journaled/);
    fs.unlinkSync(f.paths.evidence);
    assert.equal((await signAndJournalVaultCircle({ plan: f.plan, paths: f.paths, kind: 'register', restore: true })).tx_hash, result.tx_hash);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.evidence)), evidence);
  } finally { f.cleanup(); }
});

test('funding requires verified original deployment, swap, registration, matching keys and fresh balance', { skip }, async () => {
  for (const scenario of ['bootstrap','swap','registration','backup','balance']) {
    const f = await fixture();
    try {
      await signAndJournalVaultCircle({ plan: f.plan, paths: f.paths, kind: 'register', nowMs: NOW });
      const reg = JSON.parse(fs.readFileSync(f.paths.journal)); reg.status = 'ORIGINAL_FINAL_VERIFIED';
      reg.final_verification = { status: 'VAULT_CIRCLE_REGISTERED_AT_FINAL', tx_hash: reg.envelope.tx_hash,
        owner: f.plan.account_id, vault: reg.envelope.vault, receipt: { tx_hash: reg.envelope.tx_hash },
        state: { vault_circle_registration: 'REGISTERED_AT_VIEW' } };
      fs.writeFileSync(f.paths.registrationJournal, JSON.stringify(reg), { mode: 0o600 });
      fs.unlinkSync(f.paths.journal); fs.unlinkSync(f.paths.evidence);
      const snap = { ...f.snapshot, owner_key_nonce: '102', vault_circle_registration: 'REGISTERED_AT_VIEW', register_eligible: false, fund_eligible: true };
      if (scenario === 'bootstrap') fs.writeFileSync(f.paths.bootstrapJournal, '{}');
      if (scenario === 'swap') fs.writeFileSync(f.paths.swapJournal, '{}');
      if (scenario === 'registration') fs.writeFileSync(f.paths.registrationJournal, '{}');
      if (scenario === 'backup') fs.writeFileSync(f.paths.backup, '{}');
      if (scenario === 'balance') snap.owner_circle_atoms = '6908';
      fs.writeFileSync(f.paths.snapshot, JSON.stringify(snap), { mode: 0o600 });
      await assert.rejects(signAndJournalVaultCircle({ plan: f.plan, paths: f.paths, kind: 'fund', nowMs: NOW }));
      assert.equal(fs.existsSync(f.paths.journal), false); assert.equal(fs.existsSync(f.paths.evidence), false);
    } finally { f.cleanup(); }
  }
});
