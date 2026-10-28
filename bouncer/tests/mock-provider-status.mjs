// TEST ONLY: stub the RPC status; no blockchain calls are made.
import nearApi from 'near-api-js';
nearApi.providers.JsonRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: process.env.MOCK_CHAIN || 'testnet' });
