import { isTestnetAccount } from './walletconnect-core.mjs';

// NEP-413: SHA-256(Borsh(2^31+413, message, nonce, recipient, no callback)).
// A CLI login is proof only after checking both the signature and the current
// testnet access key. This module never signs or sends a transaction.
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TESTNET_RPC = 'https://test.rpc.fastnear.com';

function decodePublicKey(value) {
  if (typeof value !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error('Invalid CLI public key');
  const encoded = value.slice(8);
  let number = 0n;
  for (const char of encoded) number = number * 58n + BigInt(BASE58.indexOf(char));
  const bytes = [];
  while (number > 0n) { bytes.push(Number(number & 255n)); number >>= 8n; }
  bytes.reverse();
  let zeros = 0;
  while (encoded[zeros] === '1') zeros++;
  const raw = Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
  if (raw.length !== 32) throw new Error('Invalid CLI public key');
  return raw;
}

function decodeSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) throw new Error('Invalid CLI signature');
  let decoded;
  try { decoded = atob(value); } catch { throw new Error('Invalid CLI signature'); }
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (bytes.length !== 64) throw new Error('Invalid CLI signature');
  return bytes;
}

export function nep413Payload({ message, nonce, recipient }) {
  if (typeof message !== 'string' || typeof recipient !== 'string' || !(nonce instanceof Uint8Array) || nonce.length !== 32) {
    throw new Error('Invalid login challenge');
  }
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message), recipientBytes = encoder.encode(recipient);
  if (!messageBytes.length || messageBytes.length > 2048 || !recipientBytes.length || recipientBytes.length > 255) throw new Error('Invalid login challenge');
  const bytes = new Uint8Array(4 + 4 + messageBytes.length + 32 + 4 + recipientBytes.length + 1);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint32(offset, 0x80000000 + 413, true); offset += 4;
  view.setUint32(offset, messageBytes.length, true); offset += 4;
  bytes.set(messageBytes, offset); offset += messageBytes.length;
  bytes.set(nonce, offset); offset += 32;
  view.setUint32(offset, recipientBytes.length, true); offset += 4;
  bytes.set(recipientBytes, offset); offset += recipientBytes.length;
  bytes[offset] = 0; // no callback URL
  return bytes;
}

export async function verifyCliLogin({ account, message, nonce, recipient, crypto, fetch }) {
  const id = account?.accountId, signed = account?.signedMessage;
  if (!isTestnetAccount(id) || !signed || signed.accountId !== id || account.publicKey !== signed.publicKey) throw new Error('Invalid CLI account');
  const rawKey = decodePublicKey(signed.publicKey);
  const signature = decodeSignature(signed.signature);
  if (!crypto?.subtle || typeof fetch !== 'function') throw new Error('CLI verification unavailable');
  let key;
  try { key = await crypto.subtle.importKey('raw', rawKey, { name: 'Ed25519' }, false, ['verify']); }
  catch { throw new Error('CLI_ED25519_UNAVAILABLE'); }
  const hash = await crypto.subtle.digest('SHA-256', nep413Payload({ message, nonce, recipient }));
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, hash)) throw new Error('Invalid CLI signature');

  // A read-only, final-block RPC query. Requiring FullAccess avoids treating
  // possession of a restricted application key as control of the account.
  let response, result;
  try {
    response = await fetch(TESTNET_RPC, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', method: 'query', params: {
        request_type: 'view_access_key', finality: 'final', account_id: id, public_key: signed.publicKey,
      } }),
    });
    if (!response.ok) throw new Error('RPC unavailable');
    const text = await response.text();
    if (text.length > 16_384) throw new Error('RPC response too large');
    result = JSON.parse(text);
  } catch { throw new Error('CLI_RPC_UNAVAILABLE'); }
  if (result?.error || result?.result?.permission !== 'FullAccess') throw new Error('CLI_KEY_NOT_FULL_ACCESS');
  return id;
}
