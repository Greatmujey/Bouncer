/**
 * Experimental owner-approved YouTick testnet Play grant. The original paid
 * and published session is mandatory. A signed transaction hash is persisted
 * to the original encrypted, exclusively locked journal BEFORE one broadcast.
 * Recovery uses that hash and public data only; it never signs or resends.
 *
 * The RPC, deployed contracts, provider publication and local clock remain
 * trust assumptions. A grant is not evidence that playback or delivery works.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { validateFtCallGoal, verifyFtCallSettlement } from './ft-call.mjs';
import { signReviewedOneYoctoOwnerCall } from './reviewed-transaction.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { YOUTICK_MARKET, YOUTICK_ACCESS } from './youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from './youtick-quote.mjs';
import { verifyYoutickPlayGrantArgs, YOUTICK_PLAY_ORIGIN_HASH } from './youtick-play-proof.mjs';
import { prepareYoutickPlayGrant, verifyYoutickPlayGrantBinding, verifyYoutickPlayGrantView,
  verifyYoutickPlayGrantTransaction, YOUTICK_PLAY_GRANT_GAS } from './youtick-playback.mjs';

// These are observations of deployed hashes, not proof that the deployed
// bytes correspond to inspected source. An upgrade requires a fresh review.
export const YOUTICK_ACCESS_CODE_HASH = 'G8RyYN3nxGPc1jDoyy2u9uph7MzMs6jMJ1pTwe1U1CCq';
const VERSION = 'bouncer-agent-v10-youtick-testnet';
const KIND = 'youtick-owner-grant-v1';
const GAS = BigInt(YOUTICK_PLAY_GRANT_GAS);
const running = new WeakSet();
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function scope(journal) {
  if (!(journal instanceof FileJournal)) throw new Error('original encrypted exclusive file journal is required');
  journal.assertAvailable();
  if (!journal.encryptionEnabled) throw new Error('original encrypted exclusive file journal is required');
  return { vault: journal.data.contract_id, owner: journal.data.owner_account_id };
}
function time(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid local clock');
  return now;
}
async function exclusive(journal, operation) {
  scope(journal);
  if (running.has(journal)) throw new Error('a YouTick owner grant operation is already running on this journal');
  running.add(journal);
  try { return await operation(); } finally { running.delete(journal); }
}
function requireProvider(provider) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.query !== 'function' ||
      typeof provider.callFunction !== 'function' || typeof provider.txStatusReceipts !== 'function') {
    throw new Error('a testnet FINAL receipt-capable provider is required');
  }
}

/** Establish a single FINAL block for account code, vault identity and views.
 * An honest RPC is essential; a malicious RPC can lie about all of these. */
async function pinnedIdentity(provider, goal, vaultCodeHash) {
  requireProvider(provider);
  if (!isTransactionHash(vaultCodeHash)) throw new Error('an explicitly reviewed V10 vault code hash is required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report the NEAR testnet chain');
  const vault = await provider.query({ request_type: 'view_account', account_id: goal.contract_id, finality: 'final' });
  if (!isTransactionHash(vault?.block_hash) || vault?.code_hash !== vaultCodeHash) throw new Error('FINAL vault code does not match the reviewed V10 hash');
  const block = { blockId: vault.block_hash };
  const [access, market, version, owner] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: YOUTICK_ACCESS, ...block }),
    provider.query({ request_type: 'view_account', account_id: YOUTICK_MARKET, ...block }),
    provider.callFunction(goal.contract_id, 'contract_version', {}, block),
    provider.callFunction(goal.contract_id, 'get_owner', {}, block),
  ]);
  if (access?.block_hash !== vault.block_hash || market?.block_hash !== vault.block_hash ||
      access?.code_hash !== YOUTICK_ACCESS_CODE_HASH || market?.code_hash !== YOUTICK_V1_CODE_HASH) {
    throw new Error('FINAL YouTick access or market code hash changed; stop for review');
  }
  if (version !== VERSION || owner !== goal.owner_account_id) throw new Error('FINAL vault version or owner differs from the reviewed plan');
  return block;
}

