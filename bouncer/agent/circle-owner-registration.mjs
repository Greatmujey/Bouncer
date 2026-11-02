/** Testnet-only Circle owner registration: pinned views and one narrow offline
 * signature. This is owner setup, NOT an agent purchase. Publishing the signed
 * transaction makes it a bearer item; it can only execute its fixed action but
 * anyone can relay it before the local broadcaster's final checks. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { hasPlainOwnerProfileAt, NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const OWNER_REGISTRATION_GAS = 50n * 10n ** 12n;
export const MAX_OWNER_REGISTRATION_DEPOSIT = 10n ** 22n; // 0.01 test NEAR
const ONE_NEAR = 10n ** 24n, MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha = b => crypto.createHash('sha256').update(b).digest();

/** One single-block public inspection; it never signs or sends. */
export async function inspectCircleOwnerRegistration({ plan: raw, provider, now = Date.now } = {}) {
  const plan = validateOwnerBootstrapPlan(raw);
  if (!provider || ['viewNodeStatus', 'viewBlock', 'query', 'callFunctionRaw'].some(k => typeof provider[k] !== 'function') ||
      typeof now !== 'function') throw new Error('a read-only testnet provider and clock are required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('Circle owner registration requires testnet');
  const start = now(), block = await provider.viewBlock({ finality: 'final' }), fresh = assertFreshFinalBlock(block, start);
  const at = { block_id: fresh.hash }, view = (method, args) => readPinnedJsonView(provider, fresh.hash, CIRCLE_TESTNET_USDC, method, args);
  const [owner, keys, access, token, bounds, registration, metadata, balance] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: plan.account_id, ...at }),
    provider.query({ request_type: 'view_access_key_list', account_id: plan.account_id, ...at }),
    provider.query({ request_type: 'view_access_key', account_id: plan.account_id, public_key: plan.public_key, ...at }),
    provider.query({ request_type: 'view_account', account_id: CIRCLE_TESTNET_USDC, ...at }),
    view('storage_balance_bounds', {}), view('storage_balance_of', { account_id: plan.account_id }),
    view('ft_metadata', {}), view('ft_balance_of', { account_id: plan.account_id }),
  ]);
  const nonce = pinnedAccessKeyNonce(access?.nonce), key = keys?.keys?.[0];
  if (!hasPlainOwnerProfileAt(owner, fresh.hash) || !uint(owner.amount) || !uint(owner.locked) || owner.locked !== '0' ||
      keys?.block_hash !== fresh.hash || !Array.isArray(keys.keys) || keys.keys.length !== 1 ||
      key?.public_key !== plan.public_key || key?.access_key?.permission !== 'FullAccess' ||
      access?.block_hash !== fresh.hash || access.permission !== 'FullAccess' || nonce === null ||
      pinnedAccessKeyNonce(key.access_key.nonce) !== nonce) throw new Error('owner profile or sole full-access key is not verified at the pinned block');
  if (token?.block_hash !== fresh.hash || !isTransactionHash(token.code_hash) || token.code_hash === NO_LOCAL_CONTRACT_HASH ||
      !record(metadata) || metadata.symbol !== 'USDC' || metadata.decimals !== 6 || !uint(balance) ||
      !record(bounds) || !uint(bounds.min) || bounds.min === '0' || BigInt(bounds.min) > MAX_OWNER_REGISTRATION_DEPOSIT ||
      !(bounds.max === null || (uint(bounds.max) && BigInt(bounds.max) >= BigInt(bounds.min))) ||
      BigInt(owner.amount) < ONE_NEAR + BigInt(bounds.min)) throw new Error('Circle token identity, storage bounds or owner reserve is not verified');
  let registrationState;
  if (registration === null) registrationState = 'NOT_REGISTERED_AT_VIEW';
  else if (record(registration) && uint(registration.total) && registration.total !== '0' && uint(registration.available) &&
      BigInt(registration.available) <= BigInt(registration.total)) registrationState = 'REGISTERED_AT_VIEW';
  else throw new Error('Circle storage registration view is malformed');
  const end = now();
  if (!Number.isSafeInteger(end) || end < start) throw new Error('local clock moved backwards during owner registration views');
  assertFreshFinalBlock({ header: { hash: fresh.hash, timestamp_nanosec: block.header.timestamp_nanosec } }, end);
  return { version: 1, chain: 'testnet', owner: plan.account_id, public_key: plan.public_key,
    block_hash: fresh.hash, block_timestamp_nanosec: block.header.timestamp_nanosec,
    observed_at: new Date(end).toISOString(), owner_native_yocto: owner.amount, owner_key_count: 1,
    owner_key_nonce: nonce.toString(), circle_token: CIRCLE_TESTNET_USDC, circle_code_hash: token.code_hash,
    circle_symbol: metadata.symbol, circle_decimals: metadata.decimals, circle_storage_min_yocto: bounds.min,
    circle_registration: registrationState, circle_balance_atoms: balance,
    signed: false, sent: false, private_key_checked: false, backup_export_verified: false,
    scope: 'single trusted-RPC FINAL snapshot, not consensus proof or authorization; state and nonce may race' };
}

