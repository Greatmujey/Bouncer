import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { nep413Payload, verifyCliLogin } from '../web-src/cli-login.mjs';

const challenge = { message: 'Connect to Bouncer on NEAR testnet.', nonce: Uint8Array.from({ length: 32 }, (_, i) => i), recipient: 'bouncer-near.vercel.app' };
function independentlyEncode({ message, nonce, recipient }) {
  const num = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
  const text = value => { const bytes = Buffer.from(value); return Buffer.concat([num(bytes.length), bytes]); };
  return Buffer.concat([num(2 ** 31 + 413), text(message), Buffer.from(nonce), text(recipient), Buffer.from([0])]);
}
function sign(pair, params = challenge) {
  const digest = createHash('sha256').update(independentlyEncode(params)).digest();
  const publicKey = pair.getPublicKey().toString();
  return { accountId: 'cli.testnet', publicKey, signedMessage: { accountId: 'cli.testnet', publicKey, signature: Buffer.from(pair.sign(digest).signature).toString('base64') } };
}
const goodResponse = { ok: true, text: async () => JSON.stringify({ result: { permission: 'FullAccess' } }) };

test('CLI NEP-413 payload matches the independently encoded standard', () => {
  assert.deepEqual(Buffer.from(nep413Payload(challenge)), independentlyEncode(challenge));
  assert.throws(() => nep413Payload({ ...challenge, nonce: new Uint8Array(31) }), /challenge/);
});

test('CLI login verifies a fresh signature and checks the current Full Access key with a read-only testnet query', async () => {
  const account = sign(KeyPair.fromRandom('ed25519'));
  const requests = [];
  const fetch = async (url, options) => { requests.push({ url, ...options, body: JSON.parse(options.body) }); return goodResponse; };
  assert.equal(await verifyCliLogin({ account, ...challenge, crypto: webcrypto, fetch }), 'cli.testnet');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://test.rpc.fastnear.com');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body.params, { request_type: 'view_access_key', finality: 'final', account_id: 'cli.testnet', public_key: account.publicKey });
  assert.equal(requests[0].body.method, 'query');
  assert.equal(requests[0].credentials, 'omit');
});

test('CLI rejects tampered messages, identities, keys and signatures before contacting RPC', async () => {
  const account = sign(KeyPair.fromRandom('ed25519'));
  let calls = 0;
  const fetch = async () => { calls++; return goodResponse; };
  const verify = (overrides = {}) => verifyCliLogin({ account, ...challenge, crypto: webcrypto, fetch, ...overrides });
  await assert.rejects(verify({ nonce: new Uint8Array(32) }), /Invalid CLI signature/);
  await assert.rejects(verify({ recipient: 'other.example' }), /Invalid CLI signature/);
  await assert.rejects(verify({ message: 'Different request' }), /Invalid CLI signature/);
  await assert.rejects(verify({ account: { ...account, accountId: 'other.testnet' } }), /Invalid CLI account/);
  await assert.rejects(verify({ account: { ...account, accountId: 'alice.near' } }), /Invalid CLI account/);
  await assert.rejects(verify({ account: { ...account, publicKey: 'ed25519:bad', signedMessage: { ...account.signedMessage, publicKey: 'ed25519:bad' } } }), /Invalid CLI public key/);
  await assert.rejects(verify({ account: { ...account, signedMessage: { ...account.signedMessage, signature: 'bad' } } }), /Invalid CLI signature/);
  assert.equal(calls, 0);
});

test('CLI refuses limited, missing or unreachable testnet keys and unsupported browser crypto', async () => {
  const account = sign(KeyPair.fromRandom('ed25519'));
  const verify = (fetch, crypto = webcrypto) => verifyCliLogin({ account, ...challenge, crypto, fetch });
  const response = result => async () => ({ ok: true, text: async () => JSON.stringify(result) });
  await assert.rejects(verify(response({ result: { permission: { FunctionCall: {} } } })), /CLI_KEY_NOT_FULL_ACCESS/);
  await assert.rejects(verify(response({ error: { message: 'Unknown access key' } })), /CLI_KEY_NOT_FULL_ACCESS/);
  await assert.rejects(verify(async () => { throw new Error('offline'); }), /CLI_RPC_UNAVAILABLE/);
  await assert.rejects(verify(async () => ({ ok: false })), /CLI_RPC_UNAVAILABLE/);
  await assert.rejects(verify(async () => ({ ok: true, text: async () => ' '.repeat(16385) })), /CLI_RPC_UNAVAILABLE/);
  await assert.rejects(verify(async () => goodResponse, { subtle: { importKey: async () => { throw new Error('unsupported'); } } }), /CLI_ED25519_UNAVAILABLE/);
});
