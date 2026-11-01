/**
 * Experimental testnet YouTick/Livepeer upload transport. It never creates a
 * NEAR transaction or pays for a job. The caller supplies the original FINAL
 * payment receipts and a trusted FINAL market view. The bridge, pinned TUS
 * origin, RPC, local filesystem and process are trust assumptions; successful
 * TUS receipt is not proof of publication, retrieval or provider honesty.
 *
 * Signed control requests and TUS URLs are bearer capabilities. They are never
 * returned or logged here. The original FileJournal must be encrypted, backed
 * up and reopened with requireExisting. Deletion/rollback remain undetectable.
 */
import crypto from 'node:crypto';
import { openVerifiedYoutickSource, prepareYoutickUploadControl, prepareYoutickHeartbeatControl,
  verifyYoutickPaidSession } from './youtick-session.mjs';

const BRIDGE = 'https://bridge-public-testnet.youtick.net';
const ORIGIN = 'https://public-testnet.youtick.net';
const TUS_ORIGIN = 'https://origin.livepeer.com';
const CHUNK = 32 * 1024 * 1024, HEARTBEAT = 300_000, MAX_RESPONSE = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set(['UPLOAD_READY', 'UPLOADING', 'PROCESSING', 'READY_VERIFIED', 'FINALIZE_QUEUED',
  'FINALIZE_RETRY', 'ONCHAIN_PUBLISHED', 'PROVIDER_FAILED', 'UPLOAD_EXPIRED']);
const UPLOADABLE_STATES = new Set(['UPLOAD_READY', 'UPLOADING']);
const inFlight = new WeakSet();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));

