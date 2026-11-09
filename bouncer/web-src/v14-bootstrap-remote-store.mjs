/** Default-OFF browser transport for the independently operated temporary-vault
 * checkpoint. It stores ciphertext and public originals, never a passphrase or
 * private key. No response proves database freshness or authorizes spending.
 * Lost acknowledgements and mismatched copies must stop the flow. */
import {V14_BOOTSTRAP_ORIGINS,validateBootstrapEnrollmentTerms,validateBootstrapRecoveryTerms,
  verifyBootstrapAttestation,verifyBootstrapEnrollmentContents,bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {inspectBootstrapOriginals} from './v14-bootstrap-originals.mjs';

export const V14_BOOTSTRAP_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-bootstrap-checkpoint';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ZERO='0'.repeat(64);
const exact=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const fail=()=>new Error('independent bootstrap checkpoint unavailable or uncertain; do not repeat a wallet prompt or send');
function validLocation(location) {
  if(!location||!V14_BOOTSTRAP_ORIGINS.includes(location.origin)||new URL(location.origin).host!==location.host)throw fail();
}
async function boundedText(stream,limit) {
  if(!stream||typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
async function post({location,fetchImpl,body,isCurrent}) {
  validLocation(location);if(typeof fetchImpl!=='function'||typeof isCurrent!=='function'||isCurrent()!==true)throw fail();
  try {
    const response=await fetchImpl(V14_BOOTSTRAP_ENDPOINT,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)});
    if(isCurrent()!==true||!response.ok)throw fail();
    const result=JSON.parse(await boundedText(response.body,128_000));if(isCurrent()!==true)throw fail();return result;
  }catch{throw fail()}
}
/** A successful new enrollment is still not proof of a verified independent
 * restore. An EXISTING or unknown result must enter recovery-only mode. */
export async function enrollBootstrapCheckpoint({signed,location,fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true,now=Date.now}={}) {
  if(!exact(signed,['terms','nonce_base64','signature_base64','sealed_kit','review_text'])||typeof now!=='function')throw fail();
  const terms=validateBootstrapEnrollmentTerms(signed.terms,{now:now()});validLocation(location);
  if(terms.site!==location.origin)throw fail();
  await verifyBootstrapEnrollmentContents({terms,reviewText:signed.review_text,kitText:signed.sealed_kit,crypto});
  const attestation=JSON.stringify({terms,nonce_base64:signed.nonce_base64,signature_base64:signed.signature_base64});
  await verifyBootstrapAttestation({text:attestation,terms,crypto});
  const result=await post({location,fetchImpl,isCurrent,body:{operation:'enroll',...signed}});
  if(!exact(result,['status','scope_id','revision','head_sha256','kit_sha256','attestation_sha256'])||
    !['ENROLLED','EXISTING'].includes(result.status)||result.scope_id!==terms.scope_id||!Number.isSafeInteger(result.revision)||
    result.revision<0||result.revision>4||!HEX.test(result.head_sha256??'')||result.kit_sha256!==terms.kit_sha256||
    result.attestation_sha256!==await bootstrapSha256(crypto,attestation))throw fail();
  if(result.status==='ENROLLED'&&(result.revision!==0||result.head_sha256!==ZERO))throw fail();
  return {...result,new_scope_created:result.status==='ENROLLED',recovery_only:true,
    independently_restored:false,transaction_authorized:false};
}
export function createBootstrapRemoteStore({location,scopeId,capability,reviewSha256,crypto=globalThis.crypto,
  fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true}={}) {
  validLocation(location);
  if(!SCOPE.test(scopeId??'')||!HEX.test(capability??'')||!HEX.test(reviewSha256??'')||!crypto?.subtle)throw fail();
  async function request(body) {
    const result=await post({location,fetchImpl,isCurrent,body:{scope_id:scopeId,capability,...body}});
    await inspectBootstrapOriginals({snapshot:result,scopeId,reviewSha256,crypto});return result;
  }
  return Object.freeze({
    read:()=>request({operation:'read'}),
    append:async({expected_revision,expected_head_sha256,record}={})=>{
      if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>3||!HEX.test(expected_head_sha256??'')||
        typeof record!=='string'||!record||record.length>4096||/[\r\n]/.test(record))throw fail();
      const result=await request({operation:'append',expected_revision,expected_head_sha256,record});
      if(result.revision!==expected_revision+1||result.events.at(-1)!==record||result.head_sha256!==await bootstrapSha256(crypto,record))throw fail();
      return result;
    },
  });
}
/** Retrieve and verify the signed encrypted kit and public originals, with a
 * current owner read signature. This deliberately remains recovery-only. */
export async function recoverBootstrapCheckpoint({signed,location,fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true,now=Date.now}={}) {
  if(!exact(signed,['terms','nonce_base64','signature_base64'])||typeof now!=='function')throw fail();
  const terms=validateBootstrapRecoveryTerms(signed.terms,{now:now()});validLocation(location);if(terms.site!==location.origin)throw fail();
  const result=await post({location,fetchImpl,isCurrent,body:{operation:'recover',...signed}});
  if(!exact(result,['status','scope_id','review_text','sealed_kit','owner_attestation','revision','head_sha256','events',
    'transaction_authorized','latest_head_independently_verified'])||result.status!=='EXISTING_RECOVERY_ONLY'||
    result.transaction_authorized!==false||result.latest_head_independently_verified!==false)throw fail();
  const att=await verifyBootstrapAttestation({text:result.owner_attestation,crypto});
  if(att.terms.owner!==terms.owner||att.terms.vault!==terms.vault||att.terms.scope_id!==result.scope_id)throw fail();
  await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:result.review_text,kitText:result.sealed_kit,crypto});
  await inspectBootstrapOriginals({snapshot:{revision:result.revision,head_sha256:result.head_sha256,events:result.events},
    scopeId:result.scope_id,reviewSha256:att.terms.review_sha256,crypto});
  return result;
}
