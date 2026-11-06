#!/usr/bin/env node
/** Fixed testnet views only. No quote reservation or transaction. */
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectRefCirclePaths } from '../agent/ref-circle-discovery.mjs';

let result;
for (const endpoint of ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']) {
  try {
    result = await inspectRefCirclePaths({ provider: new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 }) });
    result.rpc = new URL(endpoint).hostname;
    break;
  } catch (error) {
    const reason = String(error?.message || 'unknown error').replace(/[\r\n]/g, ' ').slice(0, 200);
    console.error(`Ref discovery unavailable via ${new URL(endpoint).hostname}: ${reason}`);
  }
}
if (!result) { console.error('No Ref snapshot available; no transaction was signed or sent.'); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
