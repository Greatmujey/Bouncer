// Synthetic RPC input; when configured, this still exercises the real pinned
// third-party SDK. The separate Actions check supplies an actual FINAL receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPipRailTestSdk } from '../scripts/piprail-test-adapter.mjs';
import { verifyPipRailHistory } from '../scripts/verify-piprail-history.mjs';
import { V2_HISTORICAL as h, V2_MEMOS } from '../scripts/seller-v2-history-vectors.mjs';
import { mockGuardedPayment } from './mock-guarded-payment.mjs';

const sdkRoot = process.env.BOUNCER_PIPRAIL_PACKAGE_ROOT;
const key = 'ed25519:kMuMxfvV9WNLuhhqfawrcknYZh8ukCEVTGC4zR2kpXW';
function fixture() {
  const chain = mockGuardedPayment({ hash: h.compute_tx, owner: h.owner, contract: h.contract, publicKey: key,
    args: { policy_id: 'circle-resources', expected_token: h.token, payee: h.vendor, amount: '1000', memo: V2_MEMOS.compute } });
  chain.receipts_outcome[1].outcome.logs = ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: h.contract, new_owner_id: h.vendor, amount: '1000', memo: V2_MEMOS.compute }] })];
  let reads = 0;
  return { chain, provider: { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash, owner, final) {
    assert.equal(hash, h.compute_tx); assert.equal(owner, h.owner); assert.equal(final, 'FINAL'); reads++; return structuredClone(chain);
  }, async sendTransactionUntil() { throw new Error('read-only verifier must not broadcast'); } }, get reads() { return reads; } };
}
test('retrospective SDK check rejects substitutions and exposes restart replay, with no payment',
  { skip: !sdkRoot && 'install the pinned independent SDK and set BOUNCER_PIPRAIL_PACKAGE_ROOT' }, async () => {
    const f = fixture(), sdk = await loadPipRailTestSdk(sdkRoot), result = await verifyPipRailHistory({ provider: f.provider, sdk });
    assert.equal(f.reads, 1); assert.equal(result.tx_hash, h.compute_tx);
    assert.equal(result.same_instance_replay_rejected, true); assert.equal(result.fresh_default_gate_accepts_again, true);
    assert.equal(result.substituted_nonce_rejected, true); assert.equal(result.substituted_payee_rejected, true);
    assert.match(result.challenge, /no independent seller quote/);
    const wrong = fixture(); wrong.provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
    await assert.rejects(verifyPipRailHistory({ provider: wrong.provider, sdk }), /testnet/); assert.equal(wrong.reads, 0);
    const altered = fixture(); altered.chain.receipts_outcome[1].outcome.logs = [];
    await assert.rejects(verifyPipRailHistory({ provider: altered.provider, sdk }), /NEP-297/); assert.equal(altered.reads, 1);
  });
