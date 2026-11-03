/** Durable local retention of the exact, already-received Tollgate response.
 * This is not a distributed backup, proof of the HTTP peer, settlement proof,
 * or permission to retry an exposed voucher. The caller must retain the file
 * across environments and keep it private. Signing material is not added by
 * this store, but untrusted seller bytes could echo it; never publish the raw
 * response or log it without inspecting it in a secure environment. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TOLLGATE_RESOURCE } from './tollgate-v12-readiness.mjs';

const FORMAT = 'bouncer-tollgate-quakes-response-v1';
const MAX_BODY = 256 * 1024, MAX_FILE = 400 * 1024;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const id = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(x) && BigInt(x) <= 0xffffffffn;
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const stamp = x => typeof x === 'string' && /^[1-9][0-9]{12,15}$/.test(x) && BigInt(x) <= BigInt(Number.MAX_SAFE_INTEGER);
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const filename = (reviewHash, channelId) => {
  if (!digest(reviewHash) || !id(channelId)) throw new Error('invalid Tollgate response identity');
  return `tollgate-quakes-${reviewHash}-${channelId}.json`;
};
function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('absolute private response directory required');
  const d = path.resolve(directory), s = fs.lstatSync(d);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid()) || fs.realpathSync(d) !== d) {
    throw new Error('private non-symlink response directory required');
  }
  return d;
}
function checkRecord(r) {
  if (!plain(r) || Object.keys(r).sort().join(',') !==
      'body_base64,channel_id,format,network,observed_at_ms,resource,response_sha256,review_hash' ||
      r.format !== FORMAT || r.network !== 'testnet' || r.resource !== TOLLGATE_RESOURCE || !digest(r.review_hash) ||
      !id(r.channel_id) || !stamp(r.observed_at_ms) || !digest(r.response_sha256) || typeof r.body_base64 !== 'string' ||
      r.body_base64.length > Math.ceil(MAX_BODY / 3) * 4) throw new Error('invalid retained Tollgate response');
  const body = Buffer.from(r.body_base64, 'base64');
  if (!body.length || body.length > MAX_BODY || body.toString('base64') !== r.body_base64 || sha(body) !== r.response_sha256) {
    throw new Error('retained Tollgate response failed integrity validation');
  }
  return body;
}

export class TollgateResponseStore {
  #directory;
  constructor(directory) { this.#directory = privateDirectory(directory); }
  /** Save one exact response once, fsyncing both file and directory. Failure
   * after voucher exposure is not a reason to repeat the paid HTTP request. */
  save({ reviewHash, channelId, observedAtMs, rawBytes }) {
    privateDirectory(this.#directory);
    if (!Buffer.isBuffer(rawBytes) || !rawBytes.length || rawBytes.length > MAX_BODY ||
        !Number.isSafeInteger(observedAtMs) || observedAtMs < 1_000_000_000_000) throw new Error('invalid Tollgate response bytes');
    const name = filename(reviewHash, channelId);
    const record = { format: FORMAT, network: 'testnet', resource: TOLLGATE_RESOURCE, review_hash: reviewHash,
      channel_id: channelId, observed_at_ms: String(observedAtMs), response_sha256: sha(rawBytes), body_base64: rawBytes.toString('base64') };
    checkRecord(record);
    const file = path.join(this.#directory, name), bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > MAX_FILE) throw new Error('Tollgate response evidence exceeds limit');
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const dirFd = fs.openSync(this.#directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return { filename: name, response_sha256: record.response_sha256, observed_at_ms: record.observed_at_ms };
  }
  /** Return only the exact original public response; never accept a different
   * review/channel, a symlink, a permissive file, malformed base64 or a digest
   * mismatch. This local record does not authenticate the seller. */
  load({ reviewHash, channelId }) {
    privateDirectory(this.#directory);
    const file = path.join(this.#directory, filename(reviewHash, channelId));
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.size < 1 || s.size > MAX_FILE ||
          (typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('unsafe Tollgate response file');
      const bytes = fs.readFileSync(fd);
      if (bytes.length !== s.size) throw new Error('Tollgate response file changed while reading');
      let record; try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Error('invalid retained Tollgate response JSON'); }
      const rawBytes = checkRecord(record);
      if (record.review_hash !== reviewHash || record.channel_id !== channelId) throw new Error('Tollgate response scope differs');
      return { record, rawBytes };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