/** This guards one owner self-registration only. Even malicious snapshot data
 * cannot choose another receiver/method, beneficiary, gas or uncapped deposit. */
export function validateRegistrationSnapshot(snapshot, rawPlan, nowMs = Date.now()) {
  const plan = validateOwnerBootstrapPlan(rawPlan);
  if (!record(snapshot) || snapshot.version !== 1 || snapshot.chain !== 'testnet' || snapshot.owner !== plan.account_id ||
      snapshot.public_key !== plan.public_key || snapshot.circle_token !== CIRCLE_TESTNET_USDC ||
      snapshot.circle_symbol !== 'USDC' || snapshot.circle_decimals !== 6 || snapshot.owner_key_count !== 1 ||
      snapshot.circle_registration !== 'NOT_REGISTERED_AT_VIEW' || !uint(snapshot.owner_native_yocto) ||
      !uint(snapshot.circle_storage_min_yocto) || snapshot.circle_storage_min_yocto === '0' ||
      BigInt(snapshot.circle_storage_min_yocto) > MAX_OWNER_REGISTRATION_DEPOSIT ||
      BigInt(snapshot.owner_native_yocto) < ONE_NEAR + BigInt(snapshot.circle_storage_min_yocto) ||
      pinnedAccessKeyNonce(snapshot.owner_key_nonce) === null || !isTransactionHash(snapshot.circle_code_hash) ||
      snapshot.circle_code_hash === NO_LOCAL_CONTRACT_HASH || snapshot.signed !== false || snapshot.sent !== false) {
    throw new Error('snapshot is not eligible for the one testnet Circle self-registration');
  }
  assertFreshFinalBlock({ header: { hash: snapshot.block_hash, timestamp_nanosec: snapshot.block_timestamp_nanosec } }, nowMs);
  return { owner: plan.account_id, publicKey: plan.public_key, nonce: pinnedAccessKeyNonce(snapshot.owner_key_nonce),
    blockHash: snapshot.block_hash, deposit: BigInt(snapshot.circle_storage_min_yocto) };
}

/** Returns an exact bearer transaction and original hash. Caller MUST durably
 * fence the hash before making the bytes public or submitting the transaction. */
export async function signCircleOwnerRegistration({ plan, snapshot, keyPair, nowMs = Date.now() } = {}) {
  const terms = validateRegistrationSnapshot(snapshot, plan, nowMs);
  if (!keyPair || typeof keyPair.getPublicKey !== 'function' || String(keyPair.getPublicKey()) !== terms.publicKey) {
    throw new Error('local testnet owner key does not match the reviewed public key');
  }
  const decodedBlock = Buffer.from(nearApi.utils.serialize.base_decode(terms.blockHash));
  if (decodedBlock.length !== 32) throw new Error('invalid block hash');
  const action = nearApi.transactions.functionCall('storage_deposit', { account_id: terms.owner, registration_only: true },
    OWNER_REGISTRATION_GAS, terms.deposit);
  const transaction = nearApi.transactions.createTransaction(terms.owner, keyPair.getPublicKey(), CIRCLE_TESTNET_USDC,
    terms.nonce + 1n, [action], decodedBlock);
  const unsigned = Buffer.from(nearApi.transactions.encodeTransaction(transaction)), digest = sha(unsigned);
  const [returned, signed] = await new nearApi.KeyPairSigner(keyPair).signTransaction(transaction);
  if (!Buffer.from(returned ?? []).equals(digest) || !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned) ||
      signed.signature?.enum !== 'ed25519Signature' || !keyPair.getPublicKey().verify(digest, signed.signature.data)) {
    throw new Error('offline owner signature differs from the reviewed registration');
  }
  const bytes = Buffer.from(nearApi.transactions.encodeTransaction(signed));
  return { version: 1, purpose: 'one-testnet-circle-owner-registration', network: 'testnet', owner: terms.owner,
    public_key: terms.publicKey, token: CIRCLE_TESTNET_USDC, expected_circle_code_hash: snapshot.circle_code_hash,
    method: 'storage_deposit', deposit_yocto: terms.deposit.toString(),
    gas: OWNER_REGISTRATION_GAS.toString(), nonce: (terms.nonce + 1n).toString(), block_hash: terms.blockHash,
    tx_hash: nearApi.utils.serialize.base_encode(digest), signed_tx_base64: bytes.toString('base64'),
    do_not_blindly_resend: true, scope: 'public fixed-action bearer transaction; no private key is included' };
}

