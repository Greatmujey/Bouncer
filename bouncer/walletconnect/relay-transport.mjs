// Injected only into the isolated WalletConnect bundle. The application and
// unrelated sockets keep the browser's native WebSocket. A gateway attempt
// registers its own freshly signed JWT, then exactly that socket is routed to
// the same-origin bridge. The JWT goes in the first encrypted frame, never the
// gateway URL. Pairing keys and URIs are not supplied to the bridge.
const registered = new Map();
const MAX_PENDING = 128;
const READY = 'BOUNCER_RELAY_READY_V1';
const ERROR = 'BOUNCER_RELAY_ERROR_V1:';
const canonical = 'wss://relay.walletconnect.org';

export function registerBridgeToken(token, signal) {
  const now = Date.now();
  // Keep expired registrations as small tombstones until consumed: a very late
  // cancelled SDK attempt must not accidentally fall through to a direct URL.
  // The cap fails closed; reloading the tab clears this in-memory map.
  if (signal?.aborted || typeof token !== 'string' || token.length > 1_500 || registered.size >= MAX_PENDING) throw new Error('WalletConnect fallback unavailable');
  registered.set(token, { expiry: now + 60_000, signal });
}

function consumeBridgeToken(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const token = url.searchParams.get('auth');
  const record = registered.get(token);
  if (!record || url.origin !== canonical) return null;
  registered.delete(token);
  // A late cancelled gateway attempt must not fall through to a direct socket.
  if (record.expiry <= Date.now() || record.signal?.aborted) throw new Error('WalletConnect pairing cancelled');
  return record;
}

class BridgeSocket {
  constructor(relayURL, signal) {
    this.url = String(relayURL);
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    this.ready = false; this.failed = false; this.closed = false;
    const here = globalThis.location;
    if (!here || here.protocol !== 'https:') throw new Error('WalletConnect fallback requires HTTPS');
    const endpoint = `wss://${here.host}/api/wc-relay`;
    this.socket = new globalThis.WebSocket(endpoint);
    const abort = () => this.socket.close();
    signal?.addEventListener('abort', abort, { once: true });
    this.socket.onopen = () => {
      try { this.socket.send(JSON.stringify({ type: 'connect', url: this.url })); }
      catch { this.signalError('WalletConnect fallback unavailable'); this.socket.close(); }
    };
    this.socket.onmessage = event => {
      if (!this.ready) {
        if (event.data === READY) {
          this.ready = true;
          this.onopen?.(new Event('open'));
        } else {
          const reason = typeof event.data === 'string' && event.data.startsWith(ERROR) ? event.data.slice(ERROR.length) : '';
          this.signalError(reason === 'AUTH' ? '401 WalletConnect relay rejected authorization' : 'WalletConnect fallback unavailable');
          this.socket.close();
        }
        return;
      }
      this.onmessage?.(event);
    };
    this.socket.onerror = () => this.signalError('WalletConnect fallback unavailable');
    this.socket.onclose = event => {
      this.closed = true;
      signal?.removeEventListener('abort', abort);
      if (!this.ready) this.signalError('WalletConnect fallback unavailable');
      this.onclose?.(event);
    };
  }
  signalError(message) {
    if (this.failed) return;
    this.failed = true;
    // The SDK reads event.error. Never include the URL, auth token or frames.
    this.onerror?.({ type: 'error', error: new Error(message) });
  }
  get readyState() { return this.closed ? 3 : this.ready ? this.socket.readyState : this.socket.readyState >= 2 ? this.socket.readyState : 0; }
  get bufferedAmount() { return this.socket.bufferedAmount; }
  get protocol() { return this.socket.protocol; }
  get extensions() { return this.socket.extensions; }
  get binaryType() { return this.socket.binaryType; }
  set binaryType(value) { this.socket.binaryType = value; }
  send(data) {
    if (!this.ready || this.socket.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    return this.socket.send(data);
  }
  close(code, reason) { return this.socket.close(code, reason); }
}

// esbuild injects this export as a lexical WebSocket into the SDK modules.
// Returning the native instance for unregistered tokens avoids touching any
// other wallet, direct relay or application WebSocket.
export class WebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url, protocols) {
    const record = consumeBridgeToken(url);
    if (record) return new BridgeSocket(url, record.signal);
    return protocols === undefined ? new globalThis.WebSocket(url) : new globalThis.WebSocket(url, protocols);
  }
}
