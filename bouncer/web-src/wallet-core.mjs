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
 * The picker is our own accessible dialog; wallet executors remain sandboxed.
 */
export async function initWallet({ window: win, document: doc, NearConnector }) {
  const dialog = doc.querySelector('#wallet-dialog');
  const closeButton = doc.querySelector('#wallet-close');
  const optionsBox = doc.querySelector('#wallet-options');
  const options = [...doc.querySelectorAll('[data-wallet-id]')];
  const openers = [...doc.querySelectorAll('[data-wallet-open]')];
  const disconnect = doc.querySelector('#wallet-disconnect');
  const status = doc.querySelector('#wallet-status');
  const dialogStatus = doc.querySelector('#wallet-dialog-status');
  const openSite = doc.querySelector('#wallet-open-site');
  const banner = doc.querySelector('#wallet-banner');
  if (!dialog || !closeButton || !optionsBox || !options.length || !openers.length || !disconnect || !status || !dialogStatus) return;

  const approved = doc.querySelector('meta[name="bouncer-wallet-origin"]')?.content || '';
  const allowedIds = new Set(WALLET_MANIFEST.wallets.map(wallet => wallet.id));
  let connector, selectedWallet = null, connected = false, ready = false, busyState = false, opener = null;
  let bannerTimer;
  const trusted = new Set(WALLET_MANIFEST.wallets);
  function setWalletLabels(label) {
    doc.querySelectorAll('[data-wallet-label]').forEach(node => { node.textContent = label; });
  }
  function setStatus(message) { status.textContent = message; dialogStatus.textContent = message; }
  function notify(message, persistent = false) {
    if (!banner) return;
    clearTimeout(bannerTimer);
    banner.textContent = message; banner.hidden = false;
    if (!persistent) {
      bannerTimer = setTimeout(() => { banner.hidden = true; }, 5500);
      bannerTimer?.unref?.();
    }
  }
  function hideBanner() { clearTimeout(bannerTimer); if (banner) banner.hidden = true; }
  function renderControls() {
    optionsBox.hidden = connected;
    options.forEach(button => { button.disabled = !ready || busyState || connected || !allowedIds.has(button.dataset.walletId); });
    disconnect.hidden = !connected; disconnect.disabled = busyState;
    openers.forEach(button => { button.disabled = busyState; });
  }
  function busy(value) { busyState = value; renderControls(); }
  function showDisconnected(message = 'Choose a testnet wallet to connect.') {
    selectedWallet = null; connected = false;
    setStatus(message); setWalletLabels('Connect wallet'); renderControls();
  }
  function acceptAccounts(wallet, accounts) {
    const id = accounts?.[0]?.accountId;
    if (!wallet || !trusted.has(wallet.manifest) || !testnetAccount(id)) {
      showDisconnected('The wallet did not return a testnet account. No account was connected.');
      void storage.remove('selected-wallet').catch(() => {});
      return false;
    }
    selectedWallet = wallet; connected = true;
    setWalletLabels('Account connected');
    setStatus(`Connected: ${id} (wallet-reported). No vault or spending access is granted.`);
    renderControls();
    return true;
  }
  function closePicker() { if (dialog.open) dialog.close(); }
  function openPicker(trigger) {
    if (dialog.open) return;
    opener = trigger || doc.activeElement;
    if (typeof dialog.showModal !== 'function') {
      setStatus('This browser does not support the wallet picker. Try an up-to-date browser.');
      return;
    }
    hideBanner();
    dialog.showModal();
    doc.body?.classList.add('wallet-dialog-open');
    (connected ? disconnect : options.find(button => !button.disabled) || closeButton).focus();
  }
  for (const button of openers) {
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'wallet-dialog');
    button.addEventListener('click', () => openPicker(button));
  }
  closeButton.addEventListener('click', closePicker);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closePicker(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  dialog.addEventListener('close', () => {
    // The browser can queue a close event after an immediately reopened dialog.
    if (dialog.open) return;
    doc.body?.classList.remove('wallet-dialog-open');
    if (opener && typeof opener.focus === 'function') opener.focus();
  });
  dialog.addEventListener('click', event => {
    // Only a click on the backdrop closes the sheet, not empty space inside it.
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePicker();
  });
  renderControls();

  let isTop = false;
  try { isTop = win.top === win.self; } catch { /* fail closed */ }
  if (!walletOriginAllowed(win.location, isTop, approved)) {
    setStatus('Open Bouncer in a new tab to connect your testnet wallet.');
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
  function trimUntrustedWallets() {
    // NEAR Connect also discovers injected/debug/parent-frame wallets. Keep
    // only the exact curated manifest objects; never trust injected overrides.
    connector.wallets = connector.wallets.filter(wallet => trusted.has(wallet.manifest));
  }
  try {
    connector = new NearConnector({ network: 'testnet', features: { testnet: true, signInWithoutAddKey: true },
      autoConnect: false, manifest: WALLET_MANIFEST, storage, providers: { testnet: ['https://test.rpc.fastnear.com'] } });
    // Avoid executing stale code cached by another app/version on this origin.
    connector.db.getItem = async () => null;
    connector.db.setItem = async () => {};
    connector.on('selector:walletsChanged', trimUntrustedWallets);
    connector.on('wallet:signIn', ({ wallet, accounts }) => acceptAccounts(wallet, accounts));
    connector.on('wallet:signOut', () => showDisconnected());
    await connector.whenManifestLoaded;
    trimUntrustedWallets();
    ready = true;
    // Only attempt restoration if this app had a previously selected wallet.
    if (await storage.get('selected-wallet')) {
      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        acceptAccounts(wallet, accounts);
      } catch { showDisconnected('Previous wallet session could not be restored. You can connect again.'); }
    } else showDisconnected();
    renderControls();
  } catch {
    setStatus('Wallet connector could not initialize. Check browser storage and try reloading.');
    ready = false; renderControls();
    return;
  }

  for (const button of options) {
    button.addEventListener('click', async () => {
      const walletId = button.dataset.walletId;
      if (!ready || busyState || connected || !allowedIds.has(walletId)) return;
      const name = WALLET_MANIFEST.wallets.find(wallet => wallet.id === walletId).name;
      busy(true); setStatus(`Opening ${name} on testnet…`); notify(`Opening ${name}…`, true);
      // The NEAR Connect executor uses its own iframe overlay. A native dialog
      // is in the top layer, so close ours before opening the wallet UI.
      closePicker();
      let reopen = false;
      try {
        trimUntrustedWallets();
        // Explicit choice; no addFunctionCallKey, message signing or transaction.
        await connector.connect({ walletId });
        if (!connected) {
          await storage.remove('selected-wallet');
          if (!/did not return a testnet account/.test(status.textContent)) showDisconnected('No valid testnet account was returned.');
          reopen = true;
        } else notify('Testnet account connected. No spending access was granted.');
      } catch {
        await storage.remove('selected-wallet');
        showDisconnected('Wallet connection was cancelled or unavailable. No transaction was sent.');
        reopen = true;
      } finally {
        busy(false);
        if (reopen) { hideBanner(); openPicker(opener); }
      }
    });
  }
  disconnect.addEventListener('click', async () => {
    if (!selectedWallet || busyState) return;
    busy(true); setStatus('Disconnecting your wallet…');
    try { await connector.disconnect(selectedWallet); showDisconnected('Wallet disconnected.'); }
    catch { setStatus('Could not disconnect. Please try again in your wallet.'); }
    finally { busy(false); }
  });
}
