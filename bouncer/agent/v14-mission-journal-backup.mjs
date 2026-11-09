/** Research-only encrypted native mission-journal backup coordination.
 *
 * Before a new original can be witnessed/sent, copy the exact authenticated
 * encrypted FileJournal to an independently provisioned, append-only store.
 * After a FINAL result, copy the completed journal before advancing the witness.
 * A store must atomically bind an append to the CURRENT witness revision/head;
 * the generic interface cannot prove that it does. No live service enables this.
 * Never put plaintext, keys, passphrases or signed transactions in this store.
 * Rollback of both the witness and backup (or a compromised operator) is not
 * prevented. Restoring requires an independently retained latest head, owner
 * action, receipt reconciliation and a recovery-only runtime, not a new send.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {FileJournal} from './procurement.mjs';
import {decryptFileJournal,FILE_JOURNAL_FORMAT} from './file-journal-crypto.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
import {createV14MissionOriginalCheckpoint,createV14MissionOriginalVerifier} from './v14-mission-original-checkpoint.mjs';
import {inspectV14OriginalSnapshot,isV14OriginalWitness} from './v14-original-witness.mjs';

const FORMAT='bouncer-v14-mission-journal-backup-v1',MAX_BYTES=256_000;
const HEX=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const fields=['format','scope_id','owner','vault','review_sha256','mission_sha256','witness_revision','witness_head_sha256',
  'goal_id','kind','tx_hash','fingerprint','phase','ciphertext_sha256','ciphertext'];
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const fail=()=>new Error('encrypted V14 mission backup is missing, mismatched or uncertain; stop and reconcile without another send');
const same=(a,b)=>isDeepStrictEqual(a,b);
function checkInput(input,binding) {
  if(!exact(input,['goal_id','kind','tx_hash','fingerprint','owner','vault','mission_sha256'])||
      input.owner!==binding.owner||input.vault!==binding.vault||input.mission_sha256!==binding.mission_sha256||
      !binding.goals.some(g=>g.id===input.goal_id&&g.kind===input.kind)||!isTransactionHash(input.tx_hash)||!HEX.test(input.fingerprint??''))throw fail();
}
function checkRecord(record,binding) {
  if(!exact(record,fields)||record.format!==FORMAT||record.scope_id!==binding.scope_id||record.owner!==binding.owner||
      record.vault!==binding.vault||record.review_sha256!==binding.review_sha256||record.mission_sha256!==binding.mission_sha256||
      !Number.isSafeInteger(record.witness_revision)||record.witness_revision<1||record.witness_revision>31||
      !HEX.test(record.witness_head_sha256??'')||!ID.test(record.goal_id??'')||
      !binding.goals.some(g=>g.id===record.goal_id&&g.kind===record.kind)||!isTransactionHash(record.tx_hash)||
      !HEX.test(record.fingerprint??'')||!['pending','completed'].includes(record.phase)||!HEX.test(record.ciphertext_sha256??'')||
      typeof record.ciphertext!=='string'||Buffer.byteLength(record.ciphertext,'utf8')>MAX_BYTES||
      hash(record.ciphertext)!==record.ciphertext_sha256)throw fail();
  let envelope;try{envelope=JSON.parse(record.ciphertext)}catch{throw fail()}
  if(!exact(envelope,['format','cipher','nonce','ciphertext','tag'])||envelope.format!==FILE_JOURNAL_FORMAT||
      envelope.cipher!=='aes-256-gcm'||`${JSON.stringify(envelope)}\n`!==record.ciphertext)throw fail();
  return structuredClone(record);
}
function checkJournal(data,binding,rows) {
  const mission=binding.public_review.mission;
  if(!data||data.version!==1||data.contract_id!==binding.vault||data.owner_account_id!==binding.owner||
      !Array.isArray(data.entries)||data.entries.length!==rows.length+1)throw fail();
  const intent=data.entries.find(e=>e?.id===`native-mission:${mission.id}`);
  if(!intent||intent.kind!=='native-mission-intent-v1'||intent.status!=='pending'||
      intent.fingerprint!==hash(`bouncer-native-mission-v1\0${JSON.stringify(mission)}`)||!same(intent.mission,mission))throw fail();
  if(new Set(data.entries.map(e=>e?.id)).size!==data.entries.length)throw fail();
  for(const row of rows) {
    const entry=data.entries.find(e=>e?.id===row.goal_id),goalKey=row.kind==='oracle'?'oracle_goal':row.kind==='storage'?'storage_goal':'outlayer_goal';
    if(!entry||entry.status!==row.status||entry.tx_hash!==row.tx_hash||entry.fingerprint!==row.fingerprint||
        entry.agent_public_key!==binding.public_review.agent_public_keys[row.goal_id]||!entry[goalKey]||
        hash(JSON.stringify(entry[goalKey]))!==row.fingerprint||
        (row.status==='completed'&&entry.delivery?.tx_hash!==row.tx_hash))throw fail();
  }
}
function rowsFromState(state,current,status) {
  const rows=state.mission.map(row=>({...row,status:'completed'}));
  if(current) rows.push({...current,status});
  return rows;
}
function recordFor(input,binding,state,phase,ciphertext) {
  return checkRecord({format:FORMAT,scope_id:binding.scope_id,owner:binding.owner,vault:binding.vault,
    review_sha256:binding.review_sha256,mission_sha256:binding.mission_sha256,witness_revision:state.revision,
    witness_head_sha256:state.head_sha256,goal_id:input.goal_id,kind:input.kind,tx_hash:input.tx_hash,
    fingerprint:input.fingerprint,phase,ciphertext_sha256:hash(ciphertext),ciphertext},binding);
}
function eventFor(history,type,goalId) {
  const events=history.events.map(line=>JSON.parse(line));
  const matches=events.filter(e=>e.type===type&&e.data?.goal_id===goalId);
  if(matches.length!==1)throw fail();return matches[0];
}
function checkedHistoricalBackup({record,history,binding,journal,goalId,kind,txHash,fingerprint}) {
  const verified=eventFor(history,'mission_verified',goalId);
  const original=eventFor(history,'mission_original',goalId);
  if(verified.seq!==original.seq+1||verified.data.tx_hash!==txHash||original.data.tx_hash!==txHash||
      original.data.kind!==kind||original.data.fingerprint!==fingerprint||record.witness_revision!==verified.seq-1||
      record.witness_head_sha256!==verified.previous_sha256||record.phase!=='completed'||record.goal_id!==goalId||
      record.kind!==kind||record.tx_hash!==txHash||record.fingerprint!==fingerprint)throw fail();
  const prefix={revision:verified.seq,head_sha256:hash(history.events[verified.seq-1]),events:history.events.slice(0,verified.seq)};
  const state=inspectV14OriginalSnapshot(prefix,binding);
  checkJournal(journal.inspectEncryptedSnapshot(record.ciphertext),binding,rowsFromState(state));
}

/** Pair these hooks only with a separately reviewed durable store. `append`
 * must atomically compare the record's witness_revision/head to the separate
 * checkpoint stream before inserting, and `read` must return the exact saved
 * record (or null). Neither a store interface nor a successful reply proves
 * independence or durability. On uncertain writes, stop; no automatic retry. */
