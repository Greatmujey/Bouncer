/**
 * Experimental Svalin Pro testnet buyer. Reconstructs a V11 exact intent from
 * the ORIGINAL encrypted bearer session, verifies the restricted key and the
 * on-chain policy, journals the signed hash before ONE broadcast, and recovers
 * that hash without signing. Activation and the first paid risk request are
 * separate, explicitly approved, write-ahead-fenced seller operations.
 *
 * Payment and same-hash recovery have also been exercised on an isolated
 * nearcore chain with a mock token and fake seller; activation and delivery
 * remain simulated. Svalin's deployed code and seller attribution are not
 * attested; its amount matcher is not sender-bound. Never use real funds,
 * fall back to a full-access key, or repeat ambiguous actions.
 */
import { isDeepStrictEqual } from 'node:util';
import { FileJournal, requestFingerprint, validatePlan } from './procurement.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { signReviewedCall } from './reviewed-transaction.mjs';
import { preflightExactFt, readExactFtEvidence } from './exact-ft-runtime.mjs';
import { readSvalinPlainOwnerAtFinal } from './svalin-owner-snapshot.mjs';
import { SVALIN_TRIAL_MAX_GAS_ALLOWANCE } from './svalin-pro-preflight.mjs';
import { assertMultiAgencyExactFtView } from './multiagency-exact-ft.mjs';
import { validateSvalinProGoal, reconstructSvalinProExactFt } from './svalin-pro-session.mjs';
import { probeSvalinProOffer, SVALIN_ORIGIN } from './svalin-pro-readiness.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const sessionId = goal => `${goal.id}-svalin-pro`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isFinite(new Date(value).getTime())) throw new Error('invalid local time');
  return value;
}
function requireJournal(journal, goal) {
  if (!(journal instanceof FileJournal) || journal.encryptionEnabled !== true ||
      journal.data?.contract_id !== goal.vault || journal.data?.owner_account_id !== goal.owner) {
    throw new Error('original owner/vault-scoped encrypted file journal is required');
  }
  journal.assertAvailable();
}
function paymentRequest(goal, prepared) {
  const a = prepared.owner_call.args;
  return validatePlan({ contract_id: goal.vault, owner_account_id: goal.owner, requests: [{ id: goal.id, resource: 'api',
    policy_id: goal.policy_id, token: a.expected_token, payee: a.payee, amount: a.amount, memo: a.memo }] }).requests[0];
}
function assertNoPriorPayment(journal, goal, request) {
  if (journal.get(goal.id) || journal.list().some(entry => entry.request?.token === request.token &&
      entry.request?.payee === request.payee && entry.request?.amount === request.amount)) {
    throw new Error('this exact Svalin payment amount is already recorded; reconcile the original and never repay automatically');
  }
}
function originalPayment(journal, goal, now) {
  const entry = journal.get(goal.id);
  if (!entry || !['pending', 'completed'].includes(entry.status) || entry.payment_version !== 'svalin-exact-ft-signed-v11' ||
      !isTransactionHash(entry.tx_hash) || typeof entry.agent_public_key !== 'string' || entry.exact_ft?.version !== 1 ||
      !entry.exact_ft.pinned_view) throw new Error('original Svalin exact FT payment is missing or ambiguous; never resend automatically');
  const prepared = reconstructSvalinProExactFt({ goal, journal, agentPublicKey: entry.agent_public_key, now, allowExpired: true });
  const request = paymentRequest(goal, prepared);
  if (!isDeepStrictEqual(entry.exact_ft.prepared, prepared) || !isDeepStrictEqual(entry.request, request) ||
      entry.fingerprint !== requestFingerprint(request) || journal.list().filter(other => other.request?.token === request.token &&
        other.request?.payee === request.payee && other.request?.amount === request.amount).length !== 1) {
    throw new Error('original Svalin payment and reservation differ or are ambiguous; never resend automatically');
  }
  assertMultiAgencyExactFtView(prepared, entry.exact_ft.pinned_view);
  return { entry, prepared };
}
async function checkedSettlement({ journal, goal, provider, now }) {
  const { entry, prepared } = originalPayment(journal, goal, now);
  const settlement = await readExactFtEvidence({ prepared, txHash: entry.tx_hash, pinnedView: entry.exact_ft.pinned_view, provider });
  if (entry.status === 'completed' && !isDeepStrictEqual(entry.settlement, settlement)) {
    throw new Error('recorded Svalin payment differs from the original chain evidence');
  }
  return { entry, prepared, settlement };
}
async function offerStillReviewed(fetchImpl, now) {
  try { await probeSvalinProOffer({ fetchImpl, nowMs: timestamp(now) }); }
  catch { throw new Error('fresh seller offer unavailable or changed; no payment was broadcast'); }
}

