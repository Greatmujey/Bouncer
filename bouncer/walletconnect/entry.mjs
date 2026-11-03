// This separately bundled component is loaded only after WalletConnect is
// configured and the user selects it. No wallet transaction methods are used.
import SignClient from '@walletconnect/sign-client';
import { Core } from '@walletconnect/core';
import QRCode from 'qrcode';
import { registerBridgeToken } from './relay-transport.mjs';
import { connectWalletConnectWithFallback, WC_RELAY_URLS } from '../web-src/walletconnect-core.mjs';

export async function connect(options) {
  return connectWalletConnectWithFallback({ ...options, createClient: ({ useBridge, attemptSignal, ...config }) => {
    if (!useBridge) return SignClient.init(config);
    // Do not change relayUrl: the relay JWT must be signed for the canonical
    // upstream audience. Only this Core instance's freshly signed socket is
    // routed by the bundle-local transport shim to the same-origin gateway.
    const core = new Core(config);
    const sign = core.crypto.signJWT.bind(core.crypto);
    core.crypto.signJWT = async audience => {
      if (audience !== WC_RELAY_URLS[0] || attemptSignal?.aborted) throw new Error('WalletConnect pairing cancelled');
      const jwt = await sign(audience);
      registerBridgeToken(jwt, attemptSignal);
      return jwt;
    };
    return SignClient.init({ ...config, core });
  } });
}

export async function renderPairingCode(canvas, uri) {
  await QRCode.toCanvas(canvas, uri, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101619', light: '#ffffff' } });
}
