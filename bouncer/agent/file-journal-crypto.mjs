/**
 * Optional encryption at rest for the existing single-host file journal.
 * This does not establish freshness or prevent restoring an older valid file.
 * All ciphertexts are bound to the caller's contract and owner IDs.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export const FILE_JOURNAL_FORMAT = 'bouncer-encrypted-file-journal-v1';
export const MAX_ENCRYPTED_JOURNAL_PLAINTEXT = 8 * 1024 * 1024;
export const MAX_ENCRYPTED_JOURNAL_FILE = 12 * 1024 * 1024;
const CIPHER = 'aes-256-gcm';
const invalid = () => new Error('encrypted file journal is invalid or failed authentication; stop and reconcile');

function validKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('file journal encryption requires a 32-byte key');
}
function aad(contractId, ownerId) {
  if (typeof contractId !== 'string' || !contractId || typeof ownerId !== 'string' || !ownerId) throw invalid();
  return Buffer.from(JSON.stringify([FILE_JOURNAL_FORMAT, CIPHER, contractId, ownerId]), 'utf8');
}
function canonicalBytes(value, length, maxLength = length) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxLength / 3) * 4) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < length || bytes.length > maxLength) throw invalid();
  return bytes;
}

export function isEncryptedFileJournal(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.format === FILE_JOURNAL_FORMAT;
}

/** Serialize and encrypt in memory: no plaintext temporary file is created. */
export function encryptFileJournal(data, key, contractId, ownerId) {
  validKey(key);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  try {
    if (!plaintext.length || plaintext.length > MAX_ENCRYPTED_JOURNAL_PLAINTEXT) throw new Error('encrypted file journal exceeds its size limit');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CIPHER, key, nonce);
    cipher.setAAD(aad(contractId, ownerId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = { format: FILE_JOURNAL_FORMAT, cipher: CIPHER, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    return `${JSON.stringify(envelope)}\n`;
  } finally { plaintext.fill(0); }
}

/** Refuse malformed, substituted, overlarge or unauthenticated envelopes. */
export function decryptFileJournal(envelope, key, contractId, ownerId) {
  validKey(key);
  let plaintext;
  try {
    if (!isEncryptedFileJournal(envelope) || envelope.cipher !== CIPHER ||
        Object.keys(envelope).sort().join(',') !== 'cipher,ciphertext,format,nonce,tag') throw invalid();
    const nonce = canonicalBytes(envelope.nonce, 12);
    const tag = canonicalBytes(envelope.tag, 16);
    const ciphertext = canonicalBytes(envelope.ciphertext, 1, MAX_ENCRYPTED_JOURNAL_PLAINTEXT);
    const decipher = crypto.createDecipheriv(CIPHER, key, nonce);
    decipher.setAAD(aad(contractId, ownerId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch { throw invalid(); }
  finally { plaintext?.fill(0); }
}

/** Read a raw random 32-byte key from an owner-only regular file, never a symlink. */
export function readFileJournalKeyFile(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('file journal key file is required');
  let fd, key;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
    key = fs.readFileSync(fd);
    if (key.length !== 32) throw new Error();
    return key;
  } catch {
    key?.fill(0);
    throw new Error('file journal key must be an owner-only regular file containing exactly 32 random bytes');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