export function createV14BackedMissionHooks({journal,witness,backupStore}={}) {
  if(!(journal instanceof FileJournal)||!journal.encryptionEnabled||!isV14OriginalWitness(witness)||
      !backupStore||typeof backupStore.read!=='function'||typeof backupStore.append!=='function')throw fail();
  const binding=witness.binding();journal.assertScope(binding.vault,binding.owner);
  const retain=createV14MissionOriginalCheckpoint({witness}),verify=createV14MissionOriginalVerifier({witness});
  async function read(goalId,phase) {
    const result=await backupStore.read({goal_id:goalId,phase});
    return result===null?null:checkRecord(result,binding);
  }
  async function save(record) {
    const prior=await read(record.goal_id,record.phase);
    if(prior===null) {
      const ack=await backupStore.append(structuredClone(record));
      if(!same(checkRecord(ack,binding),record))throw fail();
    } else if(!same(prior,record))throw fail();
    if(!same(await read(record.goal_id,record.phase),record))throw fail();
  }
  async function ensureUnchanged(ciphertext) {
    if(journal.exportEncryptedSnapshot()!==ciphertext)throw fail();
  }
  return Object.freeze({
    beforeOriginalBroadcast:async input=>{
      checkInput(input,binding);
      const state=await witness.inspect();
      if(!state.reserved||state.pending!==null||state.next_setup_stage!==null||state.next_mission_goal!==input.goal_id)throw fail();
      const ciphertext=journal.exportEncryptedSnapshot();
      checkJournal(journal.inspectEncryptedSnapshot(ciphertext),binding,rowsFromState(state,input,'pending'));
      const backup=recordFor(input,binding,state,'pending',ciphertext);
      await save(backup);await ensureUnchanged(ciphertext);
      const ack=await retain(input);
      if(!same(await read(input.goal_id,'pending'),backup))throw fail();
      await ensureUnchanged(ciphertext);
      return ack;
    },
    afterOriginalVerified:async input=>{
      checkInput(input,binding);
      const state=await witness.inspect(),existing=state.mission.find(row=>row.goal_id===input.goal_id);
      if(existing) {
        if(existing.kind!==input.kind||existing.tx_hash!==input.tx_hash||existing.fingerprint!==input.fingerprint)throw fail();
        const record=await read(input.goal_id,'completed'),history=await witness.history();
        if(!record)throw fail();
        checkedHistoricalBackup({record,history,binding,journal,goalId:input.goal_id,kind:input.kind,
          txHash:input.tx_hash,fingerprint:input.fingerprint});
        return verify(input);
      }
      if(state.pending?.type!=='mission'||state.pending.goal_id!==input.goal_id||state.pending.kind!==input.kind||
          state.pending.tx_hash!==input.tx_hash||state.pending.fingerprint!==input.fingerprint)throw fail();
      const ciphertext=journal.exportEncryptedSnapshot();
      checkJournal(journal.inspectEncryptedSnapshot(ciphertext),binding,rowsFromState(state,input,'completed'));
      const backup=recordFor(input,binding,state,'completed',ciphertext);
      await save(backup);await ensureUnchanged(ciphertext);
      const ack=await verify(input);
      if(!same(await read(input.goal_id,'completed'),backup))throw fail();
      await ensureUnchanged(ciphertext);
      return ack;
    },
  });
}

