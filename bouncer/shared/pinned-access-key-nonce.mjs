/**
 * JSON-RPC access-key nonce narrowed to a safely represented non-negative
 * integer with room for one increment. near-api-js parses JSON numbers before
 * converting them to bigint, so accepting > Number.MAX_SAFE_INTEGER could use a
 * rounded nonce. A current nonce and the next value can still race another
 * transaction; this is not a reservation or broadcast authorization.
 */
const MAX_CURRENT = BigInt(Number.MAX_SAFE_INTEGER) - 1n;
export function pinnedAccessKeyNonce(value) {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value)) n = BigInt(value);
  else return null;
  return n >= 0n && n <= MAX_CURRENT ? n : null;
}
