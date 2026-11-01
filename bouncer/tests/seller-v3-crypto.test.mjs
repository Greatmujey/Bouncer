import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { orderMemoV2, orderMemoV3, challengeFromOrderMemoV3, claimDigest, claimMessage, signClaimAuthorization,
  verifyClaimAuthorization, verifyAuthenticatedProviderPayment } from '../packages/provider-sdk/index.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

// Public test seed only, never a real credential. The deterministic vector is
// checked against near-api-js's independently implemented NEP-413 signer.
const key = nearApi.KeyPair.fromString('ed25519:' + nearApi.utils.serialize.base_encode(new Uint8Array(32).fill(7)));
const signer = new nearApi.KeyPairSigner(key), publicKey = key.getPublicKey().toString();
const input = { text: 'same work', rounds: 2 }, challenge = '00112233445566778899aabbccddeeff';
const txHash = nearApi.utils.serialize.base_encode(new Uint8Array(32).fill(9));
const terms = { network: 'near:testnet', contract_id: 'bouncer.testnet', owner_account_id: 'owner.testnet',
  seller_origin: 'https://seller.example', resource: 'compute', policy_id: 'compute', token: 'token.testnet',
  payee: 'seller.testnet', amount: '1000', memo: orderMemoV3('compute', input, challenge), tx_hash: txHash };
const expectation = { tx_hash: txHash, contract_id: terms.contract_id, owner_account_id: terms.owner_account_id,
  policy_id: terms.policy_id, token: terms.token, payee: terms.payee, amount: terms.amount, memo: terms.memo };
const chain = () => mockGuardedPayment({ hash: txHash, owner: terms.owner_account_id, contract: terms.contract_id, publicKey,
  args: { policy_id: terms.policy_id, payee: terms.payee, amount: terms.amount, memo: terms.memo, expected_token: terms.token } });

test('seller-v3 domain-separated fixed vector matches NEP-413 and binds the exact task', async () => {
  assert.equal(publicKey, 'ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  assert.equal(terms.memo, 'bouncer-order-v3:compute:00112233445566778899aabbccddeeff:0374e3d0589eff883fcdc076409fd5820629697909633ca6d649d4fd97a7cc0e');
  assert.equal(challengeFromOrderMemoV3('compute', input, terms.memo), challenge);
  assert.throws(() => challengeFromOrderMemoV3('compute', { ...input, rounds: 3 }, terms.memo), /exact order/);
  assert.throws(() => challengeFromOrderMemoV3('compute', input, orderMemoV2('compute', input, challenge)), /exact order/);
  assert.equal(claimDigest(terms).toString('hex'), '7ffc9315dacc49e9175d77a223aae26809201ba1bcbf0e78c45184fdffe66b9b');
  assert.equal(JSON.parse(claimMessage(terms))[0], 'bouncer:resource-claim:v1');
  const auth = await signClaimAuthorization({ terms, signer, publicKey });
  assert.equal(auth.signature, 'mrQ2rM2VwjdhVEmMGCOc18FBsOz6UXZQ4KyNnQeGJCKtfkZlrHX6tvT7iPcyGRc+Z53hH4WDx5cr1duBibhzCA==');
  assert.equal(verifyClaimAuthorization(terms, auth, publicKey), true);
  assert.equal(verifyAuthenticatedProviderPayment(chain(), expectation, terms, auth).agent_public_key, publicKey);
});

test('claims reject origin, order, amount, hash, account, scheme, public key and signature substitution', async () => {
  const auth = await signClaimAuthorization({ terms, signer, publicKey });
  for (const change of [
    { seller_origin: 'https://other.example' }, { amount: '1001' }, { policy_id: 'other' },
    { payee: 'other.testnet' }, { owner_account_id: 'other.testnet' }, { contract_id: 'other.testnet' },
    { token: 'other.testnet' }, { tx_hash: nearApi.utils.serialize.base_encode(new Uint8Array(32).fill(8)) },
    { memo: orderMemoV3('compute', input, 'f'.repeat(32)) },
  ]) assert.throws(() => verifyClaimAuthorization({ ...terms, ...change }, auth, publicKey));
  for (const bad of [{ ...auth, scheme: 'other' }, { ...auth, signature: auth.signature.slice(1) },
    { ...auth, signature: Buffer.alloc(64).toString('base64') }, { ...auth, public_key: nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString() },
    { ...auth, extra: true }]) assert.throws(() => verifyClaimAuthorization(terms, bad, publicKey));
  assert.throws(() => verifyClaimAuthorization({ ...terms, seller_origin: 'https://seller.example/' }, auth, publicKey));
  assert.throws(() => verifyClaimAuthorization({ ...terms, network: 'near:mainnet' }, auth, publicKey));
  const wrong = chain(); wrong.transaction.public_key = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  assert.throws(() => verifyAuthenticatedProviderPayment(wrong, expectation, terms, auth), /signing key/);
  assert.throws(() => verifyAuthenticatedProviderPayment(chain(), { ...expectation, amount: '1001' }, terms, auth), /seller payment expectation/);
});

test('a malicious signer cannot substitute a claim, signer identity or transaction hash', async () => {
  const other = nearApi.KeyPair.fromRandom('ed25519');
  const changed = { getPublicKey: () => publicKey, signNep413Message: (message, account, recipient, nonce) =>
    new nearApi.KeyPairSigner(other).signNep413Message(message, account, recipient, nonce) };
  await assert.rejects(signClaimAuthorization({ terms, signer: changed, publicKey }));
  const wrongMessage = { getPublicKey: () => publicKey, signNep413Message: (_message, account, recipient, nonce) =>
    signer.signNep413Message('different message', account, recipient, nonce) };
  await assert.rejects(signClaimAuthorization({ terms, signer: wrongMessage, publicKey }), /invalid authenticated claim signature/);
});
