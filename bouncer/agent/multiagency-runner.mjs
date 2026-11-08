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
import { FileJournal, requestFingerprint, runProcurement } from './procurement.mjs';
import { recoverDirectPayment } from './recover-direct-payment.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { preflightExactFt } from './exact-ft-runtime.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { prepareMultiAgencyExactFt, assertMultiAgencyExactFtView, multiAgencyExactExecutionBlock,
  verifyMultiAgencyExactFtPayment } from './multiagency-exact-ft.mjs';
import { MULTIAGENCY_ORIGIN } from './multiagency-readiness.mjs';
import { multiAgencyExecutionBlock, multiAgencyPaymentPlan, validateMultiAgencyGoal, validateMultiAgencyQuote,
  verifyMultiAgencyJobClaim, verifyMultiAgencyPayment, verifyMultiAgencyPublishedHandoff,
  verifyMultiAgencyResearchDelivery } from './multiagency-research.mjs';

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
  const { expectedStatus, maxBytes = 32 * 1024, ...request } = options;
  const response = await fetchImpl(url, { ...request, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  try {
    if (response.status !== expectedStatus) throw new Error('unexpected provider HTTP status');
    return await readBoundedJson(response, { maxBytes, label: 'research evidence' });
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
async function vaultAtTransaction(provider, goal, chain, executionId = multiAgencyExecutionBlock(chain, goal.vault)) {
  const blockId = chain?.transaction_outcome?.block_hash;
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
  return withExclusiveJournalOperation(journal, async scope => {
    const quote = issuedQuote(journal, goal, now), plan = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now) });
    assertUnusedMemo(journal, goal, quote);
    // Identity and registration are separate from the policy verdict. A code
    // hash pins the owner's reviewed deployment; it is not a source audit.
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
    const block = await provider.viewBlock({ finality: 'final' });
    assertFreshFinalBlock(block, timestamp(now));
    const snapshot = { header: { hash: block.header.hash, timestamp_nanosec: block.header.timestamp_nanosec } };
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
    assertFreshFinalBlock(snapshot, timestamp(now));
    const totals = await runProcurement({ plan, provider, account, publicKey, journal, exclusiveJournalScope: scope, durablePayment: true, execute: true, log,
      beforePayment: async () => {
        assertUnusedMemo(journal, goal, quote); await stillAwaiting(goal, quote, fetchImpl, now);
        assertFreshFinalBlock(snapshot, timestamp(now));
      },
      beforeBroadcast: () => {
        if (Date.parse(quote.expires_at) < timestamp(now) + 60_000) throw new Error('quote is too close to expiry');
        assertFreshFinalBlock(snapshot, timestamp(now));
      },
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
  return withExclusiveJournalOperation(journal, async scope => {
    const quote = issuedQuote(journal, goal, now, true), plan = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now), allowExpired: true });
    const entry = journal.get(goal.id);
    if (!entry || journal.list().filter(e => e.request?.memo === quote.code && e.request?.payee === quote.payment.receiver &&
        e.request?.token === quote.payment.token).length !== 1) throw new Error('original payment/memo reservation is missing or ambiguous');
    const recovered = await recoverDirectPayment({ plan, requestId: goal.id, provider, journal, update: false, log, exclusiveJournalScope: scope });
    const chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const vaultState = await vaultAtTransaction(provider, goal, chain);
    const settlement = verifyMultiAgencyPayment({ goal, quote, result: chain, publicKey: entry.agent_public_key, txHash: entry.tx_hash, vaultState });
    if (entry.status === 'pending') journal.put(goal.id, { ...entry, status: 'completed', settlement: recovered.settlement,
      completed_at: new Date(timestamp(now)).toISOString() });
    return { status: 'RECOVERED_PAYMENT_ONLY', settlement, quote_posts: 0, sends: 0,
      scope: 'original FINAL payment only; seller attribution and delivery not established' };
  });
}

/** Prepare owner-review calldata for the *original* issued quote. This only
 * reads the encrypted journal; it neither signs nor changes state. */
export async function prepareMultiAgencyExactIntent({ goal: rawGoal, journal, agentPublicKey, now = Date.now }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now);
    assertUnusedMemo(journal, goal, quote);
    return prepareMultiAgencyExactFt({ goal, quote, agentPublicKey, nowMs: timestamp(now) });
  });
}

