import { NearConnector } from '@hot-labs/near-connect';
import { initWallet } from './wallet-core.mjs';

// The connector is only constructed on an approved, isolated origin.
void initWallet({ window, document, NearConnector });
