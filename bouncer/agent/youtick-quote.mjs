/** Experimental testnet-only YouTick V1 quote verification. No HTTP, keys,
 * account mutation or payment. The market state layout is pinned to the
 * reviewed V1 source and code hash; it is not a deployed-code attestation.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { TESTNET_CIRCLE_USDC, YOUTICK_MARKET } from './youtick-capabilities.mjs';
import { YOUTICK_ADAPTIVE_PROFILE } from './youtick-profiles.mjs';
export { YOUTICK_ADAPTIVE_PROFILE } from './youtick-profiles.mjs';

export const YOUTICK_V1_CODE_HASH = '9FvV8rRn1FQg15jHG4fNZPXjskdMTr6jZBVgNFZyb731';
const requestFields = ['creator_id', 'job_id', 'title', 'price_usdc', 'expected_source_bytes', 'profile_id',
  'profile_config_sha256', 'upload_public_key', 'upload_key_expires_at_ms'];
const quoteFields = ['domain', 'version', 'network', 'contract_id', 'creator_id', 'job_id', 'request_sha256',
  'expected_source_bytes', 'upload_fee_usdc', 'sponsor_fee_usdc', 'total_fee_usdc', 'delegate_receiver_id',
  'delegate_method', 'delegate_gas', 'delegate_deposit_yocto', 'issued_at_ms', 'quote_block_height',
  'max_delegate_block_height', 'expires_at_ms', 'quote_key_version'];
const hash = value => createHash('sha256').update(value).digest('hex');
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function decimal(value, label, max = 30) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9][0-9]{0,${max - 1}})$`).test(value)) throw new Error(`invalid ${label}`);
  return BigInt(value);
}
function base64(value, bytes, label) {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  const result = Buffer.from(value, 'base64');
  if (result.length !== bytes || result.toString('base64') !== value) throw new Error(`invalid ${label}`);
  return result;
}

/** Extract a V1 on-chain quote key at a FINAL block, with strict bounds and layout checks.
 * The caller MUST first pin the reviewed code hash and pass state/version from the same block.
 */
export function extractYoutickV1QuoteKey(state, observedVersion) {
  if (!Buffer.isBuffer(state) || state.length > 4096 || !Number.isSafeInteger(observedVersion) || observedVersion < 1) throw new Error('invalid market state');
  let at = 0;
  function take(size) { if (!Number.isSafeInteger(size) || size < 0 || at + size > state.length) throw new Error('truncated market state'); const v = state.subarray(at, at + size); at += size; return v; }
  function u32() { return take(4).readUInt32LE(0); }
  function vec(max) { const n = u32(); if (n > max) throw new Error('unexpected market state field'); return take(n); }
  function account() { const b = vec(64); const s = b.toString('utf8'); if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(s) || !Buffer.from(s).equals(b)) throw new Error('invalid market account field'); }
  function option(read) { const tag = take(1)[0]; if (tag === 1) read(); else if (tag !== 0) throw new Error('invalid market state option'); }
  if (u32() !== 2) throw new Error('unsupported market state version');
  for (let i = 0; i < 4; i++) account();
  option(account);
  if (take(1)[0] > 1) throw new Error('invalid market frozen flag');
  option(() => take(8));
  account();
  for (let i = 0; i < 7; i++) vec(128); // LookupMap storage prefixes
  take(16); vec(128); take(8); take(16);
  const key = vec(32), version = u32();
  take(16);
  if (key.length !== 32 || version !== observedVersion || at !== state.length) throw new Error('market quote key or layout mismatch');
  return Buffer.from(key);
}

/** Verify a fresh signed offer bound to the exact request and trusted FINAL
 * observations. A verified offer is NOT a payment or fulfillment guarantee. */