async function exactEvidence(provider, goal, quote, entry, chain) {
  const executionId = multiAgencyExactExecutionBlock(chain, goal.vault);
  const [vaultState, view] = await Promise.all([
    vaultAtTransaction(provider, goal, chain, executionId),
    readPinnedJsonView(provider, executionId, goal.vault, 'get_exact_ft_intent', { intent_id: entry.exact_ft.prepared.intent_id }),
  ]);
  const expected = { ...entry.exact_ft.pinned_view, consumed: true, active: false };
  if (!isDeepStrictEqual(view, expected)) throw new Error('historical consumed intent differs from the original pinned review');
  return verifyMultiAgencyExactFtPayment({ goal, quote, result: chain, publicKey: entry.agent_public_key, txHash: entry.tx_hash,
    vaultState, intentState: { block_hash: executionId, view } });
}

function originalExactEntry(journal, goal, quote, now) {
  const entry = journal.get(goal.id);
  if (!entry || entry.payment_version !== 'exact-ft-signed-v11' || !['pending', 'completed'].includes(entry.status) ||
      !isTransactionHash(entry.tx_hash) || typeof entry.agent_public_key !== 'string' || entry.exact_ft?.version !== 1 ||
      !entry.exact_ft?.pinned_view || journal.list().filter(e => e.request?.memo === quote.code &&
        e.request?.payee === quote.payment.receiver && e.request?.token === quote.payment.token).length !== 1) {
    throw new Error('original exact FT payment reservation is missing or ambiguous; never resend automatically');
  }
  const prepared = prepareMultiAgencyExactFt({ goal, quote, agentPublicKey: entry.agent_public_key, nowMs: timestamp(now), allowExpired: true });
  const request = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now), allowExpired: true }).requests[0];
  if (!isDeepStrictEqual(entry.exact_ft.prepared, prepared) || entry.fingerprint !== requestFingerprint(request) ||
      !isDeepStrictEqual(entry.request, request)) throw new Error('original exact FT review differs from the journal');
  assertMultiAgencyExactFtView(prepared, entry.exact_ft.pinned_view);
  return entry;
}

/** Spend only an already owner-pinned V11 intent. The quote remains unsigned
 * and front-runnable; this tightens Bouncer's authority, not the seller. */