function timestamp(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid upload clock');
  return now;
}
function offset(value, size) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,9})$/.test(value) || BigInt(value) > BigInt(size)) {
    throw new Error('invalid TUS offset; stop and reconcile');
  }
  return Number(value);
}
function expiry(value, now) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{12,15}$/.test(value) ||
      BigInt(value) <= BigInt(now) || BigInt(value) > BigInt(now) + 3_600_000n) {
    throw new Error('invalid or expired upload lease; stop and reconcile');
  }
  return value;
}
function tusUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('invalid TUS capability');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid TUS capability'); }
  if (url.origin !== TUS_ORIGIN || url.username || url.password || url.hash || url.pathname === '/') {
    throw new Error('TUS capability is not on the pinned Livepeer origin');
  }
  return value;
}
async function locked(journal, work) {
  if (!journal || typeof journal !== 'object' || inFlight.has(journal)) throw new Error('upload operation already in progress or journal missing');
  inFlight.add(journal);
  try { return await work(); } finally { inFlight.delete(journal); }
}
function transport(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch transport is unavailable');
  return fetchImpl;
}
async function send(fetchImpl, url, options, timeoutMs) {
  try {
    return await transport(fetchImpl)(url, { ...options, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Never include an underlying error, request URL, header or response body:
    // the URL and signatures can grant control of the upload.
    throw new Error('provider request unresolved; reconcile the original upload before continuing');
  }
}
async function readJsonBounded(response) {
  if (!response || typeof response.status !== 'number' || !response.body?.getReader) throw new Error('invalid provider response');
  if (response.status < 200 || response.status >= 300) {
    await response.body.cancel().catch(() => {});
    throw new Error(`provider request unresolved (HTTP ${response.status}); reconcile the original upload`);
  }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('provider response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid provider response'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid provider response');
    return parsed;
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('provider response invalid or unresolved; reconcile the original upload');
  } finally { reader.releaseLock(); }
}
function validateIntent(value, context, now, recovery) {
  const fields = ['schema', 'job_id', 'generation', 'expected_source_bytes', 'source_type', 'chunk_bytes', 'tus_endpoint',
    'lease_id', 'lease_expires_at_ms', 'heartbeat_interval_ms', 'created'];
  if (!own(value, fields) || value.schema !== 'youtick.livepeer-upload-intent.v2' || value.job_id !== context.request.job_id ||
      value.generation !== 1 || value.expected_source_bytes !== context.input.source.size || value.source_type !== context.input.source_type ||
      value.chunk_bytes !== CHUNK || value.heartbeat_interval_ms !== HEARTBEAT || typeof value.created !== 'boolean' ||
      (recovery === undefined ? value.created !== true : value.created !== false) || typeof value.lease_id !== 'string' || !UUID.test(value.lease_id)) {
    throw new Error('provider upload intent does not match the original job; stop and reconcile');
  }
  tusUrl(value.tus_endpoint); expiry(value.lease_expires_at_ms, now);
  return value;
}
function validateStoredUpload(value, context) {
  const fields = ['version', 'job_id', 'payment_tx_hash', 'expected_source_bytes', 'source_fingerprint_sha256', 'source_sha256',
    'source_type', 'tus_endpoint', 'lease_id', 'lease_expires_at_ms', 'heartbeat_interval_ms', 'last_heartbeat_ms',
    'acknowledged_offset', 'pending_patch', 'state'];
  if (!own(value, fields) || value.version !== 1 || value.job_id !== context.request.job_id ||
      value.payment_tx_hash !== context.settlement.tx_hash || value.expected_source_bytes !== context.input.source.size ||
      value.source_fingerprint_sha256 !== context.input.source.provider_fingerprint || value.source_sha256 !== context.input.source.sha256 ||
      value.source_type !== context.input.source_type || typeof value.lease_id !== 'string' || !UUID.test(value.lease_id) ||
      typeof value.lease_expires_at_ms !== 'string' || !/^[1-9][0-9]{12,15}$/.test(value.lease_expires_at_ms) ||
      value.heartbeat_interval_ms !== HEARTBEAT || !Number.isSafeInteger(value.last_heartbeat_ms) || value.last_heartbeat_ms <= 0 ||
      !['ready', 'source_uploaded'].includes(value.state)) throw new Error('stored upload differs from original job; stop and reconcile');
  tusUrl(value.tus_endpoint);
  const size = Number(value.expected_source_bytes), acknowledged = offset(value.acknowledged_offset, size);
  if (value.pending_patch !== null) {
    const p = value.pending_patch;
    if (!own(p, ['start', 'end', 'sha256']) || typeof p.sha256 !== 'string' || !SHA.test(p.sha256)) {
      throw new Error('invalid pending upload chunk; stop and reconcile');
    }
    const start = offset(p.start, size), end = offset(p.end, size);
    if (start !== acknowledged || end <= start || end - start > CHUNK) throw new Error('invalid pending upload chunk; stop and reconcile');
  }
  if (value.state === 'source_uploaded' && (acknowledged !== size || value.pending_patch !== null)) {
    throw new Error('invalid completed upload state; stop and reconcile');
  }
  return value;
}
function contextFor(options, now) {
  return verifyYoutickPaidSession({ journal: options.journal, sessionId: options.sessionId, goal: options.goal,
    paymentResult: options.paymentResult, job: options.job, sourceFile: options.sourceFile, nowMs: now });
}
function recordUpload(options, upload, observedState) {
  const entry = options.journal.get(options.sessionId);
  options.journal.put(options.sessionId, { ...entry, upload,
    ...(observedState ? { control: { ...entry.control, last_observed_state: observedState } } : {}) });
}
function requireUploadableState(entry) {
  if (entry?.control?.last_observed_state !== undefined && !UPLOADABLE_STATES.has(entry.control.last_observed_state)) {
    throw new Error('provider reported processing or a terminal state; do not send more source bytes');
  }
}

/** Send exactly one signed control POST. Initial creation can be attempted only
 * once; after an ambiguous response callers must explicitly reconcile/resume.
 * All capabilities from a valid response are persisted only in the encrypted
 * original journal before a non-secret summary is returned. No payment occurs. */
export async function requestYoutickUploadIntent(options) {
  const { journal, sessionId, recovery, fetchImpl = globalThis.fetch, clock = Date.now } = options;
  return locked(journal, async () => {
    const now = timestamp(clock), context = contextFor(options, now);
    if (recovery === 'resume') requireUploadableState(journal.get(sessionId));
    const signed = prepareYoutickUploadControl({ journal, sessionId, goal: options.goal, paymentResult: options.paymentResult,
      job: options.job, sourceFile: options.sourceFile, nowMs: now, recovery });
    if (BigInt(signed.envelope.expires_at_ms) <= BigInt(timestamp(clock))) {
      throw new Error('prepared control expired before sending; reconcile the original attempt');
    }
    const response = await send(fetchImpl, `${BRIDGE}/v1/upload-intents`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: ORIGIN, 'X-Youtick-Signature': signed.signature },
      body: JSON.stringify({ body: signed.body, envelope: signed.envelope }) }, 20_000);
    const value = await readJsonBounded(response), checkedAt = timestamp(clock);
    if (recovery === 'reconcile' || (recovery === 'resume' && value.schema !== 'youtick.livepeer-upload-intent.v2')) {
      if (!own(value, ['job_id', 'generation', 'state']) || value.job_id !== context.request.job_id || value.generation !== 1 || !STATES.has(value.state)) {
        throw new Error('provider upload status does not match the original job; stop and reconcile');
      }
      const previous = journal.get(sessionId);
      journal.put(sessionId, { ...previous, control: { ...previous.control, last_observed_state: value.state } });
      return { status: 'PROVIDER_STATUS', job_id: value.job_id, state: value.state,
        scope: 'trusted provider status only; not proof of publication or delivery' };
    }
    validateIntent(value, context, checkedAt, recovery);
    const previous = journal.get(sessionId), old = previous.upload;
    if (old) {
      validateStoredUpload(old, context);
      if (recovery !== 'resume' || old.tus_endpoint !== value.tus_endpoint) {
        throw new Error('provider returned a different original upload capability; stop and reconcile');
      }
    }
    const upload = old ? { ...old, lease_id: value.lease_id, lease_expires_at_ms: value.lease_expires_at_ms, last_heartbeat_ms: checkedAt } : {
      version: 1, job_id: context.request.job_id, payment_tx_hash: context.settlement.tx_hash,
      expected_source_bytes: context.input.source.size, source_fingerprint_sha256: context.input.source.provider_fingerprint,
      source_sha256: context.input.source.sha256, source_type: context.input.source_type, tus_endpoint: value.tus_endpoint,
      lease_id: value.lease_id, lease_expires_at_ms: value.lease_expires_at_ms, heartbeat_interval_ms: HEARTBEAT,
      last_heartbeat_ms: checkedAt, acknowledged_offset: '0', pending_patch: null, state: 'ready' };
    recordUpload(options, upload, 'UPLOAD_READY');
    return { status: 'UPLOAD_READY', job_id: context.request.job_id, recovered: recovery === 'resume',
      scope: 'encrypted upload capability recorded; no source bytes uploaded or delivery proven' };
  });
}

