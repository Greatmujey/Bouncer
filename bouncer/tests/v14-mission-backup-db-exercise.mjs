// Shared exercise for disposable PostgreSQL and optional local PGlite only.
// All accounts, keys, receipts and ciphertext are synthetic; nothing is sent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {FileJournal} from '../agent/procurement.mjs';
import {createV14OriginalWitness,V14_WITNESS_GENESIS} from '../agent/v14-original-witness.mjs';
import {createV14BackedMissionHooks,inspectV14MissionJournalBackup} from '../agent/v14-mission-journal-backup.mjs';
import {fixture,scope,owner,vault} from './v14-witness-fixture.mjs';

const sha=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const txHash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const cap=sha('synthetic capability');
function memoryStore() {
  let state={revision:0,head_sha256:V14_WITNESS_GENESIS,events:[]};
  return {read:async()=>structuredClone(state),append:async({expected_revision,expected_head_sha256,record})=>{
    assert.equal(state.revision,expected_revision);assert.equal(state.head_sha256,expected_head_sha256);
    state={revision:state.revision+1,head_sha256:sha(record),events:[...state.events,record]};return structuredClone(state);
  }};
}
async function original(db,op,rev=null,head=null,record=null,capability=cap) {
  return (await db.query('SELECT public.bouncer_v14_original_checkpoint_v1($1,$2,$3,$4,$5,$6) AS value',
    [scope,capability,op,rev,head,record])).rows[0].value;
}
async function backup(db,op,goal,phase,rev=null,head=null,record=null,capability=cap) {
  return (await db.query('SELECT public.bouncer_v14_mission_journal_backup_v1($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [scope,capability,op,goal,phase,rev,head,record])).rows[0].value;
}

export async function exerciseV14MissionBackupDatabase(db) {
  const {binding}=fixture(),mission=binding.public_review.mission;
  const enrolled=(await db.query('SELECT public.bouncer_v14_enroll_v1($1,$2,$3,$4,$5,$6) AS value',
    [scope,cap,owner,vault,binding.public_review.owner_public_key,binding.review_sha256])).rows[0].value;
  assert.equal(enrolled.status,'ENROLLED');
  const local=memoryStore(),remote={
    read:()=>original(db,'read'),append:({expected_revision,expected_head_sha256,record})=>original(db,'append',expected_revision,expected_head_sha256,record),
  };
  const verify=async({txHash})=>({tx_hash:txHash,final_block_hash:txHashForBlock});
  const txHashForBlock=txHash(250);
  const witness=createV14OriginalWitness({binding,localStore:local,independentStore:remote,verifySetupReceipt:verify,verifyMissionReceipt:verify});
  await witness.reserve();
  for(let i=0;i<binding.stages.length;i++) {
    const stageId=binding.stages[i].id;
    await witness.claimWalletStage(stageId);await witness.retainWalletOriginal({stageId,txHash:txHash(i+1)});
    await witness.verifyWalletOriginal({stageId});
  }
  const backupStore={
    async read({goal_id,phase}) {const result=await backup(db,'read',goal_id,phase);
      if(result.status==='MISSING')return null;if(result.status!=='EXISTING_BACKUP')throw Error('backup unavailable');return result.record},
    async append(record) {const result=await backup(db,'append',record.goal_id,record.phase,record.witness_revision,
      record.witness_head_sha256,JSON.stringify(record));
      if(result.status!=='EXISTING_BACKUP')throw Error('backup unavailable');return result.record},
  };
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-backup-db-')),key=crypto.randomBytes(32);
  const journal=new FileJournal(path.join(dir,'mission.enc'),vault,owner,{encryptionKey:key});
  try {
    journal.put(`native-mission:${mission.id}`,{kind:'native-mission-intent-v1',status:'pending',
      fingerprint:sha(`bouncer-native-mission-v1\0${JSON.stringify(mission)}`),mission,created_at:'synthetic'});
    const first=mission.goals[0],id=first.goal.id,hash=txHash(80),fingerprint=sha(JSON.stringify(first.goal));
    const pending={status:'pending',fingerprint,tx_hash:hash,outlayer_goal:first.goal,agent_public_key:binding.public_review.agent_public_keys[id]};
    journal.put(id,pending);
    const hooks=createV14BackedMissionHooks({journal,witness,backupStore});
    const input={goal_id:id,kind:first.kind,tx_hash:hash,fingerprint,owner,vault,mission_sha256:binding.mission_sha256};
    assert.deepEqual(await backup(db,'read',id,'pending'),{status:'MISSING'});
    assert.deepEqual(await backup(db,'read',id,'pending',null,null,null,'f'.repeat(64)),{error:'unavailable'});
    const ack=await hooks.beforeOriginalBroadcast(input);
    assert.equal(ack.tx_hash,hash);assert.equal((await witness.inspect()).pending.tx_hash,hash);
    const pendingRecord=await backupStore.read({goal_id:id,phase:'pending'}),history=await witness.history();
    assert.equal(inspectV14MissionJournalBackup({record:pendingRecord,history,binding,encryptionKey:key,
      trustedRevision:history.revision,trustedHeadSha256:history.head_sha256}).phase,'pending');
    assert.deepEqual(await backup(db,'append',id,'pending',pendingRecord.witness_revision,pendingRecord.witness_head_sha256,
      JSON.stringify(pendingRecord)),{error:'unavailable'}); // stale witness head
    journal.put(id,{...pending,status:'completed',delivery:{tx_hash:hash},completed_at:'synthetic'});
    assert.equal((await hooks.afterOriginalVerified(input)).tx_hash,hash);
    assert.equal((await witness.inspect()).mission[0].tx_hash,hash);
    assert.equal((await hooks.afterOriginalVerified(input)).tx_hash,hash); // read-only idempotent verification
    const final=await witness.history(),completed=await backupStore.read({goal_id:id,phase:'completed'});
    assert.equal(inspectV14MissionJournalBackup({record:completed,history:final,binding,encryptionKey:key,
      trustedRevision:final.revision,trustedHeadSha256:final.head_sha256}).phase,'completed');
    for(const sql of ['UPDATE bouncer_v14_originals_v1.mission_journal_backups SET record=record',
      'DELETE FROM bouncer_v14_originals_v1.mission_journal_backups','TRUNCATE bouncer_v14_originals_v1.mission_journal_backups']) {
      await assert.rejects(db.query(sql));
    }
    // The second pending backup is accepted exactly once at the current head.
    const second=mission.goals[1],input2={goal_id:second.goal.id,kind:second.kind,tx_hash:txHash(81),
      fingerprint:sha(JSON.stringify(second.goal)),owner,vault,mission_sha256:binding.mission_sha256};
    journal.put(input2.goal_id,{status:'pending',fingerprint:input2.fingerprint,tx_hash:input2.tx_hash,oracle_goal:second.goal,
      agent_public_key:binding.public_review.agent_public_keys[input2.goal_id]});
    const state=await witness.inspect(),ciphertext=journal.exportEncryptedSnapshot();
    const candidate={format:'bouncer-v14-mission-journal-backup-v1',scope_id:scope,owner,vault,
      review_sha256:binding.review_sha256,mission_sha256:binding.mission_sha256,witness_revision:state.revision,
      witness_head_sha256:state.head_sha256,goal_id:input2.goal_id,kind:input2.kind,tx_hash:input2.tx_hash,
      fingerprint:input2.fingerprint,phase:'pending',ciphertext_sha256:sha(ciphertext),ciphertext};
    const bads=[{...candidate,owner:'other.testnet'},{...candidate,mission_sha256:'f'.repeat(64)},
      {...candidate,goal_id:'store'},{...candidate,tx_hash:null},{...candidate,ciphertext_sha256:'f'.repeat(64)}];
    for(const bad of bads) assert.deepEqual(await backup(db,'append',input2.goal_id,'pending',state.revision,state.head_sha256,JSON.stringify(bad)),{error:'unavailable'});
    assert.deepEqual(await backup(db,'append',input2.goal_id,'completed',state.revision,state.head_sha256,JSON.stringify({...candidate,phase:'completed'})),{error:'unavailable'});
    const outcomes=await Promise.all([0,1].map(()=>backup(db,'append',input2.goal_id,'pending',state.revision,state.head_sha256,JSON.stringify(candidate))));
    assert.equal(outcomes.filter(x=>x.status==='EXISTING_BACKUP').length,1);
    assert.equal(outcomes.filter(x=>x.error==='unavailable').length,1);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM bouncer_v14_originals_v1.mission_journal_backups')).rows[0].n,3);
  } finally {journal.close();key.fill(0);fs.rmSync(dir,{recursive:true,force:true});}
}
