import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import { mockHash } from './mock-guarded-payment.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { newTestnetVaultId, V11_EXPECTED_BYTES, V11_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO } from '../agent/keyless-vault-bootstrap-readiness.mjs';
import { validateVaultBootstrapSnapshot, signVaultBootstrap, verifySignedVaultBootstrap, V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';

const NOW = Date.parse('2026-11-02T17:10:00Z'), pair = nearApi.KeyPair.fromRandom('ed25519'), pub = String(pair.getPublicKey());
const plan = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
  account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: pub };
const checks = Object.fromEntries(['new_direct_child_absent', 'owner_and_circle_ready', 'vault_not_pre_registered_for_circle',
  'testnet_protocol_floor', 'selected_v11_wasm_features', 'owner_native_estimate', 'vault_native_estimate'].map(x => [x, 'PASS']));
function snapshot() { return { version: 1, status: 'READ_ONLY_BOOTSTRAP_INDICATED', network: 'testnet', owner: plan.account_id,
  public_key: pub, vault: newTestnetVaultId(plan), circle_token: CIRCLE, circle_code_hash: mockHash('circle-code'),
  block_hash: mockHash('vault-block'), block_timestamp_nanosec: (BigInt(NOW) * 1_000_000n).toString(), owner_key_nonce: '100',
  owner_native_yocto: '9990000000000000000000000', owner_test_usdc_atoms: '6917', planned_vault_native_yocto: VAULT_NATIVE_FUNDING_YOCTO,
  v11_sha256: V11_EXPECTED_SHA256, v11_bytes: V11_EXPECTED_BYTES, observed_protocol_version: 88,
  selected_v11_wasm_features: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true },
  checks: { ...checks }, blockers: [], signed: false, sent: false, vault_deployed: false }; }
const artifact = process.env.BOUNCER_V11_WASM || '/home/user/bouncer-tools/v11-review/bouncer-v11.wasm';

test('snapshot rejects wrong chain, owner, vault, nonce, protocol, balance or missing safeguards before any signature', () => {
  const s = snapshot(); assert.equal(validateVaultBootstrapSnapshot(s, plan, NOW).vault, newTestnetVaultId(plan));
  for (const change of [{ network: 'mainnet' }, { vault: 'other.testnet' }, { owner: 'other.testnet' },
    { owner_test_usdc_atoms: '2999' }, { v11_sha256: '00' }, { planned_vault_native_yocto: '1' },
    { owner_key_nonce: '9007199254740992' }, { blockers: ['bad'] }, { selected_v11_wasm_features: {} },
    { checks: { ...checks, new_direct_child_absent: 'BLOCKED' } }, { observed_protocol_version: 87 }]) {
    assert.throws(() => validateVaultBootstrapSnapshot({ ...s, ...change }, plan, NOW));
  }
  assert.throws(() => validateVaultBootstrapSnapshot(s, plan, NOW + 120_001), /stale/);
});

test('rejects wrong WASM before signing', async () => {
  await assert.rejects(signVaultBootstrap({ plan, snapshot: snapshot(), wasmBytes: Buffer.alloc(8), keyPair: pair, nowMs: NOW }), /pinned testnet artifact/);
});

test('exact recovered V11 signs one create+6-test-NEAR+deploy+init, with no vault key; tampering fails', { skip: !fs.existsSync(artifact) }, async () => {
  const wasm = fs.readFileSync(artifact), e = await signVaultBootstrap({ plan, snapshot: snapshot(), wasmBytes: wasm, keyPair: pair, nowMs: NOW });
  const signed = verifySignedVaultBootstrap(e, plan), a = signed.transaction.actions;
  assert.ok(a[0].createAccount); assert.ok(a[1].transfer); assert.ok(a[2].deployContract); assert.ok(a[3].functionCall);
  assert.equal(a.length, 4); assert.equal(a.some(x => x.addKey), false);
  assert.equal(String(a[1].transfer.deposit), VAULT_NATIVE_FUNDING_YOCTO); assert.equal(a[2].deployContract.code.length, V11_EXPECTED_BYTES);
  assert.equal(a[3].functionCall.methodName, 'new'); assert.deepEqual(JSON.parse(Buffer.from(a[3].functionCall.args).toString()), { owner: plan.account_id });
  assert.equal(a[3].functionCall.deposit, 0n); assert.equal(e.v11_near_code_hash, V11_NEAR_CODE_HASH);
  assert.equal(JSON.stringify(e).includes(pair.toString()), false);
  for (const change of [{ vault: 'other.testnet' }, { nonce: '999' }, { v11_sha256: '00' }, { tx_hash: mockHash('wrong') }]) {
    assert.throws(() => verifySignedVaultBootstrap({ ...e, ...change }, plan));
  }
  const bytes = Buffer.from(e.signed_tx_base64, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => verifySignedVaultBootstrap({ ...e, signed_tx_base64: bytes.toString('base64') }, plan));
  await assert.rejects(signVaultBootstrap({ plan, snapshot: snapshot(), wasmBytes: wasm, keyPair: nearApi.KeyPair.fromRandom('ed25519'), nowMs: NOW }), /owner key/);
});
