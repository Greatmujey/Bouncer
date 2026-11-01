// Offline vectors reconstructed from the public 1 Nov 2026 testnet execution
// and three explorer execute/ft_transfer memos. Not a complete RPC response or
// proof that a provider continues to hold the stored object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORICAL, OBSERVED_SOURCE, OBSERVED_MEMOS, historicalOracleGoal,
  reconstructHistoricalOrders } from '../scripts/dependent-history-vectors.mjs';
import { validateOracleGoal } from '../agent/oracle-outlayer.mjs';

test('historical dependent order bindings reproduce all three observed on-chain memos', () => {
  const vectors = reconstructHistoricalOrders(OBSERVED_SOURCE);
  assert.equal(validateOracleGoal(historicalOracleGoal()).owner_account_id, HISTORICAL.owner);
  assert.deepEqual(vectors.cases.map(item => item.memo), [OBSERVED_MEMOS.compute, OBSERVED_MEMOS.storage, OBSERVED_MEMOS.api]);
  assert.equal(vectors.computed.result, '9a7a84dff13b9db92440cd6bf8af4e71eb82ce352b10ca286985d8b5829aa6e4');
  assert.deepEqual(vectors.stored, { type: 'storage', object_id: '3ae7834caf1e28e587da8bc656e5168b8a3c117d713477ccb5f33b6812301fcd',
    sha256: '419c3860b9c130be47c34389eb83d7e5e8d4bf163359fc41a9a737f22b2728b8', bytes: 263 });
  assert.deepEqual(vectors.cases.map(item => item.tx_hash), [HISTORICAL.compute_tx, HISTORICAL.storage_tx, HISTORICAL.api_tx]);
  // The source is data, but changing it necessarily changes the chained memos.
  const altered = reconstructHistoricalOrders({ ...OBSERVED_SOURCE, price_usd: 9.5 });
  for (let i = 0; i < 3; i++) assert.notEqual(altered.cases[i].memo, vectors.cases[i].memo);
  assert.throws(() => reconstructHistoricalOrders({ ...OBSERVED_SOURCE, price_usd: -1 }));
});
