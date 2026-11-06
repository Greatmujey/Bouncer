#!/usr/bin/env node
/** Fixed, read-only testnet snapshot. No seller HTTP call or transaction. */
import fs from 'node:fs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectBufferLiveReadiness } from '../agent/buffer-live-readiness.mjs';

const plan = JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v3-plan.json', import.meta.url), 'utf8'));
let result;
for (const endpoint of ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']) {
  try {
    const provider = new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 });
    result = await inspectBufferLiveReadiness({ plan, provider });
    result.rpc = new URL(endpoint).hostname;
    break;
  } catch (error) {
    // These reads contain only public contract/account data, never bearer tokens.
    // Report the bounded reason so a failed or mixed snapshot can be diagnosed.
    const reason = String(error?.message || 'unknown error').replace(/[\r\n]/g, ' ').slice(0, 240);
    console.error(`Readiness unavailable via ${new URL(endpoint).hostname}: ${reason}`);
  }
}
if (!result) {
  console.error('Buffer readiness views unavailable from both testnet RPCs; no transaction was signed or sent.');
  process.exitCode = 1;
} else console.log(JSON.stringify(result, null, 2));