function paymentRecord(journal, goal) {
  const payment = journal.get(goal.id);
  if (!payment || payment.status !== 'completed' || payment.fingerprint !== digest(goal) ||
      !isDeepStrictEqual(payment.ft_call_goal, goal) || !isTransactionHash(payment.tx_hash) ||
      typeof payment.agent_public_key !== 'string') throw new Error('original completed FT payment journal is required');
  return payment;
}
async function paymentEvidence(provider, journal, goal) {
  const payment = paymentRecord(journal, goal);
  const result = await provider.txStatusReceipts(payment.tx_hash, goal.owner_account_id, 'FINAL');
  const settlement = verifyFtCallSettlement(goal, result, payment.agent_public_key);
  if (settlement.tx_hash !== payment.tx_hash || settlement.used !== goal.amount || settlement.unused !== '0' ||
      !isDeepStrictEqual(payment.settlement, settlement)) throw new Error('payment settlement is not the recorded fully-used original');
  return { payment, result };
}
function playbackFor(journal, sessionId, goal) {
  if (!identifier(sessionId) || sessionId === goal.id) throw new Error('invalid original session ID');
  const session = journal.get(sessionId)?.session;
  const playback = session?.playback;
  if (!session || session.input?.vault !== goal.contract_id || session.input?.owner !== goal.owner_account_id ||
      !playback || playback.version !== 1 || typeof playback.public_key !== 'string' ||
      !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(playback.public_key) ||
      playback.public_key === session.public_key || typeof playback.device_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(playback.device_hash)) throw new Error('original encrypted playback session is missing or invalid');
  return { session, playback };
}
function requireMatchingScope(journal, goal) {
  const { vault, owner } = scope(journal);
  if (goal.contract_id !== vault || goal.owner_account_id !== owner) throw new Error('journal belongs to a different vault or owner');
}
function ensureUnusedSession(journal, grantId, sessionId, playback) {
  if (grantId === sessionId || journal.list().some(entry => entry.id !== grantId && entry.kind === KIND &&
      (entry.binding?.session_id === sessionId || entry.binding?.prepared?.args?.session_pk === playback.public_key))) {
    throw new Error('this playback session already has an owner grant attempt; recover its original hash');
  }
}

/** Validate saved, encrypted immutable review before key-free reconciliation. */
function recordedGrant(journal, grantId) {
  if (!identifier(grantId)) throw new Error('invalid owner grant ID');
  const entry = journal.get(grantId), binding = entry?.binding;
  if (!entry || entry.kind !== KIND || !['pending', 'completed'].includes(entry.status) ||
      !isTransactionHash(entry.tx_hash) || !exactKeys(binding, ['version', 'grant_id', 'session_id', 'goal', 'prepared',
        'vault_code_hash', 'market_code_hash', 'access_code_hash', 'payment_tx_hash', 'owner_public_key']) ||
      binding.version !== 1 || binding.grant_id !== grantId || entry.fingerprint !== digest(binding) ||
      !isTransactionHash(binding.vault_code_hash) || binding.market_code_hash !== YOUTICK_V1_CODE_HASH ||
      binding.access_code_hash !== YOUTICK_ACCESS_CODE_HASH || !isTransactionHash(binding.payment_tx_hash)) {
    throw new Error('original owner grant journal entry is missing or invalid');
  }
  const goal = validateFtCallGoal(binding.goal);
  requireMatchingScope(journal, goal);
  const { session, playback } = playbackFor(journal, binding.session_id, goal);
  ensureUnusedSession(journal, grantId, binding.session_id, playback);
  const prepared = binding.prepared;
  if (!prepared || prepared.owner_id !== goal.owner_account_id || prepared.vault !== goal.contract_id ||
      prepared.method !== 'issue_youtick_play_grant' || prepared.deposit !== '1' || prepared.gas !== YOUTICK_PLAY_GRANT_GAS ||
      prepared.args?.job_id !== session.input.job_id || prepared.args?.session_pk !== playback.public_key ||
      prepared.args?.device_hash !== playback.device_hash || prepared.publication?.job_id !== session.input.job_id ||
      prepared.publication?.vault !== goal.contract_id || paymentRecord(journal, goal).tx_hash !== binding.payment_tx_hash) {
    throw new Error('recorded grant does not match the original owner, payment and playback session');
  }
  verifyYoutickPlayGrantArgs({ vault: goal.contract_id, args: prepared.args });
  let ownerKey;
  try { ownerKey = nearApi.utils.PublicKey.fromString(binding.owner_public_key); } catch { throw new Error('recorded owner public key is invalid'); }
  if (ownerKey.keyType !== 0 || String(ownerKey) !== binding.owner_public_key) throw new Error('recorded owner public key is invalid');
  return { entry, binding, goal, prepared };
}

