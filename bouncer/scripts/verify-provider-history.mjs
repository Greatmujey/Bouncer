// Read-only compatibility check against three previously completed Circle
// TESTNET payments to our development provider. No signing or new transaction.
// Passing this does NOT mean an independent seller has integrated the SDK.
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { orderMemo } from '../services/resource-provider.mjs';
import { readAndVerifyProviderPayment, verifyProviderPayment } from '../packages/provider-sdk/index.mjs';

const contract_id = 'bouncer-oracle-6a42bf32.testnet';
const owner_account_id = 'owner.bouncer-oracle-6a42bf32.testnet';
const payee = 'vendor.bouncer-oracle-6a42bf32.testnet';
const token = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const oracle = '4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ';
const report = `OutLayer single-source Coinbase near/USD=4.27625; worker timestamp=1793371214; tx=${oracle}; unverified market data.`;
const cases = [
  { resource: 'compute', tx_hash: '7XxeU466RVYvVN3wBrWqXHu2zeHHyFPcs4WhNuFX2GbJ', input: { text: report, rounds: 25 } },
  { resource: 'storage', tx_hash: 'GJkJMWBF2CCh1H5uh9uAKJJciTsqcvcgKvNXvnJrEvjL', input: { name: 'oracle-price-report', content: report } },
  { resource: 'api', tx_hash: '7RxBwG4G6FRqG1o2shYRN2ES2WsxVFdEMd8NWp7zA5vy', input: { text: report } },
];
// Bound receipt reads as well as submissions: an unavailable historical RPC
// must fail rather than hang or repeatedly query for minutes.
const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
async function main() {
  const verified = [];
  for (const item of cases) {
    const expectation = { tx_hash: item.tx_hash, contract_id, owner_account_id, policy_id: 'circle-resources',
      token, payee, amount: '1000', memo: orderMemo(item.resource, item.input) };
    const proof = await readAndVerifyProviderPayment({ provider, expectation });
    const raw = await provider.txStatusReceipts(item.tx_hash, owner_account_id, 'FINAL');
    let rejected = false;
    try { verifyProviderPayment(raw, { ...expectation, payee: 'attacker.testnet' }); } catch { rejected = true; }
    if (!rejected) throw new Error('substituted seller was unexpectedly accepted');
    verified.push({ resource: item.resource, tx: proof.tx_hash, amount: proof.amount, token: proof.token, substituted_seller_rejected: true });
  }
  const summary = { mode: 'read-only historical transactions; no signing or spending', contract: contract_id,
    owner: owner_account_id, seller: payee, transactions: verified, provider: 'self-hosted development',
    independent_seller_integration: false, testnet_usdc_has_no_real_value: true,
    trust: 'configured RPC, Bouncer deployment and token; payment verification does not prove delivery' };
  console.log(`::notice title=Provider verifier historical testnet compatibility::${JSON.stringify(summary)}`);
}
main().catch(error => { console.error(`[provider-history] ${error.stack || error}`); process.exitCode = 1; });
