/** Durable, encrypted preparation for a future YouTick upload. No provider
 * requests, NEAR signatures, payments, uploads or automatic retries occur here.
 * The filesystem and process are trusted; encryption does not detect rollback. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from './procurement.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { YOUTICK_ADAPTIVE_PROFILE } from './youtick-quote.mjs';
import { YOUTICK_MARKET } from './youtick-capabilities.mjs';
import { matchYoutickJob } from './youtick-ft-plan.mjs';
import { validateFtCallGoal, verifyFtCallSettlement } from './ft-call.mjs';
import { isDeepStrictEqual } from 'node:util';

const MAX_SOURCE = 5_000_000_000, WINDOW = 1024 * 1024;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function openSource(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('source file is required');
  return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
}
function sourceStat(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(MAX_SOURCE)) throw new Error('source must be a bounded regular file');
  return stat;
}
function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n;
}
function readAt(fd, position, count) {
  const buffer = Buffer.alloc(count); let offset = 0;
  while (offset < count) {
    const n = fs.readSync(fd, buffer, offset, count - offset, position + offset);
    if (!n) throw new Error('source changed while reading');
    offset += n;
  }
  return buffer;
}
function inspectSourceFd(fd) {
  const before = sourceStat(fd), size = Number(before.size), window = Math.min(size, WINDOW), tailSize = size > window ? window : 0;
  const provider = crypto.createHash('sha256');
  provider.update(`youtick.livepeer-source-fingerprint.v1\n${size}\n${window}\n${tailSize}\n`);
  provider.update(readAt(fd, 0, window));
  if (tailSize) provider.update(readAt(fd, size - window, tailSize));
  const full = crypto.createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  for (let at = 0; at < size;) {
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at);
    if (!n) throw new Error('source changed while reading'); full.update(chunk.subarray(0, n)); at += n;
  }
  const after = sourceStat(fd);
  if (!sameStat(before, after)) throw new Error('source changed while reading');
  return { evidence: { size: String(size), sha256: full.digest('hex'), provider_fingerprint: provider.digest('hex') }, stat: after };
}
function matchingSource(source, evidence) {
  if (!own(source, ['size', 'sha256', 'provider_fingerprint'])) throw new Error('invalid recorded source evidence');
  if (source.size !== evidence.size || source.sha256 !== evidence.sha256 || source.provider_fingerprint !== evidence.provider_fingerprint) {
    throw new Error('source file differs from the original reviewed upload');
  }
}

/** Compute the full local SHA-256 and the provider's bounded head/tail
 * fingerprint. The latter is NOT a whole-file digest. Refuses symlinks and
 * detects common source changes while reading; a trusted filesystem is needed. */
export function inspectYoutickSource(file) {
  const fd = openSource(file);
  try { return inspectSourceFd(fd).evidence; }
  finally { fs.closeSync(fd); }
}

/** Hold the verified file descriptor while reading bounded upload chunks.
 * Detects ordinary local modifications/replacements; a malicious filesystem
 * can still race metadata or lie about file contents, so it must be trusted. */
export function openVerifiedYoutickSource(source, file) {
  const fd = openSource(file); let closed = false;
  try {
    const { evidence, stat } = inspectSourceFd(fd); matchingSource(source, evidence);
    return Object.freeze({
      size: Number(evidence.size),
      read(offset, count) {
        if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 ||
            count < 1 || count > 32 * 1024 * 1024 || offset + count > Number(evidence.size)) throw new Error('invalid source chunk');
        if (!sameStat(stat, sourceStat(fd))) throw new Error('source changed during upload');
        const bytes = readAt(fd, offset, count);
        if (!sameStat(stat, sourceStat(fd))) throw new Error('source changed during upload');
        return bytes;
      },
      close() { if (!closed) { closed = true; fs.closeSync(fd); } },
    });
  } catch (error) { fs.closeSync(fd); throw error; }
}

