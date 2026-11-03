import { NearConnector, SandboxWallet } from '@hot-labs/near-connect';
import { initWallet } from './wallet-core.mjs';

// The connector is only constructed on an approved, isolated origin. The
// separately licensed WalletConnect SDK is lazy-loaded after explicit choice.
const walletConnectBundle = './walletconnect.bundle.js?v=2';
let loadedWalletConnect = null, loadingWalletConnect = null, importAttempt = 0;
function loadWalletConnect({ signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  if (loadedWalletConnect) return Promise.resolve(loadedWalletConnect);
  if (!loadingWalletConnect) {
    // Browsers can cache a failed or stalled dynamic import by URL. Use a new
    // same-origin URL only after an aborted/failed load, so Retry actually
    // starts a fresh download instead of reusing a permanently pending one.
    const attempt = importAttempt++;
    const pending = import(walletConnectBundle + (attempt ? `&retry=${attempt}` : ''));
    loadingWalletConnect = pending;
    pending.then(module => {
      if (loadingWalletConnect === pending) { loadedWalletConnect = module; loadingWalletConnect = null; }
    }, () => { if (loadingWalletConnect === pending) loadingWalletConnect = null; });
  }
  const pending = loadingWalletConnect;
  const abort = () => { if (loadingWalletConnect === pending) loadingWalletConnect = null; };
  signal?.addEventListener('abort', abort, { once: true });
  return pending.finally(() => signal?.removeEventListener('abort', abort));
}
void initWallet({ window, document, NearConnector, SandboxWallet, loadWalletConnect });
