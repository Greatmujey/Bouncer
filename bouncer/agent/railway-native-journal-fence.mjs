/**
 * Linux/one-volume host fence for the existing encrypted FileJournal.
 * A kernel flock is held by THIS process until close or death. It coordinates
 * only cooperating processes sharing the same honest filesystem; it is not a
 * distributed consensus or an independent rollback checkpoint.
 *
 * An unclean shutdown leaves the FileJournal marker. Only an exact marker
 * written by this fenced runtime can be reclaimed, only after the kernel lock
 * is held again, and only in recovery mode. Unknown/legacy locks fail closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const MARKER = Buffer.from('bouncer-railway-fenced-journal-v1\n');
const RECOVERY = Buffer.from('bouncer-native-reconciliation-required-v1\n');
const STARTED = Buffer.from('bouncer-native-recovery-started-v1\n');
const FLAGS = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function syncParent(file) {
  const fd=fs.openSync(path.dirname(file),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
}
function sameFile(file,fd) {
  const a=fs.fstatSync(fd),b=fs.lstatSync(file);
  if(!a.isFile()||!b.isFile()||b.isSymbolicLink()||a.nlink!==1||b.nlink!==1||a.dev!==b.dev||a.ino!==b.ino||
      (a.mode&0o077)!==0 || (typeof process.getuid==='function' && a.uid!==process.getuid())) throw new Error('unsafe journal fence');
}
function hasExactMarker(file, expected) {
  let fd;
  try {
    try {fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}
    catch(error) {if(error.code==='ENOENT')return false;throw error}
    sameFile(file,fd);
    if(fs.fstatSync(fd).size!==expected.length || !fs.readFileSync(fd).equals(expected)) throw new Error('unknown journal lock; manual recovery required');
    return true;
  } finally {if(fd!==undefined)fs.closeSync(fd)}
}
function createExactMarker(file, contents) {
  if(hasExactMarker(file,contents))return;
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,contents);fs.fsyncSync(fd);
  } finally {if(fd!==undefined)fs.closeSync(fd)}
  syncParent(file);
}
function lock(fd,file) {
  const acquire=spawnSync('/usr/bin/flock',['-n','-x','3'],{stdio:['ignore','ignore','ignore',fd],timeout:5000});
  if(acquire.error || acquire.status!==0)throw new Error('another mission process holds the persistent-volume fence');
  // A second, distinct open description must be unable to take the same
  // lock. Fail shut if flock is absent or the filesystem does not enforce it.
  sameFile(file,fd);
  const other=spawnSync('/usr/bin/flock',['-n','-x',file,'true'],{stdio:'ignore',timeout:5000});
  if(other.error || other.status!==1)throw new Error('persistent volume did not enforce the exclusive journal fence');
  sameFile(file,fd);
}

/** Called only after validating the declared volume and owner-private parent. */
export function acquireRailwayNativeJournalFence({journalFile, mode} = {}) {
  if(typeof journalFile!=='string'||!path.isAbsolute(journalFile)||!['recover','execute'].includes(mode)) throw new Error('invalid Railway journal fence');
  const file=`${journalFile}.host-fence`, markerFile=`${journalFile}.lock`, recoveryFile=`${journalFile}.recovery-required`,
    startedFile=`${journalFile}.recovery-started`;
  let fd, reclaimed=false, tagged=false, closed=false, recoveryRequired=false, markedJournal;
  try {
    fd=fs.openSync(file,FLAGS,0o600);sameFile(file,fd);lock(fd,file);syncParent(file);
    recoveryRequired=hasExactMarker(recoveryFile,RECOVERY);
    if(recoveryRequired && mode!=='recover')throw new Error('unclean shutdown: start recovery-only and reconcile originals before execution');
    if(hasExactMarker(markerFile,MARKER)) {
      if(mode!=='recover')throw new Error('unclean shutdown: start recovery-only and reconcile originals before execution');
      // Durably record the reconciliation requirement BEFORE removing the
      // old lock. Even a crash or wrong key during startup cannot bypass it.
      createExactMarker(recoveryFile,RECOVERY);recoveryRequired=true;
      fs.unlinkSync(markerFile);syncParent(markerFile);reclaimed=true;
    }
    const recoveryStarted=hasExactMarker(startedFile,STARTED);
    if(mode==='execute'&&!recoveryStarted)throw new Error('start in recovery-only mode before enabling execution');
  } catch(error) {if(fd!==undefined)fs.closeSync(fd);throw error}
  return Object.freeze({
    reclaimed,
    get recoveryRequired(){return recoveryRequired},
    mark(journal) {
      if(closed||tagged||!journal||journal.lockFile!==markerFile||!Number.isInteger(journal.lockFd)) throw new Error('invalid fenced journal marker');
      sameFile(file,fd);sameFile(markerFile,journal.lockFd);
      if(fs.fstatSync(journal.lockFd).size!==0)throw new Error('unexpected journal marker contents');
      fs.writeSync(journal.lockFd,MARKER,0,MARKER.length,0);fs.fsyncSync(journal.lockFd);syncParent(markerFile);
      markedJournal=journal;tagged=true;
    },
    recordRecoveryStart() {
      if(closed||!tagged||mode!=='recover')throw new Error('recovery-only fenced journal required');
      sameFile(file,fd);sameFile(markerFile,markedJournal.lockFd);
      createExactMarker(startedFile,STARTED);
    },
    completeRecovery({result,originals} = {}) {
      if(closed||!tagged||mode!=='recover')throw new Error('recovery-only fenced journal required');
      if(!recoveryRequired)return;
      const rows=originals?.originals,deliveries=result?.deliveries;
      if(!['RECOVERED','RECOVERED_PARTIAL'].includes(result?.status) || result.new_payments!==0 ||
          originals?.status!=='LOCAL_ORIGINALS' || !Array.isArray(rows) || !rows.length ||
          !Array.isArray(deliveries) || rows.length!==deliveries.length ||
          new Set(rows.map(row=>row?.goal_id)).size!==rows.length || rows.some((row,index)=> {
            const entry=typeof row?.goal_id==='string' ? markedJournal.get(row.goal_id) : null;
            return row?.status!=='completed' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.goal_id || '') ||
              !isTransactionHash(row.original_hash) || entry?.status!=='completed' || entry.tx_hash!==row.original_hash ||
              row.goal_id!==deliveries[index]?.goal_id || row.original_hash!==deliveries[index]?.delivery?.tx_hash;
          })) {
        throw new Error('verified original receipts required before clearing recovery-only');
      }
      sameFile(file,fd);
      if(!hasExactMarker(recoveryFile,RECOVERY))throw new Error('recovery marker changed; stop and reconcile');
      fs.unlinkSync(recoveryFile);syncParent(recoveryFile);recoveryRequired=false;
    },
    close() {if(!closed){closed=true;fs.closeSync(fd)}},
  });
}
