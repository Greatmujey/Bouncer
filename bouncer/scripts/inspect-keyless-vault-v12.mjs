#!/usr/bin/env node
/** Public read-only backed-up owner V12 testnet vault preflight. No signature or transaction. */
import fs from 'node:fs';
import { inspectKeylessVaultBootstrap } from '../agent/keyless-vault-v12-readiness.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { assertV12OriginalReference } from '../agent/keyless-vault-v12-runner.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8'));
const provider = new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com', { timeoutMs: 12_000 });
try {
  const result = await inspectKeylessVaultBootstrap({ plan, provider });
  if (result.status !== 'READ_ONLY_BOOTSTRAP_INDICATED') {
    console.log(JSON.stringify(result, null, 2)); process.exitCode = 2;
  } else {
    // Probe the same canonical/reference queries that the future fenced send
    // requires, before any bearer exists. The FINAL block is its own reference.
    await assertV12OriginalReference({ provider, currentBlockHash: result.block_hash, envelope: { block_hash: result.block_hash } });
    console.log(JSON.stringify({ ...result, canonical_reference_check: 'PASS' }, null, 2));
  }
} catch (error) { console.error(`Keyless vault preflight unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