/** Pay an already separately owner-approved V11 intent, once. No reservation,
 * activation, paid endpoint, new owner signature or fallback route is used. */
export async function paySvalinProExactFtOnce({ goal: rawGoal, journal, provider, account, publicKey,
  fetchImpl = globalThis.fetch, now = Date.now, execute = false, acknowledgeBackup = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true || acknowledgeBackup !== true) throw new Error('explicit payment and journal/key-backup acknowledgments are required; no payment was sent');
  if (typeof provider?.sendTransactionOnce !== 'function' || typeof provider?.txStatusReceipts !== 'function') {
    throw new Error('Svalin payment requires one-shot transport and receipt-inclusive RPC');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const agentKey = String(publicKey);
    const prepared = reconstructSvalinProExactFt({ goal, journal, agentPublicKey: agentKey, now });
    const request = paymentRequest(goal, prepared), a = prepared.owner_call.args;
    assertNoPriorPayment(journal, goal, request);
    const preflight = await preflightExactFt({ prepared, publicKey, provider, now, requirePlainOwner: true,
      maxAgentGasAllowanceYocto: SVALIN_TRIAL_MAX_GAS_ALLOWANCE });
    if (!preflight.allowed) return { status: 'BLOCKED', reason: preflight.reason, sends: 0 };
    await offerStillReviewed(fetchImpl, now);
    assertFreshFinalBlock(preflight.finalBlock, timestamp(now));
    const signed = await signReviewedCall({ account, publicKey, ownerId: goal.owner, contractId: goal.vault,
      method: 'execute_exact_ft', args: { intent_id: prepared.intent_id }, gas: 200n * 10n ** 12n });
    if (!isTransactionHash(signed.txHash)) throw new Error('invalid signed exact FT transaction hash');
    await offerStillReviewed(fetchImpl, now);
    if (timestamp(now) >= Number(a.expires_at_ms) - 60_000) throw new Error('exact FT execution cutoff is too close; no payment sent');
    if (!isDeepStrictEqual(prepared, reconstructSvalinProExactFt({ goal, journal, agentPublicKey: agentKey, now }))) {
      throw new Error('original Svalin reservation changed during review; no payment sent');
    }
    assertNoPriorPayment(journal, goal, request);
    assertFreshFinalBlock(preflight.finalBlock, timestamp(now));
    const pending = { status: 'pending', fingerprint: requestFingerprint(request), request, payment_version: 'svalin-exact-ft-signed-v11',
      tx_hash: signed.txHash, agent_public_key: agentKey, exact_ft: { version: 1, prepared, pinned_view: preflight.pinnedView },
      started_at: new Date(timestamp(now)).toISOString() };
    journal.put(goal.id, pending); // fsync BEFORE the only broadcast
    try {
      // Detect an owner-code change in a newer FINAL snapshot. Once signed and
      // recorded, any failure remains fenced under this original hash; this
      // cannot rule out later changes, in-flight receipts or a dishonest RPC.
      const currentOwner = await readSvalinPlainOwnerAtFinal({ provider, owner: goal.owner, now });
      if (timestamp(now) >= Number(a.expires_at_ms) - 60_000) throw new Error('exact FT cutoff passed after reservation');
      assertFreshFinalBlock(currentOwner, timestamp(now));
      assertFreshFinalBlock(preflight.finalBlock, timestamp(now));
      const sent = await provider.sendTransactionOnce(signed.signed, 'FINAL');
      if (sent?.transaction_outcome?.id !== signed.txHash) throw new Error('RPC returned a different or missing transaction hash');
      const settlement = await readExactFtEvidence({ prepared, txHash: signed.txHash, pinnedView: preflight.pinnedView, provider });
      journal.put(goal.id, { ...pending, status: 'completed', settlement, completed_at: new Date(timestamp(now)).toISOString() });
      return { status: 'PAID_NOT_YET_ACTIVATED', settlement, sends: 1,
        scope: 'FINAL testnet transfer only; seller attribution, activation and delivery are not established' };
    } catch {
      throw new Error(`${goal.id}: exact FT payment is unresolved (tx ${signed.txHash}); preserve the journal and never automatically resend`);
    }
  });
}