async function heartbeatUnlocked(options, clock, fetchImpl) {
  const { journal, sessionId } = options, now = timestamp(clock), context = contextFor(options, now);
  requireUploadableState(journal.get(sessionId));
  const upload = validateStoredUpload(journal.get(sessionId).upload, context); expiry(upload.lease_expires_at_ms, now);
  const signed = prepareYoutickHeartbeatControl({ journal, sessionId, goal: options.goal, paymentResult: options.paymentResult,
    job: options.job, sourceFile: options.sourceFile, nowMs: now });
  if (BigInt(signed.envelope.expires_at_ms) <= BigInt(timestamp(clock))) {
    throw new Error('prepared heartbeat expired before sending; reconcile the original lease');
  }
  const response = await send(fetchImpl, `${BRIDGE}/v1/upload-heartbeats`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: ORIGIN, 'X-Youtick-Signature': signed.signature },
    body: JSON.stringify({ body: signed.body, envelope: signed.envelope }) }, 20_000);
  const value = await readJsonBounded(response), checkedAt = timestamp(clock);
  if (!own(value, ['schema', 'job_id', 'generation', 'lease_id', 'expires_at_ms', 'heartbeat_interval_ms']) ||
      value.schema !== 'youtick.livepeer-upload-lease.v1' || value.job_id !== context.request.job_id || value.generation !== 1 ||
      value.lease_id !== upload.lease_id || value.heartbeat_interval_ms !== HEARTBEAT) {
    throw new Error('provider heartbeat does not match the original lease; stop and reconcile');
  }
  expiry(value.expires_at_ms, checkedAt);
  const previous = journal.get(sessionId);
  journal.put(sessionId, { ...previous, heartbeat: { ...previous.heartbeat, state: 'acknowledged' },
    upload: { ...upload, lease_expires_at_ms: value.expires_at_ms, last_heartbeat_ms: checkedAt } });
  return { status: 'LEASE_RENEWED', job_id: context.request.job_id, expires_at_ms: value.expires_at_ms };
}

/** Renew a previously recorded lease; no payment or upload is made. */
export async function heartbeatYoutickUpload(options) {
  const { journal, clock = Date.now, fetchImpl = globalThis.fetch } = options;
  return locked(journal, () => heartbeatUnlocked(options, clock, fetchImpl));
}

