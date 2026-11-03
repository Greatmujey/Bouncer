// Bouncer's WalletConnect policy is identity-only. The WalletConnect session
// must never grant sign-in keys, transaction signing, or unrelated networks.
export const WC_CHAIN = 'near:testnet';
export const WC_METHOD = 'near_getAccounts';
export const WC_NAMESPACES = Object.freeze({
  near: Object.freeze({ chains: Object.freeze([WC_CHAIN]), methods: Object.freeze([WC_METHOD]), events: Object.freeze([]) }),
});
export const isWalletConnectProjectId = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);

export function isTestnetAccount(value) {
  return typeof value === 'string' && value.length <= 64 && (
    /^[a-f0-9]{64}$/.test(value) ||
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value)
  );
}

// WalletConnect stores pairing encryption material via this interface. Keep it
// in this tab's memory, not localStorage/IndexedDB, and don't restore old grants.
export function createMemoryStorage() {
  const values = new Map();
  return {
    async getKeys() { return [...values.keys()]; },
    async getEntries() { return [...values.entries()]; },
    async getItem(key) { return values.get(key); },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
    clear() { values.clear(); },
  };
}

export function pairingTopic(uri) {
  if (typeof uri !== 'string' || uri.length > 2048) throw new Error('Invalid WalletConnect pairing URI');
  const match = /^wc:([a-f0-9]{64})@2\?(.+)$/i.exec(uri);
  if (!match) throw new Error('Invalid WalletConnect pairing URI');
  const params = new URLSearchParams(match[2]);
  if (params.get('relay-protocol') !== 'irn' || !/^[a-f0-9]{64}$/i.test(params.get('symKey') || '')) {
    throw new Error('Invalid WalletConnect pairing URI');
  }
  return match[1];
}

// Treat even a wallet's session response as untrusted input. A wallet that
// approves a broader namespace than requested is rejected and disconnected.
export function walletConnectAccount(session, now = Date.now()) {
  if (!session || typeof session.topic !== 'string' || !/^[a-f0-9]{64}$/i.test(session.topic)) throw new Error('Invalid WalletConnect session');
  if (!Number.isFinite(session.expiry) || session.expiry * 1000 <= now) throw new Error('WalletConnect session expired');
  const namespaces = session.namespaces;
  if (!namespaces || typeof namespaces !== 'object' || Array.isArray(namespaces)) throw new Error('Invalid WalletConnect namespace');
  const keys = Object.keys(namespaces);
  if (keys.length !== 1 || !['near', WC_CHAIN].includes(keys[0])) throw new Error('Wallet approved additional networks');
  const near = namespaces[keys[0]];
  if (!near || !Array.isArray(near.methods) || near.methods.length === 0 || !near.methods.every(method => method === WC_METHOD)) {
    throw new Error('Wallet approved additional permissions');
  }
  if (near.chains !== undefined && (!Array.isArray(near.chains) || !near.chains.every(chain => chain === WC_CHAIN))) {
    throw new Error('Wallet approved additional networks');
  }
  if (!Array.isArray(near.accounts) || !near.accounts.length || near.accounts.length > 100) throw new Error('No testnet account returned');
  const accounts = near.accounts.map(value => typeof value === 'string' && value.startsWith(`${WC_CHAIN}:`)
    ? value.slice(WC_CHAIN.length + 1) : '');
  if (!accounts.every(isTestnetAccount)) throw new Error('Wallet did not return only testnet accounts');
  return accounts[0];
}

