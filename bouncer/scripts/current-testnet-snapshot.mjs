#!/usr/bin/env node
/** Fixed-scope public testnet views only. No owner key, credentials, payment,
 * helper, seller endpoint or historical transaction is touched. Each section
 * reports its own fresh FINAL block. An RPC is trusted, not a consensus proof. */
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectHistoricalOwner } from '../agent/historical-owner-readiness.mjs';
import { inspectPayPerCallCatalog } from '../agent/paypercall-inspect.mjs';
import { inspectSvalinLiquidity } from '../agent/svalin-liquidity-readiness.mjs';

const endpoints = ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'];
for (const endpoint of endpoints) {
  try {
    const provider = new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 7000 });
    const [owner, catalog, liquidity] = await Promise.all([
      inspectHistoricalOwner(provider), inspectPayPerCallCatalog(provider), inspectSvalinLiquidity(provider),
    ]);
    const result = { chain: 'testnet', rpc: endpoint, observed_at: new Date().toISOString(),
      owner,
      paypercall: { block_hash: catalog.block_hash, block_timestamp: catalog.block_timestamp,
        escrow_code_hash: catalog.escrow_code_hash, escrow_access_keys: catalog.escrow_access_keys,
        escrow_circle_registration: catalog.escrow_circle_registration,
        service_count: catalog.service_count, scanned_services: catalog.scanned_services,
        complete_catalog_snapshot: catalog.complete_catalog_snapshot,
        circle_candidates_observed: catalog.circle_candidates_observed,
        candidates: catalog.services.filter(s => s.circle_candidate).map(s => ({ service_id: s.service_id,
          provider: s.provider, operator: s.operator, price_base_units: s.price_base_units,
          timeout_secs: s.timeout_secs, endpoint_reachability_checked: false })) },
      liquidity: { block_hash: liquidity.block_hash, block_timestamp: liquidity.block_timestamp,
        svalin_usdc_storage: liquidity.seller_usdc_storage, pools: liquidity.pools },
      signed: false, sent: false, seller_contacted: false, seller_delivery_verified: false,
      scope: 'public views only, separately pinned to fresh FINAL blocks trusted from one RPC; no key custody, trade or provider delivery established' };
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`Read-only endpoint failed: ${new URL(endpoint).hostname}: ${error?.message ?? String(error)}`);
  }
}
console.error('No endpoint returned usable fresh FINAL views; all data remain unknown.');
process.exitCode = 1;
