// Default-off browser client for the independent V14 checkpoint bridge. The
// random capability exists only in caller memory and the HTTPS POST body; it
// is never placed in a URL, header, browser storage or log by this module.
// This cannot prove server independence, latest-head freshness or receipts.
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from './v14-checkpoint-enrollment.mjs';

export const V14_BROWSER_CHECKPOINT_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-browser-original-checkpoint';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const text=new TextEncoder();
const exact=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const fail=()=>new Error('independent V14 checkpoint unavailable or uncertain; preserve originals and never repeat a wallet prompt');
async function boundedText(stream,limit) {
  if(!stream||typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function snapshot(value) {
  if(!exact(value,['revision','head_sha256','events'])||!Number.isSafeInteger(value.revision)||value.revision<0||value.revision>32||
      !HEX.test(value.head_sha256??'')||!Array.isArray(value.events)||value.events.length!==value.revision||
      value.events.some(line=>typeof line!=='string'||text.encode(line).length>24_576||/[\r\n]/.test(line)))throw fail();
  return {revision:value.revision,head_sha256:value.head_sha256,events:[...value.events]};
}
async function sha(crypto,value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',text.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function createV14BrowserIndependentStore({location,scopeId,capability,crypto=globalThis.crypto,
    fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true}={}) {
  if(location?.origin!==V14_ENROLLMENT_SITE||location?.host!==V14_ENROLLMENT_RECIPIENT||!SCOPE.test(scopeId??'')||
      !HEX.test(capability??'')||!crypto?.subtle||typeof fetchImpl!=='function'||typeof isCurrent!=='function')throw fail();
  const current=()=>{if(!isCurrent())throw fail()};
  async function request(body) {
    try {
      current();
      const response=await fetchImpl(V14_BROWSER_CHECKPOINT_ENDPOINT,{method:'POST',mode:'cors',credentials:'omit',
        redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},
        body:JSON.stringify({scope_id:scopeId,capability,...body}),signal:AbortSignal.timeout(12_000)});
      current();if(!response.ok)throw fail();
      const value=snapshot(JSON.parse(await boundedText(response.body,900_000)));current();return value;
    }catch{throw fail()}
  }
  return Object.freeze({
    read:()=>request({operation:'read'}),
    append:async({expected_revision,expected_head_sha256,record}={})=>{
      if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>=32||
          !HEX.test(expected_head_sha256??'')||typeof record!=='string'||!record||text.encode(record).length>24_576||/[\r\n]/.test(record))throw fail();
      const result=await request({operation:'append',expected_revision,expected_head_sha256,record});
      if(result.revision!==expected_revision+1||result.head_sha256!==await sha(crypto,record)||result.events.at(-1)!==record)throw fail();
      current();return result;
    },
  });
}
