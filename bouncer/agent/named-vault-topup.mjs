/** Fixed, testnet-only transfer of six Circle test USDC from the recovered
 * named account into the existing keyless Bouncer vault. Public signed bytes
 * are a bearer transaction. Retain the original hash and never blindly retry. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateNamedRecoveryPlan } from './named-testnet-recovery.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const TOPUP_SOURCE = 'greatmujey.testnet';
export const TOPUP_VAULT = 'vault.bouncer-owner-3869c162b193fa1729515442.testnet';
export const TOPUP_VAULT_OWNER = 'bouncer-owner-3869c162b193fa1729515442.testnet';
export const TOPUP_ATOMS = '6000000';
export const TOPUP_SOURCE_BEFORE = '40000000';
export const TOPUP_VAULT_BEFORE = '6907';
const GAS = 200n * 10n ** 12n;
const U128 = (1n << 128n) - 1n;
const sha = b => crypto.createHash('sha256').update(b).digest();
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= U128;
const height = x => Number.isSafeInteger(x) && x >= 0;
const registered = x => record(x) && uint(x.total) && x.total !== '0' && uint(x.available) && BigInt(x.available) <= BigInt(x.total);
function exactKey(key, plan) {
  return key?.public_key === plan.public_key && key?.access_key?.permission === 'FullAccess';
}
function action(plan) {
  return nearApi.transactions.functionCall('ft_transfer_call', { receiver_id: TOPUP_VAULT, amount: TOPUP_ATOMS, msg: '' }, GAS, 1n);
}

/** All views use the same reported fresh FINAL block. Storage and gas checks
 * are conservative estimates, not a reservation or a guarantee of admission. */
