import { NearConnector, SandboxWallet } from '@hot-labs/near-connect';
import { initWallet } from './wallet-core.mjs';

// The connector is only constructed on an approved, isolated origin. The
// separately licensed WalletConnect SDK is lazy-loaded after explicit choice.
const walletConnectBundle = './walletconnect.bundle.js?v=1';
void initWallet({ window, document, NearConnector, SandboxWallet, loadWalletConnect: () => import(walletConnectBundle) });
