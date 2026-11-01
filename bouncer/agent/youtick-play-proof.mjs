/** Exact reviewed YouTick testnet access-contract Play proof format.
 * Local signing only; no NEAR transaction or network request. */
import nearApi from 'near-api-js';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { YOUTICK_ACCESS } from './youtick-capabilities.mjs';

export const YOUTICK_PLAY_ORIGIN = 'https://public-testnet.youtick.net';
export const YOUTICK_PLAY_ORIGIN_HASH = '405f0f2f5400af2a2abaa3350ffaa0b95a56f16b85129d9a1a1663bdda989924';
export const YOUTICK_PLAY_TTL_MS = 600_000;
const hex = value => Buffer.from(value, 'utf8').toString('hex');

function proofMessage(vault, jobId, deviceHash, sessionPk) {
  if (!isTestnetAccount(vault) || typeof jobId !== 'string' || !/^[A-Za-z0-9_:.-]{1,128}$/.test(jobId) ||
      typeof deviceHash !== 'string' || !/^[a-f0-9]{64}$/.test(deviceHash) ||
      typeof sessionPk !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sessionPk)) {
    throw new Error('invalid scoped testnet grant proof inputs');
  }
  return ['youtick-session-grant-v1', `contract=${hex(YOUTICK_ACCESS)}`,
    `caller=${hex(vault)}`, `target_owner=${hex(vault)}`, `session_pk=${hex(sessionPk)}`,
    'scope=play', `resource_id=${hex(jobId)}`, `ttl_ms=${YOUTICK_PLAY_TTL_MS}`,
    `origin_hash=${hex(YOUTICK_PLAY_ORIGIN_HASH)}`, `device_hash=${hex(deviceHash)}`].join('\n');
}

/** Verify the exact scoped proof using the public session key only. This is
 * useful for recovery when the owner signing key is offline; it does not
 * authenticate a transaction, current grant, RPC or deployed code. */
export function verifyYoutickPlayGrantArgs({ vault, args }) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 4 ||
      !['job_id', 'session_pk', 'device_hash', 'session_pok'].every(key => Object.hasOwn(args, key)) ||
      typeof args.session_pok !== 'string' || !/^[a-f0-9]{128}$/.test(args.session_pok)) {
    throw new Error('invalid scoped testnet grant proof');
  }
  const message = proofMessage(vault, args.job_id, args.device_hash, args.session_pk);
  let valid = false;
  try { valid = nearApi.utils.PublicKey.fromString(args.session_pk).verify(Buffer.from(message), Buffer.from(args.session_pok, 'hex')); }
  catch { /* malformed public key fails closed */ }
  if (!valid) throw new Error('invalid playback proof signature');
  return true;
}

export function makeYoutickPlayGrantArgs({ vault, jobId, deviceHash, key }) {
  if (!key || typeof key.sign !== 'function' || typeof key.getPublicKey !== 'function') throw new Error('invalid scoped testnet grant proof inputs');
  const sessionPk = key.getPublicKey().toString(), message = proofMessage(vault, jobId, deviceHash, sessionPk);
  const signature = Buffer.from(key.sign(Buffer.from(message)).signature);
  const args = { job_id: jobId, session_pk: sessionPk, device_hash: deviceHash, session_pok: signature.toString('hex') };
  verifyYoutickPlayGrantArgs({ vault, args });
  return args;
}
