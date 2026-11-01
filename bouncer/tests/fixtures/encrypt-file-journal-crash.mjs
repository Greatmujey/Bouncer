// Fault-injection child used by file-journal-crypto.test.mjs. Never sends.
import fs from 'node:fs';
import { FileJournal } from '../../agent/procurement.mjs';
import { readFileJournalKeyFile } from '../../agent/file-journal-crypto.mjs';

const [file, keyFile, crashPoint] = process.argv.slice(2);
const sync = fs.fsyncSync, rename = fs.renameSync;
fs.fsyncSync = fd => {
  sync(fd);
  if (crashPoint === 'after-temp-sync') process.kill(process.pid, 'SIGKILL');
};
fs.renameSync = (from, to) => {
  rename(from, to);
  if (crashPoint === 'after-rename') process.kill(process.pid, 'SIGKILL');
};
const key = readFileJournalKeyFile(keyFile);
new FileJournal(file, 'bouncer.testnet', 'owner.testnet', { encryptionKey: key, migratePlaintext: true, requireExisting: true });
throw new Error('fault injection did not terminate');