async function recoverUnlocked({ journal, grantId, provider, clock }) {
  const { entry, binding, goal, prepared } = recordedGrant(journal, grantId);
  const block = await pinnedIdentity(provider, goal, binding.vault_code_hash);
  // Recheck the original payment by hash, not a replacement session or an
  // inference from current token balances. No source file or signing key needed.
  await paymentEvidence(provider, journal, goal);
  const [result, grant, verification] = await Promise.all([
    provider.txStatusReceipts(entry.tx_hash, goal.owner_account_id, 'FINAL'),
    provider.callFunction(YOUTICK_ACCESS, 'get_session_grant', { session_pk: prepared.args.session_pk }, block),
    provider.callFunction(YOUTICK_ACCESS, 'verify_session_grant', { session_pk: prepared.args.session_pk, scope: 'Play',
      resource_id: prepared.args.job_id, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: prepared.args.device_hash }, block),
  ]);
  const proof = verifyYoutickPlayGrantTransaction({ prepared, result, txHash: entry.tx_hash,
    ownerPublicKey: binding.owner_public_key, grant });
  const bound = verifyYoutickPlayGrantBinding(prepared, grant), now = time(clock);
  let status;
  if (bound.expires_at_ms <= now) {
    // A previously valid grant can expire before a restart. Prove its receipt
    // and binding, but never report it active or create a replacement grant.
    status = 'EXPIRED';
  } else {
    verifyYoutickPlayGrantView(prepared, grant, verification, now);
    status = 'GRANTED';
  }
  if (entry.status !== 'completed' || !isDeepStrictEqual(entry.proof, proof)) {
    journal.put(grantId, { ...entry, status: 'completed', proof });
  }
  return { status, grant_id: grantId, tx_hash: entry.tx_hash, access_receipt_id: proof.access_receipt_id,
    session_pk: bound.session_pk, job_id: bound.job_id, expires_at_ms: bound.expires_at_ms,
    scope: 'verified FINAL grant receipt and current access view only; no token request, playback or delivery proven' };
}

/** Key-free, source-file-free recovery. Unknown or inconsistent hashes remain
 * unresolved; this function never retries, signs or broadcasts a transaction. */
export async function recoverYoutickPlayGrant({ journal, grantId, provider, clock = Date.now }) {
  if (typeof clock !== 'function') throw new Error('invalid local clock');
  return exclusive(journal, () => recoverUnlocked({ journal, grantId, provider, clock }));
}

/** Review or issue one owner-authorized grant for the original paid publication.
 * `execute` defaults to false. Rerunning an existing grant only reconciles its
 * original hash; it never signs or broadcasts a second transaction. */