export async function payMultiAgencyExactFtOnce({ goal: rawGoal, journal, provider, account, publicKey,
  fetchImpl = globalThis.fetch, now = Date.now, execute = false }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true) throw new Error('explicit exact FT payment execution is required; no payment was sent');
  if (typeof provider?.sendTransactionOnce !== 'function' || typeof provider?.txStatusReceipts !== 'function') {
    throw new Error('exact FT payment requires one-shot transport and receipt-inclusive RPC');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now), agentKey = String(publicKey);
    const prepared = prepareMultiAgencyExactFt({ goal, quote, agentPublicKey: agentKey, nowMs: timestamp(now) });
    assertUnusedMemo(journal, goal, quote);
    const preflight = await preflightExactFt({ prepared, publicKey, provider, now });
    const snapshot = preflight.finalBlock, pinned = preflight.pinnedView, a = prepared.owner_call.args;
    if (!preflight.allowed) return { status: 'BLOCKED', reason: preflight.reason, sends: 0 };
    await stillAwaiting(goal, quote, fetchImpl, now);
    assertFreshFinalBlock(snapshot, timestamp(now));
    const signed = await signReviewedCall({ account, publicKey, ownerId: goal.owner, contractId: goal.vault,
      method: 'execute_exact_ft', args: { intent_id: prepared.intent_id }, gas: 200n * 10n ** 12n });
    if (!isTransactionHash(signed.txHash)) throw new Error('invalid signed exact FT transaction hash');
    await stillAwaiting(goal, quote, fetchImpl, now);
    if (timestamp(now) >= Number(a.expires_at_ms) - 60_000) throw new Error('exact FT execution cutoff is too close; no payment sent');
    assertUnusedMemo(journal, goal, quote);
    assertFreshFinalBlock(snapshot, timestamp(now));
    const request = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now) }).requests[0];
    const pending = { status: 'pending', fingerprint: requestFingerprint(request), request, payment_version: 'exact-ft-signed-v11',
      tx_hash: signed.txHash, agent_public_key: agentKey, exact_ft: { version: 1, prepared, pinned_view: pinned },
      started_at: new Date(timestamp(now)).toISOString() };
    journal.put(goal.id, pending); // durable original hash before the ONLY broadcast
    try {
      if (timestamp(now) >= Number(a.expires_at_ms) - 60_000) throw new Error('exact FT cutoff passed after reservation');
      assertFreshFinalBlock(snapshot, timestamp(now));
      const sent = await provider.sendTransactionOnce(signed.signed, 'FINAL');
      if (sent?.transaction_outcome?.id !== signed.txHash) throw new Error('RPC returned a different or missing transaction hash');
      const chain = await provider.txStatusReceipts(signed.txHash, goal.owner, 'FINAL');
      const settlement = await exactEvidence(provider, goal, quote, pending, chain);
      journal.put(goal.id, { ...pending, status: 'completed', settlement, completed_at: new Date(timestamp(now)).toISOString() });
      return { status: 'PAID_NOT_YET_DELIVERED', settlement, sends: 1,
        scope: 'FINAL exact-FT testnet payment only; seller attribution and delivery still require verification' };
    } catch {
      throw new Error(`${goal.id}: exact FT payment is unresolved (tx ${signed.txHash}); preserve the journal and never automatically resend`);
    }
  });
}

/** Read the original exact-FT hash only. Missing, failed or ambiguous receipts
 * never cause a new signature, quote POST or payment. */
export async function recoverMultiAgencyExactFtPayment({ goal: rawGoal, journal, provider, now = Date.now, update = true }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now, true), entry = originalExactEntry(journal, goal, quote, now);
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
    const chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const settlement = await exactEvidence(provider, goal, quote, entry, chain);
    if (entry.status === 'completed' && !isDeepStrictEqual(entry.settlement, settlement)) throw new Error('recorded exact FT settlement differs from chain');
    if (update && entry.status === 'pending') journal.put(goal.id, { ...entry, status: 'completed', settlement,
      completed_at: new Date(timestamp(now)).toISOString() });
    return { status: 'RECOVERED_PAYMENT_ONLY', settlement, quote_posts: 0, sends: 0,
      scope: 'original FINAL exact-FT payment only; seller attribution and delivery not established' };
  });
}

/** Read-only inspection of ONE published task under the original paid job.
 * All URLs are pinned; no quote POST, key, signing, send or journal write.
 * The output is untrusted provider text, not proof the full brief is satisfied. */
export async function inspectMultiAgencyResearchTask({ goal: rawGoal, journal, provider, task, githubToken,
  fetchImpl = globalThis.fetch, now = Date.now }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  if (!Number.isSafeInteger(task) || task < 1 ||
      (githubToken !== undefined && (typeof githubToken !== 'string' || !githubToken || githubToken.length > 4096 || /[\r\n]/.test(githubToken)))) {
    throw new Error('valid public task number and optional GitHub read token required');
  }
  return withExclusiveJournalOperation(journal, async scope => {
    const quote = issuedQuote(journal, goal, now, true), plan = multiAgencyPaymentPlan(goal, quote, { nowMs: timestamp(now), allowExpired: true });
    const entry = journal.get(goal.id);
    if (!entry || journal.list().filter(e => e.request?.memo === quote.code && e.request?.payee === quote.payment.receiver &&
        e.request?.token === quote.payment.token).length !== 1) throw new Error('original payment/memo reservation is missing or ambiguous');
    await recoverDirectPayment({ plan, requestId: goal.id, provider, journal, update: false, log: () => {}, exclusiveJournalScope: scope });
    const chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const vaultState = await vaultAtTransaction(provider, goal, chain);
    const sellerQuote = await requestJson(`${MULTIAGENCY_ORIGIN}/api/quotes/${quote.code}`,
      { method: 'GET', expectedStatus: 200 }, fetchImpl);
    if (!Number.isSafeInteger(sellerQuote?.issue) || sellerQuote.issue < 1) throw new Error('seller has not published a valid job number');
    const api = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'bouncer-research-recovery' };
    if (githubToken !== undefined) headers.authorization = `Bearer ${githubToken}`;
    const read = suffix => requestJson(`${api}${suffix}`, { method: 'GET', expectedStatus: 200, maxBytes: 1_000_000, headers }, fetchImpl);
    const [epic, taskIssue, comments] = await Promise.all([
      read(`/${sellerQuote.issue}`), read(`/${task}`), read(`/${task}/comments?per_page=100`),
    ]);
    const proof = verifyMultiAgencyResearchDelivery({ goal, quote, result: chain, publicKey: entry.agent_public_key,
      txHash: entry.tx_hash, vaultState, sellerQuote, epic, task: taskIssue, comments });
    return { ...proof, quote_posts: 0, sends: 0, journal_writes: 0 };
  });
}

