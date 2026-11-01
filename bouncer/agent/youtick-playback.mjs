/** Experimental, testnet-only YouTick legacy playback preparation.
 * No purchase, grant transaction or playback request is sent here. The caller
 * must obtain trusted FINAL observations and keep the original encrypted journal.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { reserveYoutickUploadSession, verifyYoutickPaidSession } from './youtick-session.mjs';
import { YOUTICK_MARKET, YOUTICK_ACCESS } from './youtick-capabilities.mjs';
import { makeYoutickPlayGrantArgs, YOUTICK_PLAY_ORIGIN, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS } from './youtick-play-proof.mjs';

export { YOUTICK_ACCESS, YOUTICK_PLAY_ORIGIN, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS };
export const YOUTICK_PLAY_GRANT_GAS = '100000000000000';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const publicKey = key => key.getPublicKey().toString();

function recordedPlayback(session) {
  const playback = session?.session?.playback;
  if (!playback || playback.version !== 1 || typeof playback.private_key !== 'string' ||
      typeof playback.public_key !== 'string' || !playback.public_key.startsWith('ed25519:') ||
      !isHash(playback.device_hash)) throw new Error('original encrypted playback session is missing or invalid');
  let key;
  try { key = nearApi.KeyPair.fromString(playback.private_key); } catch { throw new Error('original playback key is invalid'); }
  if (publicKey(key) !== playback.public_key || playback.public_key === session.session.public_key) {
    throw new Error('original playback key mismatch or reused upload key');
  }
  return { playback, key };
}

/** Reserve a distinct playback key BEFORE an order, in the same encrypted
 * journal as the source/upload key. Never return the secret. A missing/deleted
 * or rolled-back journal outside this process remains undetectable. */
export function reserveYoutickPlaybackSession({ journal, sessionId, nowMs = Date.now() }) {
  const prior = journal?.get(sessionId), input = prior?.session?.input;
  if (!input) throw new Error('original upload session is missing');
  reserveYoutickUploadSession({ journal, id: sessionId, input, nowMs });
  if (prior.session.playback) {
    const { playback } = recordedPlayback(prior);
    return { vault: input.vault, job_id: input.job_id, session_pk: playback.public_key, device_hash: playback.device_hash, reused: true };
  }
  // Do not silently invent a new playback key after a local order or upload
  // attempt has begun. This cannot detect payments in a different/rolled-back journal.
  if (prior.control || prior.upload || journal.list().some(entry => {
    const goal = entry.ft_call_goal;
    if (goal?.payee !== YOUTICK_MARKET || goal?.contract_id !== input.vault) return false;
    try { const msg = JSON.parse(goal.msg); return msg.action === 'create_paid_job' && msg.job_id === input.job_id; } catch { return false; }
  })) throw new Error('reserve playback before any original order or upload attempt');
  const key = nearApi.KeyPair.fromRandom('ed25519'), playback = { version: 1, public_key: publicKey(key),
    private_key: key.toString(), device_hash: sha256(crypto.randomBytes(32)) };
  journal.put(sessionId, { ...prior, session: { ...prior.session, playback } });
  return { vault: input.vault, job_id: input.job_id, session_pk: playback.public_key, device_hash: playback.device_hash, reused: false };
}

/** Match a trusted FINAL publication snapshot to the already verified paid job
 * and original source. This is not a proof of retrieval or of provider honesty. */
export function matchYoutickPublication(verified, job, publication) {
  const { goal, input, request } = verified;
  if (job?.status !== 'Published' || !publication || typeof publication !== 'object' || Array.isArray(publication) ||
      publication.publication_id !== request.job_id || publication.creator_id !== goal.contract_id ||
      publication.title !== request.title || publication.price_usdc !== request.price_usdc || publication.generation !== 1 ||
      publication.expected_source_bytes !== request.expected_source_bytes || publication.verified_source_bytes !== request.expected_source_bytes ||
      publication.profile_id !== request.profile_id || publication.profile_config_sha256 !== request.profile_config_sha256 ||
      !isHash(publication.asset_id_hash) || !isHash(publication.project_id_hash) ||
      typeof publication.playback_id !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(publication.playback_id) ||
      publication.availability !== 'ACTIVE' || publication.published_availability !== 'ACTIVE' ||
      publication.published_at_ms !== job.published_at_ms || !Number.isSafeInteger(publication.published_at_ms) || publication.published_at_ms <= 0 ||
      typeof publication.ready_at_ms !== 'string' || !/^[1-9][0-9]{0,15}$/.test(publication.ready_at_ms) ||
      (publication.provider_source_fingerprint !== null && publication.provider_source_fingerprint !== input.source.sha256)) {
    throw new Error('publication does not match the original paid job and source');
  }
  return { job_id: request.job_id, vault: goal.contract_id, generation: 1, playback_id: publication.playback_id,
    provider_source_sha256: publication.provider_source_fingerprint, published_at_ms: publication.published_at_ms,
    scope: 'trusted publication snapshot only; no content retrieval verified' };
}

