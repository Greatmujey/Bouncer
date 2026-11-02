import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';

test('pinned owner nonce accepts canonical safely represented values with room for one increment', () => {
  for (const [value, expected] of [[0, 0n], [0n, 0n], ['0', 0n], [42, 42n], [42n, 42n], ['42', 42n],
    [Number.MAX_SAFE_INTEGER - 1, BigInt(Number.MAX_SAFE_INTEGER) - 1n],
    ['9007199254740990', 9007199254740990n]]) assert.equal(pinnedAccessKeyNonce(value), expected);
});

test('missing, malformed, negative, fractional, rounded and increment-unsafe nonces fail closed', () => {
  for (const value of [undefined, null, true, {}, [], -1, -1n, '-1', 0.5, NaN, Infinity, '1.0', '01', '+1', ' 1', '',
    Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER), '9007199254740991', '9007199254740992',
    9007199254740993n, '18446744073709551615', '9'.repeat(200)]) assert.equal(pinnedAccessKeyNonce(value), null);
});
