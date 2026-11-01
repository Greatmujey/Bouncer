#!/usr/bin/env node
/** Recover ONE original seller-v3 delivery, without quoting or signing. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileJournal } from './procurement.mjs';
import { PaymentRpcProvider } from './near-account.mjs';
import { recoverResourceDelivery } from './recover-direct-payment.mjs';
import { routedResourceProvider } from './resource-agent.mjs';

const USAGE = `Usage: node bouncer/agent/recover-direct-delivery.mjs --goals ORIGINAL-GOALS.json --id REQUEST_ID (--state ORIGINAL-JOURNAL.json | --shared-journal STABLE_ID) [--rpc URL]

Verifies the original FINAL payment, then asks the pinned seller to replay and
verify ONE previously paid delivery. No quote, NEAR signing key, transaction
broadcast or automatic repayment. The seller must provide idempotent redemption.
The shared journal needs its separate encryption key. An ambiguous seller-side
external effect still requires manual reconciliation; never blindly retry it.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (['--goals', '--id', '--state', '--shared-journal', '--rpc'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--') && !out[name]) {
      out[name] = args[++i]; continue;
    }
    throw new Error('invalid delivery recovery arguments');
  }
  if (!out['--goals'] || !out['--id'] || Boolean(out['--state']) === Boolean(out['--shared-journal'])) {
    throw new Error('original goals and ID plus exactly one original state or shared journal are required');
  }
  return out;
}
function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(home(opts['--goals'])), 'utf8'));
  const config = parsed?.resources ?? parsed;
  const matches = Array.isArray(config?.goals) ? config.goals.filter(item => item?.id === opts['--id']) : [];
  if (matches.length !== 1 || matches[0].order_binding !== 'seller-v3') throw new Error('original goals must contain exactly one seller-v3 request ID');
  const client = routedResourceProvider({ providerUrl: config.provider_url, goals: matches });
  const provider = new PaymentRpcProvider(opts['--rpc'] || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  let journal, pool;
  try {
    if (opts['--shared-journal']) {
      const { openConfiguredBuyerJournal } = await import('./shared-buyer-config.mjs');
      ({ journal, pool } = await openConfiguredBuyerJournal({ contractId: config.contract_id, ownerAccountId: config.owner_account_id,
        journalId: opts['--shared-journal'] }));
    } else {
      const state = path.resolve(home(opts['--state']));
      if (!fs.existsSync(state)) throw new Error('original journal not found; recovery cannot create one');
      journal = new FileJournal(state, config.contract_id, config.owner_account_id);
    }
    const delivery = await recoverResourceDelivery({ goal: matches[0], contractId: config.contract_id, ownerAccountId: config.owner_account_id,
      providerUrl: config.provider_url, provider, journal, fulfill: client.fulfill, readStorage: client.readStorage });
    console.log(JSON.stringify({ id: delivery.id, receipt: delivery.receipt }, null, 2));
  } finally { if (journal) await journal.close(); if (pool) await pool.end(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[direct-delivery-recovery] ERROR: ${error.message}`); process.exitCode = 1; });
}
