import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGoogleSessionHandler, verifyGoogleIdToken } from '../web/api/google-session.mjs';

// Synthetic RSA identities and mocked Google keys only. No actual Google
// account, Google network, NEAR key, or transaction is used in these tests.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };
const origin = 'https://bouncer-near.vercel.app';
const audience = '1234567890-testclient.apps.googleusercontent.com';
const now = 1800000000000;
const seconds = now / 1000;
const nonce = 'a'.repeat(43);
const claims = { iss: 'https://accounts.google.com', aud: audience, sub: '12345678901234567890', iat: seconds, exp: seconds + 3600, nonce, name: 'Example Person', email: 'example@example.test', email_verified: true };
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url');
function makeToken(payload = claims, header = { alg: 'RS256', kid: 'key-1', typ: 'JWT' }, signer = privateKey) {
  const prefix = `${enc(header)}.${enc(payload)}`;
  return `${prefix}.${sign('RSA-SHA256', Buffer.from(prefix), signer).toString('base64url')}`;
}
function check(token = makeToken(), options = {}) { return verifyGoogleIdToken(token, { audience, keys: [key], now, nonce, ...options }); }

async function call(handler, { method = 'GET', path = '/api/google-session', originHeader, headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method; req.url = path;
  req.headers = { host: 'bouncer-near.vercel.app', 'x-forwarded-proto': 'https', ...headers };
  if (originHeader !== undefined) req.headers.origin = originHeader;
  const response = { headers: {}, setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler(req, response);
  return response;
}
const cookieValue = (res, name) => res.headers['set-cookie']?.find(x => x.startsWith(`${name}=`))?.split(';')[0];
const mutationHeaders = { 'x-bouncer-auth': '1', 'content-type': 'application/json' };
const create = (options = {}) => createGoogleSessionHandler({ audience, origin, now: () => now, keys: async () => [key], ...options });

// Claims are never trusted until signature, issuer, client audience, expiry,
// nonce, and stable Google sub have all been checked.
test('Google token verification accepts only a properly signed, nonce-bound identity', () => {
  assert.deepEqual(check(), { sub: claims.sub, name: claims.name, email: claims.email, expiresAt: claims.exp });
  const badClaims = [
    { ...claims, iss: 'https://evil.example' }, { ...claims, aud: '1-other.apps.googleusercontent.com' },
    { ...claims, azp: '1-other.apps.googleusercontent.com' }, { ...claims, exp: seconds },
    { ...claims, iat: seconds + 61 }, { ...claims, iat: seconds - 3700 },
    { ...claims, exp: seconds + 3700 }, { ...claims, nonce: 'b'.repeat(43) },
    { ...claims, sub: 'not-a-google-sub' }, { ...claims, sub: '' },
  ];
  for (const item of badClaims) assert.throws(() => check(makeToken(item)));
  assert.throws(() => check(makeToken(claims, { alg: 'none', kid: 'key-1' })));
  assert.throws(() => check(makeToken(claims, { alg: 'RS256', kid: 'unknown' })));
  assert.throws(() => check(makeToken(claims, undefined, other.privateKey)));
  assert.throws(() => check('x'.repeat(3501)));
  assert.throws(() => check(makeToken(), { keys: [key, key] }), /unknown signing key/);
  assert.equal(check(makeToken({ ...claims, email_verified: false })).email, '');
});

test('unconfigured or wrong-origin endpoints fail closed', async () => {
  const unconfigured = create({ audience: '' });
  assert.equal((await call(unconfigured)).statusCode, 503);
  const handler = create();
  assert.equal((await call(handler, { headers: { host: 'unrelated.vercel.app' } })).statusCode, 403);
  assert.equal((await call(handler, { originHeader: 'https://evil.example' })).statusCode, 403);
  assert.equal((await call(handler, { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
  assert.equal((await call(handler, { headers: { 'x-forwarded-proto': 'http' } })).statusCode, 403);
});

test('challenge and sign-in require same-origin CSRF protection and consume the nonce', async () => {
  const handler = create();
  assert.equal((await call(handler, { path: '/api/google-session?challenge=1' })).statusCode, 403);
  const challenge = await call(handler, { path: '/api/google-session?challenge=1', headers: { 'x-bouncer-auth': '1' } });
  assert.equal(challenge.statusCode, 200);
  assert.equal(challenge.body.clientId, audience);
  assert.match(challenge.body.nonce, /^[A-Za-z0-9_-]{43}$/);
  const nonceCookie = cookieValue(challenge, '__Host-bouncer_nonce');
  assert.ok(nonceCookie);
  assert.match(challenge.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Lax/);
  assert.match(challenge.headers['cache-control'], /no-store/);
  const credential = makeToken({ ...claims, nonce: challenge.body.nonce });
  const body = { credential };
  assert.equal((await call(handler, { method: 'POST', body, headers: { ...mutationHeaders, cookie: nonceCookie } })).statusCode, 403, 'missing Origin');
  assert.equal((await call(handler, { method: 'POST', body, originHeader: origin, headers: { cookie: nonceCookie, 'content-type': 'text/plain', 'x-bouncer-auth': '1' } })).statusCode, 403);
  assert.equal((await call(handler, { method: 'POST', body, originHeader: origin, headers: mutationHeaders })).statusCode, 401, 'missing nonce cookie');
  assert.equal((await call(handler, { method: 'POST', body, originHeader: origin, headers: { ...mutationHeaders, cookie: `${nonceCookie}; ${nonceCookie}` } })).statusCode, 401, 'ambiguous nonce');
  const accepted = await call(handler, { method: 'POST', body, originHeader: origin, headers: { ...mutationHeaders, cookie: nonceCookie } });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.authenticated, true);
  assert.equal(accepted.body.user.sub, claims.sub);
  assert.ok(!JSON.stringify(accepted.body).includes(credential));
  assert.match(accepted.headers['set-cookie'][0], /Max-Age=0/);
  const sessionCookie = cookieValue(accepted, '__Host-bouncer_session');
  assert.ok(sessionCookie);
  assert.match(accepted.headers['set-cookie'][1], /Max-Age=3600; Secure; HttpOnly; SameSite=Lax/);
  const restored = await call(handler, { headers: { cookie: sessionCookie } });
  assert.equal(restored.body.authenticated, true);
  assert.equal(restored.body.user.sub, claims.sub);
  const empty = await call(handler);
  assert.equal(empty.body.authenticated, false);
  const signoutDenied = await call(handler, { method: 'DELETE', headers: { 'x-bouncer-auth': '1', cookie: sessionCookie } });
  assert.equal(signoutDenied.statusCode, 403);
  const signout = await call(handler, { method: 'DELETE', originHeader: origin, headers: { 'x-bouncer-auth': '1', cookie: sessionCookie } });
  assert.equal(signout.statusCode, 200);
  assert.equal(signout.body.authenticated, false);
  assert.ok(signout.headers['set-cookie'].every(c => c.includes('Max-Age=0')));
  // The cleared challenge cookie cannot replay a credential in a browser.
  const replay = await call(handler, { method: 'POST', body, originHeader: origin, headers: mutationHeaders });
  assert.equal(replay.statusCode, 401);
});

test('tampered or expired session cookies are cleared instead of authenticating', async () => {
  const handler = create();
  for (const token of [makeToken({ ...claims, exp: seconds - 1 }), makeToken(claims, undefined, other.privateKey), 'x.y.z']) {
    const result = await call(handler, { headers: { cookie: `__Host-bouncer_session=${token}` } });
    assert.equal(result.body.authenticated, false);
    assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
  }
});

test('rotated Google keys may be refreshed but cannot be chosen by the client', async () => {
  let forced = 0;
  const handler = create({ keys: async force => { if (force) { forced++; return [key]; } return []; } });
  const result = await call(handler, { headers: { cookie: `__Host-bouncer_session=${makeToken()}` } });
  assert.equal(result.body.authenticated, true);
  assert.equal(forced, 1);
});
