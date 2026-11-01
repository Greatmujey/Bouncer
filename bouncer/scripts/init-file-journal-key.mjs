#!/usr/bin/env node
/** Create a new local file-journal key exactly once; never overwrite a key. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage: node bouncer/scripts/init-file-journal-key.mjs --key-file NEW-KEY

The parent directory must already exist, be owned by this user and be private
(mode 0700). Creates 32 random bytes in a new mode-0600 file, without printing
them or overwriting any existing path. Fsyncs both file and parent directory.
Back up the key securely; losing it prevents journal recovery. No network
request, journal or payment is created. If creation reports an error, do not
use a partial key; stop and inspect the original path before doing anything.
`;
function privateDirectory(stat) {
  return stat.isDirectory() && (stat.mode & 0o700) === 0o700 && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
export function initializeFileJournalKey(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('new key file path is required');
  const absolute = path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  const parent = path.dirname(absolute);
  let dirFd, fd, key, created = false;
  try {
    try {
      dirFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(dirFd), named = fs.lstatSync(parent);
      if (!privateDirectory(stat) || !privateDirectory(named) || stat.dev !== named.dev || stat.ino !== named.ino) throw new Error();
    } catch { throw new Error('key parent must be an existing owner-only directory with mode 0700'); }
    try { fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('key path already exists; refusing to overwrite it');
      throw new Error('cannot create a new file journal key');
    }
    created = true;
    fs.fchmodSync(fd, 0o600);
    key = crypto.randomBytes(32);
    fs.writeFileSync(fd, key); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const open = fs.fstatSync(dirFd), named = fs.lstatSync(parent);
    if (!privateDirectory(open) || !privateDirectory(named) || open.dev !== named.dev || open.ino !== named.ino) throw new Error();
    fs.fsyncSync(dirFd);
  } catch (error) {
    if (created) throw new Error('key creation did not complete; the file may exist: stop and inspect it before use');
    throw error;
  } finally {
    key?.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
}
function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 2 || args[0] !== '--key-file' || !args[1] || args[1].startsWith('--')) throw new Error('expected --key-file NEW-KEY');
  initializeFileJournalKey(args[1]);
  console.log('Created a new private file-journal key. Securely back it up; no journal or payment was created.');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(`[file-journal-key] ERROR: ${error.message}`); process.exitCode = 1; }
}
