/** Load only the public pinned compressed research artifact as inert data.
 * No downloaded script is executed. Bounds, canonical encoding and the
 * compressed SHA-256 are checked here; the plan builder checks that digest
 * again and checks the inflated WASM hash before constructing a review.
 * Matching hashes are not an audit or permission to deploy anything. */
import {V14_PHONE_RESEARCH_ARTIFACTS,V14_PHONE_RESEARCH_SIZES} from '../shared/v14-phone-research-artifacts.mjs';

const PATH='/v14-bootstrap-artifact-v1.json';
const FORMAT='bouncer-v14-compressed-artifact-v1';
const BASE64_LENGTH=Math.ceil(V14_PHONE_RESEARCH_SIZES.compressed/3)*4;
const MAX_BODY=BASE64_LENGTH+256;
const fail=()=>new Error('Pinned V14 artifact unavailable; no transaction is authorized');
const hex=bytes=>[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');

export async function loadV14BootstrapArtifact({fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,timeoutMs=20_000}={}) {
  if(typeof fetchImpl!=='function'||!crypto?.subtle||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw fail();
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeoutMs);
  let reader;
  try {
    const response=await fetchImpl(PATH,{method:'GET',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:abort.signal});
    if(!response?.ok||response.redirected||!response.body?.getReader)throw fail();
    const length=response.headers?.get('content-length');
    // Content-Length can refer to HTTP-compressed bytes; the actual decoded
    // stream is bounded independently below.
    if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY*2))throw fail();
    reader=response.body.getReader();const chunks=[];let size=0;
    for(;;) {
      const {value,done}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array))throw fail();
      size+=value.byteLength;if(size>MAX_BODY)throw fail();chunks.push(value);
    }
    const body=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(body),asset=JSON.parse(text);
    if(!asset||typeof asset!=='object'||Array.isArray(asset)||Object.keys(asset).join(',')!=='format,base64'||
      asset.format!==FORMAT||typeof asset.base64!=='string'||asset.base64.length!==BASE64_LENGTH||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)||JSON.stringify(asset)!==text)throw fail();
    const raw=atob(asset.base64);
    if(raw.length!==V14_PHONE_RESEARCH_SIZES.compressed||btoa(raw)!==asset.base64)throw fail();
    const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    if(hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))!==V14_PHONE_RESEARCH_ARTIFACTS.compressed_sha256)throw fail();
    return bytes;
  }catch{throw fail()}finally{
    clearTimeout(timer);
    // Abort/cancel a partially read oversized or failed response, without
    // waiting for an untrusted stream to acknowledge cancellation.
    abort.abort();if(reader)void reader.cancel().catch(()=>{});
  }
}
