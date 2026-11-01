import test from 'node:test';
import assert from 'node:assert/strict';
import { assessYoutickFunding } from '../agent/youtick-funding.mjs';
const one = '1000000000000000000000000';
const input = () => ({ chain: 'testnet', ownerAmount: '2000000000000000000000000', ownerStorageBytes: 100,
  storagePrice: '10000000000000000000', vaultLedger: '6926', vaultTokens: '6926', pools: [
    { pool_id: 1845, input: one, output: '700000' }, { pool_id: 2206, input: one, output: '650000' }] });
test('funding estimate is read-only, subtracts storage and reserve, and pins a conservative quote', () => {
  const result = assessYoutickFunding(input());
  assert.equal(result.status, 'CANDIDATE_NEEDS_NEW_REVIEWED_ROUTER');
  assert.equal(result.candidate.pool_id, 1845); assert.equal(result.candidate.min_micro_usdc, '665000');
  assert.match(result.scope, /no swap, funding, payment/);
  assert.equal(assessYoutickFunding({ ...input(), ownerAmount: '1000000000000000000000000' }).status, 'NOT_ESTABLISHED');
  assert.equal(assessYoutickFunding({ ...input(), pools: [{ pool_id: 1845, input: one, output: '500000' }] }).status, 'NOT_ESTABLISHED');
  assert.equal(assessYoutickFunding({ ...input(), pools: [{ pool_id: 1, input: one, output: '99999999' }] }).status, 'NOT_ESTABLISHED');
});
test('malformed or inconsistent balances never imply a funding path', () => {
  for (const bad of [{ chain: 'mainnet' }, { ownerStorageBytes: -1 }, { ownerAmount: '1.5' },
    { vaultLedger: '7000' }, { storagePrice: '999999999999999999999999999' }, { pools: null }]) {
    assert.throws(() => assessYoutickFunding({ ...input(), ...bad }));
  }
});
