/**
 * FileJournal adapter for a dedicated V14 original-witness journal. This is the
 * local copy only; a separate independently retained store is still required.
 * Explicit initialization is for a brand-new, never-attempted setup, not a way
 * to replace a missing or rolled-back journal. Caller owns the FileJournal's
 * process-lifetime lock and must require its original encrypted file/key on
 * subsequent starts. This adapter never creates or opens files itself.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { FileJournal } from './procurement.mjs';
import { V14_WITNESS_GENESIS } from './v14-original-witness.mjs';

const ENTRY_ID='v14-original-witness';
const HEX=/^[a-f0-9]{64}$/, SCOPE=/^[a-f0-9]{32}$/;
const hash=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
const error=()=>new Error('local V14 witness journal is missing or uncertain; preserve the original and stop');
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));

export function createV14FileWitnessStore({journal,owner,vault,scopeId,initializeBrandNew=false} = {}) {
  if (!(journal instanceof FileJournal) || !journal.encryptionEnabled || typeof journal.assertScope!=='function' ||
      typeof initializeBrandNew!=='boolean' || !SCOPE.test(scopeId ?? '')) throw error();
  journal.assertScope(vault,owner);
  const fingerprint=hash(`bouncer-v14-file-witness-v1\0${owner}\0${vault}\0${scopeId}`);
  const make=snapshot=>({kind:'bouncer-v14-file-witness-v1',status:'pending',fingerprint,scope_id:scopeId,...snapshot});
  const initial={revision:0,head_sha256:V14_WITNESS_GENESIS,events:[]};
  if (initializeBrandNew) {
    // A dedicated journal avoids clobbering mission entries. It still cannot
    // prove that a previous copy did not exist on another disk.
    if (journal.get(ENTRY_ID)!==undefined || journal.list().length!==0) throw error();
    journal.put(ENTRY_ID,make(initial));
  }
  function read() {
    journal.assertScope(vault,owner);
    const entry=journal.get(ENTRY_ID);
    if (!exact(entry,['id','kind','status','fingerprint','scope_id','revision','head_sha256','events']) ||
        entry.id!==ENTRY_ID || entry.kind!=='bouncer-v14-file-witness-v1' || entry.status!=='pending' ||
        entry.fingerprint!==fingerprint || entry.scope_id!==scopeId || !Number.isSafeInteger(entry.revision) ||
        entry.revision<0 || entry.revision>32 || !HEX.test(entry.head_sha256 ?? '') || !Array.isArray(entry.events) ||
        entry.events.length!==entry.revision || entry.events.some(line=>typeof line!=='string')) throw error();
    return structuredClone({revision:entry.revision,head_sha256:entry.head_sha256,events:entry.events});
  }
  // Verify presence immediately even when the caller did not initialize it.
  read();
  return Object.freeze({
    read:async()=>read(),
    append:async({expected_revision,expected_head_sha256,record} = {})=>{
      const prior=read();
      if (prior.revision!==expected_revision || prior.head_sha256!==expected_head_sha256 ||
          typeof record!=='string' || !record || Buffer.byteLength(record,'utf8')>24_576 || /[\r\n]/.test(record)) throw error();
      const next={revision:prior.revision+1,head_sha256:hash(record),events:[...prior.events,record]};
      if (next.revision>32) throw error();
      journal.put(ENTRY_ID,make(next)); // synchronous encrypted write, fsync and readback
      if (!isDeepStrictEqual(read(),next)) throw error();
      return structuredClone(next);
    },
  });
}