/** Inspect one public task only after independently rechecking the original
 * V11 payment, the seller's job claim and the bot/assignee handoff. Read-only;
 * the text is untrusted and one task may not satisfy the full brief. */
export async function inspectMultiAgencyExactResearchTask({ goal: rawGoal, journal, provider, task, githubToken,
  fetchImpl = globalThis.fetch, now = Date.now }) {
  const goal = validateMultiAgencyGoal(rawGoal); requireJournal(journal, goal);
  if (!Number.isSafeInteger(task) || task < 1 ||
      (githubToken !== undefined && (typeof githubToken !== 'string' || !githubToken || githubToken.length > 4096 || /[\r\n]/.test(githubToken)))) {
    throw new Error('valid public task number and optional GitHub read token required');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const quote = issuedQuote(journal, goal, now, true), entry = originalExactEntry(journal, goal, quote, now);
    if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
    const chain = await provider.txStatusReceipts(entry.tx_hash, goal.owner, 'FINAL');
    const payment = await exactEvidence(provider, goal, quote, entry, chain);
    if (entry.status === 'completed' && !isDeepStrictEqual(entry.settlement, payment)) throw new Error('recorded exact FT settlement differs from chain');
    const sellerQuote = await requestJson(`${MULTIAGENCY_ORIGIN}/api/quotes/${quote.code}`,
      { method: 'GET', expectedStatus: 200 }, fetchImpl);
    if (!Number.isSafeInteger(sellerQuote?.issue) || sellerQuote.issue < 1) throw new Error('seller has not published a valid job number');
    const api = 'https://api.github.com/repos/MultiAgency/kanban-sandbox/issues';
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'bouncer-exact-research-recovery' };
    if (githubToken !== undefined) headers.authorization = `Bearer ${githubToken}`;
    const read = suffix => requestJson(`${api}${suffix}`, { method: 'GET', expectedStatus: 200, maxBytes: 1_000_000, headers }, fetchImpl);
    const [epic, taskIssue, comments] = await Promise.all([
      read(`/${sellerQuote.issue}`), read(`/${task}`), read(`/${task}/comments?per_page=100`),
    ]);
    const claim = verifyMultiAgencyJobClaim({ goal, quote, txHash: payment.tx_hash, sellerQuote, epic });
    const handoff = verifyMultiAgencyPublishedHandoff({ epic, task: taskIssue, comments });
    if (handoff.job !== claim.job) throw new Error('handoff belongs to a different job');
    return { status: 'PUBLISHED_TASK_AFTER_FINAL_PAYMENT', tx_hash: payment.tx_hash, job_url: claim.job_url,
      task: handoff.task, deliverable_url: handoff.url, sha256: handoff.sha256, text: handoff.text,
      quote_posts: 0, sends: 0, journal_writes: 0,
      scope: 'one task under a paid job, not necessarily fulfillment of the complete brief; source quality, deployed watcher and future availability not established' };
  });
}
