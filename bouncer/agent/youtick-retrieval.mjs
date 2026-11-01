/**
 * Experimental, testnet-only YouTick legacy token and bounded HLS byte probe.
 * No NEAR transaction, FT payment, upload or automatic token renewal is made
 * here. Provider requests may still consume quota or create audit records.
 * All network and chain observations require trusted providers.
 * The original encrypted exclusive journal and its key must be preserved.
 *
 * A token, control signature and response URLs are bearer capabilities: never
 * return, log or place them in plaintext. An ambiguous initial token response
 * is not retried; the original session remains pending. A bounded segment hash
 * is not proof that a video plays, matches the source or remains available.
 */
import crypto from 'node:crypto';
import { inspectRecordedYoutickPlayback } from './youtick-grant-runner.mjs';
import { YOUTICK_PLAY_ORIGIN } from './youtick-playback.mjs';

const BRIDGE_URL = 'https://bridge-public-testnet.youtick.net/v1/playback-tokens';
const PRIMARY_ORIGIN = 'https://playback.livepeer.studio';
// The reviewed provider source also lists a suffix wildcard; deliberately omit
// it here. Extra CDN origins must be exact, separately approved by the caller.
const KNOWN_CDN = new Set(['https://livepeercdn.com', 'https://livepeercdn.studio', 'https://asset-cdn.lp-playback.com']);
const MAX_JSON = 16 * 1024, MAX_MANIFEST = 256 * 1024, MAX_SEGMENT = 8 * 1024 * 1024;
const MAX_URL = 2048, MAX_LINES = 4096, MAX_REDIRECTS = 2, TIMEOUT_MS = 20_000;
const running = new WeakSet();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const HEX = /^[a-f0-9]{64}$/;

function timestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid playback clock');
  return value;
}
async function locked(journal, operation) {
  if (!journal || typeof journal !== 'object' || running.has(journal)) throw new Error('playback operation already running or journal missing');
  running.add(journal);
  try { return await operation(); } finally { running.delete(journal); }
}
function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('playback transport unavailable');
}
function timeoutOption(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > TIMEOUT_MS) throw new Error('invalid playback timeout');
  return value;
}
async function withDeadline(timeoutMs, operation) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await operation(controller.signal); } finally { clearTimeout(timer); }
}
// Bound even an injected transport or stream that ignores AbortSignal. This
// cannot prevent a malicious injected transport from sending or retrying in
// the background; callers must still trust it and use the journal reservation.
async function untilAbort(operation, signal) {
  if (signal.aborted) throw new Error('deadline expired');
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new Error('deadline expired')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}
async function send(fetchImpl, url, options, signal) {
  try {
    if (signal.aborted) throw new Error('deadline expired');
    const request = Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('deadline expired');
      return fetchImpl(url, { ...options, redirect: 'manual', cache: 'no-store', credentials: 'omit',
        referrerPolicy: 'no-referrer', signal });
    });
    // If a nonconforming injected transport resolves after the deadline,
    // discard its response rather than leaving an unread body/socket open.
    void request.then(response => { if (signal.aborted) discard(response); }, () => {});
    return await untilAbort(request, signal);
  } catch {
    // The underlying error can contain the bearer header, URL or request body.
    throw new Error('playback request unresolved; do not automatically retry');
  }
}
function discard(response) {
  try { void response?.body?.cancel()?.catch(() => {}); } catch { /* best effort */ }
}
async function boundedBody(response, maximum, signal) {
  let status, body, headers;
  try {
    status = response?.status; body = response?.body; headers = response?.headers;
    if (!Number.isInteger(status) || typeof body?.getReader !== 'function' || typeof headers?.get !== 'function') throw new Error();
  } catch { discard(response); throw new Error('invalid playback response'); }
  if (status !== 200) {
    discard(response); throw new Error(`playback request unresolved (HTTP ${status}); do not automatically retry`);
  }
  let length, reader;
  try { length = headers.get('content-length'); }
  catch { discard(response); throw new Error('invalid playback response headers'); }
  if (length !== null && (typeof length !== 'string' || !/^(0|[1-9][0-9]{0,12})$/.test(length) || BigInt(length) > BigInt(maximum))) {
    discard(response); throw new Error('playback response exceeds its bound');
  }
  try { reader = body.getReader(); }
  catch { discard(response); throw new Error('invalid playback response stream'); }
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await untilAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('invalid bytes');
      size += value.byteLength;
      if (size > maximum) throw new Error('too large');
      chunks.push(Buffer.from(value));
    }
    if (!size) throw new Error('empty response');
    return Buffer.concat(chunks, size);
  } catch {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
    throw new Error('playback response invalid or unresolved; do not automatically retry');
  } finally { try { reader.releaseLock(); } catch { /* a cancelled stream can still be closing */ } }
}
function jsonObject(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('invalid playback token response'); }
}
function base64url(part, maximum) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part) || part.length > maximum) throw new Error('invalid playback token');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('invalid playback token');
  return bytes;
}
function tokenValue(value, context, receivedAt, { allowExpired = false, now = receivedAt } = {}) {
  if (!exactKeys(value, ['schema', 'playback_id', 'token', 'expires_at_ms', 'hls_url']) ||
      value.schema !== 'youtick.livepeer-playback-token.v1' || value.playback_id !== context.playback_id ||
      value.hls_url !== `${PRIMARY_ORIGIN}/asset/hls/${context.playback_id}/index.m3u8` ||
      typeof value.expires_at_ms !== 'string' || !/^[1-9][0-9]{12,15}$/.test(value.expires_at_ms) ||
      typeof value.token !== 'string' || value.token.length > 8192) throw new Error('invalid or mismatched playback token response');
  const expiration = Number(value.expires_at_ms), parts = value.token.split('.');
  if (!Number.isSafeInteger(expiration) || parts.length !== 3 || expiration > context.grant_expires_at_ms ||
      (!allowExpired && expiration <= now)) throw new Error('expired or mismatched playback token response');
  const header = jsonObject(base64url(parts[0], 1024)), claims = jsonObject(base64url(parts[1], 6144));
  const signature = base64url(parts[2], 128);
  if (header.alg !== 'ES256' || header.typ !== 'JWT' || signature.length !== 64 ||
      claims.action !== 'pull' || claims.video !== 'none' || claims.sub !== context.playback_id ||
      typeof claims.iss !== 'string' || claims.iss.length < 1 || claims.iss.length > 256 ||
      typeof claims.pub !== 'string' || claims.pub.length < 32 || claims.pub.length > 2048 ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.exp * 1000 !== expiration || claims.exp <= claims.iat || claims.exp - claims.iat > 180 ||
      claims.iat * 1000 > receivedAt + 5_000 || claims.iat * 1000 < receivedAt - 60_000 || expiration <= receivedAt) {
    throw new Error('invalid playback token claims');
  }
  let signerKey, issuer;
  try {
    issuer = new URL(claims.iss);
    if (issuer.protocol !== 'https:' || issuer.origin !== claims.iss || issuer.username || issuer.password) throw new Error();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(claims.pub)) throw new Error();
    const bytes = Buffer.from(claims.pub, 'base64');
    if (bytes.toString('base64') !== claims.pub) throw new Error();
    signerKey = bytes.subarray(0, 26).toString('ascii') === '-----BEGIN PUBLIC KEY-----'
      ? crypto.createPublicKey(bytes) : crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (signerKey.asymmetricKeyType !== 'ec' || signerKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        !crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: signerKey, dsaEncoding: 'ieee-p1363' }, signature)) {
      throw new Error();
    }
  } catch { throw new Error('invalid playback token signing key or signature'); }
  // A key embedded in its own JWT is not authenticated by self-consistency.
  // An independently reviewed SPKI fingerprint can additionally be pinned.
  return { token: value.token, expires_at_ms: value.expires_at_ms, hls_url: value.hls_url,
    signer_key_sha256: hash(signerKey.export({ type: 'spki', format: 'der' })), issuer: issuer.origin };
}
const commonFields = ['version', 'state', 'grant_id', 'grant_tx_hash', 'payment_tx_hash', 'job_id', 'playback_id',
  'session_pk', 'nonce_sha256', 'body_sha256', 'expected_key_sha256', 'attempted_at_ms'];