/** Authenticate one newest backup against a separately retained witness head.
 * This reads no chain and writes no files. A correct ciphertext is not evidence
 * that the independently supplied head is latest, that any transaction is
 * final, or that the caller may send a transaction. */
export function inspectV14MissionJournalBackup({record:raw,history,binding,encryptionKey,trustedRevision,trustedHeadSha256}={}) {
  if(!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32||!Number.isSafeInteger(trustedRevision)||
      !HEX.test(trustedHeadSha256??'')||history?.revision!==trustedRevision||history?.head_sha256!==trustedHeadSha256)throw fail();
  const state=inspectV14OriginalSnapshot(history,binding),record=checkRecord(raw,binding);
  const last=JSON.parse(history.events.at(-1)??'null');
  if(!last)throw fail();
  let rows,originalRecorded=false,resultVerified=false;
  // Normal case: the backup is anchored to the head immediately BEFORE the
  // corresponding original or verified event in the trusted history.
  if(['mission_original','mission_verified'].includes(last.type)&&record.witness_revision===last.seq-1&&
      record.witness_head_sha256===last.previous_sha256&&record.goal_id===last.data.goal_id&&record.tx_hash===last.data.tx_hash&&
      record.phase===(last.type==='mission_original'?'pending':'completed')) {
    const current=last.type==='mission_original'?state.pending:state.mission.at(-1);
    if(!current||current.kind!==record.kind||current.fingerprint!==record.fingerprint||current.tx_hash!==record.tx_hash)throw fail();
    originalRecorded=true;resultVerified=last.type==='mission_verified';
    rows=rowsFromState(state,last.type==='mission_original'?state.pending:null,'pending');
  // Crash window: backup committed but its witness append did not. Restore a
  // quarantined pending copy only, never infer non-execution or resend.
  } else if(record.phase==='pending'&&record.witness_revision===history.revision&&record.witness_head_sha256===history.head_sha256&&
      state.pending===null&&state.next_setup_stage===null&&state.next_mission_goal===record.goal_id) {
    rows=rowsFromState(state,record,'pending');
  // Crash window: completed ciphertext committed while the witness still has
  // the original pending. Recovery must recheck FINAL before advancing it.
  } else if(record.phase==='completed'&&record.witness_revision===history.revision&&record.witness_head_sha256===history.head_sha256&&
      state.pending?.type==='mission'&&state.pending.goal_id===record.goal_id&&state.pending.kind===record.kind&&
      state.pending.tx_hash===record.tx_hash&&state.pending.fingerprint===record.fingerprint) {
    originalRecorded=true;rows=rowsFromState(state,state.pending,'completed');
  } else throw fail();
  let data;try{data=decryptFileJournal(JSON.parse(record.ciphertext),encryptionKey,binding.vault,binding.owner)}catch{throw fail()}
  checkJournal(data,binding,rows);
  return Object.freeze({status:'AUTHENTICATED_RECOVERY_COPY_ONLY',scope_id:binding.scope_id,goal_id:record.goal_id,
    tx_hash:record.tx_hash,phase:record.phase,witness_revision:trustedRevision,witness_head_sha256:trustedHeadSha256,
    witness_original_recorded:originalRecorded,witness_result_verified:resultVerified,
    journal_restored:false,receipts_verified:false,transaction_authorized:false});
}

