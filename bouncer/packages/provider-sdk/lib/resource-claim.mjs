/**
 * Experimental testnet seller-v3 claim authorization. NEP-413 domain
 * separation prevents this signature from authorizing an on-chain action.
 * The verifier must ALSO anchor `public_key` to the FINAL payment transaction
 * and atomically claim seller-issued quote + hash before fulfillment.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount, isTestnetToken } from './account-id.mjs';
import { isTransactionHash } from './direct-payment-settlement.mjs';

export const CLAIM_SCHEME = 'bouncer-nep413-claim-v1';
const DOMAIN = 'bouncer:resource-claim:v1';
const PREFIX = 0x80000000 + 413; // NEP-413 off-chain message tag, u32 little endian
const fields = ['network', 'contract_id', 'owner_account_id', 'seller_origin', 'resource', 'policy_id', 'token', 'payee', 'amount', 'memo', 'tx_hash'];
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const safe = (value, max) => typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);

/** A reviewed origin, never derived from the HTTP Host header. */
export function canonicalClaimOrigin(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 2048) throw new Error('invalid seller origin');
  let u;
  try { u = new URL(input); } catch { throw new Error('invalid seller origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password ||
      u.pathname !== '/' || u.search || u.hash || input !== u.origin) throw new Error('seller origin must be canonical HTTPS or loopback HTTP');
  return u.origin;
}

/** All fields must come from the reviewed buyer request or the seller's stored quote, never from an untrusted claim body. */
export function validateClaimTerms(input) {
  if (!exact(input, fields) || input.network !== 'near:testnet' || !isTestnetAccount(input.contract_id) ||
      !isTestnetAccount(input.owner_account_id) || !isTestnetAccount(input.payee) || !isTestnetToken(input.token) ||
      !isTransactionHash(input.tx_hash) || !['compute', 'storage', 'api'].includes(input.resource) ||
      !safe(input.policy_id, 128) || typeof input.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(input.amount) ||
      BigInt(input.amount) > (1n << 128n) - 1n || typeof input.memo !== 'string' ||
      !new RegExp(`^bouncer-order-v3:${input.resource}:[a-f0-9]{32}:[a-f0-9]{64}$`).test(input.memo)) {
    throw new Error('invalid authenticated claim terms');
  }
  canonicalClaimOrigin(input.seller_origin);
  return Object.fromEntries(fields.map(key => [key, input[key]]));
}

/** Canonical UTF-8 JSON array; positions and domain are fixed by this protocol version. */
export function claimMessage(input) {
  const v = validateClaimTerms(input);
  return JSON.stringify([DOMAIN, ...fields.map(key => v[key])]);
}

function borshString(value) {
  const bytes = Buffer.from(value, 'utf8'), length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
/** Independently construct NEP-413 bytes, including no callback URL. */
export function claimDigest(input) {
  const v = validateClaimTerms(input), tag = Buffer.alloc(4);
  tag.writeUInt32LE(PREFIX);
  const nonce = Buffer.from(nearApi.utils.serialize.base_decode(v.tx_hash));
  return crypto.createHash('sha256').update(Buffer.concat([tag, borshString(claimMessage(v)), nonce,
    borshString(v.payee), Buffer.from([0])])).digest();
}
function ed25519Key(value) {
  if (typeof value !== 'string' || !value.startsWith('ed25519:')) throw new Error('claim requires an ed25519 public key');
  try {
    const key = nearApi.utils.PublicKey.from(value);
    if (key.keyType !== 0 || key.toString() !== value) throw new Error();
    return key;
  } catch { throw new Error('claim requires a canonical ed25519 public key'); }
}
function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new Error('invalid claim signature');
  const result = Buffer.from(value, 'base64');
  if (result.length !== 64 || result.toString('base64') !== value) throw new Error('invalid claim signature');
  return result;
}

/** Verify an authorization against seller/buyer-owned terms and the expected transaction signing key. */
export function verifyClaimAuthorization(input, authorization, expectedPublicKey) {
  const terms = validateClaimTerms(input);
  if (!exact(authorization, ['scheme', 'public_key', 'signature']) || authorization.scheme !== CLAIM_SCHEME ||
      authorization.public_key !== expectedPublicKey) throw new Error('claim authorization does not match the transaction signing key');
  const key = ed25519Key(expectedPublicKey), signature = signatureBytes(authorization.signature);
  let valid = false;
  try { valid = key.verify(claimDigest(terms), signature); } catch { /* malformed signatures fail closed */ }
  if (!valid) throw new Error('invalid authenticated claim signature');
  return true;
}

/** Sign only the reviewed off-chain claim; verify signer identity and bytes before returning it. */
export async function signClaimAuthorization({ terms: input, signer, publicKey }) {
  const terms = validateClaimTerms(input), key = String(publicKey);
  ed25519Key(key);
  if (!signer || typeof signer.getPublicKey !== 'function' || typeof signer.signNep413Message !== 'function' ||
      String(await signer.getPublicKey()) !== key) throw new Error('claim signer does not match the reviewed agent key');
  const nonce = nearApi.utils.serialize.base_decode(terms.tx_hash);
  const signed = await signer.signNep413Message(claimMessage(terms), terms.owner_account_id, terms.payee, nonce);
  if (signed?.accountId !== terms.owner_account_id || String(signed?.publicKey) !== key || !(signed?.signature instanceof Uint8Array)) {
    throw new Error('claim signer returned a different account or key');
  }
  const authorization = { scheme: CLAIM_SCHEME, public_key: key, signature: Buffer.from(signed.signature).toString('base64') };
  verifyClaimAuthorization(terms, authorization, key);
  return authorization;
}
