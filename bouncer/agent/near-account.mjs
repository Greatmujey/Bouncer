/**
 * near-api-js currently reads an optimistic access-key nonce each time it
 * signs. A load-balanced RPC can return a stale nonce after a FINAL tx. Keep
 * this process's signed nonces monotonic per key; this does not retry sends,
 * coordinate with other processes, or replace the pending-payment journal.
 */
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

/**
 * near-api-js retries HTTP 500/503 automatically, including send_tx. Durable
 * payment runners want exactly one HTTP submission per signed transaction;
 * ambiguous sends remain journaled and can only be investigated by reading.
 * Receipt lookups are also bounded so an unknown hash does not hang recovery.
 * Injected third-party providers must implement equivalent behavior themselves.
 */
export class PaymentRpcProvider extends nearApi.providers.JsonRpcProvider {
  constructor(url, { receiptTimeoutMs = 20_000 } = {}) {
    super({ url: validateRpcEndpoint(url) }, { retries: 1 });
    if (!Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 1 || receiptTimeoutMs > 120_000) throw new Error('invalid receipt timeout');
    this.receiptTimeoutMs = receiptTimeoutMs;
  }

  async txStatusReceipts(hash, accountId, waitUntil = 'EXECUTED_OPTIMISTIC') {
    const txHash = typeof hash === 'string' ? hash : nearApi.utils.serialize.base_encode(hash);
    const response = await fetch(this.connection.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-receipts', method: 'EXPERIMENTAL_tx_status',
        params: { tx_hash: txHash, sender_account_id: accountId, wait_until: waitUntil } }),
      signal: AbortSignal.timeout(this.receiptTimeoutMs) });
    if (!response.ok) throw new Error(`receipt RPC HTTP ${response.status}; transaction remains unresolved`);
    const body = await readBoundedJson(response, { maxBytes: 4_000_000, label: 'receipt RPC' });
    if (!body || body.error || !Object.hasOwn(body, 'result')) throw new Error(`receipt RPC error: ${JSON.stringify(body?.error ?? 'missing result').slice(0, 400)}; transaction remains unresolved`);
    return body.result;
  }
}

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