function recordedToken(record, context, now) {
  const keys = record?.state === 'issued' ? [...commonFields, 'received_at_ms', 'token', 'expires_at_ms'] : commonFields;
  if (!exactKeys(record, keys) || record.version !== 1 || !['pending', 'issued'].includes(record.state) ||
      record.grant_id !== context.grant_id || record.grant_tx_hash !== context.grant_tx_hash ||
      record.payment_tx_hash !== context.payment_tx_hash || record.job_id !== context.job_id ||
      record.playback_id !== context.playback_id || record.session_pk !== context.session_pk ||
      !HEX.test(record.nonce_sha256) || !HEX.test(record.body_sha256) ||
      (record.expected_key_sha256 !== null && (typeof record.expected_key_sha256 !== 'string' || !HEX.test(record.expected_key_sha256))) ||
      !Number.isSafeInteger(record.attempted_at_ms) || record.attempted_at_ms <= 0 || record.attempted_at_ms > now + 5_000) {
    throw new Error('original playback token journal entry is missing or mismatched');
  }
  if (record.state === 'pending') return { state: 'pending' };
  if (!Number.isSafeInteger(record.received_at_ms) || record.received_at_ms < record.attempted_at_ms ||
      record.received_at_ms > record.attempted_at_ms + 60_000 || record.received_at_ms > now + 5_000) {
    throw new Error('original playback token receipt time is invalid');
  }
  const value = { schema: 'youtick.livepeer-playback-token.v1', playback_id: context.playback_id, token: record.token,
    expires_at_ms: record.expires_at_ms, hls_url: `${PRIMARY_ORIGIN}/asset/hls/${context.playback_id}/index.m3u8` };
  const checked = tokenValue(value, context, record.received_at_ms, { allowExpired: true, now });
  if (record.expected_key_sha256 !== null && record.expected_key_sha256 !== checked.signer_key_sha256) {
    throw new Error('playback token signer differs from the independently reviewed key');
  }
  return { state: Number(checked.expires_at_ms) <= now ? 'expired' : 'issued',
    signer_key_pinned: record.expected_key_sha256 !== null, ...checked };
}
function summary(status, context, extra = {}) {
  return { status, grant_id: context.grant_id, job_id: context.job_id, grant_tx_hash: context.grant_tx_hash,
    payment_tx_hash: context.payment_tx_hash, ...extra,
    scope: 'experimental testnet only; trusted RPC and provider; no proof of playable media, source integrity or future availability' };
}

/** Review by default. With execute:true, reverify the original paid publication,
 * grant, entitlement, code pins and local source, journal the one request BEFORE
 * sending, and store a successful token only in the encrypted original journal.
 * The response body/signature/token are never returned. An ambiguous attempt is
 * permanently pending rather than silently issuing another request. */
export async function requestYoutickPlaybackToken({ journal, grantId, provider, sourceFile, expectedJwtKeySha256,
  execute = false, fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = TIMEOUT_MS }) {
  timeoutOption(timeoutMs);
  if (typeof execute !== 'boolean' || typeof clock !== 'function' ||
      (expectedJwtKeySha256 !== undefined && (typeof expectedJwtKeySha256 !== 'string' || !HEX.test(expectedJwtKeySha256)))) {
    throw new Error('invalid playback request options or reviewed signer fingerprint');
  }
  return locked(journal, async () => {
    let context = await inspectRecordedYoutickPlayback({ journal, grantId, provider, clock });
    const prior = journal.get(context.session_id).playback_token;
    if (prior) {
      const saved = recordedToken(prior, context, timestamp(clock));
      if (expectedJwtKeySha256 !== undefined && prior.expected_key_sha256 !== expectedJwtKeySha256) {
        throw new Error('signer fingerprint differs from the original token request review');
      }
      return summary(saved.state === 'pending' ? 'TOKEN_REQUEST_UNRESOLVED' : saved.state === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_AVAILABLE', context,
        saved.state === 'pending' ? {} : { expires_at_ms: saved.expires_at_ms, signer_key_sha256: saved.signer_key_sha256,
          signer_key_pinned: saved.signer_key_pinned, issuer: saved.issuer });
    }
    if (!execute) return summary('READY_FOR_TOKEN_REQUEST', context, { source_verification_required: true,
      reviewed_signer_key_sha256: expectedJwtKeySha256 ?? null });
    requireFetch(fetchImpl);
    // A fresh pinned block and full source fingerprint are required immediately
    // before creating the signature; no owner signing key is needed.
    context = await inspectRecordedYoutickPlayback({ journal, grantId, provider, sourceFile, includeTokenRequest: true, clock });
    const { signed } = context, now = timestamp(clock);
    if (Number(signed.envelope.expires_at_ms) <= now || context.grant_expires_at_ms <= now) throw new Error('grant or token request expired before send');
    const session = journal.get(context.session_id);
    if (session.playback_token) throw new Error('original token attempt already recorded; do not retry');
    const pending = { version: 1, state: 'pending', grant_id: context.grant_id, grant_tx_hash: context.grant_tx_hash,
      payment_tx_hash: context.payment_tx_hash, job_id: context.job_id, playback_id: context.playback_id,
      session_pk: context.session_pk, nonce_sha256: hash(signed.envelope.device_nonce), body_sha256: signed.envelope.body_sha256,
      expected_key_sha256: expectedJwtKeySha256 ?? null, attempted_at_ms: now };
    journal.put(context.session_id, { ...session, playback_token: pending });
    // Do not retain replayable signature or request in the journal. A crash at
    // any later point means no automatic request retry, even if no POST landed.
    if (Number(signed.envelope.expires_at_ms) <= timestamp(clock)) throw new Error('token request expired after journaling; do not retry');
    return withDeadline(timeoutMs, async signal => {
      const response = await send(fetchImpl, BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Origin: YOUTICK_PLAY_ORIGIN, 'X-Youtick-Signature': signed.signature },
        body: JSON.stringify({ body: signed.body, envelope: signed.envelope }) }, signal);
      const value = jsonObject(await boundedBody(response, MAX_JSON, signal)), receivedAt = timestamp(clock);
      if (receivedAt < now || receivedAt > now + 60_000) throw new Error('playback response time is invalid; do not retry');
      const checked = tokenValue(value, context, receivedAt);
      if (expectedJwtKeySha256 !== undefined && checked.signer_key_sha256 !== expectedJwtKeySha256) {
        throw new Error('playback token signer differs from the independently reviewed key; do not retry');
      }
      const current = journal.get(context.session_id);
      if (!current || current.playback_token?.state !== 'pending' || current.playback_token.nonce_sha256 !== pending.nonce_sha256) {
        throw new Error('original playback token state changed; do not retry');
      }
      journal.put(context.session_id, { ...current, playback_token: { ...pending, state: 'issued', received_at_ms: receivedAt,
        token: checked.token, expires_at_ms: checked.expires_at_ms } });
      return summary('TOKEN_RECEIVED', context, { expires_at_ms: checked.expires_at_ms, signer_key_sha256: checked.signer_key_sha256,
        signer_key_pinned: expectedJwtKeySha256 !== undefined, issuer: checked.issuer });
    });
  });
}

