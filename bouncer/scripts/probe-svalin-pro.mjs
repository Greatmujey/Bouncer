#!/usr/bin/env node
/** One anonymous, bounded GET plus testnet RPC views. No checkout,
 * bearer code, activation, transaction, paid request or wallet is involved. */
import { probeSvalinProOffer } from '../agent/svalin-pro-readiness.mjs';
import { inspectSvalinLiquidity } from '../agent/svalin-liquidity-readiness.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';

try {
  const offer = await probeSvalinProOffer();
  const liquidity = await inspectSvalinLiquidity(new ReadOnlyNearRpcProvider('https://rpc.testnet.near.org', { timeoutMs: 15_000 }));
  console.log(`::notice title=Independent Svalin testnet offer (read only)::${JSON.stringify({ offer, liquidity })}`);
} catch (error) {
  console.error(`[svalin-pro-readiness] ${String(error.message).slice(0, 200)}`);
  process.exitCode = 1;
}
