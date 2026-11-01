// Public 1 Nov 2026 seller-v2 testnet run. These values reconstruct inputs
// and memos observed in the explorer; they are not raw FINAL RPC receipts,
// proof of data truth/future storage, or independent seller adoption.
import { orderMemoV2 } from '../packages/provider-sdk/index.mjs';
import { reconstructHistoricalOrders } from './dependent-history-vectors.mjs';

export const V2_HISTORICAL = Object.freeze({
  contract: 'bouncer-oracle-d27edb40.testnet', owner: 'owner.bouncer-oracle-d27edb40.testnet',
  vendor: 'vendor.bouncer-oracle-d27edb40.testnet', token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  source_tx: 'EGKJHuRGtjk2SUUNeqLerGBn9q5sBatb74QuWuS5fRsn',
  source_key: 'ed25519:Jbqan7Lk5ooYxkP738S8gCeKLbhd9U1HJkuwGAGMsLJ',
  compute_tx: 'HwQB5RTFgascGDjPUmkCkiexF2WEHShHX69d6yGw7JMc',
  storage_tx: 'DpAJymo4MNEipNKEhEiwjBRHt6AqnHaVAXZu9QUUHb9u',
  api_tx: 'EofVKtasXZMf9TbTv4FtivigFwb8VrzYZZXToRYNq15L',
});
export const V2_SOURCE = Object.freeze({ success: true, token_id: 'near', source: 'custom', price_usd: 4.4585, timestamp: 1793498407 });
export const V2_CHALLENGES = Object.freeze({
  compute: '3cc0ec9e855cd2f61d0c9dd273611e54',
  storage: '56b8514694454fcad809850f6c96908a',
  api: '4f340b2dcfe9c523890a8e1020f68ade',
});
export const V2_MEMOS = Object.freeze({
  compute: 'bouncer-order-v2:compute:3cc0ec9e855cd2f61d0c9dd273611e54:906a8655d5b098d7ece9c2ad85349535df6530552c6ba1f3ad50924b3b041f8c',
  storage: 'bouncer-order-v2:storage:56b8514694454fcad809850f6c96908a:5866cd950d530a4efbf607b0d8cd199d7c95625a3584c60797672c8f1ecf4b19',
  api: 'bouncer-order-v2:api:4f340b2dcfe9c523890a8e1020f68ade:b94ae59aade21bf17a5918a2dd57d3a98ebca91f2da610f4735edc60997dfc2f',
});

export function reconstructSellerV2Orders(observation = V2_SOURCE, challenges = V2_CHALLENGES) {
  return reconstructHistoricalOrders(observation, { historical: V2_HISTORICAL,
    memoFor: (resource, input) => orderMemoV2(resource, input, challenges?.[resource]) });
}
