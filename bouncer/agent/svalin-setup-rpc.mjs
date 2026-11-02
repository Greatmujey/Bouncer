/**
 * EXPERIMENTAL: compose pinned read-only setup views with the existing bounded
 * single-HTTP-send and receipt lookup. This adapter does not enforce review,
 * owner consent, journaling or one-send-per-stage by itself. It is intended
 * only for the separately gated setup coordinator; do not call its send method
 * directly. A truthful RPC and uncompromised process are required.
 */
import nearApi from 'near-api-js';
import { ReadOnlyNearRpcProvider } from './read-only-near-rpc.mjs';
import { PaymentRpcProvider } from './near-account.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export class ExperimentalSvalinSetupRpc extends ReadOnlyNearRpcProvider {
  #endpoint;
  #sender;
  get enforcesSetupBeforeSubmitGuard() { return true; }
  constructor(url, { readTimeoutMs = 15_000, receiptTimeoutMs = 20_000, sendTimeoutMs = 60_000 } = {}) {
    super(url, { timeoutMs: readTimeoutMs });
    this.#endpoint = this.connection.url;
    this.#sender = new PaymentRpcProvider(this.#endpoint, { receiptTimeoutMs, sendTimeoutMs });
  }
  #sameEndpoint() {
    if (this.connection.url !== this.#endpoint || this.#sender.connection.url !== this.#endpoint) {
      throw new Error('setup view and transaction endpoints differ');
    }
  }
  async sendTransactionOnce(signed, waitUntil = 'FINAL', { beforeSubmit } = {}) {
    this.#sameEndpoint();
    if (waitUntil !== 'FINAL' || !isTestnetAccount(signed?.transaction?.signerId) || typeof beforeSubmit !== 'function') {
      throw new Error('setup transport requires a testnet signer, FINAL and a before-submit guard');
    }
    // An endpoint can still lie or change after this check. The caller must
    // already have retained the signed original hash and independently checked
    // the specific reviewed transaction immediately before calling this.
    const bytes = Buffer.from(nearApi.transactions.encodeTransaction(signed));
    const status = await this.viewNodeStatus();
    this.#sameEndpoint();
    if (status?.chain_id !== 'testnet') throw new Error('setup transport requires testnet');
    if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)) {
      throw new Error('signed transaction changed while checking the setup endpoint');
    }
    // Synchronous so no other await separates the caller's final check from
    // the sender's serialization and single fetch. The callback's assertions
    // do not make the trusted RPC, clock or surrounding process trustworthy.
    const guardResult = beforeSubmit();
    if (guardResult !== undefined) {
      if (guardResult && typeof guardResult.then === 'function') Promise.resolve(guardResult).catch(() => {});
      throw new Error('setup before-submit guard must be synchronous');
    }
    this.#sameEndpoint();
    if (!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)) {
      throw new Error('signed transaction changed during the before-submit guard');
    }
    return this.#sender.sendTransactionOnce(signed, 'FINAL');
  }
  async txStatusReceipts(hash, owner, waitUntil = 'FINAL') {
    this.#sameEndpoint();
    if (!isTransactionHash(hash) || !isTestnetAccount(owner) || waitUntil !== 'FINAL') {
      throw new Error('setup recovery requires the original testnet hash and FINAL');
    }
    return this.#sender.txStatusReceipts(hash, owner, 'FINAL');
  }
}
