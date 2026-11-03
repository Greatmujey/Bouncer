/**
 * TEST-ONLY adapter for the disposable nearcore integration harness.
 *
 * The production setup coordinator deliberately rejects any chain except
 * testnet. A local sandbox has a different identity, so THIS adapter checks
 * the actual loopback node's named sandbox identity and aliases only the two
 * chain-id fields that the coordinator checks. Every block, state view, signed
 * transaction and receipt still comes from the local node. This is NOT proof
 * of behavior on testnet and must never be imported by production code.
 *
 * No configurable remote endpoint, provider, private key or environment input
 * is accepted here. The optional lost-ack fault is injected only AFTER the
 * real one-shot transport has returned, so it cannot create a second send.
 */
import { ExperimentalSvalinSetupRpc } from '../agent/svalin-setup-rpc.mjs';
import { SANDBOX_CHAIN_ID, assertSandboxStatus } from './v11-sandbox-support.mjs';

export function loopbackSandboxUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('sandbox setup adapter requires a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('sandbox setup adapter requires a loopback HTTP URL');
  }
  return url.href;
}

let fetchFenceActive = false;
/** Fence ALL fetch-based RPC traffic in this test phase to one loopback URL,
 * including receipt lookups, and disable redirects. This is not a general
 * process/network sandbox; only the harness may use this temporary global. */
export async function withSandboxOnlyFetch(url, operation) {
  const expected = loopbackSandboxUrl(url);
  if (typeof operation !== 'function' || fetchFenceActive) throw new Error('sandbox fetch fence is unavailable');
  const original = globalThis.fetch;
  if (typeof original !== 'function') throw new Error('sandbox fetch is unavailable');
  const guarded = (input, options = {}) => {
    let actual;
    try {
      if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('invalid request');
      actual = new URL(input).href;
    } catch { throw new Error('sandbox fetch fence rejected a non-local request'); }
    if (actual !== expected) throw new Error('sandbox fetch fence rejected a non-local request');
    return original(input, { ...options, redirect: 'error' });
  };
  fetchFenceActive = true;
  globalThis.fetch = guarded;
  try { return await operation(); }
  finally { globalThis.fetch = original; fetchFenceActive = false; }
}

export class SandboxSetupRpc extends ExperimentalSvalinSetupRpc {
  #transportCalls = 0;
  #loseNextAcknowledgement = false;
  constructor(url) {
    super(loopbackSandboxUrl(url));
    // The production transport already verifies its read/send endpoints agree.
    // Also keep this test adapter tied to the original loopback endpoint.
    Object.defineProperty(this, 'connection', { value: Object.freeze({ ...this.connection }),
      enumerable: true, writable: false, configurable: false });
  }
  get transportCalls() { return this.#transportCalls; }

  /** In the disposable harness only, simulate losing one successful response. */
  loseNextAcknowledgementForTest() {
    if (this.#loseNextAcknowledgement) throw new Error('sandbox fault is already armed');
    this.#loseNextAcknowledgement = true;
  }

  async viewNodeStatus() {
    const actual = await super.viewNodeStatus();
    assertSandboxStatus(actual);
    return { ...actual, chain_id: 'testnet' };
  }
  async experimental_protocolConfig(reference) {
    const actual = await super.experimental_protocolConfig(reference);
    if (actual?.chain_id !== SANDBOX_CHAIN_ID || actual.protocol_version !== 88) {
      throw new Error('sandbox setup adapter requires the named protocol-88 sandbox');
    }
    return { ...actual, chain_id: 'testnet' };
  }
  async sendTransactionOnce(...args) {
    this.#transportCalls++;
    const actualResult = await super.sendTransactionOnce(...args);
    if (this.#loseNextAcknowledgement) {
      this.#loseNextAcknowledgement = false;
      throw new Error('sandbox-only simulated lost acknowledgement after one send');
    }
    return actualResult;
  }
}