function approvedOrigins(values) {
  if (values === undefined) return new Set([PRIMARY_ORIGIN]);
  if (!Array.isArray(values) || values.length > KNOWN_CDN.size || new Set(values).size !== values.length ||
      values.some(value => !KNOWN_CDN.has(value))) throw new Error('unsupported or unreviewed playback CDN origin');
  return new Set([PRIMARY_ORIGIN, ...values]);
}
function safeMediaUrl(value, base, origins) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_URL || value.trim() !== value ||
      /[\x00-\x20\x7f\\]/.test(value)) throw new Error('unsafe playback URL');
  let url;
  try { url = new URL(value, base); } catch { throw new Error('unsafe playback URL'); }
  if (url.protocol !== 'https:' || !origins.has(url.origin) || url.username || url.password || url.port ||
      url.search || url.hash || url.pathname === '/' || /%(?:00|0[ad]|2f|5c)/i.test(url.pathname)) {
    throw new Error('unapproved playback URL; stop for review');
  }
  return url.href;
}
async function mediaGet(fetchImpl, initial, origins, token, expiresAt, clock, signal, maximum) {
  let url = safeMediaUrl(initial, PRIMARY_ORIGIN, origins);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (timestamp(clock) >= expiresAt) throw new Error('playback token expired before media request');
    const response = await send(fetchImpl, url, { method: 'GET', headers: { 'Livepeer-Jwt': token,
      Origin: YOUTICK_PLAY_ORIGIN, Accept: '*/*', 'Accept-Encoding': 'identity' } }, signal);
    let status;
    try { status = response?.status; } catch { discard(response); throw new Error('invalid playback response'); }
    if ([301, 302, 303, 307, 308].includes(status)) {
      let location;
      try { location = response.headers?.get?.('location'); }
      catch { discard(response); throw new Error('invalid playback redirect headers'); }
      discard(response);
      if (redirects === MAX_REDIRECTS || !location) throw new Error('playback redirect limit or missing location');
      url = safeMediaUrl(location, url, origins);
      continue;
    }
    return { bytes: await boundedBody(response, maximum, signal), url };
  }
  throw new Error('playback redirect limit');
}
function playlist(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('invalid HLS playlist'); }
  if (text.includes('\0') || /\r(?!\n)/.test(text)) throw new Error('invalid HLS playlist');
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES || lines[0] !== '#EXTM3U') throw new Error('invalid or oversized HLS playlist');
  let pending = null, kind = null, first = null, end = false;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.trim() !== line || line.length > MAX_URL) throw new Error('invalid HLS playlist line');
    if (line.startsWith('#EXT-X-KEY:') && line !== '#EXT-X-KEY:METHOD=NONE') throw new Error('encrypted HLS is not supported by this byte probe');
    if (/^#EXT-X-(?:SESSION-KEY|MAP|BYTERANGE|GAP|PART)(?::|$)/.test(line)) throw new Error('unsupported HLS feature in byte probe');
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pending || (kind && kind !== 'master')) throw new Error('invalid mixed HLS playlist');
      kind = 'master'; pending = 'master'; continue;
    }
    if (line.startsWith('#EXTINF:')) {
      if (pending || (kind && kind !== 'media')) throw new Error('invalid mixed HLS playlist');
      kind = 'media'; pending = 'media'; continue;
    }
    if (line === '#EXT-X-ENDLIST') end = true;
    if (line.startsWith('#')) continue;
    if (!pending) throw new Error('unbound HLS URI');
    first ??= line; pending = null;
  }
  if (pending || !first || !kind || (kind === 'media' && !end)) throw new Error('incomplete HLS playlist');
  return { kind, first };
}