export function verifyYoutickQuote({ request, quote, signature, publicKey, quoteKeyVersion, blockHeight, nowMs, maxFeeMicro, market = YOUTICK_MARKET }) {
  if (!exactKeys(request, requestFields) || !exactKeys(quote, [...quoteFields, 'quote_id'])) throw new Error('unexpected quote or request fields');
  const account = /^[a-z0-9][a-z0-9._-]{1,63}$/;
  if (typeof market !== 'string' || !account.test(market) || typeof request.creator_id !== 'string' || !account.test(request.creator_id) ||
      typeof request.job_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.job_id) ||
      typeof request.title !== 'string' || !request.title.trim() || Buffer.byteLength(request.title) > 200 ||
      request.profile_id !== 'paid-media-livepeer-v1' || request.profile_config_sha256 !== YOUTICK_ADAPTIVE_PROFILE ||
      typeof request.upload_public_key !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(request.upload_public_key)) throw new Error('invalid or unsupported upload request');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !Number.isSafeInteger(blockHeight) || blockHeight < 1 ||
      !Number.isSafeInteger(quoteKeyVersion) || quoteKeyVersion < 1 || !Buffer.isBuffer(publicKey) || publicKey.length !== 32) throw new Error('invalid quote verification context');
  const size = decimal(request.expected_source_bytes, 'source bytes', 20);
  if (size < 1n || size > 5_000_000_000n || decimal(request.price_usdc, 'publication price', 20) < 2_000_000n ||
      decimal(request.upload_key_expires_at_ms, 'upload key expiry', 16) <= BigInt(nowMs)) throw new Error('upload request outside reviewed limits');
  const maxFee = decimal(maxFeeMicro, 'maximum fee', 20);
  const requestSha = hash(JSON.stringify(Object.fromEntries(requestFields.map(key => [key, request[key]]))));
  if (quote.domain !== 'youtick.sponsored-upload-quote' || quote.version !== '1' || quote.network !== 'testnet' ||
      quote.contract_id !== market || quote.creator_id !== request.creator_id || quote.job_id !== request.job_id ||
      quote.request_sha256 !== requestSha || quote.expected_source_bytes !== request.expected_source_bytes ||
      quote.delegate_receiver_id !== TESTNET_CIRCLE_USDC || quote.delegate_method !== 'ft_transfer_call' ||
      quote.delegate_gas !== '100000000000000' || quote.delegate_deposit_yocto !== '1' || quote.quote_key_version !== quoteKeyVersion) throw new Error('quote is not bound to the reviewed request and policy');
  let upload = (size * 300_000n + 999_999_999n) / 1_000_000_000n;
  if (upload < 500_000n) upload = 500_000n;
  const total = upload + 100_000n;
  if (decimal(quote.upload_fee_usdc, 'upload fee') !== upload || decimal(quote.sponsor_fee_usdc, 'sponsor fee') !== 100_000n ||
      decimal(quote.total_fee_usdc, 'total fee') !== total || total > maxFee) throw new Error('quote fee exceeds or differs from reviewed policy');
  const issued = decimal(quote.issued_at_ms, 'quote issue time', 16), expires = decimal(quote.expires_at_ms, 'quote expiry', 16);
  const first = decimal(quote.quote_block_height, 'quote block', 20), last = decimal(quote.max_delegate_block_height, 'quote block expiry', 20);
  if (issued > BigInt(nowMs) || expires <= BigInt(nowMs) || expires <= issued || expires - issued > 120_000n ||
      first > BigInt(blockHeight) || last < BigInt(blockHeight) || last <= first || last - first > 200n) throw new Error('quote is stale or outside its block window');
  const message = quoteFields.map(key => quote[key]).join('\n');
  if (typeof quote.quote_id !== 'string' || quote.quote_id !== hash(message)) throw new Error('quote id mismatch');
  const sig = base64(signature, 64, 'quote signature');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(message), key, sig)) throw new Error('invalid quote signature');
  return { status: 'VERIFIED_SIGNED_QUOTE', creator: request.creator_id, market, job_id: request.job_id,
    token: TESTNET_CIRCLE_USDC, fee_micro: total.toString(), source_bytes: size.toString(), expires_at_ms: expires.toString(),
    quote_id: quote.quote_id, quote_key_version: quoteKeyVersion,
    scope: 'signed quote only; no payment, upload, fulfillment or deployed-code attestation' };
}
