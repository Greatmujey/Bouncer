/**
 * Seal disposable TESTNET demo credentials to an operator-held RSA public key.
 * RSA-OAEP-SHA256 wraps a fresh AES-256-GCM key; the public key identifier and
 * version are authenticated as AAD. This protects artifact/log confidentiality
 * only while the private key remains secret and available. It does not prove
 * who created an envelope: validate recovered public keys against the chain.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const ALG = 'RSA-OAEP-SHA256+A256GCM', MAX_PLAINTEXT = 4096;
const envelopeFields = ['version', 'algorithm', 'key_id', 'wrapped_key', 'iv', 'ciphertext', 'tag'];
const payloadFieldsV1 = ['version', 'owner_account_id', 'contract_id', 'router_id', 'owner_secret', 'input_secret', 'sweep_secret'];
const payloadFieldsV2 = [...payloadFieldsV1, 'contract_secret', 'router_secret'];
const payloadFieldsV3 = ['version', 'purpose', 'owner_account_id', 'contract_id', 'owner_secret', 'contract_secret', 'funding_secret', 'project_secret'];
const payloadFieldsV4 = ['version', 'purpose', 'owner_account_id', 'contract_id', 'router_id', 'sweep_secret', 'original_hash', 'challenge', 'run_id'];
const payloadFieldsV5 = ['version', 'purpose', 'owner_account_id', 'contract_id', 'owner_secret', 'contract_secret', 'agent_secret', 'session_secret'];
const owns = (obj, fields) => !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === fields.length && fields.every(k => Object.hasOwn(obj, k));
function keyInfo(raw, privateRequired = false) {
  let key;
  try { key = privateRequired ? crypto.createPrivateKey(raw) : crypto.createPublicKey(raw); }
  catch { throw new Error('invalid recovery key'); }
  if (key.asymmetricKeyType !== 'rsa' || !Number.isSafeInteger(key.asymmetricKeyDetails?.modulusLength) ||
      key.asymmetricKeyDetails.modulusLength < 3072 || key.asymmetricKeyDetails.modulusLength > 8192) throw new Error('recovery key must be RSA 3072–8192 bits');
  const pub = privateRequired ? crypto.createPublicKey(key) : key;
  const der = pub.export({ type: 'spki', format: 'der' });
  return { key, id: crypto.createHash('sha256').update(der).digest('hex'), bytes: Math.ceil(key.asymmetricKeyDetails.modulusLength / 8) };
}
function payloadCheck(payload) {
  const fields = payload?.version === 1 ? payloadFieldsV1 : payload?.version === 2 ? payloadFieldsV2 :
    payload?.version === 3 ? payloadFieldsV3 : payload?.version === 4 ? payloadFieldsV4 : payload?.version === 5 ? payloadFieldsV5 : null;
  const accounts = [3, 5].includes(payload?.version) ? [payload.owner_account_id, payload.contract_id] :
    [payload?.owner_account_id, payload?.contract_id, payload?.router_id];
  if (!fields || !owns(payload, fields) || !accounts.every(isTestnetAccount) || new Set(accounts).size !== accounts.length ||
      (payload.version === 3 && payload.purpose !== 'outlayer-vrf-testnet') ||
      (payload.version === 5 && payload.purpose !== 'youtick-play-grant-testnet') ||
      (payload.version === 4 && (payload.purpose !== 'ref-sweep-once-testnet' || !isTransactionHash(payload.original_hash) ||
        typeof payload.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(payload.challenge) ||
        typeof payload.run_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(payload.run_id)))) throw new Error('invalid disposable testnet recovery payload');
  const secrets = payload.version === 4 ? ['sweep_secret'] : payload.version === 3 ? ['owner_secret', 'contract_secret', 'funding_secret', 'project_secret'] :
    payload.version === 5 ? ['owner_secret', 'contract_secret', 'agent_secret', 'session_secret'] :
    ['owner_secret', 'input_secret', 'sweep_secret', ...(payload.version === 2 ? ['contract_secret', 'router_secret'] : [])];
  if (new Set(secrets.map(field => payload[field])).size !== secrets.length) throw new Error('testnet recovery keys must be distinct');
  for (const field of secrets) {
    if (typeof payload[field] !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(payload[field])) throw new Error('invalid disposable testnet secret key');
    try { nearApi.KeyPair.fromString(payload[field]); } catch { throw new Error('invalid disposable testnet secret key'); }
  }
}
const aad = id => Buffer.from(JSON.stringify({ version: 1, algorithm: ALG, key_id: id }), 'utf8');
function bytes(value, length, maximum = length) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid recovery envelope');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (result.length !== length && (length !== null || result.length < 1 || result.length > maximum))) {
    throw new Error('invalid recovery envelope');
  }
  return result;
}
export function sealTestnetCredentials(payload, publicPem) {
  payloadCheck(payload);
  const { key: publicKey, id } = keyInfo(publicPem), plain = Buffer.from(JSON.stringify(payload), 'utf8');
  if (plain.length > MAX_PLAINTEXT) throw new Error('testnet recovery payload is too large');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(id));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const wrapped = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    return { version: 1, algorithm: ALG, key_id: id, wrapped_key: wrapped.toString('base64'), iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  } finally { key.fill(0); plain.fill(0); }
}
export function openTestnetCredentials(envelope, privatePem) {
  const info = keyInfo(privatePem, true);
  if (!owns(envelope, envelopeFields) || envelope.version !== 1 || envelope.algorithm !== ALG || envelope.key_id !== info.id) throw new Error('recovery envelope key or format mismatch');
  const wrapped = bytes(envelope.wrapped_key, info.bytes), iv = bytes(envelope.iv, 12), tag = bytes(envelope.tag, 16),
    ciphertext = bytes(envelope.ciphertext, null, MAX_PLAINTEXT);
  let key, plain;
  try {
    key = crypto.privateDecrypt({ key: info.key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
    if (key.length !== 32) throw new Error('bad symmetric key');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(info.id)); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plain.toString('utf8')); payloadCheck(payload); return payload;
  } catch { throw new Error('testnet recovery envelope could not be authenticated'); }
  finally { key?.fill(0); plain?.fill(0); }
}
export function testnetRecoveryKeyId(publicPem) { return keyInfo(publicPem).id; }