export async function inspectNamedVaultTopup({ plan: raw, provider, now = Date.now }) {
  const plan = validateNamedRecoveryPlan(raw);
  if (!provider || typeof now !== 'function' ||
      ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw', 'experimental_protocolConfig', 'gasPrice']
        .some(name => typeof provider[name] !== 'function')) throw new Error('pinned read-only testnet provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const start = now(), block = await provider.viewBlock({ finality: 'final' }), fresh = assertFreshFinalBlock(block, start);
  if (!height(block?.header?.height)) throw new Error('FINAL block height unavailable');
  const hash = fresh.hash, query = q => provider.query({ ...q, block_id: hash });
  const view = (id, method, args) => readPinnedJsonView(provider, hash, id, method, args);
  const [source, sourceKeys, access, token, vault, vaultKeys, vaultOwner, version, sourceBalance, actual, tracked,
    sourceRegistration, vaultRegistration, protocol, gas] = await Promise.all([
    query({ request_type: 'view_account', account_id: TOPUP_SOURCE }),
    query({ request_type: 'view_access_key_list', account_id: TOPUP_SOURCE }),
    query({ request_type: 'view_access_key', account_id: TOPUP_SOURCE, public_key: plan.public_key }),
    query({ request_type: 'view_account', account_id: plan.circle_token }),
    query({ request_type: 'view_account', account_id: TOPUP_VAULT }),
    query({ request_type: 'view_access_key_list', account_id: TOPUP_VAULT }),
    view(TOPUP_VAULT, 'get_owner', {}), view(TOPUP_VAULT, 'contract_version', {}),
    view(plan.circle_token, 'ft_balance_of', { account_id: TOPUP_SOURCE }),
    view(plan.circle_token, 'ft_balance_of', { account_id: TOPUP_VAULT }),
    view(TOPUP_VAULT, 'vault_balance', { token: plan.circle_token }),
    view(plan.circle_token, 'storage_balance_of', { account_id: TOPUP_SOURCE }),
    view(plan.circle_token, 'storage_balance_of', { account_id: TOPUP_VAULT }),
    provider.experimental_protocolConfig({ blockId: hash }), provider.gasPrice(hash),
  ]);
  const nonce = pinnedAccessKeyNonce(access?.nonce), listedNonce = pinnedAccessKeyNonce(sourceKeys?.keys?.[0]?.access_key?.nonce);
  if (!hasPlainOwnerProfileAt(source, hash) || !uint(source.amount) || source.locked !== '0' ||
      !Number.isSafeInteger(source.storage_usage) || source.storage_usage < 0 ||
      sourceKeys?.block_hash !== hash || !Array.isArray(sourceKeys.keys) || sourceKeys.keys.length !== 1 ||
      !exactKey(sourceKeys.keys[0], plan) || access?.block_hash !== hash || access.permission !== 'FullAccess' ||
      nonce === null || listedNonce !== nonce || token?.block_hash !== hash || token.code_hash !== plan.circle_code_hash ||
      vault?.block_hash !== hash || vault.code_hash !== V11_NEAR_CODE_HASH || !uint(vault.amount) ||
      !Number.isSafeInteger(vault.storage_usage) || vault.storage_usage < 0 || vaultKeys?.block_hash !== hash ||
      !Array.isArray(vaultKeys.keys) || vaultKeys.keys.length !== 0 || vaultOwner !== TOPUP_VAULT_OWNER ||
      version !== 'bouncer-agent-v11-exact-ft-testnet' || !uint(sourceBalance) || !uint(actual) || !uint(tracked) ||
      !registered(sourceRegistration) || !registered(vaultRegistration) || protocol?.chain_id !== 'testnet' ||
      !uint(protocol?.runtime_config?.storage_amount_per_byte) || protocol.runtime_config.storage_amount_per_byte === '0' ||
      !height(protocol.transaction_validity_period) || protocol.transaction_validity_period === 0 ||
      !uint(gas?.gas_price) || gas.gas_price === '0') throw new Error('named account, keyless vault, Circle or pinned protocol state differs');
  const bytePrice = BigInt(protocol.runtime_config.storage_amount_per_byte);
  const sourceAvailable = BigInt(source.amount) - BigInt(source.storage_usage) * bytePrice;
  const vaultAvailable = BigInt(vault.amount) - BigInt(vault.storage_usage) * bytePrice;
  const estimate = GAS * BigInt(gas.gas_price) * 13n / 10n + 10n ** 21n + 1n;
  if (estimate > U128 || sourceAvailable < estimate || vaultAvailable < 10n ** 22n) throw new Error('estimated testnet gas or vault storage headroom is insufficient');
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: block.header.timestamp_nanosec } }, end);
  return { version: 1, network: 'testnet', source: TOPUP_SOURCE, public_key: plan.public_key,
    vault: TOPUP_VAULT, vault_owner: TOPUP_VAULT_OWNER, token: plan.circle_token,
    circle_code_hash: token.code_hash, vault_code_hash: vault.code_hash, vault_key_count: 0,
    block_hash: hash, block_height: block.header.height, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(end).toISOString(), source_key_nonce: nonce.toString(),
    source_circle_atoms: sourceBalance, vault_actual_circle_atoms: actual, vault_tracked_circle_atoms: tracked,
    source_registered: true, vault_registered: true, source_native_available_yocto: sourceAvailable.toString(),
    vault_native_available_yocto: vaultAvailable.toString(), estimated_gas_yocto: estimate.toString(),
    validity_period_blocks: protocol.transaction_validity_period, signed: false, sent: false,
    scope: 'pinned trusted-RPC testnet views and estimated headroom; no signature, transfer, provider purchase or delivery' };
}

/** A pre-sign/pre-send snapshot must still match the one narrow intended topup. */
export function assertNamedVaultTopupBefore(view, raw, nowMs = Date.now()) {
  const plan = validateNamedRecoveryPlan(raw);
  if (!record(view) || view.version !== 1 || view.network !== 'testnet' || view.source !== TOPUP_SOURCE ||
      view.public_key !== plan.public_key || view.vault !== TOPUP_VAULT || view.vault_owner !== TOPUP_VAULT_OWNER ||
      view.token !== plan.circle_token || view.circle_code_hash !== plan.circle_code_hash || view.vault_code_hash !== V11_NEAR_CODE_HASH ||
      view.vault_key_count !== 0 || !height(view.block_height) || pinnedAccessKeyNonce(view.source_key_nonce) === null ||
      view.source_circle_atoms !== TOPUP_SOURCE_BEFORE || view.vault_actual_circle_atoms !== TOPUP_VAULT_BEFORE ||
      view.vault_tracked_circle_atoms !== TOPUP_VAULT_BEFORE || view.source_registered !== true || view.vault_registered !== true ||
      !uint(view.source_native_available_yocto) || !uint(view.vault_native_available_yocto) || !uint(view.estimated_gas_yocto) ||
      BigInt(view.source_native_available_yocto) < BigInt(view.estimated_gas_yocto) ||
      BigInt(view.vault_native_available_yocto) < 10n ** 22n || !height(view.validity_period_blocks) || view.validity_period_blocks === 0 ||
      view.signed !== false || view.sent !== false) throw new Error('fresh fixed topup state differs');
  assertFreshFinalBlock({ header: { hash: view.block_hash, timestamp_nanosec: view.block_timestamp_nanosec } }, nowMs);
  return view;
}

