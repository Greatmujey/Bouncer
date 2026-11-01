#!/usr/bin/env node
/**
 * Recover a --durable direct FT payment by its previously persisted hash.
 * Requires the exact reviewed plan or resource goals and ORIGINAL journal.
 * The CLI never signs, broadcasts, retries a payment or verifies delivery;
 * the exported workflow helper additionally replays an already-paid delivery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from './near-account.mjs';
import { FileJournal, normalizeProviderRoute, requestFingerprint, validatePlan } from './procurement.mjs';
import { assertJournalScope, writeJournal } from './journal-write.mjs';
import { planFromQuotes, fulfillPaidResource } from './resource-agent.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';

export async function recoverDirectPayment({ plan: rawPlan, requestId, provider, journal, update = true, log = console.log }) {
  const plan = validatePlan(rawPlan);
  const request = plan.requests.find(item => item.id === requestId);
  if (!request) throw new Error('request ID is not in the reviewed plan');
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('recovery requires the original journal');
  assertJournalScope(journal, plan.contract_id, plan.owner_account_id);
  const previous = journal.get(requestId);
  if (!previous || previous.fingerprint !== requestFingerprint(request) || !isDeepStrictEqual(previous.request, request)) {
    throw new Error(`${requestId}: journal does not match the reviewed payment`);
  }
  if (previous.payment_version !== 'direct-signed-v1' || !isTransactionHash(previous.tx_hash) ||
      typeof previous.agent_public_key !== 'string' || !previous.agent_public_key || !['pending', 'completed'].includes(previous.status)) {
    throw new Error(`${requestId}: no recoverable signed payment hash/key; reconcile legacy or incomplete entries manually, never resend automatically`);
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  if (typeof provider.txStatusReceipts !== 'function') throw new Error('receipt-inclusive RPC required');
  const chain = await provider.txStatusReceipts(previous.tx_hash, plan.owner_account_id, 'FINAL');
  const settlement = verifyDirectPayment({ result: chain, contractId: plan.contract_id, ownerAccountId: plan.owner_account_id,
    request, publicKey: previous.agent_public_key, txHash: previous.tx_hash });
  if (previous.status === 'completed' && !isDeepStrictEqual(previous.settlement, settlement)) throw new Error(`${requestId}: recorded settlement differs from chain`);
  if (update && previous.status === 'pending') await writeJournal(journal, requestId, { ...previous, status: 'completed', settlement, completed_at: new Date().toISOString() });
  log(`[direct-recovery] REUSED ${requestId}: ${settlement.tx_hash}; no new payment; delivery is not established`);
  return { status: 'REUSED', settlement };
}
/** Recover against the original resource goals without contacting a quote source. */
export async function recoverDirectResourcePayment({ config, requestId, provider, journal, update = true, log = console.log }) {
  if (!config || typeof config !== 'object' || !Array.isArray(config.goals)) throw new Error('invalid original resource goals');
  const matching = config.goals.filter(goal => goal?.id === requestId);
  if (matching.length !== 1) throw new Error('request ID must appear exactly once in the original goals');
  const goal = matching[0], previous = journal?.get(requestId);
  if (!previous || !previous.request || previous.provider_route === undefined || !['pending', 'completed'].includes(previous.status)) {
    throw new Error(`${requestId}: original journal lacks the recorded resource request and route`);
  }
  const reviewedRoute = normalizeProviderRoute({ provider_id: goal.provider_id ?? null,
    provider_origin: goal.provider_url ?? config.provider_url ?? null });
  if (!isDeepStrictEqual(normalizeProviderRoute(previous.provider_route), reviewedRoute)) throw new Error(`${requestId}: recorded provider route does not match the reviewed goal`);
  // Reuse the ordinary goal/request checks, but expose this ONE recorded entry
  // as completed to that read-only validator. No quote is fetched, no actual
  // journal state is changed, and the settlement verifier still checks pending.
  const facade = { get: id => id === requestId ? { ...previous, status: 'completed' } : undefined };
  const plan = await planFromQuotes({ contractId: config.contract_id, ownerAccountId: config.owner_account_id, goals: [goal], providerUrl: config.provider_url,
    getQuote: async () => { throw new Error('recovery must not request a quote'); }, journal: facade });
  return recoverDirectPayment({ plan, requestId, provider, journal, update, log });
}
/**
 * Reconcile an existing durable payment, then replay/verify its exact delivery
 * without a signer, a quote or another payment. This may update the same
 * journal with confirmed settlement and a verified/unverified delivery; the
 * approved provider must implement idempotent redemption for that transaction.
 */