const fields = ['vault', 'owner', 'job_id', 'title', 'price_usdc', 'source', 'source_type', 'upload_key_expires_at_ms'];
function validateInput(input, nowMs, { allowExpired = false } = {}) {
  if (!own(input, fields) || !isTestnetAccount(input.vault) || !isTestnetAccount(input.owner) || input.vault === input.owner ||
      typeof input.job_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.job_id) ||
      typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 200 ||
      typeof input.price_usdc !== 'string' || !/^[1-9][0-9]{0,19}$/.test(input.price_usdc) || BigInt(input.price_usdc) < 2_000_000n ||
      !own(input.source, ['size', 'sha256', 'provider_fingerprint']) ||
      typeof input.source.size !== 'string' || !/^[1-9][0-9]{0,9}$/.test(input.source.size) || BigInt(input.source.size) > BigInt(MAX_SOURCE) ||
      !hex(input.source.sha256) || !hex(input.source.provider_fingerprint) ||
      !['mp4', 'mov', 'avi', 'webm', 'wmv', 'mkv', 'flv'].includes(input.source_type) ||
      !Number.isSafeInteger(nowMs) || nowMs <= 0 || typeof input.upload_key_expires_at_ms !== 'string' ||
      !/^[1-9][0-9]{12,15}$/.test(input.upload_key_expires_at_ms) ||
      (!allowExpired && BigInt(input.upload_key_expires_at_ms) <= BigInt(nowMs)) ||
      BigInt(input.upload_key_expires_at_ms) > BigInt(nowMs) + 86_400_000n) {
    throw new Error('invalid or expired testnet upload session');
  }
  return { vault: input.vault, owner: input.owner, job_id: input.job_id, title: input.title,
    price_usdc: input.price_usdc, source: { size: input.source.size, sha256: input.source.sha256, provider_fingerprint: input.source.provider_fingerprint },
    source_type: input.source_type, upload_key_expires_at_ms: input.upload_key_expires_at_ms };
}
function requireEncryptedJournal(journal, input) {
  if (!(journal instanceof FileJournal) || journal.encryptionEnabled !== true || journal.data?.contract_id !== input.vault || journal.data?.owner_account_id !== input.owner) {
    throw new Error('the original owner/vault-scoped encrypted file journal is required');
  }
  journal.assertAvailable();
}

function validateRecordedSession(prior, input) {
  if (prior.status !== 'pending' || prior.fingerprint !== digest(JSON.stringify(input)) || prior.session?.version !== 1 ||
      JSON.stringify(prior.session.input) !== JSON.stringify(input) || typeof prior.session.private_key !== 'string') {
    throw new Error('existing upload session differs; stop and reconcile');
  }
  let key;
  try { key = nearApi.KeyPair.fromString(prior.session.private_key); } catch { throw new Error('original upload session key is invalid'); }
  if (key.getPublicKey().toString() !== prior.session.public_key) throw new Error('original upload session key mismatch');
}

/** Reserve the upload key in the encrypted original journal BEFORE a quote or
 * payment. Reopening with identical inputs reuses that exact key; changed input
 * or missing key fails closed. This does not detect a deleted/rolled-back journal
 * before a caller chooses to create a new one. Never log or export the key. */
export function reserveYoutickUploadSession({ journal, id, input: rawInput, nowMs = Date.now() }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid session journal id');
  const input = validateInput(rawInput, nowMs); requireEncryptedJournal(journal, input);
  const fingerprint = digest(JSON.stringify(input)), prior = journal.get(id);
  if (journal.list().some(entry => entry.id !== id && entry.session?.version === 1 && entry.session?.input?.job_id === input.job_id)) {
    throw new Error('this job already has an original upload session; reuse its journal id');
  }
  if (prior) {
    validateRecordedSession(prior, input);
    return publicSession(input, id, prior.session.public_key, true);
  }
  const key = nearApi.KeyPair.fromRandom('ed25519'), publicKey = key.getPublicKey().toString();
  journal.put(id, { status: 'pending', fingerprint, session: { version: 1, input, public_key: publicKey, private_key: key.toString() } });
  return publicSession(input, id, publicKey, false);
}
function publicSession(input, id, publicKey, reused) {
  return { id, reused, request: { creator_id: input.vault, job_id: input.job_id, title: input.title,
    price_usdc: input.price_usdc, expected_source_bytes: input.source.size, profile_id: 'paid-media-livepeer-v1',
    profile_config_sha256: YOUTICK_ADAPTIVE_PROFILE, upload_public_key: publicKey,
    upload_key_expires_at_ms: input.upload_key_expires_at_ms },
    source_sha256: input.source.sha256, source_fingerprint: input.source.provider_fingerprint,
    scope: 'encrypted session preparation only; no quote, payment or upload' };
}

