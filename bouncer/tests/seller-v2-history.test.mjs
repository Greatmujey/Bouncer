// Reconstructed public explorer data, not full RPC receipts or a live check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { challengeFromOrderMemo } from '../packages/provider-sdk/index.mjs';
import { V2_HISTORICAL, V2_SOURCE, V2_CHALLENGES, V2_MEMOS,
  reconstructSellerV2Orders } from '../scripts/seller-v2-history-vectors.mjs';

test('reconstructed seller-v2 dependent inputs reproduce the three observed on-chain memos', () => {
  const proof = reconstructSellerV2Orders();
  assert.deepEqual(proof.cases.map(item => item.memo), [V2_MEMOS.compute, V2_MEMOS.storage, V2_MEMOS.api]);
  assert.deepEqual(proof.cases.map(item => item.tx_hash), [V2_HISTORICAL.compute_tx, V2_HISTORICAL.storage_tx, V2_HISTORICAL.api_tx]);
  assert.equal(new Set(Object.values(V2_CHALLENGES)).size, 3);
  for (const item of proof.cases) {
    assert.equal(challengeFromOrderMemo(item.resource, item.input, item.memo), V2_CHALLENGES[item.resource]);
  }
  const source = JSON.parse(proof.cases[0].input.text);
  assert.equal(source.tx_hash, V2_HISTORICAL.source_tx); assert.equal(source.result.price_usd, 4.4585);
  const compute = JSON.parse(proof.cases[1].input.content);
  const storage = JSON.parse(proof.cases[2].input.text);
  assert.equal(compute.tx_hash, V2_HISTORICAL.compute_tx); assert.deepEqual(compute.result, proof.computed);
  assert.equal(storage.tx_hash, V2_HISTORICAL.storage_tx); assert.deepEqual(storage.result, proof.stored);
});

test('changing source data or a seller challenge changes the corresponding reconstructed bindings', () => {
  const proof = reconstructSellerV2Orders();
  const differentPrice = reconstructSellerV2Orders({ ...V2_SOURCE, price_usd: 9.5 });
  for (let i = 0; i < 3; i++) assert.notEqual(differentPrice.cases[i].memo, proof.cases[i].memo);
  const changedChallenge = reconstructSellerV2Orders(V2_SOURCE, { ...V2_CHALLENGES, compute: '0'.repeat(32) });
  assert.notEqual(changedChallenge.cases[0].memo, proof.cases[0].memo);
  assert.equal(changedChallenge.cases[1].memo, proof.cases[1].memo);
  assert.equal(changedChallenge.cases[2].memo, proof.cases[2].memo);
  assert.throws(() => reconstructSellerV2Orders({ ...V2_SOURCE, price_usd: -1 }), /invalid historical source/);
  assert.throws(() => reconstructSellerV2Orders(V2_SOURCE, { ...V2_CHALLENGES, api: 'nope' }), /challenge/);
});
