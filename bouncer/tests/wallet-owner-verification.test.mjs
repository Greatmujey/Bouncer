import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { verifyConnectedWalletOwner } from '../web-src/wallet-owner-verification.mjs';

// Encode the NEP-413 payload independently from the implementation.
function payload({ message, nonce, recipient }) {
  const num = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const text = value => { const b = Buffer.from(value); return Buffer.concat([num(b.length), b]); };
  return Buffer.concat([num(2 ** 31 + 413), text(message), Buffer.from(nonce), text(recipient), Buffer.from([0])]);
}
const location = { origin: 'https://bouncer-near.vercel.app', host: 'bouncer-near.vercel.app' };
function fixture({ permission = 'FullAccess' } = {}) {
  const pair = KeyPair.fromRandom('ed25519'), requests = [], prompts = [];
  const wallet = { async signMessage(params) {
    prompts.push(params);
    const digest = createHash('sha256').update(payload(params)).digest();
    return { accountId: 'great_mujey.testnet', publicKey: pair.getPublicKey().toString(),
      signature: Buffer.from(pair.sign(digest).signature).toString('base64') };
  } };
  const fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', result: { permission } }) };
  };
  const base = { wallet, accountId: 'great_mujey.testnet', location, crypto: webcrypto, fetch };
  return { base, requests, prompts };
}

test('a fresh wallet message proves only the named testnet owner, not a transaction or spending approval', async () => {
  const { base, requests, prompts } = fixture();
  const result = await verifyConnectedWalletOwner(base);
  assert.equal(result.accountId, 'great_mujey.testnet');
  assert.match(result.publicKey, /^ed25519:/);
  assert.equal(result.network, 'testnet');
  assert.equal(result.walletControlVerified, true);
  assert.equal(result.transactionApproved, false);
  assert.equal(result.spendingAccessGranted, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].signerId, 'great_mujey.testnet');
  assert.equal(prompts[0].network, 'testnet');
  assert.equal(prompts[0].recipient, location.host);
  assert.match(prompts[0].message, /off-chain identity message/);
  assert.match(prompts[0].message, /does not approve a transaction/);
  assert.equal(prompts[0].nonce.length, 32);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://test.rpc.fastnear.com');
  assert.deepEqual(requests[0].body.params, { request_type: 'view_access_key', finality: 'final',
    account_id: 'great_mujey.testnet', public_key: result.publicKey });
  assert.equal(requests[0].credentials, 'omit');
});

test('wallet responses cannot switch account, change the challenge, or replay a prior signature', async () => {
  const { base, requests, prompts } = fixture();
  const real = base.wallet.signMessage;
  base.wallet.signMessage = async p => ({ ...await real(p), accountId: 'different.testnet' });
  await assert.rejects(verifyConnectedWalletOwner(base), /Invalid CLI account/);
  base.wallet.signMessage = async p => { p.nonce.fill(0); return real(p); };
  await assert.rejects(verifyConnectedWalletOwner(base), /Invalid CLI signature/);
  let saved;
  base.wallet.signMessage = async p => { saved = await real(p); return saved; };
  await verifyConnectedWalletOwner(base);
  base.wallet.signMessage = async () => saved;
  await assert.rejects(verifyConnectedWalletOwner(base), /Invalid CLI signature/);
  assert.equal(requests.length, 1, 'bad signatures are rejected without an RPC lookup');
  assert.notDeepEqual(prompts[2].nonce, prompts[0].nonce);
});

test('restricted or unavailable keys, malformed results, invalid accounts and insecure origins fail closed', async () => {
  const limited = fixture({ permission: { FunctionCall: {} } });
  await assert.rejects(verifyConnectedWalletOwner(limited.base), /CLI_KEY_NOT_FULL_ACCESS/);
  const unavailable = fixture();
  await assert.rejects(verifyConnectedWalletOwner({ ...unavailable.base, fetch: async () => { throw new Error('offline'); } }), /CLI_RPC_UNAVAILABLE/);
  await assert.rejects(verifyConnectedWalletOwner({ ...unavailable.base, accountId: 'great_mujey.near' }), /WALLET_OWNER_VERIFICATION_UNAVAILABLE/);
  await assert.rejects(verifyConnectedWalletOwner({ ...unavailable.base, accountId: '0x1234' }), /WALLET_OWNER_VERIFICATION_UNAVAILABLE/);
  await assert.rejects(verifyConnectedWalletOwner({ ...unavailable.base, location: { origin: 'http://example.com', host: 'example.com' } }), /WALLET_OWNER_VERIFICATION_UNAVAILABLE/);
  await assert.rejects(verifyConnectedWalletOwner({ ...unavailable.base, location: { origin: 'https://example.com', host: 'other.example' } }), /WALLET_OWNER_VERIFICATION_UNAVAILABLE/);
  unavailable.base.wallet.signMessage = async () => ({ accountId: 'great_mujey.testnet', publicKey: 'bad', signature: 'bad' });
  await assert.rejects(verifyConnectedWalletOwner(unavailable.base), /Invalid CLI public key/);
});
