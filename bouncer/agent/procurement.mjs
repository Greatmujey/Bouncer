#!/usr/bin/env node
// BOUNCER procurement agent demo.
//
// A tiny AI-agent-shaped loop:
//  1. Poll open invoices against policy `agent`.
//  2. For each, call check() to see if the payment is allowed.
//  3. If yes, pay_invoice(); if rejected, log the reason and move on.
//
// The agent holds a function-call key only. It has no ability to raise caps
// or pay unknown payees — see THREAT_MODEL for the structural proof.
//
// Usage:
//   AGENT_ID=agent.xxx.testnet AGENT_KEY=ed25519:... BOUNCER_CONTRACT=bouncer.xxx.testnet \
//     node agent/procurement.mjs
//
// If AGENT_KEY is unset, runs in DRY-RUN mode (checks only, no pays).

import { BouncerClient, fmt } from '../packages/client.mjs';

const POLL_MS = parseInt(process.env.POLL_MS || '6000', 10);
const POLICY_ID = process.env.POLICY_ID || 'procurement';

async function main() {
  const contractId = process.env.BOUNCER_CONTRACT;
  const agentId = process.env.AGENT_ID;
  const agentKey = process.env.AGENT_KEY;
  const networkId = process.env.NEAR_NETWORK || 'testnet';
  const dryRun = !agentKey;

  if (!contractId) {
    console.error('set BOUNCER_CONTRACT=<bouncer account id>');
    process.exit(1);
  }
  const effectiveAgentId = agentId || ('dryrun-agent.' + contractId.split('.').slice(-2).join('.'));
  const client = new BouncerClient({
    contractId, networkId,
    accountId: effectiveAgentId,
    privateKey: agentKey,
  });

  console.log(`[procurement] watching policy="${POLICY_ID}" on ${contractId} as ${effectiveAgentId}`);
  console.log(`[procurement] mode: ${dryRun ? 'DRY RUN (no agent key set — checks only)' : 'LIVE (key present)'}`);

  const seen = new Set();
  while (true) {
    try {
      const invoices = await client.listInvoices(POLICY_ID, true);
      for (const inv of invoices) {
        if (seen.has(inv.id) || inv.paid) continue;
        seen.add(inv.id);
        const label = `#${inv.id} ${fmt(inv.amount)} to ${inv.payee} ("${inv.memo}")`;
        const [ok, reason] = await client.check(POLICY_ID, inv.payee, inv.amount.toString());
        if (!ok) {
          console.log(`[procurement] REFUSE ${label} — ${reason}`);
          continue;
        }
        console.log(`[procurement] ALLOW  ${label}`);
        if (dryRun) { console.log(`[procurement] (dry run; not sending pay_invoice)`); continue; }
        const res = await client.payInvoice(POLICY_ID, inv.id);
        if (res.ok) {
          console.log(`[procurement] PAID   ${label} (tx ${res.txHash})`);
        } else {
          console.log(`[procurement] FAIL   ${label} — ${res.error}`);
        }
      }
    } catch (e) {
      console.log('[procurement] poll error:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