/** Write ONLY a new, separate recovery copy after ciphertext/history checks.
 * This does not replace or activate a live journal, prove the supplied head is
 * latest, verify receipts, lock out another host, or authorize spending. The
 * caller must use an owner-private directory on a trusted local filesystem and
 * reconcile every original under the runtime's recovery-only fence. An error
 * after creation may leave a file: preserve it rather than trying to overwrite. */
export function writeV14MissionRecoveryCopy({file,copyOnly,...inspection}={}) {
  if(copyOnly!==true||typeof file!=='string'||!path.isAbsolute(file)||!file.endsWith('.recovery.enc')||
      path.resolve(file)!==file||file.includes('\0'))throw fail();
  const result=inspectV14MissionJournalBackup(inspection),dir=path.dirname(file);
  let parent,fd,readFd,bytes;
  try {
    const resolved=fs.realpathSync(dir),info=fs.lstatSync(dir);
    if(resolved!==dir||!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||
        (typeof process.getuid==='function'&&info.uid!==process.getuid()))throw fail();
    parent=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const parentStat=fs.fstatSync(parent);
    if(parentStat.dev!==info.dev||parentStat.ino!==info.ino)throw fail();
    fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,inspection.record.ciphertext,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.fsyncSync(parent);
    const currentParent=fs.lstatSync(dir);
    if(!currentParent.isDirectory()||currentParent.isSymbolicLink()||currentParent.dev!==parentStat.dev||currentParent.ino!==parentStat.ino||
        (currentParent.mode&0o077)!==0||currentParent.uid!==info.uid)throw fail();
    readFd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const saved=fs.fstatSync(readFd),named=fs.lstatSync(file);
    if(!saved.isFile()||!named.isFile()||named.isSymbolicLink()||saved.nlink!==1||named.nlink!==1||
        saved.dev!==named.dev||saved.ino!==named.ino||(saved.mode&0o077)!==0||
        (typeof process.getuid==='function'&&saved.uid!==process.getuid())||saved.size<=0||saved.size>MAX_BYTES)throw fail();
    bytes=fs.readFileSync(readFd);
    if(bytes.length!==saved.size||bytes.toString('utf8')!==inspection.record.ciphertext)throw fail();
    return Object.freeze({...result,status:'RECOVERY_COPY_WRITTEN',journal_restored:false});
  } catch {throw new Error('V14 recovery copy failed or may already exist; preserve any file and reconcile manually');}
  finally {bytes?.fill(0);if(readFd!==undefined)fs.closeSync(readFd);if(fd!==undefined)fs.closeSync(fd);if(parent!==undefined)fs.closeSync(parent)}
}
