/**
 * near-api-js currently reads an optimistic access-key nonce each time it
 * signs. A load-balanced RPC can return a stale nonce after a FINAL tx. Keep
 * this process's signed nonces monotonic per key; this does not retry sends,
 * coordinate with other processes, or replace the pending-payment journal.
 */
import nearApi from 'near-api-js';

const U64_MAX = (1n << 64n) - 1n;
export class MonotonicAccount extends nearApi.Account {
  #nonces = new Map();

  async createTransaction(receiverId, actions, publicKey) {
    const tx = await super.createTransaction(receiverId, actions, publicKey);
    const key = tx.publicKey.toString();
    const rpcNonce = BigInt(tx.nonce);
    const prior = this.#nonces.get(key);
    const next = prior !== undefined && rpcNonce <= prior ? prior + 1n : rpcNonce;
    if (next < 0n || next > U64_MAX) throw new Error('access-key nonce outside U64');
    tx.nonce = next;
    this.#nonces.set(key, next);
    return tx;
  }
}
