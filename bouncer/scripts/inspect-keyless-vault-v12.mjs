#!/usr/bin/env node
/** Public read-only backed-up owner V12 testnet vault preflight. No signature or transaction. */
import fs from 'node:fs';
import { inspectKeylessVaultBootstrap } from '../agent/keyless-vault-v12-readiness.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8'));
const provider = new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com', { timeoutMs: 12_000 });
try {
  const result = await inspectKeylessVaultBootstrap({ plan, provider });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'READ_ONLY_BOOTSTRAP_INDICATED') process.exitCode = 2;
} catch (error) { console.error(`Keyless vault preflight unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