export async function runYoutickPlayGrant({ journal, grantId, sessionId, goal: rawGoal, sourceFile, vaultCodeHash,
  provider, account, publicKey, execute = false, clock = Date.now }) {
  if (!identifier(grantId) || typeof execute !== 'boolean' || typeof clock !== 'function') throw new Error('invalid owner grant options');
  return exclusive(journal, async () => {
    const goal = validateFtCallGoal(rawGoal);
    requireMatchingScope(journal, goal);
    if (grantId === goal.id || grantId === sessionId) throw new Error('owner grant ID must be distinct from the payment and session IDs');
    const prior = journal.get(grantId);
    if (prior) {
      const recorded = recordedGrant(journal, grantId);
      if (recorded.binding.session_id !== sessionId || !isDeepStrictEqual(recorded.goal, goal) ||
          recorded.binding.vault_code_hash !== vaultCodeHash ||
          (publicKey !== undefined && String(publicKey) !== recorded.binding.owner_public_key)) {
        throw new Error('owner grant retry does not match its original reviewed binding');
      }
      return recoverUnlocked({ journal, grantId, provider, clock });
    }
    const { session, playback } = playbackFor(journal, sessionId, goal);
    ensureUnusedSession(journal, grantId, sessionId, playback);
    const block = await pinnedIdentity(provider, goal, vaultCodeHash);
    const { payment, result: paymentResult } = await paymentEvidence(provider, journal, goal);
    const jobId = session.input.job_id;
    const [state, policy, job, publication, entitlement, existing, emptyVerification] = await Promise.all([
      provider.callFunction(YOUTICK_ACCESS, 'get_contract_state', {}, block),
      provider.callFunction(YOUTICK_ACCESS, 'get_scope_policy', { scope: 'Play' }, block),
      provider.callFunction(YOUTICK_MARKET, 'get_media_job', { job_id: jobId }, block),
      provider.callFunction(YOUTICK_MARKET, 'get_publication', { publication_id: jobId }, block),
      provider.callFunction(YOUTICK_MARKET, 'has_entitlement', { account_id: goal.contract_id, publication_id: jobId }, block),
      provider.callFunction(YOUTICK_ACCESS, 'get_session_grant', { session_pk: playback.public_key }, block),
      provider.callFunction(YOUTICK_ACCESS, 'verify_session_grant', { session_pk: playback.public_key, scope: 'Play',
        resource_id: jobId, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: playback.device_hash }, block),
    ]);
    if (state?.market_contract_id !== YOUTICK_MARKET || state.paused !== false || state.grant_issuance_enabled !== true ||
        !Number.isSafeInteger(policy?.max_ttl_ms) || policy.max_ttl_ms < 600_000 ||
        policy.require_origin !== true || policy.require_device !== true) throw new Error('access state or Play policy is not ready for the reviewed grant');
    if (entitlement !== true) throw new Error('original vault entitlement is not established');
    if (existing !== null || emptyVerification?.valid !== false || emptyVerification?.owner_id !== null ||
        emptyVerification?.reason !== 'Session grant not found') {
      throw new Error('playback key is already granted, its status is unknown, or the Play scope is paused');
    }
    const prepared = prepareYoutickPlayGrant({ journal, sessionId, goal, paymentResult, job, publication, sourceFile, nowMs: time(clock) });
    verifyYoutickPlayGrantArgs({ vault: goal.contract_id, args: prepared.args });
    if (!execute) return { status: 'READY_FOR_OWNER_APPROVAL', grant_id: grantId, prepared,
      vault_code_hash: vaultCodeHash, access_code_hash: YOUTICK_ACCESS_CODE_HASH, market_code_hash: YOUTICK_V1_CODE_HASH,
      payment_tx_hash: payment.tx_hash, scope: 'read-only review; no grant, token, playback or delivery proven' };
    if (typeof provider.sendTransactionUntil !== 'function' || typeof provider.viewAccessKey !== 'function') throw new Error('single-send provider and owner access-key view are required');
    const key = nearApi.utils.PublicKey.fromString(String(publicKey));
    if (key.keyType !== 0 || (await provider.viewAccessKey(goal.owner_account_id, key, block))?.permission !== 'FullAccess') {
      throw new Error('owner approval requires the reviewed full-access owner key');
    }
    const signed = await signReviewedOneYoctoOwnerCall({ account, publicKey: key, ownerId: goal.owner_account_id,
      contractId: goal.contract_id, method: prepared.method, args: prepared.args, gas: GAS });
    const binding = { version: 1, grant_id: grantId, session_id: sessionId, goal, prepared, vault_code_hash: vaultCodeHash,
      market_code_hash: YOUTICK_V1_CODE_HASH, access_code_hash: YOUTICK_ACCESS_CODE_HASH,
      payment_tx_hash: payment.tx_hash, owner_public_key: String(key) };
    // Persist only the hash and review, not replayable signed bytes. An error
    // or crash after this point never permits an automatic replacement send.
    journal.put(grantId, { kind: KIND, status: 'pending', fingerprint: digest(binding), binding, tx_hash: signed.txHash });
    try { await provider.sendTransactionUntil(signed.signed, 'FINAL'); }
    catch { throw new Error(`owner grant ${grantId} has unresolved hash ${signed.txHash}; recover it without resending`); }
    try { return await recoverUnlocked({ journal, grantId, provider, clock }); }
    catch { throw new Error(`owner grant ${grantId} has hash ${signed.txHash} but FINAL proof or current views are unavailable; recover without resending`); }
  });
}