/** Recheck both local content digest and provider's partial fingerprint before
 * any future upload/resume. The caller must keep the same file stable afterward. */
export function verifyYoutickSource(source, file) {
  const current = inspectYoutickSource(file); matchingSource(source, current); return current;
}

/** Recheck the original completed payment journal, its FINAL receipt graph,
 * the matching market job and unchanged source. Returns no secret; the caller
 * must independently obtain trusted FINAL RPC observations. Historical
 * publication checks can explicitly allow an expired upload key. */
export function verifyYoutickPaidSession({ journal, sessionId, goal: rawGoal, paymentResult, job, sourceFile, nowMs = Date.now(),
  allowPublished = false, allowExpired = false }) {
  const session = journal?.get(sessionId), rawInput = session?.session?.input;
  if (!rawInput) throw new Error('original upload session is missing');
  if (typeof allowPublished !== 'boolean' || typeof allowExpired !== 'boolean') throw new Error('invalid paid-session verification mode');
  const input = validateInput(rawInput, nowMs, { allowExpired }); requireEncryptedJournal(journal, input);
  validateRecordedSession(session, input);
  if (journal.list().some(entry => entry.id !== sessionId && entry.session?.version === 1 && entry.session?.input?.job_id === input.job_id)) {
    throw new Error('this job already has an original upload session; stop and reconcile');
  }
  const reserved = publicSession(input, sessionId, session.session.public_key, true);
  const goal = validateFtCallGoal(rawGoal), payment = journal.get(goal.id);
  if (!payment || payment.status !== 'completed' || payment.fingerprint !== digest(JSON.stringify(goal)) ||
      !isDeepStrictEqual(payment.ft_call_goal, goal) || typeof payment.agent_public_key !== 'string') {
    throw new Error('original completed FT payment journal is required');
  }
  const settlement = verifyFtCallSettlement(goal, paymentResult, payment.agent_public_key);
  if (settlement.tx_hash !== payment.tx_hash || settlement.used !== goal.amount || settlement.unused !== '0' ||
      !isDeepStrictEqual(payment.settlement, settlement)) throw new Error('payment settlement is not the recorded fully-used original');
  const observed = matchYoutickJob(goal, job);
  if (observed.status !== 'MATCHING_AUTHORIZED_JOB' && !(allowPublished && observed.status === 'MATCHING_PUBLISHED_JOB')) {
    throw new Error('provider job is not awaiting upload or explicitly verified publication');
  }
  const message = JSON.parse(goal.msg), request = reserved.request;
  if (goal.contract_id !== request.creator_id || message.job_id !== request.job_id || message.title !== request.title ||
      message.price_usdc !== request.price_usdc || message.expected_source_bytes !== request.expected_source_bytes ||
      message.profile_id !== request.profile_id || message.profile_config_sha256 !== request.profile_config_sha256 ||
      message.upload_public_key !== request.upload_public_key || message.upload_key_expires_at_ms !== request.upload_key_expires_at_ms) {
    throw new Error('provider job is not bound to the original encrypted upload session');
  }
  verifyYoutickSource(input.source, sourceFile);
  return { goal, input, request, settlement };
}

function signYoutickControl({ previous, request, input, accountId, body, route, version, nowMs }) {
  // Provider canonical JSON sorts keys by code point; these bodies are flat.
  const canonicalBody = JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(key => [key, body[key]])));
  const expiry = Math.min(nowMs + 300_000, Number(input.upload_key_expires_at_ms));
  const envelope = { domain: 'youtick.paid-media-livepeer-v1.control', version, method: 'POST', route,
    network: 'testnet', contract_id: YOUTICK_MARKET, account_id: accountId, resource: `job:${request.job_id}:1`,
    session_public_key: request.upload_public_key, origin: 'https://public-testnet.youtick.net',
    device_nonce: crypto.randomBytes(32).toString('base64url'), expires_at_ms: String(expiry), body_sha256: digest(canonicalBody) };
  const key = nearApi.KeyPair.fromString(previous.session.private_key);
  const signature = Buffer.from(key.sign(Buffer.from(Object.values(envelope).join('\n'))).signature).toString('base64');
  return { envelope, signature };
}

