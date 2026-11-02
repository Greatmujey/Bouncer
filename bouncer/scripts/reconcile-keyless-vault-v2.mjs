#!/usr/bin/env node
/** READ ONLY. Reconcile the locally journaled original public vault hash from
 * FINAL receipts and pinned fresh state. This script has no signer or sender. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { verifySignedVaultBootstrap } from '../agent/keyless-vault-bootstrap.mjs';
import { reconcileVaultBootstrap } from '../agent/keyless-vault-bootstrap-runner.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const path = new URL('../evidence/testnet-owner-v2/vault-bootstrap-original.json', import.meta.url), stat = fs.lstatSync(path);
if (!stat.isFile() || stat.size < 1 || stat.size > 1_000_000) throw new Error('invalid original public vault envelope');
const bytes = fs.readFileSync(path);
if (bytes.length !== stat.size) throw new Error('original vault envelope changed while reading');
const envelope = JSON.parse(bytes.toString('utf8')); verifySignedVaultBootstrap(envelope, plan);
const provider = new ReadOnlyNearReceiptProvider('https://rpc.testnet.near.org', { timeoutMs: 20_000 });
try {
  const result = await reconcileVaultBootstrap({ plan, envelope, provider });
  console.log(JSON.stringify({ ...result, reconciliation_only: true, signed: false, sent: false }, null, 2));
} catch (error) {
  console.error(`Original vault ${envelope.tx_hash} remains unconfirmed; never resend: ${error?.message ?? 'unknown error'}`);
  process.exitCode = 1;
}
