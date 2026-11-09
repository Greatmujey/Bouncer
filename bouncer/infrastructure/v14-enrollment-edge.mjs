// Default-OFF owner-authenticated checkpoint enrollment. No NEAR transaction,
// private key, paid call, vault deployment or loader execution occurs here.
// The browser's NEP-413 message only binds a reviewed public setup and the
// SHA-256 of a random checkpoint capability. Public scope/owner uniqueness and
// atomic SQL enrollment prevent replay from creating a replacement stream.
import {validateV14EnrollmentTerms,v14EnrollmentMessage,V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from '../web-src/v14-checkpoint-enrollment.mjs';
import {boundedV14Text,verifyFreshV14Owner} from './v14-owner-nep413.mjs';

const PROJECT='jiouaqwxkvlkmvyumzwc',HEX=/^[a-f0-9]{64}$/;
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));

export function createV14EnrollmentHandler({getEnv,fetch:fetchImpl,crypto,now=Date.now} = {}) {
  return async request=>{
    const origin=request.headers.get('origin') || '';
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':V14_ENROLLMENT_SITE,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_ENROLLMENT_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(origin!==V14_ENROLLMENT_SITE)return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      const declared=request.headers.get('content-length');
      if(declared && (!/^\d+$/.test(declared)||Number(declared)>4096))throw Error();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error();
      const input=JSON.parse(await boundedV14Text(request.body,4096));
      if(!exact(input,['terms','nonce_base64','signature_base64']))throw Error();
      const terms=validateV14EnrollmentTerms(input.terms,{now:now()});
      await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:v14EnrollmentMessage(terms),
        recipient:V14_ENROLLMENT_RECIPIENT,nonceBase64:input.nonce_base64,signatureBase64:input.signature_base64,
        fetch:fetchImpl,crypto,now});
      validateV14EnrollmentTerms(terms,{now:now()});
      const projectUrl=getEnv('SUPABASE_URL'),secret=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co` || typeof secret!=='string' || !secret)throw Error();
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_v14_enroll_v1`,{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',apikey:secret,authorization:`Bearer ${secret}`},
        body:JSON.stringify({p_scope_id:terms.scope_id,p_capability_hash:terms.capability_sha256,p_owner_id:terms.owner,
          p_vault_id:terms.vault,p_owner_public_key:terms.owner_public_key,p_review_sha256:terms.review_sha256}),
        signal:AbortSignal.timeout(12_000),
      });
      if(!upstream.ok)throw Error();
      const result=JSON.parse(await boundedV14Text(upstream.body,4096));
      if(!exact(result,['status','scope_id','revision','head_sha256']) || !['ENROLLED','ALREADY_ENROLLED'].includes(result.status) ||
          result.scope_id!==terms.scope_id || !Number.isSafeInteger(result.revision) || result.revision<0 || result.revision>32 ||
          !HEX.test(result.head_sha256 ?? ''))throw Error();
      return respond(200,result);
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14EnrollmentHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
