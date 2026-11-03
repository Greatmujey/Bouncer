import { WALLET_MANIFEST } from './wallet-manifest.mjs';
import { loadVerifiedExecutor } from './wallet-executor.mjs';
import { isTestnetAccount, isWalletConnectProjectId, pairingTopic } from './walletconnect-core.mjs';
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
export async function initWallet({ window: win, document: doc, NearConnector, SandboxWallet, loadWalletConnect, walletConnectStartTimeoutMs = 20_000 }) {
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
  const wcPanel = doc.querySelector('#walletconnect-pairing');
  const wcCaption = doc.querySelector('#walletconnect-caption');
  const wcBadge = doc.querySelector('#walletconnect-badge');
  const wcQr = doc.querySelector('#walletconnect-qr');
  const wcCanvas = doc.querySelector('#walletconnect-canvas');
  const wcOpen = doc.querySelector('#walletconnect-open');
  const wcCopy = doc.querySelector('#walletconnect-copy');
  const wcCancel = doc.querySelector('#walletconnect-cancel');
  const wcRetry = doc.querySelector('#walletconnect-retry');
  const wcLoading = doc.querySelector('#walletconnect-loading');
  const wcProgress = doc.querySelector('#walletconnect-progress');
  const wcError = doc.querySelector('#walletconnect-error');
  const wcErrorTitle = doc.querySelector('#walletconnect-error-title');
  const wcErrorDetail = doc.querySelector('#walletconnect-error-detail');
  const wcReady = doc.querySelector('#walletconnect-ready');
  const walletSafety = doc.querySelector('#wallet-safety');
  if (!dialog || !closeButton || !optionsBox || !options.length || !openers.length || !disconnect || !status || !dialogStatus) return;

  const approved = doc.querySelector('meta[name="bouncer-wallet-origin"]')?.content || '';
  const allowedIds = new Set([...WALLET_MANIFEST.wallets.map(wallet => wallet.id), 'wallet-connect']);
  let connector, selectedWallet = null, connected = false, connectedAccount = '', ready = false, busyState = false, opener = null;
  let wcProjectId = '', wcHandle = null, wcAbort = null, wcPairing = false, wcUri = '';
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
    optionsBox.hidden = connected || wcPairing;
    if (wcPanel) wcPanel.hidden = !wcPairing;
    if (walletSafety) walletSafety.hidden = wcPairing;
    dialog.dataset.walletView = wcPairing ? 'pairing' : connected ? 'connected' : 'options';
    options.forEach(button => {
      const isWc = button.dataset.walletId === 'wallet-connect';
      button.disabled = !ready || busyState || connected || !allowedIds.has(button.dataset.walletId) ||
        (isWc && (!wcProjectId || typeof loadWalletConnect !== 'function' || !wcPanel || !wcQr || !wcCanvas || !wcOpen || !wcCopy || !wcCancel || !wcRetry || !wcLoading || !wcError || !wcReady));
    });
    if (wcCaption) wcCaption.textContent = wcProjectId ? 'QR or wallet app · NEAR testnet' : 'Not configured · Project ID required';
    if (wcBadge) wcBadge.textContent = wcProjectId ? 'CONNECT' : 'SETUP';
    disconnect.hidden = !connected; disconnect.disabled = busyState;
    if (walletTitle) walletTitle.textContent = connected ? 'Wallet connected' : wcPairing ? 'Connect your wallet' : 'Connect a wallet';
    if (walletDescription) walletDescription.textContent = connected
      ? 'Your testnet account is connected. You can disconnect below.'
      : wcPairing ? 'Scan with a NEAR testnet wallet, or open the wallet app on this device.'
        : 'Choose a testnet wallet. NEAR Mobile and NEAR CLI use an off-chain login message; no access key or payment is requested.';
    openers.forEach(button => {
      button.disabled = busyState;
      button.dataset.walletState = connected ? 'connected' : 'disconnected';
      button.setAttribute('aria-label', connected ? `Connected: ${connectedAccount}. Manage wallet` : 'Connect wallet');
    });
  }
  function busy(value) { busyState = value; renderControls(); }
  function showDisconnected(message = 'Choose a testnet wallet to connect.') {
    selectedWallet = null; connected = false; connectedAccount = '';
    if (wcHandle) { const handle = wcHandle; wcHandle = null; void Promise.resolve().then(() => handle.disconnect()).catch(() => {}); }
    setStatus(message); setWalletLabels('Connect wallet'); renderControls();
  }
  function acceptAccounts(wallet, accounts, cliVerified = false) {
    const id = accounts?.[0]?.accountId;
    if (!wallet || !(wallet instanceof SandboxWallet) || !trusted.has(wallet.manifest) || !isTestnetAccount(id) ||
        (wallet.manifest.id === 'near-cli' && !cliVerified)) {
      showDisconnected('The wallet did not return a verified testnet account. No account was connected.');
      void storage.remove('selected-wallet').catch(() => {});
      return false;
    }
    selectedWallet = wallet; connected = true; connectedAccount = id;
    setWalletLabels('Connected');
    setStatus(`Connected: ${id} (${cliVerified ? 'CLI login verified against testnet' : 'wallet-reported'}). No vault or spending access is granted.`);
    renderControls();
    return true;
  }
  function closePicker() {
    if (wcPairing) {
      if (wcAbort) wcAbort.abort('cancelled');
      else { wcPairing = false; clearWalletConnectPairing(); setStatus('Choose a testnet wallet to connect.'); renderControls(); }
    }
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
    if (wcPairing) wcAbort?.abort();
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

  // Configuration is a public deployment artifact, loaded only on a trusted
  // top-level origin. It cannot inject code or enable additional networks.
  // Failure leaves just WalletConnect disabled, not the other wallet choices.
  void (async () => {
    try {
      const response = await win.fetch(new URL('./walletconnect-config.json', win.location.href), {
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > 256) return;
      const config = JSON.parse(text);
      if (config && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).length === 1 && isWalletConnectProjectId(config.projectId)) {
        wcProjectId = config.projectId;
        renderControls();
      }
    } catch { /* No configured WalletConnect project on this deployment. */ }
  })();

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
      if (!wcPairing && !wcHandle) acceptAccounts(wallet, accounts);
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

  function clearWalletConnectPairing() {
    wcUri = '';
    if (wcOpen) { wcOpen.hidden = true; wcOpen.removeAttribute('href'); }
    if (wcCopy) { wcCopy.hidden = true; wcCopy.textContent = 'Copy pairing link'; }
    if (wcQr) wcQr.hidden = true;
    if (wcReady) wcReady.hidden = true;
    try { wcCanvas?.getContext('2d')?.clearRect(0, 0, wcCanvas.width, wcCanvas.height); } catch { /* canvas is optional in tests */ }
  }
  function walletConnectStage(stage, title = '', detail = '') {
    if (wcPanel) wcPanel.dataset.state = stage;
    if (wcLoading) wcLoading.hidden = stage !== 'loading';
    if (wcError) wcError.hidden = stage !== 'error' && stage !== 'qr-error';
    if (wcRetry) wcRetry.hidden = stage !== 'error';
    if (wcReady) wcReady.hidden = stage !== 'ready';
    if (stage === 'error' || stage === 'qr-error') {
      if (wcErrorTitle) wcErrorTitle.textContent = title;
      if (wcErrorDetail) wcErrorDetail.textContent = detail;
    }
  }
  function backToWallets() {
    wcPairing = false; clearWalletConnectPairing();
    setStatus('Choose a testnet wallet to connect.');
    renderControls();
    if (dialog.open) options.find(button => button.dataset.walletId === 'wallet-connect')?.focus();
  }
  wcCancel?.addEventListener('click', () => {
    if (wcAbort) wcAbort.abort('cancelled');
    else backToWallets();
  });
  wcRetry?.addEventListener('click', async () => { if (!wcAbort && !busyState) await openWalletConnect(); });
  wcCopy?.addEventListener('click', async () => {
    if (!wcUri) return;
    try {
      if (!win.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
      await win.navigator.clipboard.writeText(wcUri);
      wcCopy.textContent = 'Copied ✓';
      setStatus('Pairing code copied. Share it only with your wallet app.');
    } catch {
      wcCopy.textContent = 'Copy unavailable';
      setStatus('Copy is unavailable here. Scan the code or open your wallet app.');
    }
  });
  async function openWalletConnect() {
    if (!wcProjectId || typeof loadWalletConnect !== 'function' || wcAbort || busyState || connected) return;
    const controller = new AbortController();
    wcAbort = controller; wcPairing = true;
    clearWalletConnectPairing(); walletConnectStage('loading');
    if (wcProgress) wcProgress.textContent = 'Connecting to WalletConnect. This may take a few seconds.';
    busy(true); setStatus('Preparing a private WalletConnect pairing…');
    if (dialog.open) wcCancel?.focus();
    let startTimedOut = false, shown = false, abortListener;
    const cancelled = new Promise((_, reject) => {
      abortListener = () => reject(new Error('cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    // Bound both the bundle download and relay setup. A stalled import used to
    // wait forever, and the relay could leave an empty view for two minutes.
    const startTimer = setTimeout(() => { startTimedOut = true; controller.abort('timeout'); }, walletConnectStartTimeoutMs);
    const slowTimer = setTimeout(() => {
      if (!controller.signal.aborted && !shown && wcAbort === controller) {
        if (wcProgress) wcProgress.textContent = 'Taking longer than usual. Still trying to reach WalletConnect…';
        setStatus('Still preparing the WalletConnect QR…');
      }
    }, Math.min(8_000, Math.floor(walletConnectStartTimeoutMs / 2)));
    try {
      const module = await Promise.race([Promise.resolve().then(() => loadWalletConnect({ signal: controller.signal })), cancelled]);
      if (controller.signal.aborted) throw new Error('cancelled');
      const connecting = Promise.resolve().then(() => module.connect({
        projectId: wcProjectId, origin: win.location.origin, signal: controller.signal,
        onUri: async uri => {
          if (controller.signal.aborted || wcAbort !== controller) return;
          pairingTopic(uri); // Never put an unvalidated link in the DOM.
          clearTimeout(startTimer); clearTimeout(slowTimer); shown = true;
          wcUri = uri;
          wcOpen.setAttribute('href', uri); wcOpen.hidden = false; wcCopy.hidden = false;
          if (wcProgress) wcProgress.textContent = 'Pairing ready. Drawing your QR code…';
          setStatus('Pairing ready. Drawing the QR code…');
          // Render off-DOM so a cancelled or late attempt cannot paint over a
          // subsequent attempt's QR with an expired, different pairing URI.
          const canvas = doc.createElement('canvas');
          let renderTimer;
          try {
            const rendering = Promise.resolve().then(() => module.renderPairingCode(canvas, uri));
            const renderTimeout = new Promise((_, reject) => { renderTimer = setTimeout(() => reject(new Error('QR rendering timed out')), 5_000); });
            await Promise.race([rendering, renderTimeout, cancelled]);
            if (controller.signal.aborted || wcAbort !== controller) return;
            if (!canvas.width || !canvas.height) throw new Error('QR rendering failed');
            wcCanvas.width = canvas.width; wcCanvas.height = canvas.height;
            const context = wcCanvas.getContext('2d');
            if (!context) throw new Error('QR rendering failed');
            context.drawImage(canvas, 0, 0);
            wcQr.hidden = false; walletConnectStage('ready');
            setStatus('Waiting for approval in your NEAR testnet wallet…');
          } catch {
            if (controller.signal.aborted || wcAbort !== controller) return;
            const message = 'The pairing is ready, but the QR could not be drawn. Open your wallet app or copy the link below.';
            walletConnectStage('qr-error', 'QR display unavailable', message);
            setStatus(message);
          } finally { clearTimeout(renderTimer); }
        },
        onEnded: message => {
          if (!wcHandle) return;
          wcHandle = null; showDisconnected(message); notify(message);
        },
      }));
      // Even if the SDK or a renderer finishes after timeout/cancellation,
      // disconnect a late approved session instead of accepting it.
      connecting.then(late => {
        if ((controller.signal.aborted || wcAbort !== controller) && typeof late?.disconnect === 'function') {
          void Promise.resolve().then(() => late.disconnect()).catch(() => {});
        }
      }, () => {});
      const handle = await Promise.race([connecting, cancelled]);
      if (controller.signal.aborted) { await handle.disconnect(); showDisconnected('WalletConnect pairing cancelled.'); return; }
      if (!isTestnetAccount(handle.accountId)) { await handle.disconnect(); throw new Error('invalid account'); }
      wcHandle = handle; selectedWallet = null; connected = true; connectedAccount = handle.accountId; wcPairing = false;
      setWalletLabels('Connected');
      setStatus(`Connected: ${handle.accountId} (wallet-reported). No vault or spending access is granted.`);
      closePicker(); notify('Testnet account connected. No spending access was granted.');
    } catch (error) {
      if (controller.signal.aborted && !startTimedOut) {
        wcPairing = false;
        showDisconnected('WalletConnect pairing cancelled.');
      } else {
        clearWalletConnectPairing();
        const reason = error?.message || '';
        const message = /401|403|unauthori[sz]ed|forbidden|project.?id|allowlist/i.test(reason)
          ? 'WalletConnect rejected the site configuration. Please try another wallet.'
          : startTimedOut || !shown
            ? 'The QR could not be prepared. Check your connection or try another network, then retry.'
            : /timed out/i.test(reason)
              ? 'The pairing expired before approval. Generate a new QR and try again.'
              : 'The wallet did not complete this NEAR testnet connection. Try again or choose another wallet.';
        walletConnectStage('error', shown ? 'Connection not completed' : 'Couldn’t load the QR', message);
        showDisconnected(message);
      }
    } finally {
      clearTimeout(startTimer); clearTimeout(slowTimer);
      controller.signal.removeEventListener('abort', abortListener);
      if (wcAbort === controller) wcAbort = null;
      if (!wcPairing) clearWalletConnectPairing();
      busy(false);
      if (wcPairing && wcError && !wcError.hidden && dialog.open) wcRetry?.focus();
    }
  }

  for (const button of options) {
    button.addEventListener('click', async () => {
      const walletId = button.dataset.walletId;
      if (!ready || busyState || connected || !allowedIds.has(walletId)) return;
      if (walletId === 'wallet-connect') { await openWalletConnect(); return; }
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
      let reopen = false;
      try {
        trimUntrustedWallets();
        if (mobile) {
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
          acceptAccounts(wallet, [{ accountId: result.accountId }]);
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
          acceptAccounts(wallet, [account], true);
        } else {
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
        } else notify('Testnet account connected. No spending access was granted.');
      } catch (error) {
        await storage.remove('selected-wallet');
        const reason = error?.message;
        showDisconnected(reason === 'INTEAR_ED25519_UNAVAILABLE'
          ? 'Intear needs a newer browser with Ed25519 support. No transaction was sent.'
          : reason === 'CLI_ED25519_UNAVAILABLE'
            ? 'NEAR CLI login needs a newer browser with Ed25519 support. No transaction was sent.'
            : reason === 'CLI_RPC_UNAVAILABLE'
              ? 'Could not check your CLI public key on testnet. Check your connection and try again.'
              : reason === 'CLI_KEY_NOT_FULL_ACCESS'
                ? 'The CLI signing key is not a current Full Access key on this testnet account. No transaction was sent.'
                : cli && /Invalid CLI/.test(reason || '')
                  ? 'Could not verify the CLI login message. Check the account and paste the complete signed output.'
                  : 'Wallet connection was cancelled or unavailable. No transaction was sent.');
        reopen = true;
      } finally {
        busy(false);
        if (reopen) { hideBanner(); openPicker(opener); }
      }
    });
  }
  disconnect.addEventListener('click', async () => {
    if ((!selectedWallet && !wcHandle) || busyState) return;
    busy(true); setStatus('Disconnecting your wallet…');
    try {
      if (wcHandle) {
        const handle = wcHandle; wcHandle = null;
        await handle.disconnect(); // WalletConnect protocol only, never near_signOut.
      } else if (selectedWallet.manifest.id === 'near-mobile') {
        // Message-only sessions are intentionally not persisted and must not
        // call the adapter's signOut, which can request a DeleteKey transaction.
        await storage.remove('selected-wallet');
      } else await connector.disconnect(selectedWallet);
      showDisconnected('Wallet disconnected.');
    } catch {
      if (!selectedWallet && !wcHandle) showDisconnected('Session cleared locally. If it remains in your wallet, disconnect it there.');
      else setStatus('Could not disconnect. Please try again in your wallet.');
    } finally { busy(false); }
  });
}
