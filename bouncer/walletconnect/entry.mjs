// This separately bundled component is loaded only after WalletConnect is
// configured and the user selects it. No wallet transaction methods are used.
import SignClient from '@walletconnect/sign-client';
import QRCode from 'qrcode';
import { connectWalletConnectWithFallback } from '../web-src/walletconnect-core.mjs';

export async function connect(options) {
  return connectWalletConnectWithFallback({ ...options, createClient: config => SignClient.init(config) });
}

export async function renderPairingCode(canvas, uri) {
  await QRCode.toCanvas(canvas, uri, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#101619', light: '#ffffff' } });
}
