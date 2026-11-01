/** Experimental MultiAgency research buyer (NEAR testnet only).
 * One quote POST after an encrypted write-ahead reservation; one guarded
 * payment after a fresh quote check and signed-hash journal reservation.
 * Ambiguous responses never cause an automatic quote retry or re-payment.
 * This is not standard x402. Provider staffing, unsigned memo attribution,
 * refundability, deployed-source equivalence and report quality are unproven.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { FileJournal, runProcurement } from './procurement.mjs';
import { recoverDirectPayment } from './recover-direct-payment.mjs';
import { MULTIAGENCY_ORIGIN } from './multiagency-readiness.mjs';
import { multiAgencyExecutionBlock, multiAgencyPaymentPlan, validateMultiAgencyGoal, validateMultiAgencyQuote, verifyMultiAgencyPayment } from './multiagency-research.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quoteId = goal => `${goal.id}-ma-quote`;
function requireJournal(journal, goal) {
  if (!(journal instanceof FileJournal) || journal.encryptionEnabled !== true || journal.data?.contract_id !== goal.vault ||
      journal.data?.owner_account_id !== goal.owner) throw new Error('original owner/vault-scoped encrypted file journal is required');
  journal.assertAvailable();
}
function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid local time');
  return value;
}
function getSession(journal, goal) {
  const entry = journal.get(quoteId(goal));
  if (!entry || entry.status !== 'pending' || entry.fingerprint !== hash(goal) || entry.multiagency?.version !== 1 ||
      !isDeepStrictEqual(entry.multiagency.goal, goal)) throw new Error('original research-quote journal does not match the owner goal');
  return entry;
}
function issuedQuote(journal, goal, now, allowExpired = false) {
  const entry = getSession(journal, goal);
  if (entry.multiagency.phase !== 'issued') throw new Error('original quote response is unresolved; do not request or pay another quote automatically');
  const quote = validateMultiAgencyQuote(goal, entry.multiagency.quote, { nowMs: timestamp(now), allowExpired });
  if (journal.list().some(other => other.id !== entry.id && other.multiagency?.quote?.code === quote.code)) {
    throw new Error('quote code appears in another original session; stop and reconcile');
  }
  return quote;
}
async function requestJson(url, options, fetchImpl) {
  const { expectedStatus, ...request } = options;
  const response = await fetchImpl(url, { ...request, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  try {
    if (response.status !== expectedStatus) throw new Error('unexpected provider HTTP status');
    return await readBoundedJson(response, { maxBytes: 32 * 1024, label: 'research provider' });
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** The brief is PUBLIC. The quote POST is not idempotent in the reviewed
 * source, so write the exact goal first and never repeat an uncertain POST. */
export async function requestMultiAgencyQuoteOnce({ goal: rawGoal, journal, fetchImpl = globalThis.fetch, now = Date.now, execute = false }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true) throw new Error('explicit quote execution is required; no request was sent');
  return withExclusiveJournalOperation(journal, async () => {
    const id = quoteId(goal), prior = journal.get(id);
    if (prior) return { status: 'REUSED_QUOTE', quote: issuedQuote(journal, goal, now), quote_posts: 0 };
    const started = timestamp(now);
    const entry = { status: 'pending', fingerprint: hash(goal), multiagency: { version: 1, phase: 'requested', goal,
      requested_at: new Date(started).toISOString() } };
    journal.put(id, entry); // fsync BEFORE the one provider POST
    let response;
    try {
      response = await requestJson(`${MULTIAGENCY_ORIGIN}/api/quotes`, { method: 'POST', expectedStatus: 201,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: goal.title, brief: goal.brief, amount: goal.amount }) }, fetchImpl);
      response = validateMultiAgencyQuote(goal, response, { nowMs: timestamp(now) });
      if (journal.list().some(other => other.id !== id && other.multiagency?.quote?.code === response.code)) throw new Error('provider reused an existing quote code');
      journal.put(id, { ...entry, multiagency: { ...entry.multiagency, phase: 'issued', quote: response } });
    } catch {
      throw new Error('quote response is unresolved or untrusted; preserve the original journal and never automatically request another quote');
    }
    return { status: 'QUOTED', quote: response, quote_posts: 1,
      scope: 'unsigned seller quote only; no payment, job or delivery; the brief was submitted publicly' };
  });
}