/** Construct a signed upload-control request in memory, but do not send it.
 * The first attempt is journaled before returning a short-lived bearer
 * capability. An ambiguous initial request requires explicit reconciliation;
 * never log, commit or share the signed envelope. */
export function prepareYoutickUploadControl({ journal, sessionId, goal, paymentResult, job, sourceFile, nowMs = Date.now(), recovery }) {
  if (recovery !== undefined && !['reconcile', 'resume'].includes(recovery)) throw new Error('invalid upload recovery mode');
  const verified = verifyYoutickPaidSession({ journal, sessionId, goal, paymentResult, job, sourceFile, nowMs });
  const { input, request, settlement } = verified;
  const previous = journal.get(sessionId), priorControl = previous.control;
  if (priorControl && (priorControl.state !== 'pending' || priorControl.job_id !== request.job_id ||
      priorControl.payment_tx_hash !== settlement.tx_hash || typeof priorControl.original_nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(priorControl.original_nonce) || !hex(priorControl.original_body_sha256))) {
    throw new Error('recorded upload attempt differs; stop and reconcile');
  }
  if ((recovery === undefined && priorControl) || (recovery !== undefined && !priorControl)) {
    throw new Error('original upload attempt is missing or already pending; do not retry an initial request');
  }
  const body = { job_id: request.job_id, generation: 1, expected_source_bytes: request.expected_source_bytes,
    source_fingerprint_sha256: input.source.provider_fingerprint, source_type: input.source_type,
    profile_id: request.profile_id, profile_config_sha256: request.profile_config_sha256,
    ...(recovery === undefined ? {} : { recovery }) };
  const { envelope, signature } = signYoutickControl({ previous, request, input, accountId: verified.goal.contract_id,
    body, route: '/v1/upload-intents', version: '3', nowMs });
  const record = { state: 'pending', job_id: request.job_id, payment_tx_hash: settlement.tx_hash,
    original_nonce: priorControl?.original_nonce ?? envelope.device_nonce,
    original_body_sha256: priorControl?.original_body_sha256 ?? envelope.body_sha256,
    ...(priorControl?.last_observed_state ? { last_observed_state: priorControl.last_observed_state } : {}),
    last_mode: recovery ?? 'initial', last_nonce: envelope.device_nonce, prepared_at: new Date(nowMs).toISOString() };
  journal.put(sessionId, { ...previous, control: record });
  return { body, envelope, signature, scope: 'prepared signed testnet control only; no HTTP request or upload sent; protect this bearer capability' };
}

/** Prepare one lease heartbeat for the exact previously recorded upload. It
 * performs no HTTP request; an ambiguous response must be reconciled and is
 * never grounds to repeat a payment or create a second upload. */
export function prepareYoutickHeartbeatControl({ journal, sessionId, goal, paymentResult, job, sourceFile, nowMs = Date.now() }) {
  const verified = verifyYoutickPaidSession({ journal, sessionId, goal, paymentResult, job, sourceFile, nowMs });
  const { input, request, settlement } = verified, previous = journal.get(sessionId), upload = previous.upload;
  if (previous.control?.job_id !== request.job_id || previous.control?.payment_tx_hash !== settlement.tx_hash ||
      upload?.version !== 1 || typeof upload.lease_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(upload.lease_id) ||
      typeof upload.lease_expires_at_ms !== 'string' || !/^[1-9][0-9]{12,15}$/.test(upload.lease_expires_at_ms) ||
      BigInt(upload.lease_expires_at_ms) <= BigInt(nowMs)) {
    throw new Error('original active upload lease is unavailable; stop and reconcile');
  }
  const body = { job_id: request.job_id, generation: 1, lease_id: upload.lease_id };
  const { envelope, signature } = signYoutickControl({ previous, request, input, accountId: verified.goal.contract_id,
    body, route: '/v1/upload-heartbeats', version: '2', nowMs });
  journal.put(sessionId, { ...previous, heartbeat: { state: 'pending', nonce: envelope.device_nonce,
    lease_id: upload.lease_id, prepared_at: new Date(nowMs).toISOString() } });
  return { body, envelope, signature, scope: 'prepared heartbeat only; no HTTP request sent; protect this bearer capability' };
}
