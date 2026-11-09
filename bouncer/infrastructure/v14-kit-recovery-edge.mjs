// Default-OFF owner-authenticated retrieval of an existing encrypted key kit.
// It never decrypts, restores a journal, rotates a capability or sends NEAR.
import {validateV14KitRecoveryTerms,v14KitRecoveryMessage} from '../web-src/v14-checkpoint-kit-recovery.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from '../web-src/v14-checkpoint-enrollment.mjs';
import {inspectV14SealedKit} from '../web-src/v14-secret-recovery-kit.mjs';
import {v14KitSha256,verifyV14KitAttestation} from '../web-src/v14-checkpoint-enrollment-kit.mjs';
import {boundedV14Text,verifyFreshV14Owner} from './v14-owner-nep413.mjs';

const PROJECT='jiouaqwxkvlkmvyumzwc',HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function createV14KitRecoveryHandler({getEnv,fetch:fetchImpl,crypto,now=Date.now}={}) {
  return async request=>{
    const origin=request.headers.get('origin')||'';
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':V14_ENROLLMENT_SITE,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_KIT_RECOVERY_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(origin!==V14_ENROLLMENT_SITE)return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      const length=request.headers.get('content-length');
      if(length&&(!/^\d+$/.test(length)||Number(length)>4096))throw Error();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw Error();
      const input=JSON.parse(await boundedV14Text(request.body,4096));
      if(!exact(input,['terms','nonce_base64','signature_base64']))throw Error();
      const terms=validateV14KitRecoveryTerms(input.terms,{now:now()});
      await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:v14KitRecoveryMessage(terms),
        recipient:V14_ENROLLMENT_RECIPIENT,nonceBase64:input.nonce_base64,signatureBase64:input.signature_base64,
        fetch:fetchImpl,crypto,now});
      validateV14KitRecoveryTerms(terms,{now:now()});
      const projectUrl=getEnv('SUPABASE_URL'),secret=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co`||typeof secret!=='string'||!secret)throw Error();
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_v14_owner_kit_inspect_v2`,{method:'POST',redirect:'error',
        headers:{'content-type':'application/json',apikey:secret,authorization:`Bearer ${secret}`},
        body:JSON.stringify({p_owner_id:terms.owner,p_vault_id:terms.vault}),signal:AbortSignal.timeout(12_000)});
      if(!upstream.ok)throw Error();
      const result=JSON.parse(await boundedV14Text(upstream.body,24000));
      if(!exact(result,['status','scope_id','review_sha256','capability_sha256','kit_sha256','sealed_kit','attestation_sha256','owner_attestation'])||
          result.status!=='EXISTING_ENCRYPTED_KIT'||!SCOPE.test(result.scope_id??'')||!HEX.test(result.review_sha256??'')||
          !HEX.test(result.capability_sha256??'')||!HEX.test(result.kit_sha256??'')||!HEX.test(result.attestation_sha256??'')||
          typeof result.sealed_kit!=='string'||typeof result.owner_attestation!=='string'||/[\r\n]/.test(result.sealed_kit)||
          await v14KitSha256(crypto,result.sealed_kit)!==result.kit_sha256||
          await v14KitSha256(crypto,result.owner_attestation)!==result.attestation_sha256)throw Error();
      const kit=JSON.parse(result.sealed_kit),attestation=JSON.parse(result.owner_attestation);
      if(JSON.stringify(kit)!==result.sealed_kit)throw Error();
      inspectV14SealedKit({envelope:kit,owner:terms.owner,vault:terms.vault,scopeId:result.scope_id,
        reviewSha256:result.review_sha256,capabilitySha256:result.capability_sha256});
      // This validates the signature bytes, not the historical key's on-chain
      // authorization. The client must bind that key to the original review.
      await verifyV14KitAttestation({text:result.owner_attestation,owner:terms.owner,vault:terms.vault,
        ownerPublicKey:attestation?.terms?.owner_public_key,scopeId:result.scope_id,reviewSha256:result.review_sha256,
        capabilitySha256:result.capability_sha256,kitSha256:result.kit_sha256,crypto});
      return respond(200,{...result,wallet_transaction_authorized:false,journal_restored:false});
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14KitRecoveryHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
