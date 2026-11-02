/** Bounded NEAR view transport and pinned-block JSON decoding. The transport
 * cannot sign or broadcast. RPC view calls are HTTP POSTs by JSON-RPC
 * convention but do not mutate the chain. A trusted RPC can still be stale or
 * dishonest; callers must independently check the network and FINAL header. */
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export class ReadOnlyNearRpcProvider extends nearApi.providers.JsonRpcProvider {
  constructor(url, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    super({ url: validateRpcEndpoint(url) }, { retries: 1 });
    if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error('invalid read-only RPC transport');
    }
    this.readOnlyFetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async sendJsonRpc(method, params) {
    const viewTypes = ['view_account', 'view_access_key_list', 'view_access_key', 'call_function'];
    const protocolView = method === 'EXPERIMENTAL_protocol_config' && record(params) &&
      Object.keys(params).length === 1 && isTransactionHash(params.block_id);
    if ((!['status', 'block', 'query'].includes(method) && !protocolView) ||
        (method === 'query' && (!record(params) || !viewTypes.includes(params.request_type)))) {
      throw new Error('read-only RPC method denied');
    }
    const id = 'bouncer-read-only';
    const response = await this.readOnlyFetch(this.connection.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(this.timeoutMs) });
    try {
      if (!response.ok) throw new Error('read-only RPC unavailable');
      const body = await readBoundedJson(response, { maxBytes: 512 * 1024, label: 'read-only RPC' });
      if (!record(body) || body.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) {
        throw new Error('invalid read-only RPC response');
      }
      return body.result;
    } finally { await response.body?.cancel().catch(() => {}); }
  }

  /** Unlike generic query errors, only nearcore's structured UNKNOWN_ACCOUNT
   * for this exact testnet account and pinned block establishes absence. A
   * proxy's text-only error, timeout, wrong block or any other error is unknown. */
  async viewTestnetAccountPresenceAt(accountId, blockHash) {
    if (!isTestnetAccount(accountId) || !isTransactionHash(blockHash)) throw new Error('invalid pinned account view');
    const id = 'bouncer-pinned-presence';
    const response = await this.readOnlyFetch(this.connection.url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'query', params: {
        request_type: 'view_account', account_id: accountId, block_id: blockHash } }),
      signal: AbortSignal.timeout(this.timeoutMs) });
    try {
      if (!response.ok) throw new Error('pinned account presence unavailable');
      const body = await readBoundedJson(response, { maxBytes: 512 * 1024, label: 'read-only RPC' });
      if (!record(body) || body.jsonrpc !== '2.0' || body.id !== id) throw new Error('invalid pinned account presence');
      const cause = body.error?.cause, info = cause?.info;
      if (!Object.hasOwn(body, 'result') && cause?.name === 'UNKNOWN_ACCOUNT' && record(info) &&
          info.requested_account_id === accountId && info.block_hash === blockHash) {
        return { exists: false, block_hash: blockHash };
      }
      if (!body.error && record(body.result) && body.result.block_hash === blockHash) {
        return { exists: true, block_hash: blockHash, account: body.result };
      }
      throw new Error('invalid pinned account presence');
    } finally { await response.body?.cancel().catch(() => {}); }
  }
}

/** near-api-js callFunction discards the response block hash. Use the raw view
 * to fail closed on mixed snapshots, oversized data or non-JSON/UTF-8 results. */
export async function readPinnedJsonView(provider, blockHash, contract, method, args) {
  let result;
  try { result = await provider.callFunctionRaw(contract, method, args, { blockId: blockHash }); }
  catch { throw new Error('view unavailable'); }
  if (!record(result) || result.block_hash !== blockHash || !Array.isArray(result.result) ||
      result.result.length < 1 || result.result.length > 65_536 ||
      result.result.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('invalid view');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result));
    return JSON.parse(text);
  } catch { throw new Error('invalid view'); }
}
