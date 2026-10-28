#!/usr/bin/env node
/**
 * Recover a --durable direct FT payment by its previously persisted hash.
 * Requires the exact reviewed plan and ORIGINAL journal; this tool never
 * signs, broadcasts, retries a payment or verifies resource delivery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { FileJournal, requestFingerprint, validatePlan } from './procurement.mjs';
import { isTransactionHash, verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

export async function recoverDirectPayment({ plan: rawPlan, requestId, provider, journal, update = true, log = console.log }) {
  const plan = validatePlan(rawPlan);
  const request = plan.requests.find(item => item.id === requestId);
  if (!request) throw new Error('request ID is not in the reviewed plan');
  if (!journal || typeof journal.get !== 'function' || typeof journal.put !== 'function') throw new Error('recovery requires the original journal');
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
  if (update && previous.status === 'pending') journal.put(requestId, { ...previous, status: 'completed', settlement, completed_at: new Date().toISOString() });
  log(`[direct-recovery] REUSED ${requestId}: ${settlement.tx_hash}; no new payment; delivery is not established`);
  return { status: 'REUSED', settlement };
}
function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function parse(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') out.help = true;
    else if (['--plan', '--id', '--state', '--rpc'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
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
    console.log('Usage: node bouncer/agent/recover-direct-payment.mjs --plan REVIEWED-PLAN.json --id REQUEST_ID --state ORIGINAL-JOURNAL.json [--rpc URL]');
    console.log('Reads one recorded --durable payment; no key, signing, broadcast, delivery or automatic repayment.');
    return;
  }
  if (!options.plan || !options.id || !options.state) throw new Error('provide --plan, --id and the original --state');
  const plan = validatePlan(JSON.parse(fs.readFileSync(path.resolve(home(options.plan)), 'utf8')));
  const state = path.resolve(home(options.state));
  if (!fs.existsSync(state)) throw new Error('original journal not found; recovery cannot create one');
  const provider = new nearApi.providers.JsonRpcProvider({ url: validateRpcEndpoint(options.rpc || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com') });
  const journal = new FileJournal(state, plan.contract_id, plan.owner_account_id);
  try { console.log(JSON.stringify((await recoverDirectPayment({ plan, requestId: options.id, provider, journal })).settlement, null, 2)); }
  finally { journal.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`[direct-recovery] ERROR: ${error.message}`); process.exitCode = 1; });
}
