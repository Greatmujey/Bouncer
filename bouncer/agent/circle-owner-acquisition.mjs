/** Narrow, offline testnet owner funding actions. Only 0.01 test NEAR can be
 * wrapped and one reviewed Ref swap can spend that amount for Circle testnet
 * USDC. Signed bytes are public bearer transactions, not private keys; any
 * observer can relay the same fixed bytes before a broadcaster's preflight. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as CIRCLE, WRAP_TESTNET as WRAP, REF_TESTNET as REF } from '../scripts/circle-testnet-setup.mjs';
import { ACQUISITION_INPUT_YOCTO as INPUT, ACQUISITION_POOLS as POOLS,
  ACQUISITION_MIN_USDC_ATOMS as MIN, ACQUISITION_MAX_USDC_ATOMS as MAX_OUT } from './circle-owner-acquisition-readiness.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';

const TGAS = 10n ** 12n, MAX_STORAGE = 10n ** 22n, RESERVE = 10n ** 24n, MAX = (1n << 128n) - 1n;
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= MAX;
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sha = x => crypto.createHash('sha256').update(x).digest();
const code = x => isTransactionHash(x) && x !== NO_LOCAL_CONTRACT_HASH;

function checkTerms(e, plan) {
  if (!record(e) || e.version !== 1 || !['wrap', 'swap'].includes(e.kind) || e.network !== 'testnet' ||
      e.owner !== plan.account_id || e.public_key !== plan.public_key || e.receiver !== WRAP || e.circle_token !== CIRCLE || e.ref_exchange !== REF ||
      e.input_yocto !== INPUT || !code(e.expected_wrap_code_hash) || !code(e.expected_circle_code_hash) ||
      !['REGISTERED_AT_VIEW', 'NOT_REGISTERED_AT_VIEW'].includes(e.expected_wrap_registration) ||
      !uint(e.wrap_storage_min_yocto) || e.wrap_storage_min_yocto === '0' || BigInt(e.wrap_storage_min_yocto) > MAX_STORAGE ||
      !uint(e.expected_wrap_before) || !uint(e.expected_circle_before) || !POOLS.includes(e.pool_id) ||
      !uint(e.quote_atoms) || !uint(e.min_output_atoms) || BigInt(e.quote_atoms) > BigInt(MAX_OUT) ||
      BigInt(e.min_output_atoms) < BigInt(MIN) || BigInt(e.min_output_atoms) !== BigInt(e.quote_atoms) * 95n / 100n ||
      !isTransactionHash(e.block_hash) || pinnedAccessKeyNonce(e.nonce) === null || e.nonce === '0' || e.do_not_blindly_resend !== true ||
      (e.kind === 'wrap' && e.expected_wrap_before !== '0') ||
      (e.kind === 'swap' && (e.expected_wrap_registration !== 'REGISTERED_AT_VIEW' ||
        BigInt(e.expected_wrap_before) < BigInt(INPUT) || e.expected_circle_before !== '0'))) {
    throw new Error('invalid bounded testnet acquisition terms');
  }
}

/** Exact action list built from constrained terms, never an arbitrary call. */
function actionsFor(e) {
  const { transactions: tx } = nearApi;
  if (e.kind === 'wrap') {
    const items = [];
    if (e.expected_wrap_registration === 'NOT_REGISTERED_AT_VIEW') items.push(tx.functionCall('storage_deposit',
      { account_id: e.owner, registration_only: true }, 50n * TGAS, BigInt(e.wrap_storage_min_yocto)));
    items.push(tx.functionCall('near_deposit', {}, 50n * TGAS, BigInt(INPUT)));
    return items;
  }
  const msg = JSON.stringify({ force: 0, actions: [{ pool_id: e.pool_id, token_in: WRAP,
    token_out: CIRCLE, amount_in: INPUT, min_amount_out: e.min_output_atoms }] });
  return [tx.functionCall('ft_transfer_call', { receiver_id: REF, amount: INPUT, msg }, 300n * TGAS, 1n)];
}