/** Match the exact upstream access-contract proof bytes. The owner reviews the
 * resulting single V10 call and attaches exactly one yocto; this function does
 * not submit anything and does not prove deployed/source equivalence. */
export function prepareYoutickPlayGrant({ journal, sessionId, goal, paymentResult, job, publication, sourceFile, nowMs = Date.now() }) {
  const verified = verifyYoutickPaidSession({ journal, sessionId, goal, paymentResult, job, sourceFile,
    nowMs, allowPublished: true, allowExpired: true });
  const matched = matchYoutickPublication(verified, job, publication);
  const { playback, key } = recordedPlayback(journal.get(sessionId));
  const args = makeYoutickPlayGrantArgs({ vault: matched.vault, jobId: matched.job_id, deviceHash: playback.device_hash, key });
  return { owner_id: verified.goal.owner_account_id, vault: matched.vault, publication: matched,
    method: 'issue_youtick_play_grant', deposit: '1', gas: YOUTICK_PLAY_GRANT_GAS, args,
    warning: 'offline review only; no grant, playback token or retrieval is verified' };
}

/** Verify the immutable fields of a trusted grant, even after expiry. This
 * checks binding only; it must not be used to claim that playback is active. */
export function verifyYoutickPlayGrantBinding(prepared, grant) {
  if (!prepared?.args || !grant || typeof grant !== 'object' || Array.isArray(grant) ||
      grant.owner_id !== prepared.vault || grant.session_pk !== prepared.args.session_pk || grant.scope !== 'Play' ||
      grant.resource_id !== prepared.args.job_id || grant.origin_hash !== YOUTICK_PLAY_ORIGIN_HASH ||
      grant.device_hash !== prepared.args.device_hash || grant.revoked !== false ||
      !Number.isSafeInteger(grant.expires_at_ms) || grant.expires_at_ms <= 0) {
    throw new Error('access grant binding is missing, revoked or mismatched');
  }
  return { owner_id: prepared.vault, session_pk: grant.session_pk, job_id: grant.resource_id, expires_at_ms: grant.expires_at_ms };
}

/** Validate a trusted current FINAL grant and the access contract verification
 * view before preparing a token. Both snapshots must come from the pinned access
 * contract; the RPC and deployed contract remain trusted. */
export function verifyYoutickPlayGrantView(prepared, grant, verification, nowMs = Date.now()) {
  try { verifyYoutickPlayGrantBinding(prepared, grant); }
  catch { throw new Error('live access grant is missing, expired, revoked or mismatched'); }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || grant.expires_at_ms <= nowMs || grant.expires_at_ms > nowMs + YOUTICK_PLAY_TTL_MS + 5_000 ||
      verification?.valid !== true || verification?.owner_id !== prepared.vault || verification?.reason !== null) {
    throw new Error('live access grant is missing, expired, revoked or mismatched');
  }
  return { owner_id: prepared.vault, session_pk: grant.session_pk, job_id: grant.resource_id, expires_at_ms: grant.expires_at_ms };
}

