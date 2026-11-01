/** Secret handling for the opt-in shared buyer. Never print URLs or key bytes. */
import fs from 'node:fs';
import pg from 'pg';
import { openPostgresBuyerJournal } from './postgres-buyer-journal.mjs';

export function validateBuyerDatabaseUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('buyer database URL is required');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid buyer database URL'); }
  const allowed = new Set(['sslmode', 'sslrootcert']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/' || url.hash ||
      [...url.searchParams.keys()].some(k => !allowed.has(k) || url.searchParams.getAll(k).length !== 1)) {
    throw new Error('invalid buyer database URL');
  }
  const sslmode = url.searchParams.get('sslmode'), loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && sslmode !== 'verify-full') || (loopback && sslmode !== null && !['disable', 'verify-full'].includes(sslmode))) {
    throw new Error('remote buyer databases require TLS with sslmode=verify-full');
  }
  return value;
}

/** Read a raw random 32-byte key from an owner-only regular file, not a symlink. */
export function readBuyerKeyFile(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('buyer journal key file is required');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
    const key = fs.readFileSync(fd);
    if (key.length !== 32) throw new Error();
    return key;
  } catch { throw new Error('buyer journal key must be an owner-only regular file containing exactly 32 random bytes'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function buyerPoolFromEnvironment() {
  const connectionString = validateBuyerDatabaseUrl(process.env.BOUNCER_BUYER_DATABASE_URL);
  try {
    const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000, idleTimeoutMillis: 30000 });
    pool.on('error', () => {});
    return pool;
  } catch { throw new Error('cannot initialize verified buyer database TLS settings'); }
}

/** Open a configured journal. Caller must await journal.close() and pool.end(). */
export async function openConfiguredBuyerJournal({ contractId, ownerAccountId, journalId, createNew = false }) {
  const key = readBuyerKeyFile(process.env.BOUNCER_BUYER_JOURNAL_KEY_FILE);
  let pool;
  try {
    pool = buyerPoolFromEnvironment();
    const journal = await openPostgresBuyerJournal({ pool, contractId, ownerAccountId, journalId, key, createNew });
    return { journal, pool };
  } catch (error) {
    if (pool) await pool.end();
    throw error;
  } finally { key.fill(0); }
}