export async function recoverResourceDelivery({ goal, contractId, ownerAccountId, providerUrl, provider, journal,
  fulfill, readStorage, repositoryLookup, log = console.log }) {
  const config = { contract_id: contractId, owner_account_id: ownerAccountId, provider_url: providerUrl, goals: [goal] };
  await recoverDirectResourcePayment({ config, requestId: goal?.id, provider, journal, update: true, log });
  const entry = journal.get(goal.id);
  const delivery = await fulfillPaidResource({ goal, request: entry.request, contractId, ownerAccountId, providerUrl, journal,
    fulfill, readStorage, repositoryLookup, required: true, expectedTx: entry.tx_hash, log });
  if (!delivery) throw new Error(`${goal.id}: recovered payment has no verified delivery`);
  return delivery;
}

function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parse(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') out.help = true;
    else if (['--plan', '--goals', '--id', '--state', '--shared-journal', '--rpc'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const key = args[i].slice(2);
      if (out[key]) throw new Error(`duplicate --${key}`);
      out[key] = args[++i];
    } else throw new Error(`unknown or incomplete argument: ${args[i]}`);
  }
  return out;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node bouncer/agent/recover-direct-payment.mjs (--plan REVIEWED-PLAN.json | --goals ORIGINAL-GOALS-OR-MISSION.json) --id REQUEST_ID (--state ORIGINAL-JOURNAL.json | --shared-journal STABLE_ID) [--rpc URL]');
    console.log('Reads one recorded --durable payment; no NEAR signing key, broadcast, delivery or automatic repayment. The shared journal requires its separate encryption key.');
    return;
  }
  if (Boolean(options.plan) === Boolean(options.goals) || Boolean(options.state) === Boolean(options['shared-journal']) || !options.id) {
    throw new Error('provide exactly one of --plan or --goals, --id, and exactly one original --state or --shared-journal');
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(home(options.plan || options.goals)), 'utf8'));
  const plan = options.plan ? validatePlan(input) : null;
  const config = options.goals ? (input?.resources ?? input) : null;
  const contractId = plan?.contract_id ?? config?.contract_id, ownerId = plan?.owner_account_id ?? config?.owner_account_id;
  if (typeof contractId !== 'string' || typeof ownerId !== 'string') throw new Error('invalid owner or contract in reviewed input');
  const provider = new PaymentRpcProvider(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  let journal, pool;
  try {
    if (options['shared-journal']) {
      const { openConfiguredBuyerJournal } = await import('./shared-buyer-config.mjs');
      ({ journal, pool } = await openConfiguredBuyerJournal({ contractId, ownerAccountId: ownerId, journalId: options['shared-journal'] }));
    } else {
      const state = path.resolve(home(options.state));
      if (!fs.existsSync(state)) throw new Error('original journal not found; recovery cannot create one');
      journal = new FileJournal(state, contractId, ownerId);
    }
    const result = plan ? await recoverDirectPayment({ plan, requestId: options.id, provider, journal })
      : await recoverDirectResourcePayment({ config, requestId: options.id, provider, journal });
    console.log(JSON.stringify(result.settlement, null, 2));
  } finally { if (journal) await journal.close(); if (pool) await pool.end(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[direct-recovery] ERROR: ${error.message}`); process.exitCode = 1; });
}
