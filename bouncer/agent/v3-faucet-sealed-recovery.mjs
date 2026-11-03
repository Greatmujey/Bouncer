/** Recovery envelope for a temporary faucet journal, NOT the V3 owner key.
 * A random file-journal key is encrypted to the existing Ed25519 owner public
 * key using an ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM. The owner
 * private key is never needed by the funding runner. The retained journal is
 * an immutable PRE-HELPER snapshot: public check records are authoritative
 * for later original hashes; this envelope does not establish freshness. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv, x25519 } from '@noble/curves/ed25519';

const FORMAT = 'bouncer-v3-faucet-recovery-v1';
const INFO = Buffer.from(`${FORMAT}:x25519-hkdf-sha256-aes-256-gcm`);
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = () => new Error('invalid or unauthenticated faucet recovery envelope');
const b64 = (s, n) => {
  if (typeof s !== 'string') throw fail();
  const b = Buffer.from(s, 'base64');
  if (b.length !== n || b.toString('base64') !== s) throw fail();
  return b;
};
function ownerKey(publicKey) {
  try {
    const k = nearApi.utils.PublicKey.from(publicKey);
    if (k.keyType !== 0 || String(k) !== publicKey || k.data.length !== 32) throw fail();
    return Buffer.from(k.data);
  } catch { throw fail(); }
}
function context(value) {
  if (!record(value) || Object.keys(value).sort().join(',') !==
      'journal_sha256,owner_account,owner_public_key,temporary_account,temporary_public_key' ||
      !/^bouncer-owner-[a-f0-9]{24}\.testnet$/.test(value.owner_account ?? '') ||
      !/^bouncer-faucet-[a-f0-9]{32}\.testnet$/.test(value.temporary_account ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.journal_sha256 ?? '')) throw fail();
  ownerKey(value.owner_public_key); ownerKey(value.temporary_public_key);
  return { owner_account: value.owner_account, owner_public_key: value.owner_public_key,
    temporary_account: value.temporary_account, temporary_public_key: value.temporary_public_key,
    journal_sha256: value.journal_sha256 };
}
function aad(c, ep, salt, nonce) {
  return Buffer.from(JSON.stringify([FORMAT, c.owner_account, c.owner_public_key, c.temporary_account,
    c.temporary_public_key, c.journal_sha256, ep, salt, nonce]));
}
function derive(shared, salt) { return Buffer.from(crypto.hkdfSync('sha256', shared, salt, INFO, 32)); }

/** Ciphertext and all context fields may be made public. The original key and
 * any temporary secret must never be logged or placed in the artifact. */
export function sealFaucetRecoveryKey({ key, ownerAccount, ownerPublicKey, temporaryAccount, temporaryPublicKey, journalBytes }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(journalBytes) || !journalBytes.length) throw fail();
  const c = context({ owner_account: ownerAccount, owner_public_key: ownerPublicKey, temporary_account: temporaryAccount,
    temporary_public_key: temporaryPublicKey, journal_sha256: sha(journalBytes) });
  let secret = crypto.randomBytes(32), shared, wrapping;
  try {
    const ep = Buffer.from(x25519.getPublicKey(secret)).toString('base64');
    const saltBytes = crypto.randomBytes(32), nonceBytes = crypto.randomBytes(12);
    const salt = saltBytes.toString('base64'), nonce = nonceBytes.toString('base64');
    shared = Buffer.from(x25519.getSharedSecret(secret, edwardsToMontgomeryPub(ownerKey(c.owner_public_key))));
    wrapping = derive(shared, saltBytes);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonceBytes);
    cipher.setAAD(aad(c, ep, salt, nonce));
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Verify the ciphertext before publishing it; owner-side conversion is
    // independently exercised by the deterministic and random-key tests.
    const check = crypto.createDecipheriv('aes-256-gcm', wrapping, nonceBytes);
    check.setAAD(aad(c, ep, salt, nonce)); check.setAuthTag(tag);
    const recovered = Buffer.concat([check.update(ciphertext), check.final()]);
    const equal = crypto.timingSafeEqual(recovered, key); recovered.fill(0);
    if (!equal) throw fail();
    return { format: FORMAT, context: c, ephemeral_x25519: ep, salt, nonce,
      ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') };
  } finally { secret?.fill(0); shared?.fill(0); wrapping?.fill(0); }
}

/** Call only in a trusted private environment after the backed-up owner key is
 * restored. Returned bytes are the temporary journal key, not the owner key. */
export function openFaucetRecoveryKey({ envelope, journalBytes, ownerSecretKey }) {
  if (!record(envelope) || Object.keys(envelope).sort().join(',') !==
      'ciphertext,context,ephemeral_x25519,format,nonce,salt,tag' || envelope.format !== FORMAT ||
      !Buffer.isBuffer(journalBytes) || !journalBytes.length) throw fail();
  const c = context(envelope.context);
  if (sha(journalBytes) !== c.journal_sha256) throw fail();
  const ep = b64(envelope.ephemeral_x25519, 32), salt = b64(envelope.salt, 32), nonce = b64(envelope.nonce, 12);
  const ciphertext = b64(envelope.ciphertext, 32), tag = b64(envelope.tag, 16);
  let seed, privateKey, shared, wrapping;
  try {
    const pair = nearApi.KeyPair.fromString(ownerSecretKey);
    if (String(pair.getPublicKey()) !== c.owner_public_key) throw fail();
    const raw = Buffer.from(nearApi.utils.serialize.base_decode(pair.toString().replace(/^ed25519:/, '')));
    if (raw.length !== 64) { raw.fill(0); throw fail(); }
    seed = Buffer.from(raw.subarray(0, 32)); raw.fill(0);
    privateKey = Buffer.from(edwardsToMontgomeryPriv(seed));
    shared = Buffer.from(x25519.getSharedSecret(privateKey, ep)); wrapping = derive(shared, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, nonce);
    decipher.setAAD(aad(c, envelope.ephemeral_x25519, envelope.salt, envelope.nonce)); decipher.setAuthTag(tag);
    const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (key.length !== 32) { key.fill(0); throw fail(); }
    return key;
  } catch { throw fail(); }
  finally { seed?.fill(0); privateKey?.fill(0); shared?.fill(0); wrapping?.fill(0); }
}

export function faucetRecoveryBundleDigest(journalBytes, envelopeBytes) {
  if (!Buffer.isBuffer(journalBytes) || !journalBytes.length || !Buffer.isBuffer(envelopeBytes) || !envelopeBytes.length) throw fail();
  const h = crypto.createHash('sha256');
  for (const value of [journalBytes, envelopeBytes]) {
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(value.length)); h.update(length); h.update(value);
  }
  return h.digest('hex');
}
