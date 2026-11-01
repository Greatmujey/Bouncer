// Test-only real signatures; never use generated keys or fixed nonces in a live account.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';

export function signingFixture({ ownerId, contractId, method, args }) {
  const pair = nearApi.KeyPair.fromRandom('ed25519'), signer = new nearApi.KeyPairSigner(pair);
  const publicKey = pair.getPublicKey(), key = publicKey.toString(), gas = 300n * 10n ** 12n;
  const create = (receiver, actions) => nearApi.transactions.createTransaction(ownerId, publicKey, receiver, 1n, actions, Buffer.alloc(32, 2));
  const expected = create(contractId, [nearApi.transactions.functionCall(method, args, gas, 0n)]);
  const hash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(expected)).digest());
  const newAccount = () => ({ accountId: ownerId, signer: {
    async getPublicKey() { return key; },
    async signTransaction(tx) { return signer.signTransaction(tx); },
  }, async createTransaction(receiver, actions, providedKey) {
    assert.equal(receiver, contractId); assert.equal(String(providedKey), key); assert.equal(actions.length, 1);
    const call = actions[0].functionCall;
    assert.equal(call.methodName, method); assert.equal(call.deposit, 0n); assert.equal(call.gas, gas);
    assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), args);
    return create(receiver, actions);
  } });
  return { key, publicKey, hash, newAccount };
}
