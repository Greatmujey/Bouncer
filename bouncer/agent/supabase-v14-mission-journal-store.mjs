/** Research-only server-to-server encrypted journal backup adapter.
 * Fixed endpoint and one attempt per operation; the random capability is a
 * private bearer secret, never a wallet key. The service is default-off and
 * must atomically bind appends to the independently retained witness head.
 * No callback, HTTP acknowledgement or ciphertext proves durability. */
import {isDeepStrictEqual} from 'node:util';

export const V14_MISSION_BACKUP_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-mission-backup';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('independent encrypted V14 journal backup is unavailable or uncertain; stop and reconcile');
async function boundedText(stream,limit) {
  if(!stream||typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export function createSupabaseV14MissionJournalStore({scopeId,capability,fetch:fetchImpl=globalThis.fetch}={}) {
  if(!SCOPE.test(scopeId??'')||!HEX.test(capability??'')||typeof fetchImpl!=='function')throw fail();
  async function request(body) {
    try {
      const response=await fetchImpl(V14_MISSION_BACKUP_ENDPOINT,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
        headers:{'content-type':'application/json'},body:JSON.stringify({scope_id:scopeId,capability,...body}),signal:AbortSignal.timeout(15_000)});
      if(!response?.ok)throw fail();
      const result=JSON.parse(await boundedText(response.body,300_000));
      if(exact(result,['status'])&&result.status==='MISSING'&&body.operation==='read')return null;
      if(!exact(result,['status','record'])||result.status!=='EXISTING_BACKUP'||!result.record||
          result.record.scope_id!==scopeId||result.record.goal_id!==body.goal_id||result.record.phase!==body.phase)throw fail();
      return structuredClone(result.record);
    }catch{throw fail()}
  }
  return Object.freeze({
    read:({goal_id,phase}={})=>{
      if(!ID.test(goal_id??'')||!['pending','completed'].includes(phase))throw fail();
      return request({operation:'read',goal_id,phase});
    },
    append:async record=>{
      if(!record||typeof record!=='object'||Array.isArray(record)||record.scope_id!==scopeId||!ID.test(record.goal_id??'')||
          !['pending','completed'].includes(record.phase)||!Number.isSafeInteger(record.witness_revision)||
          record.witness_revision<19||record.witness_revision>31||!HEX.test(record.witness_head_sha256??'')||
          Buffer.byteLength(JSON.stringify(record),'utf8')>270_000)throw fail();
      const saved=await request({operation:'append',goal_id:record.goal_id,phase:record.phase,expected_revision:record.witness_revision,
        expected_head_sha256:record.witness_head_sha256,record});
      if(!isDeepStrictEqual(saved,record))throw fail();
      return saved;
    },
  });
}
