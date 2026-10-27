#!/usr/bin/env node
/**
 * Live NEAR Intents integration via the 1Click API.
 *
 * Three jobs:
 *  1. `quote`  — fetch a real quote for an intent (what the vault would execute).
 *  2. `market` — collect bids from "solvers" and pick the best, exactly as the
 *                auction in the contract does, but with real market prices.
 *  3. `getLiveQuote` — exported helper used by the solver bot.
 *
 * No API key needed for read-only quotes (a key removes the 0.2% fee).
 * Usage: node agent/intents.mjs quote|market
 */
const BASE = 'https://1click.chaindefuser.com/v0';

// Map a friendly chain+asset selector to a 1Click asset id. For the hackathon
// demo we use a small lookup; production solvers would use the /tokens endpoint
// and build a full map.
const ASSET_BY_CHAIN = {
  'near:usdc': 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'near:wnear': 'nep141:wrap.near',
  'near:usdt': 'nep141:usdt.tether-token.near',
  'base:usdc': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  'eth:usdc': 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  'sol:usdc': 'nep141:sol-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.omft.near',
  'arb:usdc': 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
};

/**
 * Get a live quote from 1Click for a cross-chain payment.
 * opts: { dest_chain (e.g. 'base'), dest_asset ('usdc'), amount_in (smallest unit, string), jwt? }
 * For the demo, origin is always NEAR USDC.
 * Returns { amount_out (bigint string), eta_seconds, ...raw } or a mock if quote fails.
 */
