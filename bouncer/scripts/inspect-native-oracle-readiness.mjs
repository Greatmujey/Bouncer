#!/usr/bin/env node
/** Public, read-only testnet views only. No wallet, keys or transactions. */
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';
import { inspectNativeOracleReadiness } from '../agent/native-oracle-readiness.mjs';
import { inspectNamedTestnetAccount } from '../agent/named-testnet-inventory.mjs';

const owner = 'great_mujey.testnet', vault = 'native.great_mujey.testnet';
const endpoints = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
let readiness, inventory;
for (const endpoint of endpoints) {
  const provider = new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 });
  try { readiness = await inspectNativeOracleReadiness({ owner, vault, provider }); readiness.rpc = new URL(endpoint).hostname; break; }
  catch (error) { console.error(`Native readiness unavailable via ${new URL(endpoint).hostname}: ${String(error?.message || 'unknown').replace(/[\r\n]/g, ' ').slice(0, 180)}`); }
}
// Even if the independent project registry is unavailable, keep the user's
// public account balance visible as a separate pinned indication. UNKNOWN does
// not mean zero, approval, wallet control or a safe setup.
if (!readiness) for (const endpoint of endpoints) {
  try { inventory = await inspectNamedTestnetAccount({ owner, accountId: owner, provider: new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 12_000 }) });
    inventory.rpc = new URL(endpoint).hostname; break;
  } catch { /* next endpoint; never manufacture an absent account */ }
}
if (!readiness && !inventory) { console.error('No fresh public testnet snapshot available; no transaction was signed or sent.'); process.exitCode = 1; }
else console.log(JSON.stringify({ readiness: readiness ?? null, inventory: inventory ?? null, signed: false, sent: false }, null, 2));
