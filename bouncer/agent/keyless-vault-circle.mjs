/** Offline, constrained Circle TESTNET registration/funding for one keyless
 * V11 vault. Public signed bytes are bearer transactions: anyone may relay
 * the exact action. Original hashes must be journaled and never replaced. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-bootstrap-readiness.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
const sha = b => crypto.createHash('sha256').update(b).digest();
const TGAS = 10n ** 12n, MAX_STORAGE = 10n ** 22n, MAX_FUNDING = 100_000n, MIN_FUNDING = 3_000n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function check(e, plan) {
  if (!record(e) || e.version !== 1 || !['register','fund'].includes(e.kind) || e.network !== 'testnet' ||
      e.owner !== plan.account_id || e.public_key !== plan.public_key || e.vault !== newTestnetVaultId(plan) || e.token !== CIRCLE ||
      !isTransactionHash(e.expected_circle_code_hash) || !uint(e.storage_min_yocto) || e.storage_min_yocto === '0' ||
      BigInt(e.storage_min_yocto) > MAX_STORAGE || !uint(e.amount_atoms) || BigInt(e.amount_atoms) < MIN_FUNDING ||
      BigInt(e.amount_atoms) > MAX_FUNDING || !uint(e.expected_owner_atoms) || BigInt(e.expected_owner_atoms) < BigInt(e.amount_atoms) ||
      e.expected_vault_atoms !== '0' || e.expected_tracked_atoms !== '0' ||
      e.expected_registration !== (e.kind === 'register' ? 'NOT_REGISTERED_AT_VIEW' : 'REGISTERED_AT_VIEW') ||
      !isTransactionHash(e.block_hash) || pinnedAccessKeyNonce(e.nonce) === null || e.nonce === '0' ||
      e.do_not_blindly_resend !== true) throw new Error('invalid bounded Circle vault terms');
}
function actionsFor(e) {
  if (e.kind === 'register') return [nearApi.transactions.functionCall('storage_deposit',
    { account_id: e.vault, registration_only: true }, 50n * TGAS, BigInt(e.storage_min_yocto))];
  return [nearApi.transactions.functionCall('ft_transfer_call',
    { receiver_id: e.vault, amount: e.amount_atoms, msg: '' }, 200n * TGAS, 1n)];
}
export function validateVaultCircleSnapshot(snapshot, rawPlan, kind, amount, nowMs = Date.now()) {
  const plan = validateOwnerBootstrapPlan(rawPlan);
  if (!record(snapshot) || snapshot.version !== 1 || !['register','fund'].includes(kind) || snapshot.network !== 'testnet' ||
      snapshot.owner !== plan.account_id || snapshot.public_key !== plan.public_key || snapshot.vault !== newTestnetVaultId(plan) ||
      snapshot.circle_token !== CIRCLE || snapshot.vault_code_hash !== V11_NEAR_CODE_HASH || snapshot.vault_key_count !== 0 ||
      snapshot.signed !== false || snapshot.sent !== false || snapshot.seller_contacted !== false ||
      (kind === 'register' ? snapshot.register_eligible !== true : snapshot.fund_eligible !== true) ||
      pinnedAccessKeyNonce(snapshot.owner_key_nonce) === null) throw new Error('fresh Circle vault snapshot is not eligible');
  assertFreshFinalBlock({ header: { hash: snapshot.block_hash, timestamp_nanosec: snapshot.block_timestamp_nanosec } }, nowMs);
  const e = { version: 1, kind, network: 'testnet', owner: plan.account_id, public_key: plan.public_key, vault: snapshot.vault,
    token: CIRCLE, expected_circle_code_hash: snapshot.circle_code_hash, storage_min_yocto: snapshot.circle_storage_min_yocto,
    amount_atoms: amount, expected_owner_atoms: snapshot.owner_circle_atoms, expected_vault_atoms: snapshot.vault_actual_circle_atoms,
    expected_tracked_atoms: snapshot.vault_tracked_circle_atoms, expected_registration: snapshot.vault_circle_registration,
    nonce: (pinnedAccessKeyNonce(snapshot.owner_key_nonce) + 1n).toString(), block_hash: snapshot.block_hash, do_not_blindly_resend: true };
  check(e, plan); return e;
}
export async function signVaultCircle({ plan: raw, snapshot, kind, amountAtoms, keyPair, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(raw), e = validateVaultCircleSnapshot(snapshot, plan, kind, amountAtoms, nowMs);
  if (!keyPair || String(keyPair.getPublicKey()) !== plan.public_key) throw new Error('owner key does not match Circle vault plan');
  const tx = nearApi.transactions.createTransaction(plan.account_id, keyPair.getPublicKey(), CIRCLE, BigInt(e.nonce),
    actionsFor(e), nearApi.utils.serialize.base_decode(e.block_hash));
  const unsigned = Buffer.from(nearApi.transactions.encodeTransaction(tx)), digest = sha(unsigned);
  const [returned, signed] = await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
  if (!Buffer.from(returned ?? []).equals(digest) || !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned) ||
      signed.signature?.enum !== 'ed25519Signature' || !keyPair.getPublicKey().verify(digest, signed.signature.data)) {
    throw new Error('offline signature differs from bounded Circle vault action');
  }
  const envelope = { ...e, tx_hash: nearApi.utils.serialize.base_encode(digest),
    signed_tx_base64: Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),
    scope: 'public fixed-action bearer; no private key; retain original hash and never blindly resend' };
  verifySignedVaultCircle(envelope, plan); return envelope;
}
export function verifySignedVaultCircle(e, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan); check(e, plan);
  if (!isTransactionHash(e.tx_hash) || typeof e.signed_tx_base64 !== 'string' || e.signed_tx_base64.length > 8192 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)) {
    throw new Error('invalid signed Circle vault bearer');
  }
  const bytes = Buffer.from(e.signed_tx_base64, 'base64');
  if (!bytes.length || bytes.length > 4096 || bytes.toString('base64') !== e.signed_tx_base64) throw new Error('invalid Circle vault bytes');
  let signed; try { signed = nearApi.transactions.SignedTransaction.decode(bytes); } catch { throw new Error('invalid Circle vault bytes'); }
  const key = nearApi.utils.PublicKey.from(plan.public_key), block = nearApi.utils.serialize.base_decode(e.block_hash);
  const expected = nearApi.transactions.createTransaction(plan.account_id, key, CIRCLE, BigInt(e.nonce), actionsFor(e), block);
  const actual = Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)), digest = sha(actual);
  const signature = signed.signature?.ed25519Signature?.data;
  if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes) ||
      !actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected))) ||
      !Array.isArray(signature) || signature.length !== 64 || !key.verify(digest, Uint8Array.from(signature)) ||
      nearApi.utils.serialize.base_encode(digest) !== e.tx_hash) throw new Error('signature or Circle vault action differs');
  return signed;
}
