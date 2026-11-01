/** Rotate/check ONE encrypted shared direct-v3 buyer journal. Never signs or pays. */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuyerJournalError, openPostgresBuyerJournal } from '../agent/postgres-buyer-journal.mjs';
import { buyerPoolFromEnvironment, readBuyerKeyFile } from '../agent/shared-buyer-config.mjs';

const USAGE = `Usage: node bouncer/scripts/rotate-shared-buyer-key.mjs --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID --confirm-rotate
   or: node bouncer/scripts/rotate-shared-buyer-key.mjs --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID --check

Uses the original primary and one atomic bounded transaction; no NEAR, seller,
signing key or payment is involved. Stop all workers and securely retain BOTH
original and new 32-byte key files/backups. Supply the database URL in
BOUNCER_BUYER_DATABASE_URL, the original key path in
BOUNCER_BUYER_JOURNAL_KEY_FILE, and the new key path in
BOUNCER_BUYER_NEW_JOURNAL_KEY_FILE. Never pass key bytes on the command line.

If a rotation result is uncertain, use --check with the SAME two key files
and original primary after all workers stop. It acquires the journal lock and
verifies every encrypted entry, without changing state. A mismatch or busy lock
is not permission to create a replacement or delete a pending payment.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--check', '--confirm-rotate'].includes(arg) && !opts[arg]) { opts[arg] = true; continue; }
    if (['--contract', '--owner', '--journal'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !opts[arg]) {
      opts[arg] = args[++i]; continue;
    }
    throw new Error('invalid key rotation arguments');
  }
  if (!opts['--contract'] || !opts['--owner'] || !opts['--journal'] || Boolean(opts['--check']) === Boolean(opts['--confirm-rotate'])) {
    throw new Error('original contract, owner, journal and exactly one of --check or --confirm-rotate are required');
  }
  return opts;
}
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  let oldKey, newKey, pool, journal;
  try {
    oldKey = readBuyerKeyFile(process.env.BOUNCER_BUYER_JOURNAL_KEY_FILE);
    newKey = readBuyerKeyFile(process.env.BOUNCER_BUYER_NEW_JOURNAL_KEY_FILE);
    if (crypto.timingSafeEqual(oldKey, newKey)) throw new Error('original and new journal keys must differ');
    pool = buyerPoolFromEnvironment();
    const scope = { pool, contractId: opts['--contract'], ownerAccountId: opts['--owner'], journalId: opts['--journal'] };
    if (opts['--check']) {
      let match = 'original';
      try { journal = await openPostgresBuyerJournal({ ...scope, key: oldKey }); }
      catch (error) {
        if (error?.code !== 'KEY_MISMATCH') throw error;
        match = 'new';
        try { journal = await openPostgresBuyerJournal({ ...scope, key: newKey }); }
        catch (nextError) {
          if (nextError?.code === 'KEY_MISMATCH') throw new Error('neither supplied key matches the original journal; stop and reconcile');
          throw nextError;
        }
      }
      console.log(JSON.stringify({ mode: 'read-only key check', matching_key: match, entries_authenticated: journal.list().length,
        warning: 'One primary and journal only; this does not prove payment, safe failover or uncompromised backups.' }));
    } else {
      journal = await openPostgresBuyerJournal({ ...scope, key: oldKey });
      const result = await journal.rotateEncryptionKey(newKey);
      console.log(JSON.stringify({ mode: 'atomic key rotation', ...result,
        warning: 'No payment sent. Retain both protected key files and backups until recovery and backup procedures are verified.' }));
    }
  } finally {
    try { if (journal) await journal.close(); }
    finally {
      try { if (pool) await pool.end(); }
      finally { oldKey?.fill(0); newKey?.fill(0); }
    }
  }
}
const safeMessages = new Set(['invalid key rotation arguments',
  'original contract, owner, journal and exactly one of --check or --confirm-rotate are required',
  'original and new journal keys must differ', 'neither supplied key matches the original journal; stop and reconcile',
  'buyer journal key file is required', 'buyer journal key must be an owner-only regular file containing exactly 32 random bytes',
  'buyer database URL is required', 'invalid buyer database URL', 'remote buyer databases require TLS with sslmode=verify-full',
  'cannot initialize verified buyer database TLS settings', 'invalid shared buyer testnet account or stable journal ID']);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error instanceof BuyerJournalError || safeMessages.has(error?.message) ? error.message :
      'operation failed; preserve both key files and the original journal, then reconcile';
    console.error(`[rotate-shared-buyer-key] ERROR: ${message}`); process.exitCode = 1;
  });
}