export function validateAcquisitionSnapshot(snapshot, rawPlan, kind, nowMs = Date.now()) {
  const plan = validateOwnerBootstrapPlan(rawPlan);
  if (!record(snapshot) || snapshot.version !== 1 || !['wrap', 'swap'].includes(kind) || snapshot.chain !== 'testnet' ||
      snapshot.owner !== plan.account_id || snapshot.public_key !== plan.public_key || snapshot.owner_key_count !== 1 ||
      snapshot.circle_token !== CIRCLE || snapshot.circle_registration !== 'REGISTERED_AT_VIEW' || snapshot.circle_symbol !== 'USDC' ||
      snapshot.circle_decimals !== 6 || snapshot.wrap_token !== WRAP || snapshot.wrap_symbol !== 'wNEAR' || snapshot.wrap_decimals !== 24 ||
      snapshot.ref_exchange !== REF || snapshot.ref_wrap_registration !== 'REGISTERED_AT_VIEW' || snapshot.ref_circle_registration !== 'REGISTERED_AT_VIEW' ||
      snapshot.acquisition_input_yocto !== INPUT || snapshot.max_usdc_atoms !== MAX_OUT || !record(snapshot.selected) ||
      !uint(snapshot.owner_native_yocto) || !uint(snapshot.wrap_storage_min_yocto) || !uint(snapshot.owner_wrap_balance_yocto) ||
      !uint(snapshot.circle_balance_atoms) || BigInt(snapshot.owner_native_yocto) < RESERVE + BigInt(INPUT) + BigInt(snapshot.wrap_storage_min_yocto) ||
      pinnedAccessKeyNonce(snapshot.owner_key_nonce) === null || snapshot.signed !== false || snapshot.sent !== false) {
    throw new Error('fresh testnet acquisition snapshot is not eligible');
  }
  assertFreshFinalBlock({ header: { hash: snapshot.block_hash, timestamp_nanosec: snapshot.block_timestamp_nanosec } }, nowMs);
  const current = pinnedAccessKeyNonce(snapshot.owner_key_nonce);
  const e = { version: 1, kind, network: 'testnet', owner: plan.account_id, public_key: plan.public_key, receiver: WRAP,
    circle_token: CIRCLE, ref_exchange: REF, input_yocto: INPUT, expected_wrap_code_hash: snapshot.wrap_code_hash,
    expected_circle_code_hash: snapshot.circle_code_hash, expected_wrap_registration: snapshot.owner_wrap_registration,
    wrap_storage_min_yocto: snapshot.wrap_storage_min_yocto, expected_wrap_before: snapshot.owner_wrap_balance_yocto,
    expected_circle_before: snapshot.circle_balance_atoms, pool_id: snapshot.selected.pool_id,
    quote_atoms: snapshot.selected.quote_atoms, min_output_atoms: snapshot.selected.min_output_atoms,
    nonce: (current + 1n).toString(), block_hash: snapshot.block_hash, do_not_blindly_resend: true };
  checkTerms(e, plan);
  return e;
}

export async function signOwnerAcquisition({ plan: rawPlan, snapshot, kind, keyPair, nowMs = Date.now() } = {}) {
  const plan = validateOwnerBootstrapPlan(rawPlan), e = validateAcquisitionSnapshot(snapshot, plan, kind, nowMs);
  if (!keyPair || typeof keyPair.getPublicKey !== 'function' || String(keyPair.getPublicKey()) !== plan.public_key) {
    throw new Error('local testnet owner key does not match acquisition plan');
  }
  const hash = Buffer.from(nearApi.utils.serialize.base_decode(e.block_hash));
  if (hash.length !== 32) throw new Error('invalid acquisition block hash');
  const tx = nearApi.transactions.createTransaction(e.owner, keyPair.getPublicKey(), WRAP, BigInt(e.nonce), actionsFor(e), hash);
  const unsigned = Buffer.from(nearApi.transactions.encodeTransaction(tx)), digest = sha(unsigned);
  const [returned, signed] = await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
  if (!Buffer.from(returned ?? []).equals(digest) || !Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned) ||
      signed.signature?.enum !== 'ed25519Signature' || !keyPair.getPublicKey().verify(digest, signed.signature.data)) {
    throw new Error('offline acquisition signature differs from the reviewed fixed actions');
  }
  return { ...e, tx_hash: nearApi.utils.serialize.base_encode(digest),
    signed_tx_base64: Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),
    scope: 'public fixed-action bearer; private key not included, original hash must be retained' };
}

export function verifySignedOwnerAcquisition(e, rawPlan) {
  const plan = validateOwnerBootstrapPlan(rawPlan); checkTerms(e, plan);
  if (!isTransactionHash(e.tx_hash) || typeof e.signed_tx_base64 !== 'string' || e.signed_tx_base64.length > 8192 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)) {
    throw new Error('invalid signed testnet acquisition envelope');
  }
  const bytes = Buffer.from(e.signed_tx_base64, 'base64');
  if (!bytes.length || bytes.length > 4096 || bytes.toString('base64') !== e.signed_tx_base64) throw new Error('invalid signed acquisition bytes');
  let signed;
  try { signed = nearApi.transactions.SignedTransaction.decode(bytes); }
  catch { throw new Error('invalid signed acquisition bytes'); }
  const key = nearApi.utils.PublicKey.from(plan.public_key), block = Buffer.from(nearApi.utils.serialize.base_decode(e.block_hash));
  if (block.length !== 32 || !Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)) throw new Error('noncanonical acquisition bytes');
  const expected = nearApi.transactions.createTransaction(plan.account_id, key, WRAP, BigInt(e.nonce), actionsFor(e), block);
  const actual = Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction));
  const digest = sha(actual), sig = signed.signature?.ed25519Signature?.data;
  if (!actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected))) || !Array.isArray(sig) || sig.length !== 64 ||
      !key.verify(digest, Uint8Array.from(sig)) || nearApi.utils.serialize.base_encode(digest) !== e.tx_hash) {
    throw new Error('signed acquisition differs from the fixed reviewed actions');
  }
  return signed;
}
