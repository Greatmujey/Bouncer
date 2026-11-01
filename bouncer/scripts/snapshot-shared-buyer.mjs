#!/usr/bin/env node
/** Authenticated forensic checkpointing; never signs, pays, resets or restores. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuyerKeyFile, openConfiguredBuyerJournal } from '../agent/shared-buyer-config.mjs';
import { BuyerJournalError, MAX_BUYER_SNAPSHOT_BYTES, verifyEncryptedBuyerSnapshot,
  compareEncryptedBuyerSnapshots } from '../agent/postgres-buyer-journal.mjs';

const USAGE = `Usage: node bouncer/scripts/snapshot-shared-buyer.mjs --export NEW-FILE --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID
   or: node bouncer/scripts/snapshot-shared-buyer.mjs --verify FILE
   or: node bouncer/scripts/snapshot-shared-buyer.mjs --compare FILE --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID

Exports one bounded encrypted journal checkpoint, authenticates it offline, or
compares it to the current original primary. Supply the live journal key file
via BOUNCER_BUYER_JOURNAL_KEY_FILE and, for compare after a key rotation, the
checkpoint's old key file via BOUNCER_BUYER_SNAPSHOT_KEY_FILE. Export/compare
also need BOUNCER_BUYER_DATABASE_URL. Keys are separate owner-only 32-byte files.

A checkpoint is NOT a full database backup, a restore tool, proof of chain state,
or evidence that it is the latest snapshot. An older snapshot, lost journals or
another database can still hide payments. Stop and reconcile, never resend.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--export', '--verify', '--compare', '--contract', '--owner', '--journal'].includes(arg) &&
        args[i + 1] && !args[i + 1].startsWith('--') && !opts[arg]) { opts[arg] = args[++i]; continue; }
    throw new Error('invalid buyer snapshot arguments');
  }
  if (['--export', '--verify', '--compare'].filter(mode => opts[mode]).length !== 1) throw new Error('select exactly one snapshot mode');
  if (opts['--verify']) {
    if (opts['--contract'] || opts['--owner'] || opts['--journal']) throw new Error('offline verification accepts only a snapshot file');
  } else if (!opts['--contract'] || !opts['--owner'] || !opts['--journal']) {
    throw new Error('the original contract, owner and journal are required');
  }
  return opts;
}
function readSnapshot(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BUYER_SNAPSHOT_BYTES || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
    const data = Buffer.alloc(stat.size + 1); let offset = 0, count;
    while (offset < data.length && (count = fs.readSync(fd, data, offset, data.length - offset, null)) > 0) offset += count;
    if (offset !== stat.size) throw new Error();
    return data.subarray(0, offset).toString('utf8');
  } catch { throw new Error('snapshot must be an owner-only, bounded regular file, not a symlink'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeSnapshot(file, data) {
  let fd;
  try {
    // O_EXCL also refuses symlinks and never overwrites a previous checkpoint.
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const dir = fs.openSync(path.dirname(path.resolve(file)), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { throw new Error('cannot create and sync a new owner-only snapshot; existing files are never overwritten'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  let snapshotKey, liveKey, journal, pool;
  try {
    if (opts['--verify'] || opts['--compare']) {
      const previous = readSnapshot(opts['--verify'] || opts['--compare']);
      snapshotKey = readBuyerKeyFile(process.env.BOUNCER_BUYER_SNAPSHOT_KEY_FILE || process.env.BOUNCER_BUYER_JOURNAL_KEY_FILE);
      const summary = verifyEncryptedBuyerSnapshot(previous, snapshotKey);
      if (opts['--verify']) { console.log(JSON.stringify(summary, null, 2)); return; }
      if (summary.contract_id !== opts['--contract'] || summary.owner_account_id !== opts['--owner'] || summary.journal_id !== opts['--journal']) {
        throw new BuyerJournalError('SNAPSHOT_SCOPE', 'checkpoint does not belong to the requested original journal');
      }
      liveKey = readBuyerKeyFile(process.env.BOUNCER_BUYER_JOURNAL_KEY_FILE);
      ({ journal, pool } = await openConfiguredBuyerJournal({ contractId: opts['--contract'], ownerAccountId: opts['--owner'], journalId: opts['--journal'] }));
      const current = await journal.exportEncryptedSnapshot();
      console.log(JSON.stringify(compareEncryptedBuyerSnapshots({ previous, previousKey: snapshotKey, current, currentKey: liveKey }), null, 2));
    } else {
      ({ journal, pool } = await openConfiguredBuyerJournal({ contractId: opts['--contract'], ownerAccountId: opts['--owner'], journalId: opts['--journal'] }));
      const serialized = await journal.exportEncryptedSnapshot();
      writeSnapshot(opts['--export'], serialized);
      console.log('[snapshot-shared-buyer] Encrypted checkpoint created; it is not a full backup or proof of latest state.');
    }
  } finally {
    snapshotKey?.fill(0); liveKey?.fill(0);
    if (journal) await journal.close();
    if (pool) await pool.end();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof BuyerJournalError || /^(invalid buyer snapshot|select exactly one|offline verification|the original contract|snapshot must be|buyer journal key must be|buyer journal key file is|required|cannot create and sync)/.test(error.message);
    console.error(`[snapshot-shared-buyer] ERROR: ${safe ? error.message : 'snapshot operation failed; preserve the original journal and reconcile'}`);
    process.exitCode = 1;
  });
}
