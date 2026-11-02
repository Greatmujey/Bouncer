#!/usr/bin/env node
/** Read-only recovery of the original named-account topup hash. Never signs,
 * submits, replaces or retries the original transaction. */
import fs from 'node:fs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
import { reconcileNamedVaultTopup } from '../agent/named-vault-topup-runner.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('../config/greatmujey-testnet-claim.json', import.meta.url), 'utf8'));
const envelope = JSON.parse(fs.readFileSync(new URL('../evidence/greatmujey-testnet/vault-topup-original.json', import.meta.url), 'utf8'));
for (const endpoint of ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com']) {
  try {
    const provider = new ReadOnlyNearReceiptProvider(endpoint, { timeoutMs: 15_000 });
    const result = await reconcileNamedVaultTopup({ plan, envelope, provider });
    console.log(JSON.stringify({ ...result, rpc: endpoint, reconciliation_only: true }, null, 2));
    process.exit(0);
  } catch { console.error(`Original topup unavailable or mismatched at ${new URL(endpoint).hostname}; no send`); }
}
console.error(`Original testnet topup ${envelope.tx_hash} remains unresolved; retain the original and never resend.`);
process.exitCode = 1;