/** Key-free recovery by the original hash. Never sign, broadcast or contact
 * the seller. An unknown/missing hash does not establish non-payment. */
export async function recoverSvalinProPayment({ goal: rawGoal, journal, provider, now = Date.now, update = true }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (typeof update !== 'boolean') throw new Error('invalid journal update option');
  return withExclusiveJournalOperation(journal, async () => {
    const { entry, settlement } = await checkedSettlement({ journal, goal, provider, now });
    if (update && entry.status === 'pending') journal.put(goal.id, { ...entry, status: 'completed', settlement,
      completed_at: new Date(timestamp(now)).toISOString() });
    return { status: 'RECOVERED_PAYMENT_ONLY', settlement, sends: 0, seller_requests: 0,
      scope: 'original FINAL testnet transfer only; seller attribution, activation and delivery are not established' };
  });
}

async function sellerJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  try {
    if (response.status !== 200) throw new Error('unexpected seller HTTP status');
    return { body: await readBoundedJson(response, { maxBytes: 64 * 1024, label: 'seller response' }), headers: response.headers };
  } finally { await response.body?.cancel().catch(() => {}); }
}
function normalizedActiveStatus(s, nowMs) {
  const until = typeof s?.until === 'string' ? Date.parse(s.until) : NaN;
  if (!record(s) || s.kind !== 'pro' || s.plan !== 'pro' || s.active !== true || s.callsPer !== 'day' ||
      !Number.isSafeInteger(s.callsLeft) || s.callsLeft < 0 || s.callsLeft > 100 || !Number.isSafeInteger(until) ||
      new Date(until).toISOString() !== s.until || until <= nowMs || until > nowMs + 33 * 24 * 60 * 60_000) {
    throw new Error('seller activation is ambiguous or outside the reviewed monthly profile');
  }
  return { seller_reported_active: true, until: s.until, calls_left: s.callsLeft, calls_per: 'day' };
}
function normalizedActivation(answer, nowMs) {
  if (!record(answer) || answer.found !== 1 || !Array.isArray(answer.pending) || answer.pending.length !== 0) {
    throw new Error('seller activation is ambiguous or outside the reviewed monthly profile');
  }
  return { ...normalizedActiveStatus(answer.status, nowMs), seller_reported_found: 1 };
}
function recordedActivation(activation, txHash, nowMs) {
  const s = activation?.summary, until = typeof s?.until === 'string' ? Date.parse(s.until) : NaN;
  if (activation?.phase !== 'active' || activation.tx_hash !== txHash || !record(s) ||
      s.seller_reported_active !== true ||
      !(s.seller_reported_found === 1 || (s.seller_reported_found === null && activation.via === 'status-check')) ||
      s.calls_per !== 'day' || !Number.isSafeInteger(s.calls_left) || s.calls_left < 0 || s.calls_left > 100 ||
      !Number.isSafeInteger(until) || new Date(until).toISOString() !== s.until || until <= nowMs ||
      until > nowMs + 33 * 24 * 60 * 60_000) {
    throw new Error('original recorded seller activation is missing, expired or inconsistent');
  }
  return { seller_reported_active: true, seller_reported_found: s.seller_reported_found,
    until: s.until, calls_left: s.calls_left, calls_per: 'day' };
}

