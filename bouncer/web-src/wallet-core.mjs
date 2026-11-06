import { WALLET_MANIFEST } from './wallet-manifest.mjs';
import { loadVerifiedExecutor } from './wallet-executor.mjs';
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

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

/**
 * Identity-only NEAR Connect integration. No add-key or transaction methods
 * are called. NEAR Mobile and CLI require an off-chain login message;
 * other accounts are wallet-reported, not proof of ownership. The picker is
 * our own accessible dialog; wallet executors remain sandboxed.
 */
export async function initWallet({ window: win, document: doc, NearConnector, SandboxWallet }) {
  const dialog = doc.querySelector('#wallet-dialog');
  const closeButton = doc.querySelector('#wallet-close');
  const optionsBox = doc.querySelector('#wallet-options');
  const options = [...doc.querySelectorAll('[data-wallet-id]')];
  const openers = [...doc.querySelectorAll('[data-wallet-open]')];
  const disconnect = doc.querySelector('#wallet-disconnect');
  const status = doc.querySelector('#wallet-status');
  const dialogStatus = doc.querySelector('#wallet-dialog-status');
  const walletTitle = doc.querySelector('#wallet-title-text');
  const walletDescription = doc.querySelector('#wallet-dialog-description');
  const openSite = doc.querySelector('#wallet-open-site');
  const banner = doc.querySelector('#wallet-banner');
  if (!dialog || !closeButton || !optionsBox || !options.length || !openers.length || !disconnect || !status || !dialogStatus) return;

  const approved = doc.querySelector('meta[name="bouncer-wallet-origin"]')?.content || '';
  const allowedIds = new Set(WALLET_MANIFEST.wallets.map(wallet => wallet.id));
  let connector, selectedWallet = null, connected = false, connectedAccount = '', ready = false, busyState = false, opener = null;
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
    dialog.dataset.walletView = connected ? 'connected' : 'options';
    options.forEach(button => {
      button.disabled = !ready || busyState || connected || !allowedIds.has(button.dataset.walletId);
    });
    disconnect.hidden = !connected; disconnect.disabled = busyState;
    if (walletTitle) walletTitle.textContent = connected ? 'Wallet connected' : 'Connect an account';
    if (walletDescription) walletDescription.textContent = connected
      ? 'Your testnet wallet is connected. Google sign-in is separate.'
      : 'Choose a testnet wallet or continue with Google. Connecting does not grant spending access.';
    openers.forEach(button => {
      button.disabled = busyState;
      button.dataset.walletState = connected ? 'connected' : 'disconnected';
      button.setAttribute('aria-label', connected ? `Connected: ${connectedAccount}. Manage accounts` : 'Connect wallet or Google account');
    });
  }
  function busy(value) { busyState = value; renderControls(); }
  function showDisconnected(message = 'Choose a testnet wallet to connect.') {
    selectedWallet = null; connected = false; connectedAccount = '';
    setStatus(message); setWalletLabels('Connect wallet'); renderControls();
  }
  function acceptAccounts(wallet, accounts, verifiedBy = '') {
    const id = accounts?.[0]?.accountId;
    if (!wallet || !(wallet instanceof SandboxWallet) || !trusted.has(wallet.manifest) || !isTestnetAccount(id) ||
        (['near-cli', 'near-mobile'].includes(wallet.manifest.id) && verifiedBy !== wallet.manifest.id)) {
      showDisconnected('The wallet did not return a verified testnet account. No account was connected.');
      void storage.remove('selected-wallet').catch(() => {});
      return false;
    }
    selectedWallet = wallet; connected = true; connectedAccount = id;
    setWalletLabels('Connected');
    const evidence = verifiedBy === 'near-cli' ? 'CLI login verified against testnet'
      : verifiedBy === 'near-mobile' ? 'NEAR Mobile login verified against testnet' : 'wallet-reported';
    setStatus(`Connected: ${id} (${evidence}). No vault or spending access is granted.`);
    renderControls();
    return true;
  }
  function closePicker() {
    if (dialog.open) dialog.close();
  }
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
    if (typeof win.CustomEvent === 'function') win.dispatchEvent(new win.CustomEvent('bouncer:account-picker-open'));

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
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], iframe, summary, input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
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
    // only curated sandbox instances and replace their loader BEFORE any
    // account restoration or sign-in can execute code. This also avoids the
    // shared IndexedDB executor cache and its background fetch race entirely.
    connector.wallets = connector.wallets.filter(wallet => wallet instanceof SandboxWallet && trusted.has(wallet.manifest));
    for (const wallet of connector.wallets) {
      wallet.executor.loadCode = () => loadVerifiedExecutor(wallet.manifest, {
        fetch: win.fetch.bind(win), crypto: win.crypto, location: win.location,
      });
    }
  }
  try {
    connector = new NearConnector({ network: 'testnet', features: { testnet: true },
      autoConnect: false, manifest: WALLET_MANIFEST, storage, providers: { testnet: ['https://test.rpc.fastnear.com'] } });
    // Defense in depth if the connector ever tries its default loader.
    connector.db.getItem = async () => null;
    connector.db.setItem = async () => {};
    connector.on('selector:walletsChanged', trimUntrustedWallets);
    connector.on('wallet:signIn', ({ wallet, accounts }) => {
      acceptAccounts(wallet, accounts);
    });
    connector.on('wallet:signOut', () => { if (selectedWallet) showDisconnected(); });
    await connector.whenManifestLoaded;
    trimUntrustedWallets();
    ready = true;
    // A CLI account typed in an older version was not verified. Never restore
    // it as connected; CLI and Mobile require a fresh login message each tab.
    const previousWallet = await storage.get('selected-wallet');
    if (previousWallet === 'near-mobile' || previousWallet === 'near-cli') {
      await storage.remove('selected-wallet');
      showDisconnected(`${previousWallet === 'near-cli' ? 'NEAR CLI' : 'NEAR Mobile'} requires a new login message.`);
    } else if (previousWallet) {
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

  // Mobile and Nightly's sandbox popups can lack a visible close control.
  // The parent-side cancel invokes the existing rejection handler; it never
  // approves a request, signs a message or sends a transaction.
  function decorateWalletPopup(walletId) {
    const mobile = walletId === 'near-mobile';
    if (mobile) doc.body?.classList.add('near-mobile-active');
    if (!win.MutationObserver || !doc.body) return () => { if (mobile) doc.body?.classList.remove('near-mobile-active'); };
    const observer = new win.MutationObserver(() => {
      const root = [...doc.querySelectorAll('.hot-connector-popup')].find(node => node.style.display !== 'none' && node.querySelector('iframe'));
      const content = root?.querySelector('.modal-content');
      const backdrop = root?.querySelector('.modal-container');
      const className = mobile ? 'bouncer-mobile-close' : 'bouncer-wallet-close';
      if (!content || !backdrop || content.querySelector(`.${className}`)) return;
      const cancel = doc.createElement('button');
      cancel.type = 'button'; cancel.className = className;
      cancel.setAttribute('aria-label', mobile ? 'Cancel NEAR Mobile connection' : 'Cancel Nightly Wallet connection');
      cancel.textContent = '×';
      cancel.addEventListener('click', () => backdrop.click());
      content.appendChild(cancel);
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); if (mobile) doc.body?.classList.remove('near-mobile-active'); };
  }

  for (const button of options) {
    button.addEventListener('click', async () => {
      const walletId = button.dataset.walletId;
      if (!ready || busyState || connected || !allowedIds.has(walletId)) return;
      const name = WALLET_MANIFEST.wallets.find(wallet => wallet.id === walletId).name;
      const mobile = walletId === 'near-mobile', cli = walletId === 'near-cli';
      busy(true);
      const opening = mobile
        ? 'NEAR Mobile: approve a login message only. No access key or payment is requested.'
        : cli ? 'NEAR CLI: enter your testnet account, then sign the login message in your terminal.'
          : `Opening ${name} on testnet…`;
      setStatus(opening); notify(opening, true);
      // The NEAR Connect executor uses its own iframe overlay. A native dialog
      // is in the top layer, so close ours before opening the wallet UI.
      closePicker();
      let reopen = false, stopWalletPresentation = () => {};
      try {
        trimUntrustedWallets();
        if (mobile) {
          stopWalletPresentation = decorateWalletPopup(walletId);
          // Upstream NEAR Mobile signIn requests an AddKey transaction (and
          // can request FullAccess). Never call it or its key-deleting signOut.
          // A fresh NEP-413 signature identifies the account without an on-chain
          // action. The pinned adapter verifies the signature and testnet key.
          const wallet = connector.wallets.find(candidate => candidate.manifest.id === walletId);
          if (!wallet || !win.crypto?.getRandomValues) throw new Error('NEAR Mobile unavailable');
          const nonce = win.crypto.getRandomValues(new Uint8Array(32));
          const result = await wallet.signMessage({
            network: 'testnet', nonce,
            recipient: win.location.host,
            message: `Connect to Bouncer on NEAR testnet.\n\nThis login message does not approve a transaction, transfer funds, or add an access key.\n\nSite: ${win.location.origin}`,
          });
          if (!result?.signature || !result?.publicKey) throw new Error('No signed login message returned');
          if (!isTestnetAccount(result.accountId)) throw new Error('MOBILE_TESTNET_REQUIRED');
          acceptAccounts(wallet, [{ accountId: result.accountId }], 'near-mobile');
        } else if (cli) {
          // CLI's ordinary signIn accepts any typed name. Ask for a fresh,
          // off-chain NEP-413 signature instead, with no AddKey parameters.
          // Clear its local-only saved choice so a retry can use another ID.
          const wallet = connector.wallets.find(candidate => candidate.manifest.id === walletId);
          if (!wallet || !win.crypto?.getRandomValues) throw new Error('NEAR CLI unavailable');
          await wallet.executor.clearStorage();
          const nonce = win.crypto.getRandomValues(new Uint8Array(32));
          const recipient = win.location.host;
          const message = `Connect to Bouncer on NEAR testnet.\n\nThis login message does not approve a transaction, transfer funds, or add an access key.\n\nSite: ${win.location.origin}`;
          const accounts = await wallet.signInAndSignMessage({ network: 'testnet', messageParams: { message, nonce, recipient } });
          const account = accounts?.[0];
          await verifyCliLogin({ account, message, nonce, recipient, crypto: win.crypto, fetch: win.fetch.bind(win) });
          acceptAccounts(wallet, [account], 'near-cli');
        } else {
          if (walletId === 'nightly-wallet') stopWalletPresentation = decorateWalletPopup(walletId);
          if (walletId === 'intear-wallet') {
            // Intear's app-session protocol needs native WebCrypto Ed25519.
            // Fail clearly on older browsers rather than opening a broken UI.
            try { await win.crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); }
            catch { throw new Error('INTEAR_ED25519_UNAVAILABLE'); }
          }
          // Explicit choice; no addFunctionCallKey, signing or transaction.
          await connector.connect({ walletId });
        }
        if (!connected) {
          await storage.remove('selected-wallet');
          if (!/did not return a verified testnet account/.test(status.textContent)) showDisconnected('No valid testnet account was returned.');
          reopen = true;
        } else notify(`Connected: ${connectedAccount}. No spending access was granted.`);
      } catch (error) {
        await storage.remove('selected-wallet');
        const reason = typeof error === 'string' ? error : error?.message || '';
        showDisconnected(reason === 'INTEAR_ED25519_UNAVAILABLE'
          ? 'Intear needs a newer browser with Ed25519 support. No transaction was sent.'
          : reason === 'CLI_ED25519_UNAVAILABLE'
            ? 'NEAR CLI login needs a newer browser with Ed25519 support. No transaction was sent.'
            : reason === 'CLI_RPC_UNAVAILABLE'
              ? 'Could not check your CLI public key on testnet. Check your connection and try again.'
              : reason === 'CLI_KEY_NOT_FULL_ACCESS'
                ? 'The CLI signing key is not a current Full Access key on this testnet account. No transaction was sent.'
                : cli && /Invalid CLI/.test(reason)
                  ? 'Could not verify the CLI login message. Check the account and paste the complete signed output.'
                  : mobile && reason === 'MOBILE_TESTNET_REQUIRED'
                    ? 'NEAR Mobile did not return a testnet account. Switch the wallet to testnet and try again.'
                    : mobile && /invalid message signature|without a signature|No signed login message/i.test(reason)
                      ? 'Could not verify the NEAR Mobile login message. No account was connected.'
                      : mobile && /full access key/i.test(reason)
                        ? 'The NEAR Mobile signing key could not be verified as a testnet Full Access key. No account was connected.'
                        : mobile && /backend request (failed|timed out)|RPC request failed|RPC error/i.test(reason)
                          ? 'NEAR Mobile or the testnet key check is unavailable. Check your connection and retry.'
                          : 'Wallet connection was cancelled or unavailable. No transaction was sent.');
        reopen = true;
      } finally {
        stopWalletPresentation();
        busy(false);
        if (reopen) { hideBanner(); openPicker(opener); }
      }
    });
  }
  disconnect.addEventListener('click', async () => {
    if (!selectedWallet || busyState) return;
    busy(true); setStatus('Disconnecting your wallet…');
    try {
      if (selectedWallet.manifest.id === 'near-mobile') {
        // Message-only sessions are intentionally not persisted and must not
        // call the adapter's signOut, which can request a DeleteKey transaction.
        await storage.remove('selected-wallet');
      } else await connector.disconnect(selectedWallet);
      showDisconnected('Wallet disconnected.');
    } catch {
      if (!selectedWallet) showDisconnected('Session cleared locally. If it remains in your wallet, disconnect it there.');
      else setStatus('Could not disconnect. Please try again in your wallet.');
    } finally { busy(false); }
  });
}
