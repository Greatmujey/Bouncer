#!/usr/bin/env node
/** Public pinned views for the replacement vault; never signs or transacts. */
import fs from 'node:fs';
import { inspectVaultCircleFunding } from '../agent/keyless-vault-circle-readiness.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json', import.meta.url), 'utf8'));
try {
  const result = await inspectVaultCircleFunding({ plan, provider: new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 12_000 }) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Circle vault preflight unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
