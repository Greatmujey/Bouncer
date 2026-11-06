#!/usr/bin/env node
/** Fixed read-only Ref testnet path allocation research; no signers or sends. */
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectRefCircleSplits } from '../agent/ref-circle-discovery.mjs';

let result;
for (const endpoint of ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']) {
  try {
    result = await inspectRefCircleSplits({ provider: new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 }) });
    result.rpc = new URL(endpoint).hostname;
    break;
  } catch (error) {
    const reason = String(error?.message || 'unknown error').replace(/[\r\n]/g, ' ').slice(0, 200);
    console.error(`Ref split discovery unavailable via ${new URL(endpoint).hostname}: ${reason}`);
  }
}
if (!result) { console.error('No Ref split snapshot available; no transaction was signed or sent.'); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
