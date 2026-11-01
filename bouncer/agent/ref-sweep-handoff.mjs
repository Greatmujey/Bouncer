/**
 * Confidential, testnet-only, one-use handoff of a separately scoped Ref sweep
 * function key to a live recovery worker. The worker creates the RSA key in
 * memory; only its public key/challenge are shared. This is not a production
 * key-management service and does not authorize a new swap or arbitrary payee.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { sealTestnetCredentials, openTestnetCredentials, testnetRecoveryKeyId } from './testnet-credential-envelope.mjs';

const requestFields = ['version', 'purpose', 'run_id', 'challenge', 'owner_account_id', 'contract_id', 'router_id',
  'original_hash', 'output_receipt_id', 'expected_output', 'sweep_public_key', 'rsa_public_pem', 'rsa_key_id'];
const responseFields = ['version', 'purpose', 'run_id', 'challenge', 'envelope'];
const contextFields = ['owner_account_id', 'contract_id', 'router_id', 'original_hash', 'output_receipt_id', 'expected_output', 'sweep_public_key'];
const owns = (value, fields) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function validateSweepHandoffRequest(request, expected) {
  if (!owns(request, requestFields) || request.version !== 1 || request.purpose !== 'ref-sweep-once-testnet' ||
      typeof request.run_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(request.run_id) ||
      typeof request.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(request.challenge) ||
      ![request.owner_account_id, request.contract_id, request.router_id].every(isTestnetAccount) ||
      new Set([request.owner_account_id, request.contract_id, request.router_id]).size !== 3 ||
      !isTransactionHash(request.original_hash) || !isTransactionHash(request.output_receipt_id) ||
      typeof request.expected_output !== 'string' || !/^[1-9][0-9]{0,5}$/.test(request.expected_output) ||
      BigInt(request.expected_output) > 100_000n || typeof request.sweep_public_key !== 'string' ||
      typeof request.rsa_public_pem !== 'string' || request.rsa_public_pem.length > 2048 ||
      typeof request.rsa_key_id !== 'string' || !/^[a-f0-9]{64}$/.test(request.rsa_key_id)) {
    throw new Error('invalid testnet sweep handoff request');
  }
  try {
    const key = nearApi.utils.PublicKey.from(request.sweep_public_key);
    if (key.keyType !== 0 || String(key) !== request.sweep_public_key || testnetRecoveryKeyId(request.rsa_public_pem) !== request.rsa_key_id) throw new Error('bad key');
  } catch { throw new Error('invalid testnet handoff public keys'); }
  if (!expected || typeof expected !== 'object' || contextFields.some(field => expected[field] !== request[field])) {
    throw new Error('handoff does not match the independently reviewed original trade and sweep key');
  }
  return structuredClone(request);
}

// A canonical, bounded single-line encoding survives GitHub job annotations
// without treating JSON newlines or percent signs as workflow commands. The
// decoded request still needs validation against independently reviewed data.
export function encodeSweepHandoffRequest(request) {
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  if (!encoded || encoded.length > 6000) throw new Error('invalid encoded handoff request');
  return encoded;
}
export function decodeSweepHandoffRequest(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,6000}$/.test(encoded)) throw new Error('invalid encoded handoff request');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('non-canonical encoded handoff request');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid encoded handoff request'); }
}

// GitHub's contents API base64-encodes files and may wrap lines. Treat every
// field as untrusted and cap the ciphertext-only response before parsing it.
export function decodeSweepHandoffFile(file, expectedPath) {
  if (!file || typeof file !== 'object' || file.type !== 'file' || file.path !== expectedPath || file.encoding !== 'base64' ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 12_000 || typeof file.content !== 'string' || file.content.length > 18_000 ||
      /[^A-Za-z0-9+/=\r\n]/.test(file.content)) throw new Error('invalid scoped handoff file metadata');
  const encoded = file.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== file.size || bytes.toString('base64') !== encoded) throw new Error('invalid scoped handoff file encoding');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid scoped handoff file JSON'); }
}

export function createSweepHandoffRequest({ runId, context }) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const request = { version: 1, purpose: 'ref-sweep-once-testnet', run_id: runId, challenge: crypto.randomBytes(32).toString('hex'),
    ...Object.fromEntries(contextFields.map(field => [field, context?.[field]])), rsa_public_pem: pair.publicKey,
    rsa_key_id: testnetRecoveryKeyId(pair.publicKey) };
  validateSweepHandoffRequest(request, context);
  return { request, privateKey: pair.privateKey };
}

export function sealSweepHandoff({ request: rawRequest, expected, credentials }) {
  const request = validateSweepHandoffRequest(rawRequest, expected);
  if (!owns(credentials, ['account_id', 'private_key']) || credentials.account_id !== request.owner_account_id ||
      typeof credentials.private_key !== 'string') throw new Error('invalid scoped sweep credential');
  let key;
  try { key = nearApi.KeyPair.fromString(credentials.private_key); }
  catch { throw new Error('invalid scoped sweep credential'); }
  if (String(key.getPublicKey()) !== request.sweep_public_key) throw new Error('scoped sweep credential does not match the reviewed public key');
  const payload = { version: 4, purpose: request.purpose, owner_account_id: request.owner_account_id, contract_id: request.contract_id,
    router_id: request.router_id, sweep_secret: credentials.private_key, original_hash: request.original_hash,
    challenge: request.challenge, run_id: request.run_id };
  return { version: 1, purpose: request.purpose, run_id: request.run_id, challenge: request.challenge,
    envelope: sealTestnetCredentials(payload, request.rsa_public_pem) };
}

export function openSweepHandoff({ request: rawRequest, expected, response, privateKey }) {
  const request = validateSweepHandoffRequest(rawRequest, expected);
  if (!owns(response, responseFields) || response.version !== 1 || response.purpose !== request.purpose ||
      response.run_id !== request.run_id || response.challenge !== request.challenge) throw new Error('handoff response context mismatch');
  const payload = openTestnetCredentials(response.envelope, privateKey);
  if (payload.version !== 4 || payload.purpose !== request.purpose || payload.owner_account_id !== request.owner_account_id ||
      payload.contract_id !== request.contract_id || payload.router_id !== request.router_id || payload.original_hash !== request.original_hash ||
      payload.run_id !== request.run_id || payload.challenge !== request.challenge) throw new Error('decrypted handoff context mismatch');
  const key = nearApi.KeyPair.fromString(payload.sweep_secret);
  if (String(key.getPublicKey()) !== request.sweep_public_key) throw new Error('decrypted sweep key differs from the reviewed key');
  return key;
}