function expectedTerms(e, plan) {
  if (!record(e) || e.version !== 1 || e.network !== 'testnet' || e.source !== TOPUP_SOURCE || e.public_key !== plan.public_key ||
      e.vault !== TOPUP_VAULT || e.token !== plan.circle_token || e.amount_atoms !== TOPUP_ATOMS ||
      e.source_before_atoms !== TOPUP_SOURCE_BEFORE || e.vault_before_atoms !== TOPUP_VAULT_BEFORE ||
      !isTransactionHash(e.block_hash) || !height(e.block_height) || pinnedAccessKeyNonce(e.nonce) === null || e.nonce === '0' ||
      e.do_not_blindly_resend !== true) throw new Error('invalid fixed topup envelope');
}
export async function signNamedVaultTopup({ plan: raw, snapshot, keyPair, nowMs = Date.now() }) {
  const plan = validateNamedRecoveryPlan(raw), view = assertNamedVaultTopupBefore(snapshot, plan, nowMs);
  if (!keyPair || String(keyPair.getPublicKey()) !== plan.public_key) throw new Error('local testnet key does not match recovery plan');
  const nonce = (pinnedAccessKeyNonce(view.source_key_nonce) + 1n).toString();
  const tx = nearApi.transactions.createTransaction(TOPUP_SOURCE, keyPair.getPublicKey(), plan.circle_token, BigInt(nonce),
    [action(plan)], nearApi.utils.serialize.base_decode(view.block_hash));
  const unsigned = Buffer.from(nearApi.transactions.encodeTransaction(tx)), digest = sha(unsigned);
  const [returned, signed] = await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
  if (!Buffer.from(returned ?? []).equals(digest) || !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned) ||
      signed.signature?.enum !== 'ed25519Signature' || !keyPair.getPublicKey().verify(digest, signed.signature.data)) {
    throw new Error('offline topup signature differs from the fixed action');
  }
  const e = { version: 1, network: 'testnet', source: TOPUP_SOURCE, public_key: plan.public_key, vault: TOPUP_VAULT,
    token: plan.circle_token, amount_atoms: TOPUP_ATOMS, source_before_atoms: TOPUP_SOURCE_BEFORE,
    vault_before_atoms: TOPUP_VAULT_BEFORE, nonce, block_hash: view.block_hash, block_height: view.block_height,
    tx_hash: nearApi.utils.serialize.base_encode(digest), signed_tx_base64: Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),
    do_not_blindly_resend: true, scope: 'public fixed-action bearer; preserve the original hash, never blindly resend' };
  verifySignedNamedVaultTopup(e, plan); return e;
}
export function verifySignedNamedVaultTopup(e, raw) {
  const plan = validateNamedRecoveryPlan(raw); expectedTerms(e, plan);
  if (!isTransactionHash(e.tx_hash) || typeof e.signed_tx_base64 !== 'string' || e.signed_tx_base64.length > 8192 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)) throw new Error('invalid signed topup bearer');
  const bytes = Buffer.from(e.signed_tx_base64, 'base64');
  if (!bytes.length || bytes.length > 4096 || bytes.toString('base64') !== e.signed_tx_base64) throw new Error('invalid signed topup bytes');
  let signed; try { signed = nearApi.transactions.SignedTransaction.decode(bytes); } catch { throw new Error('invalid signed topup bytes'); }
  const key = nearApi.utils.PublicKey.from(plan.public_key);
  const expected = nearApi.transactions.createTransaction(TOPUP_SOURCE, key, plan.circle_token, BigInt(e.nonce),
    [action(plan)], nearApi.utils.serialize.base_decode(e.block_hash));
  const actual = Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)), digest = sha(actual);
  const signature = signed.signature?.ed25519Signature?.data;
  if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes) ||
      !actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected))) ||
      !Array.isArray(signature) || signature.length !== 64 || !key.verify(digest, Uint8Array.from(signature)) ||
      nearApi.utils.serialize.base_encode(digest) !== e.tx_hash) throw new Error('signed topup does not match the fixed terms');
  return signed;
}