export async function getLiveQuote({ dest_chain, dest_asset = 'usdc', amount_in, jwt = null }) {
  const originAsset = ASSET_BY_CHAIN['near:usdc'];
  const destKey = `${dest_chain}:${dest_asset}`.toLowerCase();
  const destinationAsset = ASSET_BY_CHAIN[destKey];
  if (!destinationAsset) {
    // Fallback: pretend 0.3% bridge fee, 30s eta
    const n = BigInt(amount_in);
    return { amount_out: (n * 997n / 1000n).toString(), eta: 30, mocked: true, reason: `unknown asset ${destKey}` };
  }
  try {
    const body = {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset,
      amount: amount_in.toString(),
      // 1Click requires a valid recipient address per chain; use a dummy for quoting
      recipient: dest_chain === 'near' ? 'recipient.near' : '0x0000000000000000000000000000000000000001',
      recipientType: 'DESTINATION_CHAIN',
      refundTo: 'refund.near',
      refundType: 'ORIGIN_CHAIN',
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      quoteWaitingTimeMs: 2500,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    const r = await fetch(`${BASE}/quote`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`quote HTTP ${r.status}`);
    const q = await r.json();
    return {
      amount_out: q.quote?.amountOut || q.quote?.minAmountOut || '0',
      eta: q.quote?.timeEstimate || 30,
      raw: q,
    };
  } catch (e) {
    // Quote failed (no key, network, etc.) — fall back to mock with 0.3% fee so
    // the demo still works end-to-end.
    const n = BigInt(amount_in);
    return { amount_out: (n * 997n / 1000n).toString(), eta: 30, mocked: true, reason: e.message };
  }
}

const ASSET = {
  wNEAR: 'nep141:wrap.near',
  USDC_NEAR: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  USDC_ETH: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
};

const C = { dim: '\x1b[2m', ok: '\x1b[32m', bad: '\x1b[31m', acc: '\x1b[36m', off: '\x1b[0m' };

async function tokens() {
  const r = await fetch(`${BASE}/tokens`);
  if (!r.ok) throw new Error(`tokens: HTTP ${r.status}`);
  return r.json();
}

/** Request a quote. `dry: true` = validate + price, no deposit address, no execution. */
async function quote({ originAsset, destinationAsset, amount, recipient, slippageBps = 100 }) {
  const body = {
    dry: true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset,
    amount: amount.toString(),
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: recipient,
    refundType: 'ORIGIN_CHAIN',
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    quoteWaitingTimeMs: 1500,
  };
  const r = await fetch(`${BASE}/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`quote: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

const n = (v) => Number(v);

function showQuote(q) {
  const t = q.quoteRequest;
  console.log(`  ${C.dim}in  ${C.off}${q.quote.amountInFormatted} ${t.originAsset.split(':')[1].slice(0, 22)} ${C.dim}($${q.quote.amountInUsd})${C.off}`);
  console.log(`  ${C.dim}out ${C.off}${q.quote.amountOutFormatted} ${C.dim}($${q.quote.amountOutUsd}) · min ${C.dim}${q.quote.minAmountOut}${C.off}`);
  console.log(`  ${C.dim}eta ${C.off}~${q.quote.timeEstimate}s ${C.dim}· withdrawFee ${C.off}${q.quote.withdrawFee} ${C.dim}· correlationId ${C.off}${q.correlationId.slice(0, 8)}`);
}

async function cmdQuote() {
  console.log(`${C.acc}live quote · NEAR Intents 1Click${C.off}`);
  const t = await tokens();
  console.log(`${C.dim}${t.length} assets across ${new Set(t.map((x) => x.blockchain)).size} chains available${C.off}\n`);
  const q = await quote({
    originAsset: ASSET.wNEAR,
    destinationAsset: ASSET.USDC_NEAR,
    amount: 2n * 10n ** 24n, // 2 wNEAR (24 dp)
    recipient: 'example.near',
  });
  showQuote(q);
}

/**
 * The auction. Each "solver" is a different real routing strategy; we price all of
 * them with live data and award the intent to the one that delivers the most,
 * subject to the human's floor — the same rule the contract's `bid` enforces.
 */
async function cmdMarket() {
  const amount = 2n * 10n ** 24n; // 2 wNEAR
  const FLOOR = 8_500_000n; // 8.5 USDC — human's minimum acceptable output

  console.log(`${C.acc}intent auction · live prices, contract rules${C.off}`);
  console.log(`${C.dim}intent: swap 2 wNEAR → USDC, floor 8.5 USDC, deadline 30m${C.off}\n`);

  const strategies = [
    { solver: 'solver-alpha.near', dest: ASSET.USDC_NEAR, slippageBps: 50, recipient: 'example.near' },
    { solver: 'solver-beta.near', dest: ASSET.USDC_NEAR, slippageBps: 300, recipient: 'example.near' },
    // A cross-chain solver must be paid on its own chain: 1Click rejects a .near
    // recipient for an Ethereum destination. Address format is per-chain.
    { solver: 'solver-gamma.near', dest: ASSET.USDC_ETH, slippageBps: 100, recipient: '0x0000000000000000000000000000000000000001' },
  ];

  const bids = [];
  for (const s of strategies) {
    try {
      const q = await quote({
        originAsset: ASSET.wNEAR,
        destinationAsset: s.dest,
        amount,
        recipient: s.recipient,
        slippageBps: s.slippageBps,
      });
      bids.push({
        solver: s.solver,
        amountOut: BigInt(q.quote.amountOut),
        minOut: BigInt(q.quote.minAmountOut),
        usd: n(q.quote.amountOutUsd),
        via: s.dest === ASSET.USDC_ETH ? 'ethereum' : 'near',
        eta: q.quote.timeEstimate,
      });
    } catch (e) {
      console.log(`  ${C.bad}✗ ${s.solver} failed to quote${C.off} ${C.dim}${e.message.slice(0, 80)}${C.off}`);
    }
  }

  if (!bids.length) { console.log(`${C.bad}no bids received${C.off}`); return; }

  bids.sort((a, b) => (a.amountOut > b.amountOut ? -1 : 1));
  const winner = bids[0];

  for (const [i, b] of bids.entries()) {
    const eligible = b.amountOut >= FLOOR;
    const tag = i === 0 && eligible ? `${C.ok}WINNER${C.off}` : eligible ? `${C.dim}outbid${C.off}` : `${C.bad}below floor${C.off}`;
    console.log(`  ${b.solver.padEnd(18)} delivers ${String(b.amountOut).padStart(9)} ($${b.usd.toFixed(2)}) via ${b.via.padEnd(8)} ${tag}`);
  }

  console.log();
  if (winner.amountOut < FLOOR) {
    console.log(`  ${C.bad}✗ all bids below the human's floor — vault refuses to execute${C.off}`);
  } else {
    const spread = n(winner.amountOut) - n(bids[bids.length - 1].amountOut);
    console.log(`  ${C.ok}✓ vault awards to ${winner.solver}${C.off} ${C.dim}· best bid beat worst by ${spread} (smallest unit)${C.off}`);
    console.log(`  ${C.dim}every losing bid is logged on-chain, so "nobody could have paid more" is provable${C.off}`);
  }
}

const cmd = process.argv[2] || 'quote';
try {
  if (cmd === 'quote') await cmdQuote();
  else if (cmd === 'market') await cmdMarket();
  else { console.error('usage: node agent/intents.mjs [quote|market]'); process.exit(1); }
} catch (e) {
  console.error(`${C.bad}error:${C.off} ${e.message}`);
  process.exit(1);
}
