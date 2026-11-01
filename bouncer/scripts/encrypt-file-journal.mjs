#!/usr/bin/env node
/** Convert one EXISTING local journal in place, preserving pending payments. */
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { FileJournal } from '../agent/procurement.mjs';
import { readFileJournalKeyFile } from '../agent/file-journal-crypto.mjs';

const USAGE = `Usage: node bouncer/scripts/encrypt-file-journal.mjs --state ORIGINAL-JOURNAL --contract CONTRACT_ID --owner OWNER_ID

Set BOUNCER_FILE_JOURNAL_KEY_FILE to an owner-only file containing 32 random
bytes. Stop all workers first. This takes the original file lock, checks the
original contract/owner and entries, and atomically replaces that SAME file
with an authenticated encrypted copy. It creates no new journal, signs nothing,
and makes no network request or payment. Existing plaintext backups and storage
snapshots remain plaintext. Keep the original key safely backed up; losing it
prevents recovery. Encryption does not detect a valid old journal rollback.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!['--state', '--contract', '--owner'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--') || out[name]) {
      throw new Error('invalid encryption arguments');
    }
    out[name] = args[++i];
  }
  if (!out['--state'] || !out['--contract'] || !out['--owner']) throw new Error('original state, contract and owner are required');
  return out;
}
function home(value) { return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const key = readFileJournalKeyFile(process.env.BOUNCER_FILE_JOURNAL_KEY_FILE);
  let journal;
  try {
    journal = new FileJournal(home(opts['--state']), opts['--contract'], opts['--owner'], {
      encryptionKey: key, keyFile: process.env.BOUNCER_FILE_JOURNAL_KEY_FILE, migratePlaintext: true, requireExisting: true,
    });
    console.log(journal.migratedPlaintext
      ? `Encrypted the original journal in place (${journal.list().length} entries); no payment or network request was made.`
      : 'The original journal is already encrypted with this key; no file, payment or network request was made.');
  } finally {
    journal?.close();
    key.fill(0);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`[file-journal-encryption] ERROR: ${error.message}`); process.exitCode = 1; }
}
