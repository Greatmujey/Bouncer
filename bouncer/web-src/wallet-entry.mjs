import { NearConnector, SandboxWallet } from '@hot-labs/near-connect';
import { initWallet } from './wallet-core.mjs';

// Curated testnet wallet executors are integrity-checked before they run.
// Google identity is a separate session; there is no WalletConnect QR client.
void initWallet({ window, document, NearConnector, SandboxWallet });
