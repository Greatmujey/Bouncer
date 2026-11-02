#!/usr/bin/env node
/** Public, read-only one-block Circle registration preflight for the locally
 * generated testnet owner. No key or seller endpoint is used. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectCircleOwnerRegistration } from '../agent/circle-owner-registration.mjs';
const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-bootstrap-plan.json', import.meta.url), 'utf8'));
const provider = new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 12_000 });
try { console.log(JSON.stringify(await inspectCircleOwnerRegistration({ plan, provider }), null, 2)); }
catch (error) { console.error(`Circle owner views unavailable: ${error?.message ?? 'unknown error'}`); process.exitCode = 1; }
