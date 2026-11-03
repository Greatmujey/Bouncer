/** Offline fixed-action signer and verifier for the one provider-neutral V12
 * testnet vault. Public signed bytes are a bearer; publishing them can cause
 * exact deployment before CI's fresh checks. This creates a keyless account:
 * its code cannot be upgraded/deleted through the current V12 contract and its
 * native storage stake may remain locked. No real-money chain is permitted. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId, V12_EXPECTED_BYTES, V12_EXPECTED_SHA256, VAULT_NATIVE_FUNDING_YOCTO,
  CIRCLE_TESTNET_CODE_HASH } from './keyless-vault-v12-readiness.mjs';
import { V11_SELECTED_WASM_FEATURES } from './svalin-setup-preflight.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';

const sha = b => crypto.createHash('sha256').update(b).digest();
const TGAS = 10n ** 12n;
const REQUIRED_CHECKS = ['new_direct_child_absent', 'owner_and_circle_ready', 'circle_code_pinned', 'vault_not_pre_registered_for_circle',
  'testnet_protocol_floor', 'selected_v12_wasm_features', 'owner_native_estimate', 'vault_native_estimate'];
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;
export const V12_NEAR_CODE_HASH = nearApi.utils.serialize.base_encode(Buffer.from(V12_EXPECTED_SHA256, 'hex'));

export function validateVaultBootstrapSnapshot(snapshot, rawPlan, nowMs = Date.now()) {
  const plan = validateOwnerBootstrapPlan(rawPlan), vault = newTestnetVaultId(plan);
  if (!record(snapshot) || snapshot.version !== 1 || snapshot.status !== 'READ_ONLY_BOOTSTRAP_INDICATED' ||
      snapshot.network !== 'testnet' || snapshot.owner !== plan.account_id || snapshot.public_key !== plan.public_key ||
      snapshot.vault !== vault || snapshot.circle_token !== CIRCLE || snapshot.circle_code_hash !== CIRCLE_TESTNET_CODE_HASH ||
      !uint(snapshot.owner_native_yocto) || !uint(snapshot.owner_test_usdc_atoms) || BigInt(snapshot.owner_test_usdc_atoms) < 3_000n ||
      snapshot.planned_vault_native_yocto !== VAULT_NATIVE_FUNDING_YOCTO || snapshot.v12_sha256 !== V12_EXPECTED_SHA256 ||
      snapshot.v12_bytes !== V12_EXPECTED_BYTES || pinnedAccessKeyNonce(snapshot.owner_key_nonce) === null ||
      !record(snapshot.checks) || REQUIRED_CHECKS.some(k => snapshot.checks[k] !== 'PASS') ||
      !Array.isArray(snapshot.blockers) || snapshot.blockers.length !== 0 || snapshot.signed !== false || snapshot.sent !== false ||
      snapshot.vault_deployed !== false || !Number.isSafeInteger(snapshot.observed_protocol_version) || snapshot.observed_protocol_version < 88 ||
      !record(snapshot.selected_v12_wasm_features) || V11_SELECTED_WASM_FEATURES.some(k => snapshot.selected_v12_wasm_features[k] !== true)) {
    throw new Error('snapshot is not eligible for the fixed testnet V12 bootstrap');
  }
  assertFreshFinalBlock({ header: { hash: snapshot.block_hash, timestamp_nanosec: snapshot.block_timestamp_nanosec } }, nowMs);
  return { plan, vault, nonce: pinnedAccessKeyNonce(snapshot.owner_key_nonce), blockHash: snapshot.block_hash };
}
function checkedCode(wasm) {
  const valid = wasm instanceof Uint8Array || (Array.isArray(wasm) && wasm.every(x => Number.isInteger(x) && x >= 0 && x <= 255));
  const bytes = valid ? Buffer.from(wasm) : Buffer.alloc(0);
  if (bytes.length !== V12_EXPECTED_BYTES || sha(bytes).toString('hex') !== V12_EXPECTED_SHA256 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('V12 WASM differs from the pinned testnet artifact');
  return bytes;
}
function actionsFor(owner, wasm) {
  const t = nearApi.transactions;
  return [t.createAccount(), t.transfer(BigInt(VAULT_NATIVE_FUNDING_YOCTO)), t.deployContract(checkedCode(wasm)),
    t.functionCall('new', { owner }, 30n * TGAS, 0n)];
}
function checkEnvelope(e, plan) {
  if (!record(e) || e.version !== 1 || e.kind !== 'create-keyless-v12-vault' || e.network !== 'testnet' ||
      e.owner !== plan.account_id || e.public_key !== plan.public_key || e.vault !== newTestnetVaultId(plan) ||
      e.vault_native_funding_yocto !== VAULT_NATIVE_FUNDING_YOCTO || e.v12_sha256 !== V12_EXPECTED_SHA256 ||
      e.v12_near_code_hash !== V12_NEAR_CODE_HASH || e.expected_circle_code_hash !== CIRCLE_TESTNET_CODE_HASH ||
      !uint(e.expected_owner_circle_atoms) || BigInt(e.expected_owner_circle_atoms) < 3_000n ||
      !isTransactionHash(e.block_hash) || !isTransactionHash(e.tx_hash) || pinnedAccessKeyNonce(e.nonce) === null ||
      typeof e.signed_tx_base64 !== 'string' || e.signed_tx_base64.length > 1_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)) {
    throw new Error('invalid fixed testnet vault bearer envelope');
  }
}
export function verifySignedVaultBootstrap(e, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan); checkEnvelope(e, plan);
  const bytes = Buffer.from(e.signed_tx_base64, 'base64');
  if (bytes.toString('base64') !== e.signed_tx_base64) throw new Error('invalid vault bearer encoding');
  let signed; try { signed = nearApi.transactions.SignedTransaction.decode(bytes); } catch { throw new Error('invalid vault bearer bytes'); }
  const tx = signed?.transaction, key = nearApi.utils.PublicKey.from(plan.public_key), wasm = tx?.actions?.[2]?.deployContract?.code;
  let actual, expected;
  try {
    actual = Buffer.from(nearApi.transactions.encodeTransaction(tx));
    expected = Buffer.from(nearApi.transactions.encodeTransaction(nearApi.transactions.createTransaction(plan.account_id, key,
      e.vault, BigInt(e.nonce), actionsFor(plan.account_id, wasm), nearApi.utils.serialize.base_decode(e.block_hash))));
  } catch { throw new Error('invalid fixed V12 deployment actions'); }
  const sig = signed.signature?.ed25519Signature?.data;
  if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes) || !actual.equals(expected) ||
      nearApi.utils.serialize.base_encode(sha(actual)) !== e.tx_hash || !Array.isArray(sig) || sig.length !== 64 ||
      !key.verify(sha(actual), Uint8Array.from(sig))) {
    throw new Error('signature or deployment bytes differ from the fixed keyless V12 action');
  }
  return signed;
}
export async function signVaultBootstrap({ plan, snapshot, wasmBytes, keyPair, nowMs = Date.now() } = {}) {
  const t = validateVaultBootstrapSnapshot(snapshot, plan, nowMs), code = checkedCode(wasmBytes);
  if (!keyPair || String(keyPair.getPublicKey()) !== t.plan.public_key) throw new Error('owner key does not match public bootstrap plan');
  const tx = nearApi.transactions.createTransaction(t.plan.account_id, nearApi.utils.PublicKey.from(t.plan.public_key), t.vault,
    t.nonce + 1n, actionsFor(t.plan.account_id, code), nearApi.utils.serialize.base_decode(t.blockHash));
  const encoded = Buffer.from(nearApi.transactions.encodeTransaction(tx)), hash = sha(encoded), sig = await keyPair.sign(hash);
  const signed = new nearApi.transactions.SignedTransaction({ transaction: tx,
    signature: new nearApi.transactions.Signature({ keyType: tx.publicKey.keyType, data: sig.signature }) });
  const envelope = { version: 1, kind: 'create-keyless-v12-vault', network: 'testnet', owner: t.plan.account_id,
    public_key: t.plan.public_key, vault: t.vault, nonce: (t.nonce + 1n).toString(), block_hash: t.blockHash,
    vault_native_funding_yocto: VAULT_NATIVE_FUNDING_YOCTO, v12_sha256: V12_EXPECTED_SHA256, v12_near_code_hash: V12_NEAR_CODE_HASH,
    expected_circle_code_hash: snapshot.circle_code_hash, expected_owner_circle_atoms: snapshot.owner_test_usdc_atoms,
    tx_hash: nearApi.utils.serialize.base_encode(hash), signed_tx_base64: Buffer.from(signed.encode()).toString('base64'),
    warning: 'PUBLIC BEARER; anyone can relay this exact 6-test-NEAR keyless deployment; never blindly resend' };
  verifySignedVaultBootstrap(envelope, t.plan); return envelope;
}
