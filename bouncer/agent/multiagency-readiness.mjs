/** Read-only compatibility checks for an independent NEAR testnet research
 * provider. These do not establish merchant consent, worker availability,
 * deployed-source equivalence, a quote, payment, refund or delivery. */
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { verifyDirectPayment } from '../shared/direct-payment-settlement.mjs';

export const MULTIAGENCY_TREASURY = 'multiagency.sputnikv2.testnet';
export const MULTIAGENCY_BOARD = 'https://github.com/MultiAgency/kanban-sandbox';
export const MULTIAGENCY_ORIGIN = 'https://demo.multiagency.ai';
export const PRIOR_BUYER = 'bouncer-oracle-1ab0b52f.testnet';
export const PRIOR_OWNER = 'owner.bouncer-oracle-1ab0b52f.testnet';
export const PRIOR_PAYEE = 'vendor.bouncer-oracle-1ab0b52f.testnet';
export const PRIOR_HASH = 'zhqQHDfcF12wHQbQSMCWJR5z3fi7FZSsAWEfzXF4Yf9';
export const PRIOR_BLOCK = 275695231;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

/** Check a previously settled Bouncer payment through BOTH the provider's
 * indexed event source and trusted FINAL receipt-inclusive RPC. The memo is
 * inspected but deliberately never returned. This tests only the indexer's
 * visibility for this historical payment to our own vendor, not this seller's
 * deployed watcher, willingness to accept Bouncer or any new transaction. */
export function verifyMultiAgencyIndexerControl({ indexed, final }) {
  const tx = indexed?.transaction;
  if (!record(indexed) || !record(tx) || tx.hash !== PRIOR_HASH || tx.signer_id !== PRIOR_OWNER ||
      tx.receiver_id !== PRIOR_BUYER || !Array.isArray(tx.actions) || tx.actions.length !== 1 ||
      tx.actions[0]?.FunctionCall?.method_name !== 'execute' || !Array.isArray(indexed.receipts)) {
    throw new Error('indexer did not return the exact original nested Bouncer transaction');
  }
  let args;
  try { args = JSON.parse(Buffer.from(tx.actions[0].FunctionCall.args, 'base64').toString('utf8')); }
  catch { throw new Error('invalid indexed execute arguments'); }
  if (!record(args) || args.payee !== PRIOR_PAYEE || args.amount !== '1000' ||
      args.expected_token !== CIRCLE_TESTNET_USDC || typeof args.policy_id !== 'string' ||
      typeof args.memo !== 'string' || !args.memo.startsWith('bouncer-order-v3:')) throw new Error('indexed payment differs from the control');
  const matches = [];
  for (const item of indexed.receipts) {
    if (item?.receipt?.predecessor_id !== PRIOR_BUYER || item.receipt.receiver_id !== CIRCLE_TESTNET_USDC ||
        !record(item.execution_outcome?.outcome?.status) || typeof item.execution_outcome.outcome.status.SuccessValue !== 'string') continue;
    for (const line of item.execution_outcome.outcome.logs ?? []) {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:') || Buffer.byteLength(line) > 16_384) continue;
      let event;
      try { event = JSON.parse(line.slice(11)); } catch { continue; }
      if (event?.standard !== 'nep141' || event.version !== '1.0.0' || event.event !== 'ft_transfer' || !Array.isArray(event.data)) continue;
      for (const v of event.data) if (v?.old_owner_id === PRIOR_BUYER && v.new_owner_id === PRIOR_PAYEE &&
        v.amount === '1000' && v.memo === args.memo) matches.push({ receipt_id: item.receipt.receipt_id, log: line });
    }
  }
  if (matches.length !== 1) throw new Error('indexer did not expose the unique nested Circle transfer event and memo');
  const request = { id: 'historical-indexer-control', resource: 'compute', policy_id: args.policy_id,
    token: CIRCLE_TESTNET_USDC, payee: PRIOR_PAYEE, amount: '1000', memo: args.memo };
  verifyDirectPayment({ result: final, contractId: PRIOR_BUYER, ownerAccountId: PRIOR_OWNER,
    request, publicKey: tx.public_key, txHash: PRIOR_HASH });
  const matchingReceipt = final.receipts.filter(item => item.receipt_id === matches[0].receipt_id && item.predecessor_id === PRIOR_BUYER &&
    item.receiver_id === CIRCLE_TESTNET_USDC && Array.isArray(item.receipt?.Action?.actions) &&
    item.receipt.Action.actions.length === 1 && item.receipt.Action.actions[0]?.FunctionCall?.method_name === 'ft_transfer');
  const matchingFinal = final.receipts_outcome.filter(item => item.id === matches[0].receipt_id &&
    item.outcome?.executor_id === CIRCLE_TESTNET_USDC && item.outcome?.logs?.filter(line => line === matches[0].log).length === 1);
  if (matchingReceipt.length !== 1 || matchingFinal.length !== 1) throw new Error('indexed event was not in the same FINAL token receipt');
  return { tx_hash: PRIOR_HASH, nested_circle_event_indexed: true, independently_final_verified: true,
    scope: 'historical self-hosted vendor control only; not a MultiAgency payment or delivery' };
}

