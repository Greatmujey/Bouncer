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

/** Compute the full local SHA-256 and the provider's bounded head/tail
 * fingerprint. The latter is NOT a whole-file digest. Refuses symlinks and
 * detects common source changes while reading; a trusted filesystem is needed. */
export function inspectYoutickSource(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('source file is required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_SOURCE)) throw new Error('source must be a bounded regular file');
    const size = Number(before.size), window = Math.min(size, WINDOW), tailSize = size > window ? window : 0;
    function readAt(position, count) {
      const buffer = Buffer.alloc(count); let offset = 0;
      while (offset < count) { const n = fs.readSync(fd, buffer, offset, count - offset, position + offset); if (!n) throw new Error('source changed while reading'); offset += n; }
      return buffer;
    }
    const provider = crypto.createHash('sha256');
    provider.update(`youtick.livepeer-source-fingerprint.v1\n${size}\n${window}\n${tailSize}\n`);
    provider.update(readAt(0, window));
    if (tailSize) provider.update(readAt(size - window, tailSize));
    const full = crypto.createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
    for (let at = 0; at < size;) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at);
      if (!n) throw new Error('source changed while reading'); full.update(chunk.subarray(0, n)); at += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) throw new Error('source changed while reading');
    return { size: String(size), sha256: full.digest('hex'), provider_fingerprint: provider.digest('hex') };
  } finally { fs.closeSync(fd); }
}

const fields = ['vault', 'owner', 'job_id', 'title', 'price_usdc', 'source', 'source_type', 'upload_key_expires_at_ms'];
function validateInput(input, nowMs) {
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
      BigInt(input.upload_key_expires_at_ms) <= BigInt(nowMs) || BigInt(input.upload_key_expires_at_ms) > BigInt(nowMs) + 86_400_000n) {
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
    if (prior.status !== 'pending' || prior.fingerprint !== fingerprint || prior.session?.version !== 1 ||
        JSON.stringify(prior.session.input) !== JSON.stringify(input) || typeof prior.session.private_key !== 'string') {
      throw new Error('existing upload session differs; stop and reconcile');
    }
    let key;
    try { key = nearApi.KeyPair.fromString(prior.session.private_key); } catch { throw new Error('original upload session key is invalid'); }
    if (key.getPublicKey().toString() !== prior.session.public_key) throw new Error('original upload session key mismatch');
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
  if (!own(source, ['size', 'sha256', 'provider_fingerprint'])) throw new Error('invalid recorded source evidence');
  const current = inspectYoutickSource(file);
  if (current.size !== source.size || current.sha256 !== source.sha256 || current.provider_fingerprint !== source.provider_fingerprint) {
    throw new Error('source file differs from the original reviewed upload');
  }
  return current;
}

/** Construct a signed upload-control request in memory, but do not send it.
 * Requires the original completed payment journal, matching FINAL receipt
 * graph, matching market job and unchanged source. The first control attempt
 * is journaled before the signed envelope is returned; an ambiguous attempt
 * can only produce an explicit reconcile/resume request, never a new initial
 * request. Signed envelopes are short-lived bearer capabilities: do not log,
 * commit or share them. This is not an uploader or proof of delivery. */
export function prepareYoutickUploadControl({ journal, sessionId, goal: rawGoal, paymentResult, job, sourceFile, nowMs = Date.now(), recovery }) {
  if (recovery !== undefined && !['reconcile', 'resume'].includes(recovery)) throw new Error('invalid upload recovery mode');
  const session = journal?.get(sessionId), input = session?.session?.input;
  if (!input) throw new Error('original upload session is missing');
  const reserved = reserveYoutickUploadSession({ journal, id: sessionId, input, nowMs });
  const goal = validateFtCallGoal(rawGoal), payment = journal.get(goal.id);
  if (!payment || payment.status !== 'completed' || payment.fingerprint !== digest(JSON.stringify(goal)) ||
      !isDeepStrictEqual(payment.ft_call_goal, goal) || typeof payment.agent_public_key !== 'string') {
    throw new Error('original completed FT payment journal is required');
  }
  const settlement = verifyFtCallSettlement(goal, paymentResult, payment.agent_public_key);
  if (settlement.tx_hash !== payment.tx_hash || settlement.used !== goal.amount || settlement.unused !== '0' ||
      !isDeepStrictEqual(payment.settlement, settlement)) throw new Error('payment settlement is not the recorded fully-used original');
  const observed = matchYoutickJob(goal, job);
  if (observed.status !== 'MATCHING_AUTHORIZED_JOB') throw new Error('provider job is not awaiting upload');
  const message = JSON.parse(goal.msg), request = reserved.request;
  if (goal.contract_id !== request.creator_id || message.job_id !== request.job_id || message.title !== request.title ||
      message.price_usdc !== request.price_usdc || message.expected_source_bytes !== request.expected_source_bytes ||
      message.profile_id !== request.profile_id || message.profile_config_sha256 !== request.profile_config_sha256 ||
      message.upload_public_key !== request.upload_public_key || message.upload_key_expires_at_ms !== request.upload_key_expires_at_ms) {
    throw new Error('provider job is not bound to the original encrypted upload session');
  }
  verifyYoutickSource(input.source, sourceFile);
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
  const canonicalBody = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
  const expiry = Math.min(nowMs + 300_000, Number(input.upload_key_expires_at_ms));
  const envelope = { domain: 'youtick.paid-media-livepeer-v1.control', version: '3', method: 'POST', route: '/v1/upload-intents',
    network: 'testnet', contract_id: YOUTICK_MARKET, account_id: goal.contract_id, resource: `job:${request.job_id}:1`,
    session_public_key: request.upload_public_key, origin: 'https://public-testnet.youtick.net',
    device_nonce: crypto.randomBytes(32).toString('base64url'), expires_at_ms: String(expiry), body_sha256: digest(canonicalBody) };
  const canonicalMessage = Object.values(envelope).join('\n');
  const key = nearApi.KeyPair.fromString(previous.session.private_key);
  const signature = Buffer.from(key.sign(Buffer.from(canonicalMessage)).signature).toString('base64');
  const record = { state: 'pending', job_id: request.job_id, payment_tx_hash: settlement.tx_hash,
    original_nonce: priorControl?.original_nonce ?? envelope.device_nonce,
    original_body_sha256: priorControl?.original_body_sha256 ?? envelope.body_sha256,
    last_mode: recovery ?? 'initial', last_nonce: envelope.device_nonce, prepared_at: new Date(nowMs).toISOString() };
  journal.put(sessionId, { ...previous, control: record });
  return { body, envelope, signature, scope: 'prepared signed testnet control only; no HTTP request or upload sent; protect this bearer capability' };
}
