/**
 * Experimental Svalin Pro testnet session. A random bearer code is generated
 * locally and persisted ONLY in the encrypted owner/vault-scoped FileJournal
 * before any reservation request. This module does not sign or pay, and no
 * live reservation or activation has been established by its fixture tests.
 * Seller POSTs have explicit opt-ins and never retry an ambiguous outcome.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { readSvalinPlainOwnerAtFinal } from './svalin-owner-snapshot.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { CIRCLE_TESTNET_USDC } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_NETWORK, SVALIN_ORIGIN, SVALIN_PAYEE, summarizeSvalinProOffer,
  validateSvalinProCheckout } from './svalin-pro-readiness.mjs';

const FIELDS = ['version', 'id', 'vault', 'owner', 'vault_code_hash', 'policy_id',
  'accept_unsigned_seller_risk', 'accept_exact_amount_matching_risk'];
const CODE = /^svp_[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PENDING_PHASES = new Set(['prepared', 'reservation_requested', 'recovery_requested', 'reserved']);
const digest = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = now => {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 1 || !Number.isFinite(new Date(value).getTime())) throw new Error('invalid local time');
  return value;
};
const sessionKey = goal => `${goal.id}-svalin-pro`;

export function validateSvalinProGoal(input) {
  if (!record(input) || Object.keys(input).length !== FIELDS.length || FIELDS.some(k => !Object.hasOwn(input, k)) ||
      input.version !== 1 || !/^[A-Za-z0-9_-]{1,48}$/.test(input.id ?? '') ||
      !isTestnetAccount(input.vault) || !isTestnetAccount(input.owner) || input.vault === input.owner ||
      !isTransactionHash(input.vault_code_hash) || typeof input.policy_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.policy_id) || input.accept_unsigned_seller_risk !== true ||
      input.accept_exact_amount_matching_risk !== true) throw new Error('invalid or unacknowledged Svalin testnet goal');
  return Object.fromEntries(FIELDS.map(k => [k, input[k]]));
}
function requireJournal(journal, goal) {
  if (!(journal instanceof FileJournal) || journal.encryptionEnabled !== true ||
      journal.data?.contract_id !== goal.vault || journal.data?.owner_account_id !== goal.owner) {
    throw new Error('original owner/vault-scoped encrypted file journal is required');
  }
  journal.assertAvailable();
}
function session(journal, goal) {
  const entry = journal.get(sessionKey(goal));
  if (!entry || entry.status !== 'pending' || entry.fingerprint !== digest(JSON.stringify(goal)) ||
      entry.svalin?.version !== 1 || !PENDING_PHASES.has(entry.svalin.phase) ||
      !isDeepStrictEqual(entry.svalin.goal, goal) || !CODE.test(entry.svalin.code ?? '')) {
    throw new Error('original encrypted Svalin session is missing or differs from the owner goal');
  }
  return entry;
}
function safeCheckout(c) {
  if (!record(c) || c.network !== SVALIN_NETWORK || c.environment !== 'testnet' ||
      c.token !== CIRCLE_TESTNET_USDC || c.payee !== SVALIN_PAYEE || c.plan !== 'month' ||
      typeof c.amount_atoms !== 'string' || !/^500[0-9]{4}$/.test(c.amount_atoms) ||
      BigInt(c.amount_atoms) <= 5_000_000n || BigInt(c.amount_atoms) > 5_009_999n) {
    throw new Error('original reviewed testnet reservation is missing or invalid');
  }
  const expires = typeof c.expires_at === 'string' ? Date.parse(c.expires_at) : NaN;
  if (!Number.isSafeInteger(expires) || new Date(expires).toISOString() !== c.expires_at) {
    throw new Error('original reservation expiry is invalid');
  }
  // Reconstruct, rather than returning untrusted extra fields from the seller
  // or a mutable in-memory journal. Never expose a bearer in metadata.
  return { network: SVALIN_NETWORK, environment: 'testnet', token: CIRCLE_TESTNET_USDC,
    payee: SVALIN_PAYEE, plan: 'month', amount_atoms: c.amount_atoms, expires_at: c.expires_at,
    authorization: 'NOT_APPROVED', quote_signed: false,
    warning: 'Keep the bearer code encrypted and backed up; exact-amount matching does not authenticate the sender.' };
}
function summary(entry) {
  return { phase: entry.svalin.phase, reservation: entry.svalin.checkout ? safeCheckout(entry.svalin.checkout) : null,
    bearer_code_returned: false, payment_sent_by_this_library: false, fulfillment_verified: false,
    scope: 'testnet session metadata only; this library neither pays nor proves seller attribution or delivery' };
}
function publicKey(value) {
  if (typeof value !== 'string') throw new Error('an explicit agent public key is required');
  let key;
  try { key = nearApi.utils.PublicKey.from(value); } catch { throw new Error('invalid agent public key'); }
  if (key.keyType !== 0 || String(key) !== value) throw new Error('agent key must be a canonical Ed25519 public key');
  return value;
}

/** Local only. The high-entropy code is durable before it can be sent; this
 * does not create a provider reservation. Keep a separate secure backup of the
 * encrypted journal AND its key. Stale-restored or separate journals remain a
 * duplicate-risk outside this single-journal fence. */
