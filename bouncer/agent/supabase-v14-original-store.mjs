/**
 * Server-to-server client for the separately provisioned, default-off Supabase
 * V14 original checkpoint. The capability is NOT a NEAR key; it is a private
 * random 32-byte bearer secret and must never appear in logs, URLs, browser
 * storage, source control, or a public review. No automatic request retry.
 * Missing capability/scope/endpoint or any uncertain reply blocks execution.
 */
import crypto from 'node:crypto';

export const V14_ORIGINAL_CHECKPOINT_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-original-checkpoint';
const HEX=/^[a-f0-9]{64}$/, SCOPE=/^[a-f0-9]{32}$/;
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const unavailable=()=>new Error('independent V14 checkpoint unavailable or uncertain; preserve the original and stop, never retry a prompt or send');
const hash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
async function boundedText(stream,limit) {
  if (!stream || typeof stream.getReader!=='function') throw unavailable();
  const reader=stream.getReader(),chunks=[];let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (size+=value.byteLength)>limit) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),size);
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function snapshot(value) {
  if (!exact(value,['revision','head_sha256','events']) || !Number.isSafeInteger(value.revision) || value.revision<0 || value.revision>32 ||
      !HEX.test(value.head_sha256 ?? '') || !Array.isArray(value.events) || value.events.length!==value.revision ||
      value.events.some(line=>typeof line!=='string' || Buffer.byteLength(line,'utf8')>24_576 || /[\r\n]/.test(line))) throw unavailable();
  return structuredClone(value);
}
export function createSupabaseV14OriginalStore({scopeId,capability,fetch:fetchImpl=globalThis.fetch} = {}) {
  if (!SCOPE.test(scopeId ?? '') || !HEX.test(capability ?? '') || typeof fetchImpl!=='function') throw unavailable();
  async function request(body) {
    try {
      const response=await fetchImpl(V14_ORIGINAL_CHECKPOINT_ENDPOINT,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
        headers:{'content-type':'application/json'},body:JSON.stringify({scope_id:scopeId,capability,...body}),signal:AbortSignal.timeout(12_000)});
      if (!response?.ok) throw unavailable();
      const text=await boundedText(response.body,900_000);
      return snapshot(JSON.parse(text));
    } catch { throw unavailable(); }
  }
  return Object.freeze({
    read:()=>request({operation:'read'}),
    append:async({expected_revision,expected_head_sha256,record} = {})=>{
      if (!Number.isSafeInteger(expected_revision) || expected_revision<0 || expected_revision>=32 ||
          !HEX.test(expected_head_sha256 ?? '') || typeof record!=='string' || !record ||
          Buffer.byteLength(record,'utf8')>24_576 || /[\r\n]/.test(record)) throw unavailable();
      const result=await request({operation:'append',expected_revision,expected_head_sha256,record});
      if (result.revision!==expected_revision+1 || result.head_sha256!==hash(record) || result.events.at(-1)!==record) throw unavailable();
      return result;
    },
  });
}
