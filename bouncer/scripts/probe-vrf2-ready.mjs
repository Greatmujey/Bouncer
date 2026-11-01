#!/usr/bin/env node
// READ ONLY: no helper POST, key creation, account, journal, payment or order.
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { assertProviderTerms, readVrf2SetupReadiness } from './paid-vrf2-once.mjs';

async function main() {
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
  // Same canonical seed length as a fresh attempt; this seed is never used for a purchase.
  const input = JSON.stringify({ operation: 'vrf', seed: `bouncer_vrf2_${'0'.repeat(32)}` });
  const [terms, setup] = await Promise.all([assertProviderTerms(provider, input), readVrf2SetupReadiness(provider)]);
  const report = { terms, setup, sends: 0, helper_posts: 0, accounts_created: 0,
    scope: 'read-only, non-atomic testnet availability; fake USDC.e only; no independent fulfillment or reservation established' };
  console.log(`::notice title=Read-only VRF2 terms and funding readiness::${JSON.stringify(report)}`);
}
main().catch(error => {
  const text = String(error.message || error).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`[vrf2-readiness] ${error.message}`); console.log(`::error title=Read-only VRF2 readiness failed::${text}`); process.exitCode = 1;
});
