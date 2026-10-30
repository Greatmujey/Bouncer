// The memo vectors were reconstructed from the recorded mission inputs and
// compared with the three public explorer execute/ft_transfer receipts. This
// is NOT a substitute for running the receipt-inclusive SDK against an RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { orderMemo } from '../services/resource-provider.mjs';
import { verifyProviderPayment } from '../packages/provider-sdk/index.mjs';

const report = 'OutLayer single-source Coinbase near/USD=4.27625; worker timestamp=1793371214; tx=4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ; unverified market data.';
test('historical Circle testnet order memo vectors match the recorded inputs', () => {
  assert.equal(orderMemo('compute', { text: report, rounds: 25 }),
    'bouncer-order-v1:compute:6af7db529ebea804d6acbb5f9932a7a538b418226dc2c5c02530219708788fb2');
  assert.equal(orderMemo('storage', { name: 'oracle-price-report', content: report }),
    'bouncer-order-v1:storage:3f863185c48d8de8182f74da23b4637d453d88e0ea4fe098d9737d46917a1898');
  assert.equal(orderMemo('api', { text: report }),
    'bouncer-order-v1:api:ae87a6df347063629a6c4468c493507b88dc09e1457d95dde66c70a31d532bc2');
});

test('seller verifier accepts a partial reconstruction from historical testnet blocks', () => {
  // Fields/IDs are transcribed from FastNEAR's testnet block data at heights
  // 275463446–449. This is a deliberately REDUCED reconstruction, not a raw
  // tx_status RPC response: final status is synthesized from the observed
  // completion, and unrelated receipts/proofs and metadata are omitted. It is
  // useful as a regression vector, not evidence of complete FINAL RPC data.
  const result = JSON.parse(fs.readFileSync(new URL('./fixtures/circle-compute-reconstructed.json', import.meta.url), 'utf8'));
  const expectation = {
    tx_hash: '7XxeU466RVYvVN3wBrWqXHu2zeHHyFPcs4WhNuFX2GbJ', contract_id: 'bouncer-oracle-6a42bf32.testnet',
    owner_account_id: 'owner.bouncer-oracle-6a42bf32.testnet', policy_id: 'circle-resources',
    token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
    payee: 'vendor.bouncer-oracle-6a42bf32.testnet', amount: '1000', memo: orderMemo('compute', { text: report, rounds: 25 }),
  };
  assert.equal(verifyProviderPayment(result, expectation).tx_hash, expectation.tx_hash);
  assert.throws(() => verifyProviderPayment(result, { ...expectation, payee: 'attacker.testnet' }), /does not match/);
});