async function stillAwaiting(goal, quote, fetchImpl, now) {
  const latest = await requestJson(`${MULTIAGENCY_ORIGIN}/api/quotes/${quote.code}`, { method: 'GET', expectedStatus: 200 }, fetchImpl);
  // Exact equality prevents a changed payee, amount, memo, title or expiry.
  validateMultiAgencyQuote(goal, latest, { nowMs: timestamp(now) });
  if (!isDeepStrictEqual(latest, quote)) throw new Error('provider quote changed before payment');
}
function assertUnusedMemo(journal, goal, quote) {
  if (journal.get(goal.id) || journal.list().some(entry => entry.request?.memo === quote.code &&
      entry.request?.payee === quote.payment.receiver && entry.request?.token === quote.payment.token)) {
    throw new Error('this payment or quote memo is already recorded; reconcile the original and never repay automatically');
  }
}
async function vaultAtTransaction(provider, goal, chain) {
  const blockId = chain?.transaction_outcome?.block_hash, executionId = multiAgencyExecutionBlock(chain, goal.vault);
  if (typeof blockId !== 'string' || !blockId) throw new Error('original transaction block is unavailable');
  async function at(id) {
    const [account, keys] = await Promise.all([
      provider.viewAccount(goal.vault, { blockId: id }), provider.viewAccessKeyList(goal.vault, { blockId: id }),
    ]);
    if (account?.block_hash !== id || keys?.block_hash !== id) throw new Error('historical vault queries disagree');
    return { block_hash: id, code_hash: account.code_hash, keys: keys.keys };
  }
  const [transaction, execution] = await Promise.all([at(blockId), at(executionId)]);
  return { ...transaction, execution };
}

/** One guarded transfer, with the quote fetched again immediately before the
 * durable payment reservation. The public memo still permits a race or seller
 * misattribution: the goal must explicitly accept that risk. */
export async function payMultiAgencyQuoteOnce({ goal: rawGoal, journal, provider, account, publicKey,
  fetchImpl = globalThis.fetch, now = Date.now, execute = false, log = console.log }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true) throw new Error('explicit payment execution is required; no payment was sent');
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now), plan = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now) });
    assertUnusedMemo(journal, goal, quote);
    // Identity and registration are separate from the policy verdict. A code
    // hash pins the owner's reviewed deployment; it is not a source audit.
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
    const block = await provider.viewBlock({ finality: 'final' });
    if (typeof block?.header?.hash !== 'string' || !block.header.hash) throw new Error('FINAL block is unavailable');
    const finality = { blockId: block.header.hash };
    const [vault, vaultKeys, owner, recipientStorage] = await Promise.all([
      provider.viewAccount(goal.vault, finality), provider.viewAccessKeyList(goal.vault, finality),
      provider.callFunction(goal.vault, 'get_owner', {}, finality),
      provider.callFunction(quote.payment.token, 'storage_balance_of', { account_id: quote.payment.receiver }, finality),
    ]);
    if (vault?.block_hash !== block.header.hash || vault?.code_hash !== goal.vault_code_hash || vaultKeys?.block_hash !== block.header.hash ||
        !Array.isArray(vaultKeys?.keys) || vaultKeys.keys.length !== 0 || owner !== goal.owner ||
        !recipientStorage || typeof recipientStorage.total !== 'string' || !/^[1-9][0-9]*$/.test(recipientStorage.total)) {
      throw new Error('reviewed keyless vault identity, owner or Circle recipient registration differs; no payment sent');
    }
    const totals = await runProcurement({ plan, provider, account, publicKey, journal, durablePayment: true, execute: true, log,
      beforePayment: async () => { assertUnusedMemo(journal, goal, quote); await stillAwaiting(goal, quote, fetchImpl, now); },
      beforeBroadcast: () => { if (Date.parse(quote.expires_at) < timestamp(now) + 60_000) throw new Error('quote is too close to expiry'); },
    });
    if (totals.paid !== 1) return { status: 'BLOCKED', totals, scope: 'no payment; provider delivery is not established' };
    const entry = journal.get(goal.id), chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const vaultState = await vaultAtTransaction(provider, goal, chain);
    const settlement = verifyMultiAgencyPayment({ goal, quote, result: chain, publicKey: entry.agent_public_key, txHash: entry.tx_hash, vaultState });
    return { status: 'PAID_NOT_YET_DELIVERED', settlement,
      scope: 'FINAL guarded testnet payment only; seller attribution and delivery still require verification' };
  });
}

/** Key-free recovery of the original payment hash, with no quote POST, signing
 * or broadcast. Unknown hashes and missing events remain unresolved. */
export async function recoverMultiAgencyPayment({ goal: rawGoal, journal, provider, now = Date.now, log = console.log }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now, true), plan = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now), allowExpired: true });
    const entry = journal.get(goal.id);
    if (!entry || journal.list().filter(e => e.request?.memo === quote.code && e.request?.payee === quote.payment.receiver &&
        e.request?.token === quote.payment.token).length !== 1) throw new Error('original payment/memo reservation is missing or ambiguous');
    const recovered = await recoverDirectPayment({ plan, requestId: goal.id, provider, journal, update: false, log });
    const chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const vaultState = await vaultAtTransaction(provider, goal, chain);
    const settlement = verifyMultiAgencyPayment({ goal, quote, result: chain, publicKey: entry.agent_public_key, txHash: entry.tx_hash, vaultState });
    if (entry.status === 'pending') journal.put(goal.id, { ...entry, status: 'completed', settlement: recovered.settlement,
      completed_at: new Date(timestamp(now)).toISOString() });
    return { status: 'RECOVERED_PAYMENT_ONLY', settlement, quote_posts: 0, sends: 0,
      scope: 'original FINAL payment only; seller attribution and delivery not established' };
  });
}
