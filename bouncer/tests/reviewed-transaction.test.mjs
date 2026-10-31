import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { signReviewedCall } from '../agent/reviewed-transaction.mjs';

for (const type of ['ed25519', 'secp256k1']) {
  test(`reviewed signer derives the hash and validates the ${type} signature`, async () => {
    const pair = nearApi.KeyPair.fromRandom(type), signer = new nearApi.KeyPairSigner(pair), publicKey = pair.getPublicKey();
    const args = { policy_id: 'compute', amount: '7' }, gas = 300n * 10n ** 12n;
    const account = { accountId: 'owner.testnet', signer, async createTransaction(receiver, actions, key) {
      return nearApi.transactions.createTransaction(this.accountId, key, receiver, 42n, actions, Buffer.alloc(32, 2));
    } };
    const output = await signReviewedCall({ account, publicKey, ownerId: account.accountId, contractId: 'bouncer.testnet', method: 'execute', args, gas });
    const digest = crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(output.signed.transaction)).digest();
    assert.equal(output.txHash, nearApi.utils.serialize.base_encode(digest));
    assert.equal(publicKey.verify(digest, output.signed.signature.data), true);
    assert.equal(output.signed.transaction.actions[0].functionCall.deposit, 0n);
  });
}

test('reviewed signer rejects missing or mismatched keys before transaction preparation', async () => {
  let preparations = 0;
  const pair = nearApi.KeyPair.fromRandom('ed25519'), wrong = nearApi.KeyPair.fromRandom('ed25519');
  const account = { accountId: 'owner.testnet', signer: new nearApi.KeyPairSigner(pair), async createTransaction() { preparations++; } };
  const common = { account, publicKey: wrong.getPublicKey(), ownerId: 'owner.testnet', contractId: 'bouncer.testnet', method: 'execute', args: {}, gas: 1n };
  await assert.rejects(signReviewedCall(common), /signer does not match/);
  await assert.rejects(signReviewedCall({ ...common, publicKey: pair.getPublicKey(), ownerId: 'other.testnet' }), /signer does not match/);
  assert.equal(preparations, 0);
});
