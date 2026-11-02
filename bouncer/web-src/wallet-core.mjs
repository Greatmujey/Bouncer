import { WALLET_MANIFEST } from './wallet-manifest.mjs';

/** A temporary host with many projects under one origin must never hold a wallet session. */
export function walletOriginAllowed(location, isTopLevel, approvedOrigin = '') {
  if (!isTopLevel) return false;
  const { hostname, protocol, origin } = location;
  if (hostname === 'madethis.website' || hostname.endsWith('.madethis.website')) return false;
  // Public GitHub Pages projects owned by the same account share one origin
  // across repository paths, so approving an exact origin would also expose
  // wallet storage to every other project on that origin. Use an isolated
  // custom domain instead, after a separate security review.
  if (hostname === 'github.io' || hostname.endsWith('.github.io')) return false;
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return protocol === 'http:' || protocol === 'https:';
  if (protocol !== 'https:') return false;
  if (/^[a-z0-9-]+-\d+\.app\.github\.dev$/i.test(hostname)) return true;
  if (/^\d+-[a-z0-9-]+\.e2b\.app$/i.test(hostname)) return true;
  // For a real deployment, the owner can explicitly approve its exact dedicated
  // origin in index.html. Never set this to a shared path-based hosting origin.
  return approvedOrigin !== '' && approvedOrigin === origin;
}

function testnetAccount(value) {
  // Implicit IDs exist on both networks; the connector itself is fixed to
  // testnet. A named mainnet account must never be presented as testnet.
  return typeof value === 'string' && value.length <= 64 && (
    /^[a-f0-9]{64}$/.test(value) ||
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value)
  );
}

/**
 * Identity-only NEAR Connect integration. No add-key/sign/send methods are
 * called. The returned account is wallet-reported, not proof of ownership.
 */
export async function initWallet({ window: win, document: doc, NearConnector }) {
  const connect = doc.querySelector('#wallet-connect');
  const disconnect = doc.querySelector('#wallet-disconnect');
  const choice = doc.querySelector('#wallet-choice');
  const status = doc.querySelector('#wallet-status');
  const openSite = doc.querySelector('#wallet-open-site');
  if (!connect || !disconnect || !choice || !status) return;
  const approved = doc.querySelector('meta[name="bouncer-wallet-origin"]')?.content || '';
  let isTop = false;
  try { isTop = win.top === win.self; } catch { /* fail closed */ }
  if (!walletOriginAllowed(win.location, isTop, approved)) {
    status.textContent = 'Open Bouncer in a new tab to connect your testnet wallet.';
    connect.disabled = true; choice.disabled = true;
    if (openSite) {
      // A dedicated development preview can be opened directly; shared or
      // unapproved hosts link to the approved production site instead.
      if (!isTop && walletOriginAllowed(win.location, true, approved) && typeof win.location.href === 'string') {
        openSite.href = win.location.href;
      }
      openSite.hidden = false;
    }
    return;
  }

  const prefix = 'bouncer:near-connect:';
  // Keep the connector selection in memory if persistent storage is blocked.
  // Individual wallet executors may still require browser storage.
  const memory = new Map();
  const storage = {
    async get(key) {
      if (key === 'debug-wallets') return null;
      try { return win.localStorage.getItem(prefix + key) ?? memory.get(key) ?? null; }
      catch { return memory.get(key) ?? null; }
    },
    async set(key, value) {
      if (key === 'debug-wallets') return;
      memory.set(key, value);
      try { win.localStorage.setItem(prefix + key, value); } catch { /* session-only */ }
    },
    async remove(key) {
      memory.delete(key);
      try { win.localStorage.removeItem(prefix + key); } catch { /* session-only */ }
    },
  };
  let connector, selectedWallet = null, connected = false;
  const trusted = new Set(WALLET_MANIFEST.wallets);
  function trimUntrustedWallets() {
    // NEAR Connect also discovers injected/debug/parent-frame wallets. Keep
    // only the exact curated manifest objects; never trust injected overrides.
    connector.wallets = connector.wallets.filter(wallet => trusted.has(wallet.manifest));
  }
  function setWalletLabels(label) {
    doc.querySelectorAll?.('[data-wallet-label]')?.forEach(node => { node.textContent = label; });
  }
  function showDisconnected(message = 'Choose a testnet wallet to connect.') {
    selectedWallet = null; connected = false;
    status.textContent = message; connect.hidden = false; disconnect.hidden = true; choice.disabled = false;
    setWalletLabels('Connect wallet');
  }
  function acceptAccounts(wallet, accounts) {
    const id = accounts?.[0]?.accountId;
    if (!wallet || !trusted.has(wallet.manifest) || !testnetAccount(id)) {
      showDisconnected('The wallet did not return a testnet account. No account was connected.');
      void storage.remove('selected-wallet').catch(() => {});
      return false;
    }
    selectedWallet = wallet; connected = true; choice.disabled = true;
    connect.hidden = true; disconnect.hidden = false; setWalletLabels('Account connected');
    status.textContent = `Connected: ${id} (wallet-reported). No vault or spending access is granted.`;
    return true;
  }
  function busy(value) { connect.disabled = value; disconnect.disabled = value; }

  try {
    connector = new NearConnector({ network: 'testnet', features: { testnet: true, signInWithoutAddKey: true },
      autoConnect: false, manifest: WALLET_MANIFEST, storage, providers: { testnet: ['https://test.rpc.fastnear.com'] } });
    // The SDK normally runs an IndexedDB cache before refreshing the executor.
    // Avoid running stale code cached by another app/version on this origin;
    // fetch the immutable, pinned URL each page session instead.
    connector.db.getItem = async () => null;
    connector.db.setItem = async () => {};
    connector.on('selector:walletsChanged', trimUntrustedWallets);
    connector.on('wallet:signIn', ({ wallet, accounts }) => acceptAccounts(wallet, accounts));
    connector.on('wallet:signOut', () => showDisconnected());
    await connector.whenManifestLoaded;
    trimUntrustedWallets();
    // Only attempt restoration if this app had a previously selected wallet.
    if (await storage.get('selected-wallet')) {
      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        acceptAccounts(wallet, accounts);
      } catch { showDisconnected('Previous wallet session could not be restored. You can connect again.'); }
    } else showDisconnected();
    busy(false);
  } catch {
    status.textContent = 'Wallet connector could not initialize. Check browser storage and try reloading.';
    connect.disabled = true; choice.disabled = true;
    return;
  }

  connect.addEventListener('click', async () => {
    if (connected) return;
    const walletId = choice.value;
    if (!WALLET_MANIFEST.wallets.some(wallet => wallet.id === walletId)) return;
    busy(true); status.textContent = 'Opening your selected testnet wallet…';
    try {
      trimUntrustedWallets();
      // Explicit choice; no addFunctionCallKey, message signing or transaction.
      await connector.connect({ walletId });
      if (!connected) showDisconnected('No valid testnet account was returned.');
    } catch {
      await storage.remove('selected-wallet');
      showDisconnected('Wallet connection was cancelled or unavailable. No transaction was sent.');
    } finally { busy(false); }
  });
  disconnect.addEventListener('click', async () => {
    if (!selectedWallet) return;
    busy(true); status.textContent = 'Disconnecting your wallet…';
    try { await connector.disconnect(selectedWallet); showDisconnected('Wallet disconnected.'); }
    catch { status.textContent = 'Could not disconnect. Please try again in your wallet.'; }
    finally { busy(false); }
  });
}