/** A separately approved POST can claim payments and mutate seller state. The
 * original FINAL payment must already be recovered, and 30 seconds must have
 * elapsed after recording it. A lost, early or untrusted response is never
 * reposted automatically. The seller does not identify the credited tx. */
export async function activateSvalinProOnce({ goal: rawGoal, journal, provider, fetchImpl = globalThis.fetch,
  now = Date.now, execute = false, acknowledgeBackup = false, acknowledgeMutation = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true || acknowledgeBackup !== true || acknowledgeMutation !== true) {
    throw new Error('explicit activation, seller-state mutation and journal/key-backup acknowledgments are required');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const { entry, prepared, settlement } = await checkedSettlement({ journal, goal, provider, now });
    if (entry.status !== 'completed') throw new Error('recover the original FINAL payment before activation');
    if (!isDeepStrictEqual(prepared, reconstructSvalinProExactFt({ goal, journal, agentPublicKey: entry.agent_public_key, now, allowExpired: true }))) {
      throw new Error('original Svalin session changed during settlement verification');
    }
    const doneAt = typeof entry.completed_at === 'string' ? Date.parse(entry.completed_at) : NaN, nowMs = timestamp(now);
    if (!Number.isSafeInteger(doneAt) || new Date(doneAt).toISOString() !== entry.completed_at || nowMs < doneAt + 30_000) {
      throw new Error('wait at least 30 seconds after recorded FINAL settlement before activation; seller indexing may take longer');
    }
    const id = sessionId(goal), session = journal.get(id), prior = session.svalin.activation;
    if (prior?.phase === 'active') return { status: 'SELLER_REPORTED_ACTIVE', activation: recordedActivation(prior, entry.tx_hash, nowMs), activation_posts: 0,
      settlement, seller_attribution_verified: false,
      scope: 'seller does not identify the credited transaction; attribution and delivery remain unproven' };
    if (prior) throw new Error('original activation is unresolved; do not automatically repeat the seller POST');
    const requested = { ...session, svalin: { ...session.svalin, activation: { phase: 'requested',
      tx_hash: entry.tx_hash, requested_at: new Date(nowMs).toISOString() } } };
    journal.put(id, requested); // BEFORE the potentially mutating seller call
    try {
      const { body } = await sellerJson(`${SVALIN_ORIGIN}/v1/pro/activate`, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ code: requested.svalin.code }) }, fetchImpl);
      const activation = normalizedActivation(body, timestamp(now));
      journal.put(id, { ...requested, svalin: { ...requested.svalin,
        activation: { ...requested.svalin.activation, phase: 'active', summary: activation } } });
      return { status: 'SELLER_REPORTED_ACTIVE', activation, activation_posts: 1, settlement, seller_attribution_verified: false,
        scope: 'seller does not identify the credited transaction; attribution and delivery remain unproven' };
    } catch {
      // Never leak untrusted bodies, exceptions, Authorization or the bearer.
      throw new Error('activation response is unresolved or untrusted; preserve the original journal and do not repeat automatically');
    }
  });
}

/** Explicit status-only recovery after an ambiguous activation POST. The pinned
 * seller source implements this GET without claiming payments or consuming a
 * paid call; the deployed service is unverified. It sends the original bearer
 * to the fixed seller and cannot prove which transaction activated the pass. */
