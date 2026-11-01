/**
 * Optional, local pre-broadcast checkpoints for one shared direct-v3 journal.
 * The directory and journal key have separate trust boundaries. The filesystem
 * must honor exclusive creation and fsync; this is not replication or proof of
 * freshness if the directory itself is rolled back or lost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { BuyerJournalError, MAX_BUYER_SNAPSHOT_BYTES, verifyEncryptedBuyerSnapshot,
  compareEncryptedBuyerSnapshots } from './postgres-buyer-journal.mjs';

const MAX_FILES = 256;
const filePattern = /^([0-9]{6})-([1-9A-HJ-NP-Za-km-z]{32,64})\.json$/;
const unusable = () => new BuyerJournalError('CHECKPOINT_DIRECTORY', 'buyer checkpoint directory is unsafe, incomplete or unreadable; stop and reconcile');
function ownerOnly(stat, kind) {
  return stat && (kind === 'directory' ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
function readSnapshot(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!ownerOnly(stat, 'file') || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_BUYER_SNAPSHOT_BYTES) throw unusable();
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0, n;
    while (offset < bytes.length && (n = fs.readSync(fd, bytes, offset, bytes.length - offset, null)) > 0) offset += n;
    if (offset !== stat.size) throw unusable();
    return bytes.subarray(0, offset).toString('utf8');
  } catch { throw unusable(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Open an existing, dedicated owner-only directory. If it already contains
 * checkpoints, authenticate the latest against the current original journal
 * before allowing new work. A fresh directory is only valid for an empty
 * journal; this avoids silently accepting an uncheckpointed payment history.
 * `previousKey` is optional for the latest checkpoint across one key rotation.
 */
export async function openBuyerCheckpointDirectory({ directory, journal, currentKey, previousKey }) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0') || journal?.sharedDirectV3 !== true ||
      typeof journal.exportEncryptedSnapshot !== 'function' || !Buffer.isBuffer(currentKey) || currentKey.length !== 32 ||
      (previousKey !== undefined && (!Buffer.isBuffer(previousKey) || previousKey.length !== 32))) throw unusable();
  const root = path.resolve(directory); let dirfd, closed = false, busy = false;
  try {
    dirfd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const identity = fs.fstatSync(dirfd);
    if (!ownerOnly(identity, 'directory')) throw unusable();
    function checkDirectory() {
      if (closed) throw unusable();
      try {
        const open = fs.fstatSync(dirfd), named = fs.lstatSync(root);
        if (!ownerOnly(open, 'directory') || !ownerOnly(named, 'directory') || open.dev !== identity.dev || open.ino !== identity.ino ||
            named.dev !== identity.dev || named.ino !== identity.ino) throw unusable();
      } catch { throw unusable(); }
    }
    checkDirectory();
    const names = []; let scan;
    try {
      scan = fs.opendirSync(root);
      for (let item; (item = scan.readSync()) !== null;) {
        if (names.length >= MAX_FILES || !item.isFile()) throw unusable();
        const match = filePattern.exec(item.name), count = match && Number(match[1]);
        if (!match || count < 1 || count > MAX_FILES || !isTransactionHash(match[2])) throw unusable();
        names.push({ name: item.name, count, hash: match[2] });
      }
    } finally { scan?.closeSync(); }
    names.sort((a, b) => a.count - b.count);
    if (names.some((item, index) => item.count !== index + 1)) throw unusable();
    checkDirectory();
    const currentCount = journal.list().length;
    if (currentCount !== names.length) throw unusable();
    // Check even a new, empty journal: its key file may have changed between
    // opening the session and configuring the checkpoint directory.
    const current = await journal.exportEncryptedSnapshot();
    if (verifyEncryptedBuyerSnapshot(current, currentKey).count !== currentCount) throw unusable();
    checkDirectory();
    let count = names.length;
    if (count) {
      const latest = names[count - 1], previous = readSnapshot(path.join(root, latest.name));
      let key = currentKey, summary;
      try { summary = verifyEncryptedBuyerSnapshot(previous, key); }
      catch (error) {
        if (!previousKey || error?.code !== 'SNAPSHOT_INVALID') throw error;
        key = previousKey; summary = verifyEncryptedBuyerSnapshot(previous, key);
      }
      if (summary.count !== latest.count || !summary.entries.some(item => item.tx_hash === latest.hash && item.status === 'pending')) throw unusable();
      compareEncryptedBuyerSnapshots({ previous, previousKey: key, current, currentKey });
      checkDirectory();
    }
    return Object.freeze({
      assertCapacity(additional = 1) {
        checkDirectory();
        if (!Number.isSafeInteger(additional) || additional < 0 || count + additional > MAX_FILES) {
          throw new BuyerJournalError('CHECKPOINT_LIMIT', 'buyer checkpoint capacity reached; do not reserve or send another payment');
        }
      },
      async checkpoint({ id, tx_hash: txHash }) {
        if (busy) throw unusable();
        busy = true;
        try {
          checkDirectory();
          const entry = journal.get(id);
          if (!entry || entry.status !== 'pending' || entry.tx_hash !== txHash || !isTransactionHash(txHash)) throw unusable();
          const serialized = await journal.exportEncryptedSnapshot();
          if (journal.list().length !== count + 1 || count >= MAX_FILES) throw unusable();
          const name = `${String(count + 1).padStart(6, '0')}-${txHash}.json`;
          let file;
          try {
            file = fs.openSync(path.join(root, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            fs.fchmodSync(file, 0o600); fs.writeFileSync(file, serialized, 'utf8'); fs.fsyncSync(file);
            fs.closeSync(file); file = undefined;
            checkDirectory(); fs.fsyncSync(dirfd); checkDirectory();
          } finally { if (file !== undefined) fs.closeSync(file); }
          count++;
        } catch (error) {
          if (error instanceof BuyerJournalError) throw error;
          throw unusable();
        } finally { busy = false; }
      },
      close() { if (!closed) { closed = true; fs.closeSync(dirfd); } },
    });
  } catch (error) {
    if (dirfd !== undefined) fs.closeSync(dirfd);
    if (error instanceof BuyerJournalError) throw error;
    throw unusable();
  }
}
