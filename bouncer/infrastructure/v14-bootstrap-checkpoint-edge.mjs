// Default-OFF, owner-authenticated testnet recovery checkpoint for the one
// named MVP owner/vault. Stores ciphertext and public originals only. It never
// holds a wallet key, decrypts the kit, signs, sends, or authorizes a NEAR
// transaction. A compromised origin or server can still misuse data, and a
// restored database can roll back its history; independent heads are required.
import {validateBootstrapEnrollmentTerms,bootstrapEnrollmentMessage,verifyBootstrapEnrollmentContents,
  validateBootstrapRecoveryTerms,bootstrapRecoveryMessage,verifyBootstrapAttestation,bootstrapSha256,
  V14_BOOTSTRAP_ORIGINS} from '../shared/v14-bootstrap-protocol.mjs';
import {inspectBootstrapOriginals} from '../web-src/v14-bootstrap-originals.mjs';
import {boundedV14Text,verifyFreshV14Owner} from './v14-owner-nep413.mjs';

const PROJECT='jiouaqwxkvlkmvyumzwc',OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('unavailable');
export function createV14BootstrapCheckpointHandler({getEnv,fetch:fetchImpl,crypto,now=Date.now}={}) {
  return async request=>{
    const origin=request.headers.get('origin')||'';
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_BOOTSTRAP_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(!V14_BOOTSTRAP_ORIGINS.includes(origin))return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      if(request.headers.has('cookie')||request.headers.has('authorization')||request.headers.has('apikey'))throw fail();
      const length=request.headers.get('content-length');
      if(length&&(!/^\d+$/.test(length)||Number(length)>48_000))throw fail();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw fail();
      const data=JSON.parse(await boundedV14Text(request.body,48_000));
      const projectUrl=getEnv('SUPABASE_URL'),secret=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co`||typeof secret!=='string'||!secret)throw fail();
      async function rpc(name,body) {
        const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',cache:'no-store',
          headers:{'content-type':'application/json',apikey:secret,authorization:`Bearer ${secret}`},body:JSON.stringify(body),
          signal:AbortSignal.timeout(12_000)});
        if(!upstream.ok)throw fail();return JSON.parse(await boundedV14Text(upstream.body,128_000));
      }
      if(data?.operation==='enroll') {
        if(!exact(data,['operation','terms','nonce_base64','signature_base64','sealed_kit','review_text']))throw fail();
        const terms=validateBootstrapEnrollmentTerms(data.terms,{now:now()});
        if(terms.site!==origin||terms.owner!==OWNER||terms.vault!==VAULT)throw fail();
        await verifyBootstrapEnrollmentContents({terms,reviewText:data.review_text,kitText:data.sealed_kit,crypto});
        await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:bootstrapEnrollmentMessage(terms),
          recipient:new URL(origin).host,nonceBase64:data.nonce_base64,signatureBase64:data.signature_base64,fetch:fetchImpl,crypto,now});
        validateBootstrapEnrollmentTerms(terms,{now:now()});
        const attestation=JSON.stringify({terms,nonce_base64:data.nonce_base64,signature_base64:data.signature_base64});
        const attestationSha=await bootstrapSha256(crypto,attestation);
        const result=await rpc('bouncer_v14_bootstrap_enroll_v1',{p_scope_id:terms.scope_id,p_capability_hash:terms.capability_sha256,
          p_owner_id:terms.owner,p_vault_id:terms.vault,p_owner_public_key:terms.owner_public_key,p_temporary_public_key:terms.temporary_public_key,
          p_review_sha256:terms.review_sha256,p_review_text:data.review_text,p_kit_sha256:terms.kit_sha256,p_sealed_kit:data.sealed_kit,
          p_attestation_sha256:attestationSha,p_owner_attestation:attestation});
        if(!exact(result,['status','scope_id','revision','head_sha256','kit_sha256','attestation_sha256'])||
          !['ENROLLED','EXISTING'].includes(result.status)||result.scope_id!==terms.scope_id||!Number.isSafeInteger(result.revision)||
          result.revision<0||result.revision>4||!HEX.test(result.head_sha256??'')||result.kit_sha256!==terms.kit_sha256||
          result.attestation_sha256!==attestationSha)throw fail();
        return respond(200,result);
      }
      if(data?.operation==='read'||data?.operation==='append') {
        const read=data.operation==='read';
        if(!exact(data,read?['operation','scope_id','capability']:['operation','scope_id','capability','expected_revision','expected_head_sha256','record'])||
          !SCOPE.test(data.scope_id??'')||!HEX.test(data.capability??''))throw fail();
        if(!read&&(!Number.isSafeInteger(data.expected_revision)||data.expected_revision<0||data.expected_revision>3||
          !HEX.test(data.expected_head_sha256??'')||typeof data.record!=='string'||data.record.length>4096||/[\r\n]/.test(data.record)))throw fail();
        const result=await rpc('bouncer_v14_bootstrap_events_v1',{p_scope_id:data.scope_id,p_capability_hash:await bootstrapSha256(crypto,data.capability),
          p_operation:data.operation,p_expected_revision:read?null:data.expected_revision,p_expected_head_sha256:read?null:data.expected_head_sha256,
          p_record:read?null:data.record});
        if(!exact(result,['status','scope_id','revision','head_sha256','review_sha256','events'])||
          result.status!==(read?'EXISTING':'APPENDED')||result.scope_id!==data.scope_id||!HEX.test(result.review_sha256??''))throw fail();
        const snapshot={revision:result.revision,head_sha256:result.head_sha256,events:result.events};
        await inspectBootstrapOriginals({snapshot,scopeId:data.scope_id,reviewSha256:result.review_sha256,crypto});
        if(!read&&(snapshot.revision!==data.expected_revision+1||snapshot.events.at(-1)!==data.record||
          snapshot.head_sha256!==await bootstrapSha256(crypto,data.record)))throw fail();
        return respond(200,snapshot);
      }
      if(data?.operation==='recover') {
        if(!exact(data,['operation','terms','nonce_base64','signature_base64']))throw fail();
        const terms=validateBootstrapRecoveryTerms(data.terms,{now:now()});
        if(terms.site!==origin||terms.owner!==OWNER||terms.vault!==VAULT)throw fail();
        await verifyFreshV14Owner({owner:terms.owner,ownerPublicKey:terms.owner_public_key,message:bootstrapRecoveryMessage(terms),
          recipient:new URL(origin).host,nonceBase64:data.nonce_base64,signatureBase64:data.signature_base64,fetch:fetchImpl,crypto,now});
        validateBootstrapRecoveryTerms(terms,{now:now()});
        const result=await rpc('bouncer_v14_bootstrap_owner_read_v1',{p_owner_id:terms.owner,p_vault_id:terms.vault});
        if(!exact(result,['status','scope_id','owner','vault','owner_public_key','temporary_public_key','review_sha256','review_text',
          'kit_sha256','sealed_kit','attestation_sha256','owner_attestation','revision','head_sha256','events'])||
          result.status!=='EXISTING'||result.owner!==terms.owner||result.vault!==terms.vault||
          await bootstrapSha256(crypto,result.owner_attestation)!==result.attestation_sha256)throw fail();
        const att=await verifyBootstrapAttestation({text:result.owner_attestation,crypto});
        if(att.terms.owner!==result.owner||att.terms.vault!==result.vault||att.terms.owner_public_key!==result.owner_public_key||
          att.terms.temporary_public_key!==result.temporary_public_key||att.terms.scope_id!==result.scope_id||
          att.terms.review_sha256!==result.review_sha256||att.terms.kit_sha256!==result.kit_sha256)throw fail();
        await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:result.review_text,kitText:result.sealed_kit,crypto});
        const snapshot={revision:result.revision,head_sha256:result.head_sha256,events:result.events};
        await inspectBootstrapOriginals({snapshot,scopeId:result.scope_id,reviewSha256:result.review_sha256,crypto});
        return respond(200,{status:'EXISTING_RECOVERY_ONLY',scope_id:result.scope_id,review_text:result.review_text,
          sealed_kit:result.sealed_kit,owner_attestation:result.owner_attestation,...snapshot,
          transaction_authorized:false,latest_head_independently_verified:false});
      }
      throw fail();
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14BootstrapCheckpointHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