async function tusHead(fetchImpl, upload, size) {
  const response = await send(fetchImpl, tusUrl(upload.tus_endpoint), { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }, 20_000);
  if (!response || ![200, 204].includes(response.status) || response.headers?.get('Tus-Resumable') !== '1.0.0' ||
      response.headers?.get('Upload-Length') !== String(size)) throw new Error('TUS status is invalid; stop and reconcile');
  return offset(response.headers.get('Upload-Offset'), size);
}
async function tusPatch(fetchImpl, upload, start, bytes) {
  const response = await send(fetchImpl, tusUrl(upload.tus_endpoint), { method: 'PATCH', headers: {
    'Tus-Resumable': '1.0.0', 'Upload-Offset': String(start), 'Content-Type': 'application/offset+octet-stream',
    'Content-Length': String(bytes.length) }, body: bytes }, 120_000);
  if (!response || response.status !== 204 || response.headers?.get('Tus-Resumable') !== '1.0.0' ||
      response.headers?.get('Upload-Offset') !== String(start + bytes.length)) {
    throw new Error('TUS chunk is unresolved; reconcile with HEAD before resuming');
  }
}

/** Upload one source sequentially, with no automatic retry. A write-ahead
 * chunk digest is durable before every PATCH. After an ambiguous PATCH, the
 * next explicit invocation checks HEAD and permits only an offset within that
 * original chunk. It never interprets receipt as publication or retrieval. */
export async function uploadYoutickSource(options) {
  const { journal, sessionId, clock = Date.now, fetchImpl = globalThis.fetch } = options;
  return locked(journal, async () => {
    let now = timestamp(clock), context = contextFor(options, now);
    requireUploadableState(journal.get(sessionId));
    let upload = validateStoredUpload(journal.get(sessionId)?.upload, context);
    expiry(upload.lease_expires_at_ms, now);
    const source = openVerifiedYoutickSource(context.input.source, options.sourceFile);
    try {
      now = timestamp(clock); expiry(upload.lease_expires_at_ms, now);
      if (BigInt(context.input.upload_key_expires_at_ms) <= BigInt(now)) throw new Error('upload session key expired; stop and reconcile');
      const remote = await tusHead(fetchImpl, upload, source.size), recorded = offset(upload.acknowledged_offset, source.size);
      if (upload.pending_patch) {
        const pending = upload.pending_patch, start = offset(pending.start, source.size), end = offset(pending.end, source.size);
        if (remote < start || remote > end || sha256(source.read(start, end - start)) !== pending.sha256) {
          throw new Error('TUS offset does not reconcile with the original pending chunk');
        }
        upload = { ...upload, acknowledged_offset: String(remote), pending_patch: null };
        recordUpload(options, upload);
      } else if (remote !== recorded) throw new Error('TUS offset differs from the original journal; stop and reconcile');
      for (let at = remote; at < source.size;) {
        now = timestamp(clock);
        if (BigInt(context.input.upload_key_expires_at_ms) <= BigInt(now)) throw new Error('upload session key expired; stop and reconcile');
        expiry(upload.lease_expires_at_ms, now);
        if (now >= upload.last_heartbeat_ms + HEARTBEAT || now + 120_000 >= Number(upload.lease_expires_at_ms)) {
          await heartbeatUnlocked(options, clock, fetchImpl);
          upload = validateStoredUpload(journal.get(sessionId).upload, context);
          now = timestamp(clock); expiry(upload.lease_expires_at_ms, now);
        }
        const bytes = source.read(at, Math.min(CHUNK, source.size - at)), end = at + bytes.length;
        upload = { ...upload, pending_patch: { start: String(at), end: String(end), sha256: sha256(bytes) } };
        recordUpload(options, upload); // fsync BEFORE any PATCH
        try { await tusPatch(fetchImpl, upload, at, bytes); }
        catch { throw new Error('TUS chunk is unresolved; reconcile with HEAD before resuming'); }
        upload = { ...upload, acknowledged_offset: String(end), pending_patch: null };
        recordUpload(options, upload); at = end;
      }
      upload = { ...upload, state: 'source_uploaded' }; recordUpload(options, upload);
      return { status: 'SOURCE_UPLOADED', job_id: context.request.job_id, accepted_bytes: String(source.size),
        scope: 'trusted TUS server reports all source bytes received; not proof of processing, publication or retrieval' };
    } finally { source.close(); }
  });
}
