// This separately bundled component is loaded only after WalletConnect is
// configured and the user selects it. No wallet transaction methods are used.
import SignClient from '@walletconnect/sign-client';
import { Core } from '@walletconnect/core';
import QRCode from 'qrcode';
import { registerBridgeToken } from './relay-transport.mjs';
import { connectWalletConnectWithFallback, WC_RELAY_URLS } from '../web-src/walletconnect-core.mjs';

export async function connect(options) {
  return connectWalletConnectWithFallback({ ...options, createClient: ({ useBridge, attemptSignal, ...config }) => {
    // Hold the Core while SignClient.init is pending, so a timed-out attempt
    // can stop its internal retry loop instead of continuing in the background.
    const core = new Core(config);
    const stop = () => {
      try { core.heartbeat?.stop?.(); } catch { /* best effort */ }
      try { void Promise.resolve(core.relayer?.transportClose?.()).catch(() => {}); } catch { /* not started */ }
    };
    attemptSignal?.addEventListener('abort', stop, { once: true });
    const sign = core.crypto.signJWT.bind(core.crypto);
    core.crypto.signJWT = async audience => {
      if (attemptSignal?.aborted || (useBridge && audience !== WC_RELAY_URLS[0])) throw new Error('WalletConnect pairing cancelled');
      const jwt = await sign(audience);
      if (attemptSignal?.aborted) throw new Error('WalletConnect pairing cancelled');
      // Preserve the canonical JWT audience. Only this Core instance's socket
      // is routed by the bundle-local shim to the same-origin gateway.
      if (useBridge) registerBridgeToken(jwt, attemptSignal);
      return jwt;
    };
    return SignClient.init({ ...config, core });
  } });
}

export async function renderPairingCode(canvas, uri) {
  await QRCode.toCanvas(canvas, uri, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101619', light: '#ffffff' } });
}
