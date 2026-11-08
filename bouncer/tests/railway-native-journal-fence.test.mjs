// Local Linux filesystem only. No Railway, blockchain, wallet or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FileJournal } from '../agent/procurement.mjs';
import { acquireRailwayNativeJournalFence } from '../agent/railway-native-journal-fence.mjs';

const linuxFlockTest=process.platform==='linux'&&fs.existsSync('/usr/bin/flock') ? test : test.skip;
const owner='fence-owner.testnet',vault=`vault.${owner}`,key=Buffer.alloc(32,73);
const fileModule=fileURLToPath(new URL('../agent/procurement.mjs',import.meta.url));
const fenceModule=fileURLToPath(new URL('../agent/railway-native-journal-fence.mjs',import.meta.url));
function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-railway-fence-'));fs.chmodSync(dir,0o700);
  const file=path.join(dir,'originals.json'),journal=new FileJournal(file,vault,owner,{encryptionKey:key});
  journal.put('existing',{status:'pending',fingerprint:'synthetic',tx_hash:'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn'});journal.close();
  const recovery=acquireRailwayNativeJournalFence({journalFile:file,mode:'recover'}),reopened=new FileJournal(file,vault,owner,{encryptionKey:key,requireExisting:true});
  recovery.mark(reopened);recovery.recordRecoveryStart();reopened.close();recovery.close();
  return {dir,file,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

linuxFlockTest('execution is blocked until a recovery-only service has checked the original',()=>{
  const f=fixture();let fence,journal;
  try {
    fs.unlinkSync(`${f.file}.recovery-started`);
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'execute'}),/start in recovery-only mode/);
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'});
    journal=new FileJournal(f.file,vault,owner,{encryptionKey:key,requireExisting:true});fence.mark(journal);
    fence.recordRecoveryStart();journal.close();journal=null;fence.close();fence=null;
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'execute'});
    assert.equal(fence.reclaimed,false);
  } finally {journal?.close();fence?.close();f.clean()}
});

linuxFlockTest('kernel fence excludes another process and leaves the existing encrypted original untouched',()=>{
  const f=fixture();let fence,journal;
  try {
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'});assert.equal(fence.reclaimed,false);
    journal=new FileJournal(f.file,vault,owner,{encryptionKey:key,requireExisting:true});fence.mark(journal);
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'}),/another mission process/);
    assert.equal(journal.get('existing').tx_hash,'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn');
    assert.doesNotMatch(fs.readFileSync(f.file,'utf8'),/k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn/);
  } finally {journal?.close();fence?.close();f.clean()}
});

linuxFlockTest('after a crash only recovery may reclaim a known stale marker, never replace the original',()=>{
  const f=fixture();let fence,journal;
  try {
    const script=`import {FileJournal} from ${JSON.stringify(new URL(`file://${fileModule}`).href)};
      import {acquireRailwayNativeJournalFence} from ${JSON.stringify(new URL(`file://${fenceModule}`).href)};
      const key=Buffer.alloc(32,73),file=process.argv[1],fence=acquireRailwayNativeJournalFence({journalFile:file,mode:'execute'});
      const journal=new FileJournal(file,${JSON.stringify(vault)},${JSON.stringify(owner)},{encryptionKey:key,requireExisting:true});
      fence.mark(journal);journal.put('pending',{status:'pending',fingerprint:'synthetic',tx_hash:'p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV'});
      process.exit(75);`;
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',script,f.file],{encoding:'utf8',timeout:10_000});
    assert.equal(crashed.status,75,crashed.stderr);assert.equal(fs.existsSync(`${f.file}.lock`),true);
    const before=fs.readFileSync(f.file);
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'execute'}),/unclean shutdown/);
    assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(fs.existsSync(`${f.file}.lock`),true);
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'});assert.equal(fence.reclaimed,true);
    journal=new FileJournal(f.file,vault,owner,{encryptionKey:key,requireExisting:true});fence.mark(journal);
    assert.equal(journal.get('existing').tx_hash,'k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn');
    assert.equal(journal.get('pending').tx_hash,'p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV');
    assert.equal(fence.recoveryRequired,true);
    assert.throws(()=>fence.completeRecovery({result:{status:'RECOVERED_PARTIAL',new_payments:0,deliveries:[]},originals:{status:'LOCAL_ORIGINALS',originals:[]}}),/verified original receipts/);
    journal.close();journal=null;fence.close();fence=null;
    // Merely starting/stopping recovery, a wrong key, or a failed receipt
    // lookup cannot silently re-enable execution.
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'execute'}),/unclean shutdown/);
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'});
    journal=new FileJournal(f.file,vault,owner,{encryptionKey:key,requireExisting:true});fence.mark(journal);
    // Synthetic results imitate a successful, non-paying receipt lookup;
    // the real service verifies NEAR before marking either original complete.
    const hashes=['k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn','p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV'];
    const ids=['existing','pending'];
    const verified={result:{status:'RECOVERED_PARTIAL',new_payments:0,deliveries:ids.map((goal_id,i)=>({goal_id,delivery:{tx_hash:hashes[i]}}))},
      originals:{status:'LOCAL_ORIGINALS',originals:ids.map((goal_id,i)=>({goal_id,status:'completed',original_hash:hashes[i]}))}};
    assert.throws(()=>fence.completeRecovery(verified),/verified original receipts/); // journal is still pending
    for(const id of ids)journal.put(id,{...journal.get(id),status:'completed'});
    fence.completeRecovery(verified);
    assert.equal(fence.recoveryRequired,false);
    journal.close();journal=null;fence.close();fence=null;
    fence=acquireRailwayNativeJournalFence({journalFile:f.file,mode:'execute'});assert.equal(fence.reclaimed,false);
  } finally {journal?.close();fence?.close();f.clean()}
});

linuxFlockTest('unknown or unsafe lock markers are never removed automatically',()=>{
  const f=fixture();try {
    const marker=`${f.file}.lock`,before=fs.readFileSync(f.file);
    fs.writeFileSync(marker,'legacy or incomplete lock',{mode:0o600});
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'}),/unknown journal lock/);
    assert.equal(fs.readFileSync(marker,'utf8'),'legacy or incomplete lock');assert.deepEqual(fs.readFileSync(f.file),before);
    fs.unlinkSync(marker);fs.symlinkSync(f.file,marker);
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'}));
    assert.equal(fs.lstatSync(marker).isSymbolicLink(),true);assert.deepEqual(fs.readFileSync(f.file),before);
  } finally {f.clean()}
});

linuxFlockTest('unsafe host-fence files and invalid modes fail before touching the journal',()=>{
  const f=fixture();try {
    const before=fs.readFileSync(f.file),lock=`${f.file}.host-fence`;
    assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'other'}));
    fs.unlinkSync(lock); // synthetic fixture has no running process
    fs.symlinkSync(f.file,lock);assert.throws(()=>acquireRailwayNativeJournalFence({journalFile:f.file,mode:'recover'}));
    assert.deepEqual(fs.readFileSync(f.file),before);assert.equal(fs.lstatSync(lock).isSymbolicLink(),true);
  } finally {f.clean()}
});
