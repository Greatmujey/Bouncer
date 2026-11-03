#!/usr/bin/env node
/** Public, fixed-scope preflight. No secret, signature, transaction or seller. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectNamedVaultTopup, assertNamedVaultTopupBefore } from '../agent/named-vault-topup.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('../config/greatmujey-testnet-claim.json', import.meta.url), 'utf8'));
for (const endpoint of ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com']) {
  try {
    const provider = new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 10_000 });
    const view = await inspectNamedVaultTopup({ plan, provider });
    assertNamedVaultTopupBefore(view, plan);
    console.log(JSON.stringify({ ...view, rpc: endpoint, necessary_state_checks_passed: true }, null, 2));
    process.exit(0);
  } catch { console.error(`topup state unavailable or ineligible at ${new URL(endpoint).hostname}`); }
}
console.error('No matching testnet snapshot; no signature or transfer.');
process.exitCode = 1;
