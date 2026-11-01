/** Shared, bounded reference resource-order serialization for testnet sellers.
 * A public challenge/memo is not authentication, a delivery guarantee or a
 * replay database. Seller-owned durable state must reserve both quote and tx.
 */
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const CHALLENGE = /^[a-f0-9]{32}$/;

export function normalizeRepository(value) {
  if (typeof value !== 'string' || bytes(value) > 140) throw new Error('repository must be owner/name');
  const parts = value.split('/');
  if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || parts[1] === '.' || parts[1] === '..') {
    throw new Error('repository must be a safe GitHub owner/name');
  }
  return `${parts[0]}/${parts[1]}`;
}

export function normalizeOrder(resource, input) {
  if (!plain(input)) throw new Error('resource input must be an object');
  if (resource === 'compute') {
    if (!Object.hasOwn(input, 'text') || !Object.hasOwn(input, 'rounds') || typeof input.text !== 'string' || bytes(input.text) > 1024 || !Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20_000 || Object.keys(input).length !== 2) {
      throw new Error('compute needs text (max 1024 bytes) and rounds (1-20000)');
    }
    return { text: input.text, rounds: input.rounds };
  }
  if (resource === 'storage') {
    if (!Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'content') || typeof input.name !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(input.name) || typeof input.content !== 'string' || bytes(input.content) > 4096 || Object.keys(input).length !== 2) {
      throw new Error('storage needs a safe name and content (max 4096 bytes)');
    }
    return { name: input.name, content: input.content };
  }
  if (resource === 'api') {
    if (Object.keys(input).length === 1 && Object.hasOwn(input, 'repo')) return { repo: normalizeRepository(input.repo) };
    if (typeof input.text !== 'string' || bytes(input.text) > 4096 || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'text')) {
      throw new Error('api needs text (max 4096 bytes) or a public GitHub owner/repository');
    }
    return { text: input.text };
  }
  throw new Error('unsupported resource');
}

/** Legacy deterministic binding; identical inputs produce identical memos. */
export function orderMemo(resource, input) {
  return `bouncer-order-v1:${resource}:${digest(JSON.stringify(normalizeOrder(resource, input)))}`;
}

/**
 * seller-v2 adds a 128-bit seller-generated random challenge. The challenge is
 * public and must be unique across this seller's durable order book. The digest
 * commits to the exact normalized resource input, not just the challenge.
 */
export function orderMemoV2(resource, input, challenge) {
  if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) throw new Error('seller challenge must be 32 lowercase hex characters');
  const normalized = normalizeOrder(resource, input);
  const hash = digest(`bouncer-order-v2\0${resource}\0${challenge}\0${JSON.stringify(normalized)}`);
  return `bouncer-order-v2:${resource}:${challenge}:${hash}`;
}

/** Fail closed unless a v2 memo matches the exact normalized order; return its challenge. */
export function challengeFromOrderMemo(resource, input, memo) {
  if (typeof memo !== 'string') throw new Error('invalid seller-v2 order memo');
  const match = /^bouncer-order-v2:(compute|storage|api):([a-f0-9]{32}):([a-f0-9]{64})$/.exec(memo);
  if (!match || match[1] !== resource || orderMemoV2(resource, input, match[2]) !== memo) {
    throw new Error('seller-v2 quote is not bound to this exact order');
  }
  return match[2];
}