export async function prepareSvalinProSession({ goal: rawGoal, journal, now = Date.now }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  return withExclusiveJournalOperation(journal, async () => {
    const id = sessionKey(goal), prior = journal.get(id);
    if (prior) return summary(session(journal, goal));
    if (journal.list().some(e => e && Object.hasOwn(e, 'svalin'))) {
      throw new Error('an original Svalin session already exists in this journal; preserve and reconcile it');
    }
    const entropy = crypto.randomBytes(32);
    let code;
    try { code = `svp_${nearApi.utils.serialize.base_encode(entropy)}`; }
    finally { entropy.fill(0); }
    if (!CODE.test(code)) throw new Error('secure Pro code generation failed');
    const entry = { status: 'pending', fingerprint: digest(JSON.stringify(goal)), svalin: { version: 1,
      phase: 'prepared', goal, code, prepared_at: new Date(timestamp(now)).toISOString() } };
    journal.put(id, entry);
    return summary(entry);
  });
}

async function requestJson(url, { method, body }, fetchImpl) {
  const options = { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) };
  const response = await fetchImpl(url, options);
  try {
    if (response.status !== 200) throw new Error('unexpected seller HTTP status');
    return await readBoundedJson(response, { maxBytes: 64 * 1024, label: 'seller response' });
  } finally { await response.body?.cancel().catch(() => {}); }
}
async function freshOffer(fetchImpl, now) {
  const offer = await requestJson(`${SVALIN_ORIGIN}/v1/pro`, { method: 'GET' }, fetchImpl);
  summarizeSvalinProOffer(offer, timestamp(now));
  return offer;
}
function checkOptIn(execute, acknowledgeBackup) {
  if (execute !== true || acknowledgeBackup !== true) {
    throw new Error('explicit seller POST and secure journal/key backup acknowledgments are required; no request was sent');
  }
}

/** Exactly one reservation POST after a narrow owner snapshot and durable
 * write-ahead state. A lost or untrusted response remains unresolved: never
 * repeat the POST automatically. This does not prove consent or future state. */
export async function reserveSvalinProOnce({ goal: rawGoal, journal, provider, fetchImpl = globalThis.fetch,
  now = Date.now, execute = false, acknowledgeBackup = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal); checkOptIn(execute, acknowledgeBackup);
  return withExclusiveJournalOperation(journal, async () => {
    const id = sessionKey(goal), entry = session(journal, goal);
    if (entry.svalin.phase === 'reserved') return summary(entry);
    if (entry.svalin.phase !== 'prepared') throw new Error('reservation outcome is unresolved; preserve the original journal and do not send another reservation');
    let ownerSnapshot;
    try { ownerSnapshot = await readSvalinPlainOwnerAtFinal({ provider, owner: goal.owner, now }); }
    catch { throw new Error('fresh pinned testnet owner without local or global contract code is required; no reservation was sent'); }
    // GET is before the write-ahead reservation: failure cannot have sent POST.
    let offer;
    try { offer = await freshOffer(fetchImpl, now); }
    catch { throw new Error('fresh seller offer unavailable or untrusted; no reservation was sent'); }
    assertFreshFinalBlock(ownerSnapshot, timestamp(now));
    const requested = { ...entry, svalin: { ...entry.svalin, phase: 'reservation_requested',
      reservation_requested_at: new Date(timestamp(now)).toISOString() } };
    journal.put(id, requested);
    try {
      assertFreshFinalBlock(ownerSnapshot, timestamp(now));
      const raw = await requestJson(`${SVALIN_ORIGIN}/v1/pro/near`, { method: 'POST',
        body: { code: requested.svalin.code, plan: 'month' } }, fetchImpl);
      const checkout = validateSvalinProCheckout({ offer, checkout: raw, nowMs: timestamp(now) });
      const reserved = { ...requested, svalin: { ...requested.svalin, phase: 'reserved', checkout } };
      journal.put(id, reserved);
      return summary(reserved);
    } catch {
      // Provider errors, response bodies and network exceptions can contain the
      // bearer. Never echo or chain them into a loggable exception.
      throw new Error('reservation response is unresolved or untrusted; preserve the original journal and do not request another automatically');
    }
  });
}

/** A separately approved activation POST can recover a lost reservation using
 * the ORIGINAL code. Activation may mutate seller state by claiming observed
 * payments; it is not read-only. It is itself write-ahead fenced and never
 * automatically retried. Anything except one unpaid pending checkout is left
 * unresolved, including an active pass, missing or multiple reservations. */
