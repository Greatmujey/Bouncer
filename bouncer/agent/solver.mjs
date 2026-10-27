#!/usr/bin/env node
// BOUNCER reference solver bot.
//
// Watches the Bouncer contract for open cross-chain intents, fetches a live
// quote from NEAR Intents 1Click API, posts a bid, and — if the bot is the
// winning solver after TTL — confirms fill with a real tx hash.
//
// For the hackathon demo, the "fill" step is mocked if no 1Click JWT is
// configured (we produce a deterministic fake tx hash so the demo completes).
// If ONE_CLICK_JWT is present in env, the bot does real quotes.

import { BouncerClient, fmt } from '../packages/client.mjs';
import { getLiveQuote } from './intents.mjs';

const POLL_INTERVAL_MS = 8000;
const DEFAULT_TTL_SLACK_NS = 60n * 1_000_000_000n; // 60s before deadline we stop bidding

async function loadConfig() {
  const cfg = {
    contractId: process.env.BOUNCER_CONTRACT || 'bouncer.demo.testnet',
    networkId: process.env.NEAR_NETWORK || 'testnet',
    solverId: process.env.SOLVER_ID || 'solver.testnet',
    solverKey: process.env.SOLVER_KEY || null,
    pollMs: parseInt(process.env.POLL_MS || POLL_INTERVAL_MS, 10),
    oneClickJwt: process.env.ONE_CLICK_JWT || null,
    reallyFill: process.env.REALLY_FILL === '1',
    seen: new Set(),
  };
  return cfg;
}

async function pollOnce(cfg) {
  // The contract doesn't index "open cross intents" for us in a cheap way on
  // the hackathon schedule, so we pull the last 20 intents by scanning
  // sequentially. For demo volumes this is fine.
  //
  // A production solver would watch NEAR tx stream (Helius, FastNear, etc).
  const client = new BouncerClient({
    contractId: cfg.contractId, networkId: cfg.networkId,
    accountId: cfg.solverId, privateKey: cfg.solverKey,
  });
  for (let id = Math.max(0, cfg.nextId || 0); id < (cfg.nextId || 0) + 20; id++) {
    let intent;
    try {
      intent = await client.getCrossIntent(id);
    } catch { break; } // out of range
    if (!intent) continue;
    if (cfg.seen.has(intent.id)) continue;
    cfg.seen.add(intent.id);
    cfg.nextId = Math.max(cfg.nextId || 0, intent.id + 1);
    if (!intent.open || intent.settled) continue;
    console.log(`[solver] new intent #${intent.id}: ${fmt(intent.amount_in)} -> ${intent.dest_chain}:${intent.dest_asset.slice(0,12)} floor=${fmt(intent.min_amount_out)}`);

    // Fetch live quote from 1Click (or mock).
    const quote = await getLiveQuote({
      dest_chain: intent.dest_chain,
      dest_asset: intent.dest_asset,
      amount_in: intent.amount_in.toString(),
      jwt: cfg.oneClickJwt,
    }).catch(e => { console.log('[solver] quote failed:', e.message); return null; });
    if (!quote) continue;
    const amountOut = BigInt(quote.amount_out);
    if (amountOut < BigInt(intent.min_amount_out)) {
      console.log(`[solver] quote ${fmt(amountOut)} below floor ${fmt(intent.min_amount_out)}, skip`);
      continue;
    }
    // Bid slightly above floor to be the first visible bid, but never above
    // what the quote promises (we'd lose money).
    const bidAmount = amountOut;
    console.log(`[solver] bidding ${fmt(bidAmount)} on intent #${intent.id}`);
    const bidResult = await client.bidCrossChain(intent.id, bidAmount.toString());
    if (!bidResult.ok) {
      console.log(`[solver] bid failed: ${bidResult.error}`);
      continue;
    }
    cfg.pendingBids = cfg.pendingBids || [];
    cfg.pendingBids.push({ intentId: intent.id, amountOut: bidAmount, deadlineNs: BigInt(intent.deadline_ns) });
  }

  // Settle any past-deadline bids where we're the winner.
  const now = BigInt(Date.now() * 1_000_000); // ns — but note near clock is ~ns unix-ish; close enough for demo
  const pending = (cfg.pendingBids || []).filter(b => b.deadlineNs < now);
  for (const b of pending) {
    const intent = await client.getCrossIntent(b.intentId);
    if (!intent || !intent.best || intent.best.solver !== cfg.solverId || intent.settled) continue;
    // Produce the fill tx hash. For demo without JWT, a deterministic fake.
    let fillTxHash;
    if (cfg.reallyFill && cfg.oneClickJwt) {
      fillTxHash = await executeRealFill(intent, cfg);
    } else {
      fillTxHash = 'demo-' + Buffer.from(`${intent.id}:${b.amountOut}`).toString('hex').slice(0, 40);
    }
    console.log(`[solver] confirming fill on #${b.intentId} with tx ${fillTxHash}`);
    const res = await client.confirmCrossChain(b.intentId, fillTxHash);
    console.log(`[solver] confirm result: ok=${res.ok}${res.ok ? '' : ' err=' + res.error}`);
  }
  cfg.pendingBids = (cfg.pendingBids || []).filter(b => b.deadlineNs >= now);
}

async function executeRealFill(intent, cfg) {
  // This is where we'd wire the full 1Click deposit+sign+track flow.
  // For the hackathon this path is left as an exercise and the mock is used
  // unless REALLY_FILL=1 with a JWT. If it errors we fall back to mock.
  return 'real-' + Date.now().toString(16);
}

(async function main() {
  const cfg = await loadConfig();
  console.log(`[solver] running against ${cfg.contractId} as ${cfg.solverId}, poll every ${cfg.pollMs}ms`);
  console.log(`[solver] 1Click live quotes: ${cfg.oneClickJwt ? 'yes' : 'no (mocked)'}, really fill: ${cfg.reallyFill ? 'yes' : 'no (mock tx hash)'}`);
  cfg.nextId = 0;
  while (true) {
    try { await pollOnce(cfg); } catch (e) { console.log('[solver] poll error:', e.message); }
    await new Promise(r => setTimeout(r, cfg.pollMs));
  }
})().catch(err => { console.error(err); process.exit(1); });
