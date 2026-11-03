#!/usr/bin/env node
/** Fixed public OutLayer views for the backed-up V12 owner/vault only. No
 * signature, order, seller API call, FT transfer or provider payment. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectOutlayerV12Readiness } from '../agent/outlayer-v12-readiness.mjs';
const ownerPlan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8'));
try {
  const result = await inspectOutlayerV12Readiness({ ownerPlan,
    provider: new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com', { timeoutMs: 12_000 }) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`V12 OutLayer readiness unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
