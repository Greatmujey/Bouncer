/** A strictly read-only receipt lookup added to the pinned view transport.
 * The only additional JSON-RPC method is EXPERIMENTAL_tx_status with a
 * specific testnet owner and original transaction hash. It cannot broadcast.
 * This is recovery evidence from a trusted RPC, not a consensus proof. */
import { ReadOnlyNearRpcProvider } from './read-only-near-rpc.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export class ReadOnlyNearReceiptProvider extends ReadOnlyNearRpcProvider {
  async txStatusReceipts(hash, owner, waitUntil = 'FINAL') {
    if (!isTransactionHash(hash) || !isTestnetAccount(owner) || waitUntil !== 'FINAL') {
      throw new Error('receipt recovery requires the original testnet hash and FINAL');
    }
    const id = 'bouncer-read-only-receipts';
    const response = await this.readOnlyFetch(this.connection.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'EXPERIMENTAL_tx_status',
        params: { tx_hash: hash, sender_account_id: owner, wait_until: 'FINAL' } }),
      signal: AbortSignal.timeout(this.timeoutMs) });
    try {
      if (!response.ok) throw new Error('original receipt lookup unavailable');
      const body = await readBoundedJson(response, { maxBytes: 4_000_000, label: 'original receipt' });
      if (!record(body) || body.jsonrpc !== '2.0' || body.id !== id || body.error || !record(body.result)) {
        throw new Error('invalid original receipt response');
      }
      return body.result;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
}