/** Decode, re-encode and independently authenticate the fixed action before any
 * broadcaster uses public bearer bytes. Exact metadata must match the bytes. */
export function verifySignedCircleRegistration(envelope, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan);
  if (!record(envelope) || envelope.version !== 1 || envelope.purpose !== 'one-testnet-circle-owner-registration' ||
      envelope.network !== 'testnet' || envelope.owner !== plan.account_id || envelope.public_key !== plan.public_key ||
      envelope.token !== CIRCLE_TESTNET_USDC || envelope.method !== 'storage_deposit' ||
      !uint(envelope.deposit_yocto) || envelope.deposit_yocto === '0' || BigInt(envelope.deposit_yocto) > MAX_OWNER_REGISTRATION_DEPOSIT ||
      envelope.gas !== OWNER_REGISTRATION_GAS.toString() || pinnedAccessKeyNonce(envelope.nonce) === null || envelope.nonce === '0' ||
      !isTransactionHash(envelope.block_hash) || !isTransactionHash(envelope.tx_hash) ||
      !isTransactionHash(envelope.expected_circle_code_hash) || envelope.expected_circle_code_hash === NO_LOCAL_CONTRACT_HASH ||
      envelope.do_not_blindly_resend !== true ||
      typeof envelope.signed_tx_base64 !== 'string' || envelope.signed_tx_base64.length > 8192 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.signed_tx_base64)) {
    throw new Error('invalid reviewed Circle registration envelope');
  }
  const bytes = Buffer.from(envelope.signed_tx_base64, 'base64');
  if (bytes.toString('base64') !== envelope.signed_tx_base64 || bytes.length < 1 || bytes.length > 4096) {
    throw new Error('invalid reviewed Circle registration bytes');
  }
  let signed;
  try { signed = nearApi.transactions.SignedTransaction.decode(bytes); }
  catch { throw new Error('invalid reviewed Circle registration bytes'); }
  if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)) throw new Error('noncanonical signed registration');
  const tx = signed.transaction, key = nearApi.utils.PublicKey.from(plan.public_key), data = tx?.publicKey?.ed25519Key?.data;
  const actions = tx?.actions, action = actions?.[0]?.functionCall;
  const expectedArgs = Buffer.from(JSON.stringify({ account_id: plan.account_id, registration_only: true }));
  const sig = signed.signature?.ed25519Signature?.data;
  const digest = sha(Buffer.from(nearApi.transactions.encodeTransaction(tx)));
  if (tx?.signerId !== plan.account_id || tx.receiverId !== CIRCLE_TESTNET_USDC ||
      !Array.isArray(data) || !Buffer.from(data).equals(Buffer.from(key.ed25519Key.data)) ||
      String(tx.nonce) !== envelope.nonce || nearApi.utils.serialize.base_encode(Buffer.from(tx.blockHash ?? [])) !== envelope.block_hash ||
      !Array.isArray(actions) || actions.length !== 1 || !record(actions[0]) || Object.keys(actions[0]).join(',') !== 'functionCall' ||
      action?.methodName !== 'storage_deposit' || action.gas !== OWNER_REGISTRATION_GAS ||
      String(action.deposit) !== envelope.deposit_yocto || !Buffer.from(action.args ?? []).equals(expectedArgs) ||
      !Array.isArray(sig) || sig.length !== 64 || !key.verify(digest, Uint8Array.from(sig)) ||
      nearApi.utils.serialize.base_encode(digest) !== envelope.tx_hash) throw new Error('signed registration differs from the fixed reviewed action');
  return signed;
}
