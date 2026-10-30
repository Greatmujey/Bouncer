// The memo vectors were reconstructed from the recorded mission inputs and
// compared with the three public explorer execute/ft_transfer receipts. This
// is NOT a substitute for running the receipt-inclusive SDK against an RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderMemo } from '../services/resource-provider.mjs';

const report = 'OutLayer single-source Coinbase near/USD=4.27625; worker timestamp=1793371214; tx=4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ; unverified market data.';
test('historical Circle testnet order memo vectors match the recorded inputs', () => {
  assert.equal(orderMemo('compute', { text: report, rounds: 25 }),
    'bouncer-order-v1:compute:6af7db529ebea804d6acbb5f9932a7a538b418226dc2c5c02530219708788fb2');
  assert.equal(orderMemo('storage', { name: 'oracle-price-report', content: report }),
    'bouncer-order-v1:storage:3f863185c48d8de8182f74da23b4637d453d88e0ea4fe098d9737d46917a1898');
  assert.equal(orderMemo('api', { text: report }),
    'bouncer-order-v1:api:ae87a6df347063629a6c4468c493507b88dc09e1457d95dde66c70a31d532bc2');
});
