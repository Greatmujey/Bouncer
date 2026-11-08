#!/usr/bin/env node
/** Explicit one-time initialization for a NEW testnet vault/mission only.
 * Never use this to replace a missing journal or restart an uncertain mission. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertPrivateParent, readConfiguredMission } from '../agent/configured-native-mission-site.mjs';
import { encryptFileJournal, readFileJournalKeyFile } from '../agent/file-journal-crypto.mjs';

export function initializeNativeMissionJournal({missionFile,journalFile,keyFile,confirmBrandNewVault=false}={}) {
  if(confirmBrandNewVault!==true)throw new Error('explicit brand-new-vault confirmation is required');
  const mission=readConfiguredMission(missionFile);
  assertPrivateParent(journalFile);assertPrivateParent(keyFile);
  const key=readFileJournalKeyFile(keyFile);let fd,dirFd,created=false,check;
  try {
    const intent={id:`native-mission:${mission.id}`,kind:'native-mission-intent-v1',status:'pending',
      fingerprint:crypto.createHash('sha256').update(`bouncer-native-mission-v1\0${JSON.stringify(mission)}`).digest('hex'),
      mission,created_at:new Date().toISOString()};
    const ciphertext=encryptFileJournal({version:1,contract_id:mission.contract_id,owner_account_id:mission.owner_account_id,entries:[intent]},
      key,mission.contract_id,mission.owner_account_id);
    dirFd=fs.openSync(path.dirname(journalFile),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const before=fs.fstatSync(dirFd),named=fs.lstatSync(path.dirname(journalFile));
    if(before.dev!==named.dev||before.ino!==named.ino)throw new Error('journal directory changed');
    check=readFileJournalKeyFile(keyFile);
    if(!crypto.timingSafeEqual(key,check))throw new Error('journal key changed');
    check.fill(0);check=null;
    fd=fs.openSync(journalFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    created=true;fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,ciphertext);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    const after=fs.lstatSync(path.dirname(journalFile));
    if(before.dev!==after.dev||before.ino!==after.ino)throw new Error('journal directory changed');
    fs.fsyncSync(dirFd);
    return {status:'NEW_JOURNAL_INITIALIZED',transactions_sent:0};
  } catch(error) {
    if(created)throw new Error('journal creation was uncertain; preserve and inspect the original file, never initialize a replacement');
    if(error.code==='EEXIST')throw new Error('journal path already exists; refusing to overwrite it');
    throw error;
  } finally {key.fill(0);check?.fill(0);if(fd!==undefined)fs.closeSync(fd);if(dirFd!==undefined)fs.closeSync(dirFd)}
}
const USAGE=`Usage: node scripts/init-native-mission-journal.mjs --confirm-brand-new-vault

Only for a genuinely new testnet vault/mission with no earlier attempts. This
creates one encrypted journal exclusively and never overwrites an existing
path. It cannot prove that a previous journal did not exist. Never use it to
replace a missing journal, recover an uncertain send, or bypass an earlier
original. Back up the original journal and key; encryption does not prevent
rollback. Required environment: BOUNCER_NATIVE_MISSION_FILE,
BOUNCER_NATIVE_MISSION_JOURNAL_FILE, BOUNCER_FILE_JOURNAL_KEY_FILE.
No network request, wallet prompt or transaction is made.
`;
function main() {
  if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USAGE);return}
  if(process.argv.length!==3||process.argv[2]!=='--confirm-brand-new-vault')throw new Error('explicit confirmation is required');
  initializeNativeMissionJournal({missionFile:process.env.BOUNCER_NATIVE_MISSION_FILE,journalFile:process.env.BOUNCER_NATIVE_MISSION_JOURNAL_FILE,
    keyFile:process.env.BOUNCER_FILE_JOURNAL_KEY_FILE,confirmBrandNewVault:true});
  console.log('Created the new encrypted testnet mission journal. No transaction was sent. Preserve and back it up securely.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try{main()}catch(error){console.error(`[mission-journal] ${error.message}`);process.exitCode=1}
}