/** Retrieve at most a master playlist, one media playlist and one bounded media
 * segment. No bytes, URLs or tokens are returned; only digests and lengths are
 * persisted. Redirects are manual and restricted to the primary origin plus
 * explicitly approved exact CDN origins. This is a byte probe, not a player. */
export async function probeYoutickHls({ journal, grantId, provider, approvedCdnOrigins,
  fetchImpl = globalThis.fetch, clock = Date.now, timeoutMs = TIMEOUT_MS }) {
  timeoutOption(timeoutMs);
  if (typeof clock !== 'function') throw new Error('invalid playback clock');
  const origins = approvedOrigins(approvedCdnOrigins);
  return locked(journal, async () => {
    const context = await inspectRecordedYoutickPlayback({ journal, grantId, provider, clock });
    const token = recordedToken(journal.get(context.session_id)?.playback_token, context, timestamp(clock));
    if (token.state !== 'issued') throw new Error('an unexpired original recorded playback token is required');
    requireFetch(fetchImpl);
    return withDeadline(timeoutMs, async signal => {
      const expiresAt = Number(token.expires_at_ms);
      const first = await mediaGet(fetchImpl, token.hls_url, origins, token.token, expiresAt, clock, signal, MAX_MANIFEST);
      let parsed = playlist(first.bytes), media = first;
      if (parsed.kind === 'master') {
        const next = safeMediaUrl(parsed.first, first.url, origins);
        media = await mediaGet(fetchImpl, next, origins, token.token, expiresAt, clock, signal, MAX_MANIFEST);
        parsed = playlist(media.bytes);
        if (parsed.kind !== 'media') throw new Error('nested HLS master playlists are not supported');
      }
      const segmentUrl = safeMediaUrl(parsed.first, media.url, origins);
      const segment = await mediaGet(fetchImpl, segmentUrl, origins, token.token, expiresAt, clock, signal, MAX_SEGMENT);
      const observedAt = timestamp(clock);
      if (observedAt >= expiresAt) throw new Error('playback token expired before byte evidence was recorded');
      const evidence = { version: 1, grant_id: context.grant_id, grant_tx_hash: context.grant_tx_hash,
        payment_tx_hash: context.payment_tx_hash, job_id: context.job_id, playback_id: context.playback_id,
        final_block_hash: context.final_block_hash, observed_at_ms: observedAt,
        signer_key_sha256: token.signer_key_sha256, signer_key_pinned: token.signer_key_pinned, issuer: token.issuer,
        initial_playlist_bytes: first.bytes.length, initial_playlist_sha256: hash(first.bytes),
        media_playlist_bytes: media.bytes.length, media_playlist_sha256: hash(media.bytes),
        segment_bytes: segment.bytes.length, segment_sha256: hash(segment.bytes) };
      const current = journal.get(context.session_id);
      const stillRecorded = recordedToken(current?.playback_token, context, observedAt);
      if (stillRecorded.state !== 'issued' || stillRecorded.token !== token.token || stillRecorded.expires_at_ms !== token.expires_at_ms) {
        throw new Error('original playback token changed during byte probe');
      }
      journal.put(context.session_id, { ...current, playback_probe: evidence });
      return summary('HLS_BYTES_RECEIVED', context, { evidence });
    });
  });
}
