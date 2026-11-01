import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../packages/provider-sdk/index.mjs';
import { verifyDependentHistory } from '../scripts/verify-dependent-history.mjs';
import { HISTORICAL, OBSERVED_SOURCE, reconstructHistoricalOrders } from '../scripts/dependent-history-vectors.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

function fixture() {
  const cases = reconstructHistoricalOrders(OBSERVED_SOURCE).cases, reads = [], calls = [];
  const chains = new Map(cases.map(item => [item.tx_hash, mockGuardedPayment({ hash: item.tx_hash, owner: HISTORICAL.owner,
    contract: HISTORICAL.contract, args: { policy_id: 'circle-resources', expected_token: HISTORICAL.token,
      payee: HISTORICAL.vendor, amount: '1000', memo: item.memo } })]));
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(tx, owner, wait) {
    calls.push('receipt'); reads.push(tx); assert.equal(owner, HISTORICAL.owner); assert.equal(wait, 'FINAL');
    if (tx === HISTORICAL.source_tx) return { sentinel: 'synthetic source receipts' };
    if (!chains.has(tx)) throw new Error('unexpected transaction');
    return structuredClone(chains.get(tx));
  }, async sendTransactionUntil() { throw new Error('historical verification must never broadcast'); } };
  const verifySource = async (goal, chain, key, configuredProvider) => {
    assert.equal(goal.contract_id, HISTORICAL.contract); assert.equal(chain.sentinel, 'synthetic source receipts');
    assert.equal(key, HISTORICAL.source_key); assert.equal(configuredProvider, provider);
    return { tx_hash: HISTORICAL.source_tx, result: { ...OBSERVED_SOURCE }, charged_yocto: '10', refunded_to_owner_yocto: '90' };
  };
  return { provider, verifySource, reads, calls };
}

test('historical verification rechecks the source and every exact order with no payment', async () => {
  const f = fixture();
  const result = await verifyDependentHistory({ ...f, sdk });
  assert.equal(result.independent_ft_seller_proven, false);
  assert.deepEqual(result.reconstructed_orders.map(row => row.resource), ['compute', 'storage', 'api']);
  assert.ok(result.reconstructed_orders.every(row => row.substituted_seller_rejected));
  assert.deepEqual(f.reads, [HISTORICAL.source_tx, HISTORICAL.compute_tx, HISTORICAL.compute_tx, HISTORICAL.storage_tx, HISTORICAL.api_tx]);
});

test('historical verification stops on wrong chain, source result or seller verifier behavior', async () => {
  const network = fixture(); network.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(verifyDependentHistory({ ...network, sdk }), /testnet/); assert.equal(network.reads.length, 0);
  const source = fixture(); const original = source.verifySource;
  source.verifySource = async (...args) => ({ ...await original(...args), result: { ...OBSERVED_SOURCE, price_usd: 999 } });
  await assert.rejects(verifyDependentHistory({ ...source, sdk }), /does not match/);
  assert.deepEqual(source.reads, [HISTORICAL.source_tx]);
  const changedSeller = fixture();
  const laxSdk = { ...sdk, verifyProviderPayment: (chain, expected) => sdk.verifyProviderPayment(chain, { ...expected, payee: HISTORICAL.vendor }) };
  await assert.rejects(verifyDependentHistory({ ...changedSeller, sdk: laxSdk }), /substituted seller was accepted/);
  assert.deepEqual(changedSeller.reads, [HISTORICAL.source_tx, HISTORICAL.compute_tx]);
});
