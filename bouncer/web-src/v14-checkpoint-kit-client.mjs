// Research-only fixed-origin clients for checkpoint+encrypted-kit enrollment
// and ciphertext recovery. No passphrase or wallet private key is sent. These
// routes are not deployed or enabled; this module is not wired into the UI.
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from './v14-checkpoint-enrollment.mjs';
import {validateV14KitEnrollmentTerms,verifyV14KitText,verifyV14KitAttestation,v14KitSha256} from './v14-checkpoint-enrollment-kit.mjs';
import {validateV14KitRecoveryTerms} from './v14-checkpoint-kit-recovery.mjs';
import {inspectV14SealedKit} from './v14-secret-recovery-kit.mjs';

export const V14_KIT_ENROLLMENT_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-kit-enrollment';
export const V14_KIT_RECOVERY_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-kit-recovery';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(key=>Object.hasOwn(x,key));
const fail=()=>new Error('V14 encrypted-kit request is unavailable or uncertain; preserve originals and do not retry a wallet prompt');
async function boundedText(stream,limit) {
  if(!stream||typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function signatureFields(submission,fields) {
  if(!exact(submission,fields)||!/^[A-Za-z0-9+/]{43}=$/.test(submission.nonce_base64??'')||
      !/^[A-Za-z0-9+/]{86}==$/.test(submission.signature_base64??''))throw fail();
}
export function createV14KitClient({location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true,now=Date.now}={}) {
  if(location?.origin!==V14_ENROLLMENT_SITE||location?.host!==V14_ENROLLMENT_RECIPIENT||!crypto?.subtle||
      typeof fetchImpl!=='function'||typeof isCurrent!=='function'||typeof now!=='function')throw fail();
  const current=()=>{if(!isCurrent())throw fail()};
  async function send(url,body,maxBytes) {
    const response=await fetchImpl(url,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
    current();if(!response.ok)throw fail();return JSON.parse(await boundedText(response.body,maxBytes));
  }
  return Object.freeze({
    async enroll(submission) {
      current();signatureFields(submission,['terms','nonce_base64','signature_base64','sealed_kit']);
      const terms=validateV14KitEnrollmentTerms(submission.terms,{now:now()}),text=submission.sealed_kit;
      const nonceBase64=submission.nonce_base64,signatureBase64=submission.signature_base64;
      await verifyV14KitText({text,terms,crypto});current();
      const attestation=JSON.stringify({terms,nonce_base64:nonceBase64,signature_base64:signatureBase64});
      const attestationSha256=await v14KitSha256(crypto,attestation);
      try {
        const result=await send(V14_KIT_ENROLLMENT_ENDPOINT,{terms,nonce_base64:nonceBase64,
          signature_base64:signatureBase64,sealed_kit:text},4096);
        if(!exact(result,['status','scope_id','revision','head_sha256','kit_sha256','attestation_sha256'])||
            !['ENROLLED_WITH_KIT','EXISTING_KIT'].includes(result.status)||result.scope_id!==terms.scope_id||
            !Number.isSafeInteger(result.revision)||result.revision<0||result.revision>32||!HEX.test(result.head_sha256??'')||
            result.kit_sha256!==terms.kit_sha256||result.attestation_sha256!==attestationSha256)throw fail();
        current();return result;
      }catch{throw fail()}
    },
    // `review` and `scopeId` come from the separately retained, validated public
    // history; never take them solely from this ciphertext response.
    async read(submission,{review,scopeId,trustedReviewSha256}={}) {
      current();signatureFields(submission,['terms','nonce_base64','signature_base64']);
      const terms=validateV14KitRecoveryTerms(submission.terms,{now:now()}),reviewSnapshot=structuredClone(review);
      const nonceBase64=submission.nonce_base64,signatureBase64=submission.signature_base64;
      if(!SCOPE.test(scopeId??'')||!HEX.test(trustedReviewSha256??'')||reviewSnapshot?.review_sha256!==trustedReviewSha256||
          reviewSnapshot?.owner!==terms.owner||reviewSnapshot?.vault!==terms.vault||typeof reviewSnapshot?.owner_public_key!=='string')throw fail();
      const unsigned={...reviewSnapshot};delete unsigned.review_sha256;
      if(await v14KitSha256(crypto,JSON.stringify(unsigned))!==trustedReviewSha256)throw fail();
      current();
      try {
        const result=await send(V14_KIT_RECOVERY_ENDPOINT,{terms,nonce_base64:nonceBase64,signature_base64:signatureBase64},24000);
        if(!exact(result,['status','scope_id','review_sha256','capability_sha256','kit_sha256','sealed_kit','attestation_sha256',
            'owner_attestation','wallet_transaction_authorized','journal_restored'])||result.status!=='EXISTING_ENCRYPTED_KIT'||
            result.wallet_transaction_authorized!==false||result.journal_restored!==false||result.scope_id!==scopeId||
            result.review_sha256!==trustedReviewSha256||!HEX.test(result.capability_sha256??'')||!HEX.test(result.kit_sha256??'')||
            !HEX.test(result.attestation_sha256??'')||typeof result.sealed_kit!=='string'||typeof result.owner_attestation!=='string'||
            await v14KitSha256(crypto,result.sealed_kit)!==result.kit_sha256||
            await v14KitSha256(crypto,result.owner_attestation)!==result.attestation_sha256)throw fail();
        const envelope=JSON.parse(result.sealed_kit);
        if(JSON.stringify(envelope)!==result.sealed_kit)throw fail();
        inspectV14SealedKit({envelope,owner:terms.owner,vault:terms.vault,scopeId,reviewSha256:trustedReviewSha256,
          capabilitySha256:result.capability_sha256});
        const attestation=await verifyV14KitAttestation({text:result.owner_attestation,owner:terms.owner,vault:terms.vault,
          ownerPublicKey:reviewSnapshot.owner_public_key,scopeId,reviewSha256:trustedReviewSha256,capabilitySha256:result.capability_sha256,
          kitSha256:result.kit_sha256,crypto});
        current();return {envelope,attestation,scope_id:scopeId,capability_sha256:result.capability_sha256,kit_sha256:result.kit_sha256,
          journal_restored:false,wallet_transaction_authorized:false};
      }catch{throw fail()}
    },
  });
}
