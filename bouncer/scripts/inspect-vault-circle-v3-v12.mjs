#!/usr/bin/env node
/** Read-only Circle views for the backed-up V3 owner's V12 vault. No signing,
 * transactions or seller calls. Freshness and code pins can change later. */
import fs from 'node:fs';
import { inspectVaultCircleFunding } from '../agent/keyless-vault-v12-circle-readiness.mjs';
import { assertV12OriginalReference } from '../agent/keyless-vault-v12-runner.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8'));
try {
  const provider = new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com', { timeoutMs: 12_000 });
  const result = await inspectVaultCircleFunding({ plan, provider });
  await assertV12OriginalReference({ provider, currentBlockHash: result.block_hash, envelope: { block_hash: result.block_hash } });
  console.log(JSON.stringify({ ...result, canonical_reference_check: 'PASS' }, null, 2));
} catch (error) { console.error(`V12 Circle vault preflight unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
