#!/usr/bin/env node
/** Public, read-only Circle/wNEAR/Ref preflight for the new testnet owner. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectCircleOwnerAcquisition } from '../agent/circle-owner-acquisition-readiness.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-bootstrap-plan.json', import.meta.url), 'utf8'));
const provider = new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 12_000 });
try { console.log(JSON.stringify(await inspectCircleOwnerAcquisition({ plan, provider }), null, 2)); }
catch (error) { console.error(`Owner acquisition views unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