const USER_DISCONNECTED = Object.freeze({ code: 6000, message: 'User disconnected.' });
function waitBriefly(task, ms = 1500) {
  let timer;
  return Promise.race([
    Promise.resolve(task).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, ms); timer?.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Establish one user-approved WalletConnect session. The only requested RPC
 * method is near_getAccounts; this module never sends a wallet RPC request.
 * The UI supplies a client factory, QR renderer and AbortSignal.
 */
export async function connectWalletConnect({ projectId, origin, createClient, onUri, onEnded, signal, timeoutMs = 180_000 }) {
  if (!isWalletConnectProjectId(projectId)) throw new Error('WalletConnect project ID is not configured');
  const parsed = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) throw new Error('Invalid site origin');
  if (typeof createClient !== 'function' || typeof onUri !== 'function') throw new Error('WalletConnect is unavailable');
  if (signal?.aborted) throw new Error('WalletConnect pairing cancelled');
  const storage = createMemoryStorage();
  // Isolate each retry even if an SDK update unexpectedly enables its global
  // Core cache. The prefix contains no pairing keys and is not persisted.
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable');
  const prefixBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const customStoragePrefix = `bouncer-${Array.from(prefixBytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let client = null, topic = null, pendingTopic = null, stopped = false, active = false;
  let startPhase = 'client';
  let expiryListener, deleteListener, updateListener;
  let timer;
  let abortListener;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(new Error('WalletConnect pairing cancelled'));
    signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => reject(new Error('WalletConnect pairing timed out')), timeoutMs);
    timer?.unref?.();
  });
  // Avoid unhandled rejection if cancellation races with client construction.
  interrupted.catch(() => {});
  const shutdown = async (disconnectSession = true) => {
    if (stopped) return;
    stopped = true;
    active = false;
    if (client) {
      if (deleteListener) client.off?.('session_delete', deleteListener);
      if (expiryListener) client.off?.('session_expire', expiryListener);
      if (updateListener) client.off?.('session_update', updateListener);
      const jobs = [];
      if (disconnectSession && topic) jobs.push(Promise.resolve().then(() => client.disconnect({ topic, reason: USER_DISCONNECTED })));
      if (pendingTopic && client.core?.pairing?.disconnect) jobs.push(Promise.resolve().then(() => client.core.pairing.disconnect({ topic: pendingTopic })));
      await waitBriefly(Promise.allSettled(jobs));
      try { client.core?.heartbeat?.stop?.(); } catch { /* best-effort cleanup */ }
      if (client.core?.relayer?.transportClose) await waitBriefly(Promise.resolve().then(() => client.core.relayer.transportClose()), 500);
    }
    storage.clear();
  };
  try {
    const creating = Promise.resolve().then(() => createClient({
      projectId, storage, customStoragePrefix, logger: 'error', telemetryEnabled: false,
      metadata: { name: 'Bouncer', description: 'NEAR testnet account display', url: origin, icons: [`${origin}/favicon.svg`] },
    }));
    creating.then(late => {
      if (stopped) {
        try { late.core?.heartbeat?.stop?.(); } catch { /* best-effort cleanup */ }
        void Promise.resolve().then(() => late.core?.relayer?.transportClose?.()).catch(() => {}).finally(() => storage.clear());
      }
    }, () => {});
    client = await Promise.race([creating, interrupted]);
    startPhase = 'proposal';
    const opening = Promise.resolve().then(() => client.connect({ requiredNamespaces: {
      near: { chains: [WC_CHAIN], methods: [WC_METHOD], events: [] },
    } }));
    opening.then(late => {
      if (stopped && late?.uri && client?.core?.pairing?.disconnect) {
        try { void Promise.resolve(client.core.pairing.disconnect({ topic: pairingTopic(late.uri) })).catch(() => {}); } catch { /* invalid URI */ }
      }
    }, () => {});
    const proposal = await Promise.race([opening, interrupted]);
    if (!proposal || typeof proposal.approval !== 'function') throw new Error('WalletConnect pairing failed');
    pendingTopic = pairingTopic(proposal.uri);
    startPhase = 'approval';
    // SignClient's approval listener must be armed before exposing the URI: a
    // very fast wallet response can otherwise arrive before approval() is called.
    const approval = Promise.resolve(proposal.approval());
    approval.then(late => {
      if (stopped && late?.topic && client?.disconnect) {
        void Promise.resolve().then(() => client.disconnect({ topic: late.topic, reason: USER_DISCONNECTED })).catch(() => {});
      }
    }, () => {});
    await Promise.race([Promise.resolve(onUri(proposal.uri)), interrupted]);
    const session = await Promise.race([approval, interrupted]);
    topic = typeof session?.topic === 'string' ? session.topic : null;
    const accountId = walletConnectAccount(session);
    const end = message => {
      if (!active || stopped) return;
      active = false;
      void shutdown(false);
      onEnded?.(message);
    };
    deleteListener = event => { if (event?.topic === topic) end('WalletConnect session disconnected.'); };
    expiryListener = event => { if (event?.topic === topic) end('WalletConnect session expired.'); };
    updateListener = event => {
      if (event?.topic !== topic || !active) return;
      try {
        const next = walletConnectAccount({ ...session, namespaces: event?.params?.namespaces });
        if (next !== accountId) throw new Error('Account changed');
      } catch {
        active = false;
        void shutdown(true);
        onEnded?.('WalletConnect permissions or account changed. Please reconnect.');
      }
    };
    client.on('session_delete', deleteListener);
    client.on('session_expire', expiryListener);
    client.on('session_update', updateListener);
    active = true;
    return { accountId, disconnect: () => shutdown(true) };
  } catch (error) {
    await shutdown(true);
    if (signal?.aborted || startPhase === 'approval') throw error;
    // SDK exceptions can include bearer URLs or other internal details. Keep
    // only the startup phase, plus explicit authorization failures, for the UI.
    const reason = String(error?.message || '');
    if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|allowlist/i.test(reason)) {
      const rejected = new Error('WalletConnect site configuration was rejected');
      rejected.code = 'WC_CONFIGURATION';
      throw rejected;
    }
    const failure = new Error('WalletConnect could not prepare a pairing');
    failure.code = startPhase === 'client' ? 'WC_CLIENT_INIT' : 'WC_PROPOSAL_INIT';
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
  }
}

// Both addresses are documented Reown relays. Retry only before a pairing URI
// is exposed: never replay a wallet request or silently replace a visible QR.
export const WC_RELAY_URLS = Object.freeze(['wss://relay.walletconnect.org', 'wss://relay.walletconnect.com']);
export async function connectWalletConnectWithFallback({ createClient, onUri, onProgress, signal, relayStartTimeoutMs = 18_000, ...options }) {
  if (typeof createClient !== 'function' || typeof onUri !== 'function') throw new Error('WalletConnect is unavailable');
  if (!isWalletConnectProjectId(options.projectId)) throw new Error('WalletConnect project ID is not configured');
  const failures = [];
  for (const [index, relayUrl] of WC_RELAY_URLS.entries()) {
    if (signal?.aborted) throw new Error('WalletConnect pairing cancelled');
    const attempt = new AbortController();
    let shown = false, timedOut = false, timer;
    const abort = () => attempt.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      onProgress?.(index === 0 ? 'primary' : 'alternate');
      // Reown's own WebSocket connection timeout is 15 seconds. Do not cut a
      // viable connection short before the SDK has had a chance to finish.
      timer = setTimeout(() => { timedOut = true; attempt.abort(); }, relayStartTimeoutMs);
      return await connectWalletConnect({
        ...options, signal: attempt.signal,
        createClient: config => createClient({ ...config, relayUrl }),
        onUri: uri => { shown = true; clearTimeout(timer); return onUri(uri); },
      });
    } catch (error) {
      if (signal?.aborted || shown) throw error;
      // Invalid site/project configuration is not a relay problem. Do not
      // multiply requests or leak an arbitrary SDK error to the interface.
      const reason = String(error?.message || '');
      if (/Invalid site origin|project ID is not configured/i.test(reason)) throw error;
      if (error?.code === 'WC_CONFIGURATION' || /\b401\b|\b403\b|unauthori[sz]ed|forbidden|allowlist/i.test(reason)) {
        const rejected = new Error('WalletConnect site configuration was rejected');
        rejected.code = 'WC_CONFIGURATION';
        throw rejected;
      }
      failures.push(timedOut ? 'WC_START_TIMEOUT' : error?.code || 'WC_START_FAILED');
      if (index === WC_RELAY_URLS.length - 1) {
        const unavailable = new Error('WalletConnect could not prepare a pairing');
        // Expose only an allowlisted phase code, never raw SDK error text.
        unavailable.code = failures.every(value => value === 'WC_CLIENT_INIT') ? 'WC_CLIENT_INIT'
          : failures.every(value => value === 'WC_PROPOSAL_INIT') ? 'WC_PROPOSAL_INIT'
            : failures.includes('WC_START_TIMEOUT') ? 'WC_START_TIMEOUT' : 'WC_START_FAILED';
        throw unavailable;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
