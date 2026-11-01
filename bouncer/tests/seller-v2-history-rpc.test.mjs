import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../packages/provider-sdk/index.mjs';
import { verifySellerV2History } from '../scripts/verify-seller-v2-history.mjs';
import { V2_HISTORICAL as h, V2_SOURCE, reconstructSellerV2Orders } from '../scripts/seller-v2-history-vectors.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

function fixture() {
  const cases = reconstructSellerV2Orders().cases, reads = [];
  const chains = new Map(cases.map(item => [item.tx_hash, mockGuardedPayment({ hash: item.tx_hash, owner: h.owner,
    contract: h.contract, args: { policy_id: 'circle-resources', expected_token: h.token,
      payee: h.vendor, amount: '1000', memo: item.memo } })]));
  const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(tx, owner, wait) {
    reads.push(tx); assert.equal(owner, h.owner); assert.equal(wait, 'FINAL');
    if (tx === h.source_tx) return { sentinel: 'synthetic source receipts' };
    if (!chains.has(tx)) throw new Error('unexpected transaction');
    return structuredClone(chains.get(tx));
  }, async sendTransactionUntil() { throw new Error('historical verification must never broadcast'); } };
  const verifySource = async (goal, chain, key, configuredProvider) => {
    assert.equal(goal.contract_id, h.contract); assert.equal(chain.sentinel, 'synthetic source receipts');
    assert.equal(key, h.source_key); assert.equal(configuredProvider, provider);
    return { tx_hash: h.source_tx, result: { ...V2_SOURCE }, charged_yocto: '10', refunded_to_owner_yocto: '90' };
  };
  return { provider, verifySource, reads };
}

test('seller-v2 historical verifier checks source, all three payments and substitutions with no sends', async () => {
  const f = fixture(), result = await verifySellerV2History({ ...f, sdk });
  assert.equal(result.independent_ft_seller_proven, false);
  assert.deepEqual(result.reconstructed_orders.map(row => row.resource), ['compute', 'storage', 'api']);
  assert.ok(result.reconstructed_orders.every(row => row.substituted_seller_rejected && row.substituted_challenge_rejected));
  assert.deepEqual(f.reads, [h.source_tx, h.compute_tx, h.compute_tx, h.storage_tx, h.api_tx]);
});

test('seller-v2 historical verifier stops on wrong network, changed source and lax seller/challenge verifiers', async () => {
  const network = fixture(); network.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
  await assert.rejects(verifySellerV2History({ ...network, sdk }), /testnet/); assert.equal(network.reads.length, 0);
  const source = fixture(); const original = source.verifySource;
  source.verifySource = async (...args) => ({ ...await original(...args), result: { ...V2_SOURCE, price_usd: 999 } });
  await assert.rejects(verifySellerV2History({ ...source, sdk }), /does not match/);
  assert.deepEqual(source.reads, [h.source_tx]);
  for (const lax of [
    { ...sdk, verifyProviderPayment: (chain, expected) => sdk.verifyProviderPayment(chain, { ...expected, payee: h.vendor }) },
    { ...sdk, verifyProviderPayment: (chain, expected) => sdk.verifyProviderPayment(chain,
      { ...expected, memo: reconstructSellerV2Orders().cases[0].memo }) },
  ]) {
    const changed = fixture();
    await assert.rejects(verifySellerV2History({ ...changed, sdk: lax }), /substituted seller or challenge was accepted/);
    assert.deepEqual(changed.reads, [h.source_tx, h.compute_tx]);
  }
});