export async function inspectSvalinProActivation({ goal: rawGoal, journal, provider, fetchImpl = globalThis.fetch,
  now = Date.now, execute = false, acknowledgeBackup = false, acknowledgeDisclosure = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (execute !== true || acknowledgeBackup !== true || acknowledgeDisclosure !== true) {
    throw new Error('explicit seller status-check, bearer disclosure and journal/key-backup acknowledgments are required');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const { entry, prepared, settlement } = await checkedSettlement({ journal, goal, provider, now });
    if (entry.status !== 'completed' || !isDeepStrictEqual(prepared, reconstructSvalinProExactFt({
      goal, journal, agentPublicKey: entry.agent_public_key, now, allowExpired: true }))) {
      throw new Error('recover the original FINAL payment and preserve its session before checking activation');
    }
    const id = sessionId(goal), session = journal.get(id), prior = session.svalin.activation, nowMs = timestamp(now);
    if (prior?.phase === 'active') return { status: 'SELLER_REPORTED_ACTIVE',
      activation: recordedActivation(prior, entry.tx_hash, nowMs), activation_posts: 0, status_checks: 0, settlement,
      seller_attribution_verified: false,
      scope: 'seller does not identify the credited transaction; attribution and delivery remain unproven' };
    if (prior?.phase !== 'requested' || prior.tx_hash !== entry.tx_hash) {
      throw new Error('an original unresolved activation attempt is required; status inspection never initiates activation');
    }
    try {
      const { body } = await sellerJson(`${SVALIN_ORIGIN}/v1/keys/me`, { method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${session.svalin.code}` } }, fetchImpl);
      if (!record(body) || typeof body.active !== 'boolean') throw new Error('malformed status');
      if (body.active === false) {
        return { status: 'SELLER_ACTIVE_NOT_CONFIRMED', activation_posts: 0, status_checks: 1, settlement, seller_attribution_verified: false,
          scope: 'no claim or payment retry was made; preserve the original journal for manual reconciliation' };
      }
      const activation = { ...normalizedActiveStatus(body, timestamp(now)), seller_reported_found: null };
      journal.put(id, { ...session, svalin: { ...session.svalin,
        activation: { ...prior, phase: 'active', via: 'status-check', summary: activation } } });
      return { status: 'SELLER_REPORTED_ACTIVE', activation, activation_posts: 0, status_checks: 1, settlement, seller_attribution_verified: false,
        scope: 'status-check does not identify a transaction; attribution and delivery remain unproven' };
    } catch {
      throw new Error('seller status check is unresolved or untrusted; preserve the journal and do not repeat the activation POST automatically');
    }
  });
}

function publicNearAccount(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
    (/^[a-f0-9]{64}$/.test(value) || /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.(?:near|testnet)$/.test(value));
}
function boundedNumber(n, min, max) { return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max; }
const FINDING_KINDS = new Set(['concentration', 'stable-buffer', 'long-tail-exposure', 'meme-exposure', 'lst-opportunity',
  'idle-stablecoins', 'unpriced-holdings', 'small-portfolio', 'exit-cost', 'hidden-instructions']);
const FINDING_SEVERITIES = new Set(['info', 'low', 'medium', 'high']);
// These are seller claims, not independently verified provenance. In
// particular, the upstream mock source returns plausible-looking sample
// holdings for any address; never discard its label or present it as live.
const RISK_DATA_SOURCES = new Set(['fastnear', 'mock']);
function validFinding(f) { return record(f) && FINDING_KINDS.has(f.kind) && FINDING_SEVERITIES.has(f.severity); }
function riskSourceScope(source) {
  return source === 'mock'
    ? 'seller-labelled sample data, not live holdings; payment attribution and accuracy are not verified'
    : 'seller-reported source and untrusted data; source, accuracy and payment attribution are not independently verified';
}
function riskSummary(body, headers, target, nowMs) {
  const rawCalls = headers?.get('x-calls-left'), date = typeof body?.generatedAt === 'string' ? Date.parse(body.generatedAt) : NaN;
  const m = body?.metrics, score = body?.score;
  const grade = score === null ? null : score <= 20 ? 'A' : score <= 40 ? 'B' : score <= 60 ? 'C' : score <= 80 ? 'D' : 'F';
  const level = score === null ? null : score <= 25 ? 'low' : score <= 50 ? 'moderate' : score <= 75 ? 'elevated' : 'high';
  if (!record(body) || body.wallet !== target || body.chain !== 'near' ||
      !(score === null || (Number.isSafeInteger(score) && score >= 0 && score <= 100)) || body.grade !== grade || body.level !== level ||
      !Number.isSafeInteger(body.dataCoverage) || body.dataCoverage < 0 || body.dataCoverage > 100 ||
      !RISK_DATA_SOURCES.has(body.dataSource) ||
      body.methodologyVersion !== '2026-10.8' || !Number.isSafeInteger(date) || new Date(date).toISOString() !== body.generatedAt ||
      date < nowMs - 24 * 60 * 60_000 || date > nowMs + 5 * 60_000 || Object.hasOwn(body, 'locked') ||
      !record(m) || !boundedNumber(m.totalValueUsd, 0, 1e15) || !Number.isSafeInteger(m.pricedAssetCount) || m.pricedAssetCount < 0 ||
      !Number.isSafeInteger(m.unpricedAssetCount) || m.unpricedAssetCount < 0 ||
      !Array.isArray(body.findings) || body.findings.length > 50 ||
      body.findings.some(f => !validFinding(f) || typeof f.action !== 'string' || !f.action || Buffer.byteLength(f.action, 'utf8') > 4096) ||
      typeof rawCalls !== 'string' || !/^(?:0|[1-9][0-9]?)$/.test(rawCalls)) {
    throw new Error('seller response does not match the reviewed paid risk report profile');
  }
  return { account: target, chain: 'near', score, grade, level, data_coverage_percent: body.dataCoverage,
    portfolio_value_usd: m.totalValueUsd, priced_assets: m.pricedAssetCount, unpriced_assets: m.unpricedAssetCount,
    finding_count: body.findings.length, findings: body.findings.map(({ kind, severity }) => ({ kind, severity })),
    generated_at: body.generatedAt, methodology_version: body.methodologyVersion,
    seller_reported_data_source: body.dataSource, sample_data: body.dataSource === 'mock',
    seller_reported_calls_left: Number(rawCalls), scope: riskSourceScope(body.dataSource) };
}
function recordedRiskSummary(s, target) {
  const score = s?.score, date = typeof s?.generated_at === 'string' ? Date.parse(s.generated_at) : NaN;
  const grade = score === null ? null : score <= 20 ? 'A' : score <= 40 ? 'B' : score <= 60 ? 'C' : score <= 80 ? 'D' : 'F';
  const level = score === null ? null : score <= 25 ? 'low' : score <= 50 ? 'moderate' : score <= 75 ? 'elevated' : 'high';
  if (!record(s) || s.account !== target || s.chain !== 'near' ||
      !(score === null || (Number.isSafeInteger(score) && score >= 0 && score <= 100)) || s.grade !== grade || s.level !== level ||
      !Number.isSafeInteger(s.data_coverage_percent) || s.data_coverage_percent < 0 || s.data_coverage_percent > 100 ||
      !boundedNumber(s.portfolio_value_usd, 0, 1e15) || !Number.isSafeInteger(s.priced_assets) || s.priced_assets < 0 ||
      !Number.isSafeInteger(s.unpriced_assets) || s.unpriced_assets < 0 || !Number.isSafeInteger(s.finding_count) ||
      s.finding_count < 0 || s.finding_count > 50 || !Array.isArray(s.findings) || s.findings.length !== s.finding_count ||
      s.findings.some(f => !validFinding(f)) || !Number.isSafeInteger(date) || new Date(date).toISOString() !== s.generated_at ||
      s.methodology_version !== '2026-10.8' || !RISK_DATA_SOURCES.has(s.seller_reported_data_source) ||
      s.sample_data !== (s.seller_reported_data_source === 'mock') || !Number.isSafeInteger(s.seller_reported_calls_left) ||
      s.seller_reported_calls_left < 0 || s.seller_reported_calls_left > 99) {
    throw new Error('recorded risk report is missing or inconsistent');
  }
  return { account: target, chain: 'near', score, grade, level, data_coverage_percent: s.data_coverage_percent,
    portfolio_value_usd: s.portfolio_value_usd, priced_assets: s.priced_assets, unpriced_assets: s.unpriced_assets,
    finding_count: s.finding_count, findings: s.findings.map(({ kind, severity }) => ({ kind, severity })),
    generated_at: s.generated_at, methodology_version: s.methodology_version,
    seller_reported_data_source: s.seller_reported_data_source, sample_data: s.sample_data,
    seller_reported_calls_left: s.seller_reported_calls_left, scope: riskSourceScope(s.seller_reported_data_source) };
}

/** ONE explicitly approved paid-endpoint GET. It sends the original bearer in
 * an Authorization header, discloses the public target to the seller and may
 * consume one daily call. Only bounded scalars and allowlisted finding enums
 * are returned; arbitrary seller text and bearer echoes never enter logs or
 * model instructions. */
export async function requestSvalinProRiskOnce({ goal: rawGoal, journal, provider, target, fetchImpl = globalThis.fetch,
  now = Date.now, execute = false, acknowledgeDisclosure = false, acknowledgeUsage = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (!publicNearAccount(target)) throw new Error('one public canonical NEAR account is required');
  if (execute !== true || acknowledgeDisclosure !== true || acknowledgeUsage !== true) {
    throw new Error('explicit paid call, public-account disclosure and quota-use acknowledgments are required');
  }
  return withExclusiveJournalOperation(journal, async () => {
    const { entry, prepared, settlement } = await checkedSettlement({ journal, goal, provider, now });
    if (entry.status !== 'completed') throw new Error('recover the original FINAL payment before requesting a report');
    if (!isDeepStrictEqual(prepared, reconstructSvalinProExactFt({ goal, journal, agentPublicKey: entry.agent_public_key, now, allowExpired: true }))) {
      throw new Error('original Svalin session changed during settlement verification');
    }
    const id = sessionId(goal), session = journal.get(id), activation = session.svalin.activation;
    recordedActivation(activation, entry.tx_hash, timestamp(now));
    const previous = session.svalin.risk;
    if (previous?.phase === 'returned' && previous.target === target && previous.tx_hash === entry.tx_hash) return { status: 'SELLER_REPORT_REUSED',
      report: recordedRiskSummary(previous.summary, target), settlement, paid_requests: 0, seller_attribution_verified: false };
    if (previous) throw new Error('original paid risk request is unresolved or targets a different account; do not repeat automatically');
    const requested = { ...session, svalin: { ...session.svalin, risk: { phase: 'requested', target,
      tx_hash: entry.tx_hash, requested_at: new Date(timestamp(now)).toISOString() } } };
    journal.put(id, requested); // BEFORE any request that might consume quota
    try {
      const { body, headers } = await sellerJson(`${SVALIN_ORIGIN}/v1/risk/${target}`, { method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${requested.svalin.code}` } }, fetchImpl);
      const report = riskSummary(body, headers, target, timestamp(now));
      journal.put(id, { ...requested, svalin: { ...requested.svalin,
        risk: { ...requested.svalin.risk, phase: 'returned', summary: report } } });
      return { status: 'SELLER_REPORT_RECEIVED', report, settlement, paid_requests: 1, seller_attribution_verified: false,
        scope: 'seller-reported active code and bounded response; not proof that this particular transfer funded the pass' };
    } catch {
      throw new Error('paid risk response is unresolved or untrusted; preserve the original journal and do not repeat automatically');
    }
  });
}
