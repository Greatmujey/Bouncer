#!/usr/bin/env node
/** READ ONLY. Check the exact original Circle vault registration or funding
 * hash and fresh pinned state; has no signer and cannot broadcast. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { verifySignedVaultCircle } from '../agent/keyless-vault-circle.mjs';
import { reconcileVaultCircle } from '../agent/keyless-vault-circle-runner.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
const [kind, ...extra] = process.argv.slice(2);
if (!['register','fund'].includes(kind) || extra.length) throw new Error('usage: reconcile-vault-circle-v2.mjs register|fund');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8')));
const input = new URL(`../evidence/testnet-owner-v2/vault-circle-${kind}-original.json`, import.meta.url), stat = fs.lstatSync(input);
if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid original Circle vault bearer');
const bytes = fs.readFileSync(input);
if (bytes.length !== stat.size) throw new Error('original Circle vault bearer changed while reading');
const envelope = JSON.parse(bytes.toString('utf8'));
if (envelope.kind !== kind) throw new Error('original Circle vault kind differs');
verifySignedVaultCircle(envelope, plan);
try {
  const result = await reconcileVaultCircle({ plan, envelope, provider: new ReadOnlyNearReceiptProvider('https://rpc.testnet.near.org', { timeoutMs: 20_000 }) });
  console.log(JSON.stringify({ ...result, reconciliation_only: true, signed: false, sent: false }, null, 2));
} catch (error) { console.error(`Original vault ${kind} ${envelope.tx_hash} remains unconfirmed; never resend: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
