/**
 * A NON-SECRET marker for one controlled Railway volume-persistence check.
 * It is separate from every checkpoint, journal and recovery kit. It cannot
 * sign, authenticate a user, enable a route, or authorize a transaction.
 *
 * Phase 1 exclusively creates and fsyncs a random marker; phase 2 MUST only
 * observe it. Matching fingerprints after a redeployment are evidence of this
 * marker surviving that restart, not proof of crash durability, independent
 * administration, rollback protection, recovery of real data or latest head.
 *
 * An interrupted creation leaves an exclusive lock, and an existing malformed
 * marker or stale lock is never removed or repaired automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

// This diagnostic is intentionally limited to the already-mounted volume of
// this one standby service, never to other Railway projects or environments.
const PROJECT='3ec18e48-2aff-41d7-bcb6-cb43fb1815c7';
const SERVICE='3de96476-d197-40fb-9c17-ee5ebdb3ad65';
const ENVIRONMENT='b44a0026-ada6-483f-bfc1-9f05ca9c84a9';
const PREFIX='.bouncer-volume-check-82d80f6e-v1';
const HEX=/^[a-f0-9]{64}$/;

export function isRailwayRecoveryProbeTarget(env=process.env) {
  return env.RAILWAY_PROJECT_ID===PROJECT&&env.RAILWAY_SERVICE_ID===SERVICE&&
    env.RAILWAY_ENVIRONMENT_ID===ENVIRONMENT&&env.RAILWAY_VOLUME_MOUNT_PATH==='/data';
}
function syncDirectory(root) {
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try {fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
}
function absent(file) {
  try {fs.lstatSync(file);return false} catch(error) {if(error?.code==='ENOENT')return true;throw error}
}
function readMarker(file) {
  // O_NOFOLLOW + fstat reject symlinks, directories, hard links and malformed
  // data. The random contents contain no account, checkpoint or secret data.
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size!==64)throw Error('invalid marker');
    const text=fs.readFileSync(fd,'utf8');
    if(!HEX.test(text))throw Error('invalid marker');
    return createHash('sha256').update(text).digest('hex');
  } finally {fs.closeSync(fd)}
}
function newFile(file,text) {
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
}

/** The caller must first verify that root is the declared, writable mount.
 * The observe-only mode never creates, repairs or deletes anything. */
export function runRailwayRecoveryVolumeProbe({root,phase,mode}={}) {
  if(!((phase==='initial'&&mode==='create-once')||(phase==='after-redeploy'&&mode==='observe-only')))
    throw Error('invalid probe configuration');
  const result=(status,fingerprint=null)=>Object.freeze({phase,status,fingerprint,transaction_authorized:false});
  try {
    if(typeof root!=='string'||!path.isAbsolute(root)||root==='/'||path.normalize(root)!==root||fs.realpathSync(root)!==root)throw Error();
    const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error();
    const marker=path.join(root,PREFIX),lock=path.join(root,`${PREFIX}.lock`);
    if(!absent(lock))return result('LOCKED');
    if(!absent(marker)) {
      const fingerprint=readMarker(marker);
      if(!absent(lock))return result('LOCKED');
      return result('OBSERVED',fingerprint);
    }
    if(mode==='observe-only')return result('MISSING');
    // The exclusive lock is durable before touching the marker. If anything
    // becomes uncertain, it remains for human inspection instead of repair.
    newFile(lock,'pending');syncDirectory(root);
    if(!absent(marker)) {
      // Another actor created it between our read and lock. Do not replace it.
      // Removing our own lock is safe because no marker mutation was made.
      let fingerprint;try {fingerprint=readMarker(marker)} finally {fs.unlinkSync(lock);syncDirectory(root)}
      return result('OBSERVED',fingerprint);
    }
    const nonce=randomBytes(32).toString('hex');
    newFile(marker,nonce);syncDirectory(root);
    const fingerprint=readMarker(marker);
    fs.unlinkSync(lock);syncDirectory(root);
    return result('CREATED',fingerprint);
  } catch {return result('UNAVAILABLE')}
}
