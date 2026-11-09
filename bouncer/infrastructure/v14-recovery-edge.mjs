// Default-OFF read-only owner recovery. Current FullAccess owner signatures
// can read the public checkpoint history without the checkpoint capability.
// No database reset, capability rotation, wallet transaction or payment.
import {validateV14RecoveryTerms,v14RecoveryMessage} from '../web-src/v14-checkpoint-recovery.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from '../web-src/v14-checkpoint-enrollment.mjs';
import {boundedV14Text,verifyFreshV14Owner} from './v14-owner-nep413.mjs';
import {inspectV14PublicHistory} from '../web-src/v14-checkpoint-history.mjs';

const PROJECT='jiouaqwxkvlkmvyumzwc';
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
export function createV14RecoveryHandler({getEnv,fetch:fetchImpl,crypto,now=Date.now} = {}) {
  return async request=>{
    const origin=request.headers.get('origin') || '';
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':V14_ENROLLMENT_SITE,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_RECOVERY_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(origin!==V14_ENROLLMENT_SITE)return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      const declared=request.headers.get('content-length');
      if(declared && (!/^\d+$/.test(declared)||Number(declared)>4096))throw Error();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error();
      const input=JSON.parse(await boundedV14Text(request.body,4096));
      if(!exact(input,['terms','nonce_base64','signature_base64']))throw Error();
      const terms=validateV14RecoveryTerms(input.terms,{now:now()});
      await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:v14RecoveryMessage(terms),
        recipient:V14_ENROLLMENT_RECIPIENT,nonceBase64:input.nonce_base64,signatureBase64:input.signature_base64,fetch:fetchImpl,crypto,now});
      validateV14RecoveryTerms(terms,{now:now()});
      const projectUrl=getEnv('SUPABASE_URL'),secret=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co` || typeof secret!=='string' || !secret)throw Error();
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_v14_owner_inspect_v1`,{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',apikey:secret,authorization:`Bearer ${secret}`},
        body:JSON.stringify({p_owner_id:terms.owner,p_vault_id:terms.vault}),signal:AbortSignal.timeout(12_000),
      });
      if(!upstream.ok)throw Error();
      const raw=JSON.parse(await boundedV14Text(upstream.body,900_000));
      const checked=await inspectV14PublicHistory({snapshot:raw,owner:terms.owner,vault:terms.vault,crypto});
      return respond(200,{status:'CHECKPOINT_HISTORY_READ',scope_id:checked.scope_id,revision:checked.revision,
        head_sha256:checked.head_sha256,events:raw.events,absence_verified:false,wallet_transaction_authorized:false});
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14RecoveryHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