/** Assess public configuration/health without treating a running coordinator or
 * past completed jobs as proof that human/agent workers are available now. */
export function summarizeMultiAgencyReadiness({ config, health, engagements, tasks, nowMs = Date.now(), indexerControl = null }) {
  if (!record(config) || config.network !== 'testnet' || config.treasury !== MULTIAGENCY_TREASURY ||
      config.usdc !== CIRCLE_TESTNET_USDC || config.deposit !== '3000000' || config.board !== MULTIAGENCY_BOARD ||
      !record(health) || !Array.isArray(engagements) || engagements.length > 100 ||
      !record(tasks) || !Array.isArray(tasks.tasks) || tasks.tasks.length > 100 || !Number.isSafeInteger(nowMs) ||
      nowMs < 1 || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new Error('independent provider config or bounded public readiness data differs from reviewed testnet profile');
  }
  const completed = Date.parse(health.coordinator?.last_completed_at);
  const coordinatorRecent = health.ok === true && health.coordinator?.running === true && Number.isFinite(completed) &&
    completed <= nowMs + 30_000 && nowMs - completed <= 120_000;
  const paid = engagements.filter(e => record(e) && typeof e.deposit === 'string' && /^[1-9][0-9]*$/.test(e.deposit) &&
    typeof e.created_at === 'string' && Number.isFinite(Date.parse(e.created_at)) && Date.parse(e.created_at) <= nowMs);
  paid.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const ready = tasks.tasks.filter(t => record(t) && t.state === 'ready').length;
  return { status: 'BLOCKED_OR_UNPROVEN', network: config.network, token: config.usdc,
    treasury: config.treasury, observed_default_deposit_micro_usdc: config.deposit,
    observed_at: new Date(nowMs).toISOString(),
    coordinator_last_completed_at: Number.isFinite(completed) ? new Date(completed).toISOString() : null,
    coordinator_recent: coordinatorRecent, listed_ready_tasks: ready,
    last_listed_paid_job_created_at: paid[0]?.created_at ?? null,
    independent_worker_capacity: 'UNPROVEN', historical_nested_indexer_control: indexerControl,
    requires_external_human_approval: true, offer_signed: false,
    risks: ['worker availability and new-job fulfillment are not established',
      'provider quotes are unsigned and the public memo can be front-run or misattributed',
      'no general refund for an accepted or stalled deposit was established',
      'published source does not attest the currently deployed watcher'],
    sends: 0, quote_posts: 0,
    scope: 'public read-only observations; no quote, purchase, delivery, merchant consent or reservation established' };
}