export async function recoverSvalinProReservationOnce({ goal: rawGoal, journal, fetchImpl = globalThis.fetch,
  now = Date.now, execute = false, acknowledgeBackup = false, acknowledgeMutation = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal); checkOptIn(execute, acknowledgeBackup);
  if (acknowledgeMutation !== true) throw new Error('explicit seller-state mutation acknowledgment is required for reservation recovery');
  return withExclusiveJournalOperation(journal, async () => {
    const id = sessionKey(goal), entry = session(journal, goal);
    if (entry.svalin.phase === 'reserved') return summary(entry);
    if (entry.svalin.phase !== 'reservation_requested') {
      throw new Error('original reservation is not eligible for one activation lookup; preserve and reconcile it');
    }
    let offer;
    try { offer = await freshOffer(fetchImpl, now); }
    catch { throw new Error('fresh seller offer unavailable or untrusted; no activation request was sent'); }
    const requested = { ...entry, svalin: { ...entry.svalin, phase: 'recovery_requested',
      recovery_requested_at: new Date(timestamp(now)).toISOString() } };
    journal.put(id, requested);
    try {
      const answer = await requestJson(`${SVALIN_ORIGIN}/v1/pro/activate`, { method: 'POST', body: { code: requested.svalin.code } }, fetchImpl);
      if (!record(answer) || answer.status !== null || answer.found !== 0 ||
          !Array.isArray(answer.pending) || answer.pending.length !== 1) throw new Error('unresolved seller state');
      const checkout = validateSvalinProCheckout({ offer, checkout: answer.pending[0], nowMs: timestamp(now) });
      const reserved = { ...requested, svalin: { ...requested.svalin, phase: 'reserved', checkout } };
      journal.put(id, reserved);
      return summary(reserved);
    } catch {
      throw new Error('activation response is unresolved or untrusted; preserve the original journal and do not repeat automatically');
    }
  });
}

/** Internal read-only reconstruction for a caller already holding the
 * journal-operation fence. Returns no bearer code. `allowExpired` is ONLY for
 * reconciling an original signed hash; it never authorizes a new payment. */
export function reconstructSvalinProExactFt({ goal: rawGoal, journal, agentPublicKey, now = Date.now, allowExpired = false }) {
  const goal = validateSvalinProGoal(rawGoal); requireJournal(journal, goal);
  if (typeof allowExpired !== 'boolean') throw new Error('invalid expiry mode');
  const entry = session(journal, goal), nowMs = timestamp(now);
  if (entry.svalin.phase !== 'reserved') throw new Error('original reviewed testnet reservation is missing or invalid');
  const c = safeCheckout(entry.svalin.checkout);
  const expires = Date.parse(c.expires_at), cutoff = expires - 5 * 60_000;
  if (!Number.isSafeInteger(expires) || new Date(expires).toISOString() !== c.expires_at || cutoff <= 0 ||
      (!allowExpired && (cutoff < nowMs + 60_000 || cutoff > nowMs + 73 * 60 * 60_000))) {
    throw new Error('reservation is expired or too close to expiry for owner review');
  }
  const key = publicKey(agentPublicKey);
  const review = { protocol: 'bouncer:svalin-pro-exact-ft:v1', goal, checkout: { network: c.network, token: c.token,
    payee: c.payee, plan: c.plan, amount_atoms: c.amount_atoms, expires_at: c.expires_at },
    code_commitment: digest(`bouncer:svalin-pro-code:v1:${entry.svalin.code}`), agent_public_key: key,
    expires_at_ms: String(cutoff) };
  const reviewHash = digest(JSON.stringify(review));
  const intentId = `sv-${reviewHash.slice(0, 60)}`, memo = `bouncer-svalin:${reviewHash.slice(0, 32)}`;
  const args = { intent_id: intentId, policy_id: goal.policy_id, expected_token: c.token,
    payee: c.payee, amount: c.amount_atoms, memo, review_hash: reviewHash,
    expires_at_ms: String(cutoff), agent_public_key: key };
  return { review, review_hash: reviewHash, intent_id: intentId,
    owner_call: { receiver_id: goal.vault, method: 'set_exact_ft_intent', attached_yocto: '1', args },
    agent_call: { receiver_id: goal.vault, method: 'execute_exact_ft', attached_yocto: '0', args: { intent_id: intentId } },
    scope: 'unsigned preparation only; no owner approval, signature, payment, seller attribution or delivery' };
}

/** Prepare public V11 owner/agent calldata only. The code is never included in
 * calldata or memo; a domain-separated SHA-256 commitment binds the locally
 * generated 256-bit secret without revealing it. No signature or send occurs. */
export async function prepareSvalinProExactFt({ goal, journal, agentPublicKey, now = Date.now }) {
  return withExclusiveJournalOperation(journal, () => reconstructSvalinProExactFt({ goal, journal, agentPublicKey, now }));
}
