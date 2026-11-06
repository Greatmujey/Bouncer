#!/usr/bin/env node
/** Public testnet views only. No wallet, keys, seller contact or transactions. */
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectBufferWalletReadiness } from '../agent/buffer-wallet-readiness.mjs';

const owner = 'great_mujey.testnet', vault = 'vault.great_mujey.testnet';
let result;
for (const endpoint of ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']) {
  try {
    result = await inspectBufferWalletReadiness({ owner, vault, provider: new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 }) });
    result.rpc = new URL(endpoint).hostname;
    break;
  } catch (error) {
    console.error(`Wallet funding readiness unavailable via ${new URL(endpoint).hostname}: ${String(error?.message || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 200)}`);
  }
}
if (!result) { console.error('No wallet funding snapshot available; no transaction was signed or sent.'); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
