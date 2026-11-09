// Default-OFF owner-authenticated checkpoint + encrypted key-kit enrollment.
// Only ciphertext and public metadata cross this boundary. A signature here is
// non-spending: no loader, key installation, vault deployment or NEAR payment.
import {validateV14KitEnrollmentTerms,v14KitEnrollmentMessage,verifyV14KitText,v14KitSha256} from '../web-src/v14-checkpoint-enrollment-kit.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from '../web-src/v14-checkpoint-enrollment.mjs';
import {boundedV14Text,verifyFreshV14Owner} from './v14-owner-nep413.mjs';

const PROJECT='jiouaqwxkvlkmvyumzwc',HEX=/^[a-f0-9]{64}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function createV14KitEnrollmentHandler({getEnv,fetch:fetchImpl,crypto,now=Date.now}={}) {
  return async request=>{
    const origin=request.headers.get('origin')||'';
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':V14_ENROLLMENT_SITE,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_KIT_ENROLLMENT_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(origin!==V14_ENROLLMENT_SITE)return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      const length=request.headers.get('content-length');
      if(length&&(!/^\d+$/.test(length)||Number(length)>20000))throw Error();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error();
      const input=JSON.parse(await boundedV14Text(request.body,20000));
      if(!exact(input,['terms','nonce_base64','signature_base64','sealed_kit']))throw Error();
      const terms=validateV14KitEnrollmentTerms(input.terms,{now:now()});
      await verifyV14KitText({text:input.sealed_kit,terms,crypto});
      await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:v14KitEnrollmentMessage(terms),
        recipient:V14_ENROLLMENT_RECIPIENT,nonceBase64:input.nonce_base64,signatureBase64:input.signature_base64,
        fetch:fetchImpl,crypto,now});
      validateV14KitEnrollmentTerms(terms,{now:now()});
      const projectUrl=getEnv('SUPABASE_URL'),secret=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co`||typeof secret!=='string'||!secret)throw Error();
      const attestation=JSON.stringify({terms,nonce_base64:input.nonce_base64,signature_base64:input.signature_base64});
      const attestationSha256=await v14KitSha256(crypto,attestation);
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_v14_enroll_kit_v2`,{method:'POST',redirect:'error',
        headers:{'content-type':'application/json',apikey:secret,authorization:`Bearer ${secret}`},
        body:JSON.stringify({p_scope_id:terms.scope_id,p_capability_hash:terms.capability_sha256,p_owner_id:terms.owner,
          p_vault_id:terms.vault,p_owner_public_key:terms.owner_public_key,p_review_sha256:terms.review_sha256,
          p_kit_sha256:terms.kit_sha256,p_sealed_kit:input.sealed_kit,p_attestation_sha256:attestationSha256,
          p_owner_attestation:attestation}),signal:AbortSignal.timeout(12_000)});
      if(!upstream.ok)throw Error();
      const result=JSON.parse(await boundedV14Text(upstream.body,4096));
      if(!exact(result,['status','scope_id','revision','head_sha256','kit_sha256','attestation_sha256'])||
          !['ENROLLED_WITH_KIT','EXISTING_KIT'].includes(result.status)||result.scope_id!==terms.scope_id||
          !Number.isSafeInteger(result.revision)||result.revision<0||result.revision>32||!HEX.test(result.head_sha256??'')||
          result.kit_sha256!==terms.kit_sha256||result.attestation_sha256!==attestationSha256)throw Error();
      return respond(200,result);
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14KitEnrollmentHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
