#!/usr/bin/env node
/** READ ONLY: reconcile the exact original V3/V12 Circle vault hash and fresh
 * pinned state; this transport cannot sign or broadcast. */
import fs from 'node:fs';
import { validateOwnerBootstrapPlan } from '../agent/testnet-owner-bootstrap.mjs';
import { verifySignedVaultCircle } from '../agent/keyless-vault-v12-circle.mjs';
import { reconcileVaultCircle } from '../agent/keyless-vault-v12-circle-runner.mjs';
import { ReadOnlyNearReceiptProvider } from '../agent/read-only-near-receipts.mjs';
const [kind, ...extra] = process.argv.slice(2);
if (!['register','fund'].includes(kind) || extra.length) throw new Error('usage: reconcile-vault-circle-v3-v12.mjs register|fund');
const plan = validateOwnerBootstrapPlan(JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8')));
const input = new URL(`../evidence/testnet-owner-v3/vault-v12-circle-${kind}-original.json`, import.meta.url), stat = fs.lstatSync(input);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16_384) throw new Error('invalid original V12 Circle vault bearer');
const bytes = fs.readFileSync(input);
if (bytes.length !== stat.size) throw new Error('original V12 Circle bearer changed while reading');
const envelope = JSON.parse(bytes.toString('utf8'));
if (envelope.kind !== kind) throw new Error('original V12 Circle kind differs');
verifySignedVaultCircle(envelope, plan);
try {
  const result = await reconcileVaultCircle({ plan, envelope, provider: new ReadOnlyNearReceiptProvider('https://test.rpc.fastnear.com', { timeoutMs: 20_000 }) });
  console.log(JSON.stringify({ ...result, reconciliation_only: true, signed: false, sent: false }, null, 2));
} catch (error) { console.error(`Original V12 vault ${kind} ${envelope.tx_hash} remains unconfirmed; never resend: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