function decodeJson(value) {
  if (typeof value !== 'string' || value.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid grant receipt encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('invalid grant receipt encoding');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid grant receipt JSON'); }
}

/** Bind the original owner-signed transaction to the linked successful access
 * receipt and the currently observed grant. A trusted FINAL RPC is assumed;
 * neither the source version nor an outer success alone proves that receipt. */
export function verifyYoutickPlayGrantTransaction({ prepared, result, txHash, ownerPublicKey, grant }) {
  const tx = result?.transaction;
  if (!prepared?.args || !isTransactionHash(txHash) || typeof ownerPublicKey !== 'string' ||
      result?.final_execution_status !== 'FINAL' || result?.transaction_outcome?.id !== txHash ||
      result.status?.Failure !== undefined || result.status?.SuccessReceiptId !== undefined || typeof result.status?.SuccessValue !== 'string' ||
      !tx || tx.hash !== txHash || tx.signer_id !== prepared.owner_id || tx.public_key !== ownerPublicKey ||
      tx.receiver_id !== prepared.vault || !Array.isArray(tx.actions) || tx.actions.length !== 1 ||
      !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) {
    throw new Error('grant transaction is not the original successful FINAL owner call');
  }
  const call = tx.actions[0]?.FunctionCall;
  if (call?.method_name !== prepared.method || String(call.deposit) !== prepared.deposit || String(call.gas) !== prepared.gas ||
      !isDeepStrictEqual(decodeJson(call.args), prepared.args)) throw new Error('grant transaction action differs from owner review');
  const receiptIds = result.receipts.map(r => r?.receipt_id), outcomeIds = result.receipts_outcome.map(r => r?.id);
  if (receiptIds.some(x => typeof x !== 'string' || !x) || new Set(receiptIds).size !== receiptIds.length ||
      outcomeIds.some(x => typeof x !== 'string' || !x) || new Set(outcomeIds).size !== outcomeIds.length) {
    throw new Error('missing or duplicate grant receipt IDs');
  }
  const requests = result.receipts.filter(r => r.predecessor_id === prepared.vault && r.receiver_id === YOUTICK_ACCESS &&
    Array.isArray(r.receipt?.Action?.actions) && r.receipt.Action.actions.length === 1 &&
    r.receipt.Action.actions[0]?.FunctionCall?.method_name === 'issue_session_grant');
  if (requests.length !== 1) throw new Error('missing unique pinned access-contract grant receipt');
  const request = requests[0], accessCall = request.receipt.Action.actions[0].FunctionCall;
  const expected = { target_owner_id: prepared.vault, session_pk: prepared.args.session_pk, scope: 'Play',
    resource_id: prepared.args.job_id, ttl_ms: YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH,
    device_hash: prepared.args.device_hash, session_pok: prepared.args.session_pok };
  // near-sdk's default gas weight may allocate unused parent gas on top of the
  // 70 Tgas static minimum, so the finalized receipt need not show exactly 70.
  const accessGas = String(accessCall.gas);
  if (String(accessCall.deposit) !== '0' || !/^[0-9]{1,15}$/.test(accessGas) ||
      BigInt(accessGas) < 70_000_000_000_000n || BigInt(accessGas) > BigInt(prepared.gas) ||
      !isDeepStrictEqual(decodeJson(accessCall.args), { request: expected })) {
    throw new Error('access grant receipt differs from the pinned scoped request');
  }
  const initiation = result.receipts_outcome.filter(r => r.outcome?.executor_id === prepared.vault &&
    result.transaction_outcome?.outcome?.receipt_ids?.includes(r.id) &&
    r.outcome?.status?.SuccessReceiptId === request.receipt_id && r.outcome?.receipt_ids?.includes(request.receipt_id));
  const accessOutcome = result.receipts_outcome.filter(r => r.id === request.receipt_id && r.outcome?.executor_id === YOUTICK_ACCESS &&
    r.outcome?.status?.Failure === undefined && r.outcome?.status?.SuccessReceiptId === undefined && typeof r.outcome?.status?.SuccessValue === 'string');
  if (initiation.length !== 1 || accessOutcome.length !== 1 ||
      result.transaction_outcome?.outcome?.status?.SuccessReceiptId !== initiation[0].id ||
      result.transaction_outcome?.outcome?.status?.Failure !== undefined ||
      result.transaction_outcome?.outcome?.status?.SuccessValue !== undefined ||
      accessOutcome[0].outcome.status.SuccessValue !== result.status.SuccessValue ||
      !isDeepStrictEqual(decodeJson(result.status.SuccessValue), grant)) {
    throw new Error('grant receipt graph is missing, failed, unlinked or differs from the current grant');
  }
  return { tx_hash: txHash, access_receipt_id: request.receipt_id, owner: prepared.owner_id, vault: prepared.vault };
}

/** Build a legacy token request in memory only after verifying the recorded
 * owner grant transaction and both current FINAL access views. The returned
 * signature/token request is sensitive and must not be logged. */
export function prepareYoutickPlaybackTokenRequest({ journal, sessionId, goal, paymentResult, job, publication, sourceFile,
  grant, verification, grantResult, grantTxHash, ownerPublicKey, expectedPrepared, nowMs = Date.now() }) {
  const prepared = prepareYoutickPlayGrant({ journal, sessionId, goal, paymentResult, job, publication, sourceFile, nowMs });
  if (expectedPrepared !== undefined && !isDeepStrictEqual(prepared, expectedPrepared)) {
    throw new Error('current publication differs from the original owner grant review');
  }
  verifyYoutickPlayGrantView(prepared, grant, verification, nowMs);
  verifyYoutickPlayGrantTransaction({ prepared, result: grantResult, txHash: grantTxHash, ownerPublicKey, grant });
  const { playback, key } = recordedPlayback(journal.get(sessionId)), playbackId = prepared.publication.playback_id;
  const body = { job_id: prepared.args.job_id, generation: 1, playback_id: playbackId,
    grant_id: `play:${prepared.args.job_id}:${prepared.vault}`, origin_hash: YOUTICK_PLAY_ORIGIN_HASH,
    device_hash: playback.device_hash, requested_ttl_seconds: 180 };
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(name => [name, body[name]])));
  const envelope = { domain: 'youtick.paid-media-livepeer-v1.control', version: '2', method: 'POST', route: '/v1/playback-tokens',
    network: 'testnet', contract_id: YOUTICK_MARKET, account_id: prepared.vault,
    resource: `playback:${prepared.args.job_id}:1:${playbackId}`, session_public_key: playback.public_key,
    origin: YOUTICK_PLAY_ORIGIN, device_nonce: crypto.randomBytes(32).toString('base64url'),
    expires_at_ms: String(Math.min(nowMs + 300_000, grant.expires_at_ms)), body_sha256: sha256(canonical) };
  const signature = Buffer.from(key.sign(Buffer.from(Object.values(envelope).join('\n'))).signature).toString('base64');
  return { body, envelope, signature };
}
