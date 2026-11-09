/** Browser client for an independent Railway encrypted-kit/original anchor.
 * Recovery-only workspace controls are hidden while the route is off. The service has a
 * separate capability derived locally from the temporary key, never the
 * Supabase capability or passphrase. Equal copies still cannot prove a latest
 * head or protect against simultaneous rollback/compromise. Never recreate an
 * absent anchor after an uncertain initialization or transaction. */
import {V14_BOOTSTRAP_ORIGINS,bootstrapSha256,verifyBootstrapAttestation,verifyBootstrapEnrollmentContents} from '../shared/v14-bootstrap-protocol.mjs';
import {deriveBootstrapAnchorCredentials} from '../shared/v14-bootstrap-anchor-auth.mjs';
import {inspectBootstrapOriginals} from './v14-bootstrap-originals.mjs';
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {openV14BootstrapRecoveryKit} from './v14-bootstrap-recovery-kit.mjs';

export const V14_RAILWAY_ANCHOR_ENDPOINT='https://bouncer-production-6df1.up.railway.app/api/v14-bootstrap-anchor';
const SCOPE=/^[a-f0-9]{32}$/,HEX=/^[a-f0-9]{64}$/,ZERO='0'.repeat(64),OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const fail=()=>new Error('Independent bootstrap anchor unavailable or uncertain; preserve records and never repeat a claimed prompt');
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
async function bounded(stream,limit){
  if(!stream?.getReader)throw fail();const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.length)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function validLocation(location,isTopLevel){
  if(isTopLevel!==true||!location||!V14_BOOTSTRAP_ORIGINS.includes(location.origin)||new URL(location.origin).host!==location.host)throw fail();
}
async function post({location,isTopLevel,fetchImpl,isCurrent,body}){
  try {
    validLocation(location,isTopLevel);if(isCurrent()!==true)throw fail();
    const response=await fetchImpl(V14_RAILWAY_ANCHOR_ENDPOINT,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)});
    if(!response.ok)throw fail();const result=JSON.parse(await bounded(response.body,128_000));if(isCurrent()!==true)throw fail();return result;
  }catch{throw fail()}
}
/** An explicit initialization may be attempted ONCE only after the caller
 * persistently records its stop marker and the existing remote is at genesis.
 * A lost response is uncertain; neither a later 404 nor an empty snapshot is
 * permission to initialize a replacement. */
export async function createV14BootstrapRailwayStore({location,isTopLevel,scopeId,reviewSha256,temporaryKey,
  compressedV14:inputCompressed,fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true}={}) {
  validLocation(location,isTopLevel);
  if(!SCOPE.test(scopeId??'')||!HEX.test(reviewSha256??'')||!(inputCompressed instanceof Uint8Array)||
    typeof fetchImpl!=='function'||typeof isCurrent!=='function'||isCurrent()!==true||!crypto?.subtle)throw fail();
  const compressedV14=new Uint8Array(inputCompressed);
  let credentials=await deriveBootstrapAnchorCredentials({temporaryKey,scopeId,reviewSha256,crypto}),initialized=false,disposed=false;
  const current=()=>!disposed&&isCurrent()===true;
  async function request(payload){
    if(!credentials||!current())throw fail();
    return post({location,isTopLevel,fetchImpl,isCurrent:current,body:{scope_id:scopeId,capability:credentials.capability,...payload}});
  }
  async function checked(value){
    await inspectBootstrapOriginals({snapshot:value,scopeId,reviewSha256,crypto});if(!current())throw fail();return value;
  }
  return Object.freeze({
    async initializeNew({reviewText,sealedKit,ownerAttestation,remoteStore,markBeforeInitialize}={}) {
      if(initialized||!current()||!remoteStore||typeof remoteStore.read!=='function'||typeof markBeforeInitialize!=='function')throw fail();
      initialized=true;
      const att=await verifyBootstrapAttestation({text:ownerAttestation,crypto});
      const {review}=await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText,kitText:sealedKit,crypto});
      if(att.terms.owner!==OWNER||att.terms.vault!==VAULT||att.terms.scope_id!==scopeId||att.terms.review_sha256!==reviewSha256||
        review.temporary_vault_public_key!==credentials.temporary_public_key)throw fail();
      const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
        temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
      if(JSON.stringify(plan.review)!==JSON.stringify(review)||!current())throw fail();
      const remote=await remoteStore.read();await checked(remote);
      if(remote.revision!==0||remote.head_sha256!==ZERO||remote.events.length!==0||!current())throw fail();
      // Persist before the network attempt. This is a local stop marker, not a
      // cross-device lock, an independent backup or proof of latest history.
      if(await markBeforeInitialize()!==true||!current())throw fail();
      const result=await request({operation:'initialize',review_sha256:reviewSha256,
        initialization_signature:credentials.initialization_signature,review_text:reviewText,sealed_kit:sealedKit,owner_attestation:ownerAttestation});
      await checked(result);if(result.revision!==0||result.head_sha256!==ZERO||result.events.length!==0)throw fail();
      return Object.freeze({status:'INDEPENDENT_ANCHOR_CREATED',revision:0,head_sha256:ZERO,
        independent_restore_verified:false,latest_head_independently_verified:false,transaction_authorized:false});
    },
    async read(){return checked(await request({operation:'read'}))},
    async append({expected_revision,expected_head_sha256,record}={}){
      if(!Number.isSafeInteger(expected_revision)||expected_revision<0||expected_revision>3||!HEX.test(expected_head_sha256??'')||
        typeof record!=='string'||!record||new TextEncoder().encode(record).length>4096||/[\r\n]/.test(record))throw fail();
      const result=await request({operation:'append',expected_revision,expected_head_sha256,record});await checked(result);
      if(result.revision!==expected_revision+1||result.events.at(-1)!==record||result.head_sha256!==await bootstrapSha256(crypto,record))throw fail();
      return result;
    },
    destroy(){disposed=true;credentials=null;},
  });
}
/** Coarse, owner-authenticated current-mount observation. It neither reads a
 * kit into the browser nor permits initialization. Even a missing result is
 * not evidence that no earlier save or original transaction existed. */
export async function inspectV14BootstrapRailwayAnchor({signed,location,isTopLevel,
  fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true}={}) {
  if(!exact(signed,['terms','nonce_base64','signature_base64'])||typeof fetchImpl!=='function'||typeof isCurrent!=='function')throw fail();
  const result=await post({location,isTopLevel,fetchImpl,isCurrent,body:{operation:'inspect_owner',...structuredClone(signed)}});
  if(!exact(result,['status','latest_head_independently_verified','independent_restore_verified','prior_absence_verified','transaction_authorized'])||
    !['RECORD_VERIFIED_ON_CURRENT_MOUNT','NO_RECORD_ON_CURRENT_MOUNT','CURRENT_MOUNT_UNAVAILABLE'].includes(result.status)||
    result.latest_head_independently_verified!==false||result.independent_restore_verified!==false||
    result.prior_absence_verified!==false||result.transaction_authorized!==false)throw fail();
  return Object.freeze({...result});
}
/** A fresh owner-signed, non-transaction message can retrieve the encrypted
 * kit if the first service or saved file is unavailable. Original hashes are
 * withheld until the kit is unlocked and a capability-authenticated second
 * read matches. Even then, a compromised/rolled-back service can lie; this is
 * not proof of latest history, another device, consent or final receipts. */
export async function recoverV14BootstrapRailwayAnchor({signed,location,isTopLevel,compressedV14:inputCompressed,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true}={}) {
  if(!exact(signed,['terms','nonce_base64','signature_base64'])||!(inputCompressed instanceof Uint8Array)||
    typeof fetchImpl!=='function'||typeof isCurrent!=='function'||!crypto?.subtle)throw fail();
  const compressedV14=new Uint8Array(inputCompressed);
  const result=await post({location,isTopLevel,fetchImpl,isCurrent,body:{operation:'recover_owner',...structuredClone(signed)}});
  if(!exact(result,['scope_id','review_sha256','review_text','sealed_kit','owner_attestation','revision','head_sha256','events',
    'latest_head_independently_verified','transaction_authorized'])||result.latest_head_independently_verified!==false||result.transaction_authorized!==false)throw fail();
  const att=await verifyBootstrapAttestation({text:result.owner_attestation,crypto});
  if(att.terms.owner!==OWNER||att.terms.vault!==VAULT||att.terms.scope_id!==result.scope_id||att.terms.review_sha256!==result.review_sha256)throw fail();
  const {review,kit}=await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:result.review_text,kitText:result.sealed_kit,crypto});
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  if(JSON.stringify(plan.review)!==JSON.stringify(review)||isCurrent()!==true)throw fail();
  const snapshot={revision:result.revision,head_sha256:result.head_sha256,events:result.events};
  await inspectBootstrapOriginals({snapshot,scopeId:result.scope_id,reviewSha256:result.review_sha256,crypto});
  let disposed=false,busy=false,unlocked=false;const current=()=>!disposed&&isCurrent()===true;
  return Object.freeze({status:'ENCRYPTED_ANCHOR_READ_ONLY',owner:OWNER,vault:VAULT,scope_id:result.scope_id,
    review_sha256:result.review_sha256,service_reported_revision:result.revision,history_authentication_verified:false,
    latest_head_independently_verified:false,transaction_authorized:false,
    async unlock(passphrase){
      if(busy||!current())throw fail();busy=true;unlocked=false;let opened;
      try {
        opened=await openV14BootstrapRecoveryKit({kit,passphrase,crypto,expected:{owner:OWNER,vault:VAULT,
          ownerPublicKey:review.owner_public_key,temporaryPublicKey:review.temporary_vault_public_key,
          reviewSha256:result.review_sha256,scopeId:result.scope_id}});passphrase='';
        const authenticated=await opened.useSecrets(async({temporaryKey})=>{
          const credentials=await deriveBootstrapAnchorCredentials({temporaryKey,scopeId:result.scope_id,reviewSha256:result.review_sha256,crypto});
          if(credentials.temporary_public_key!==review.temporary_vault_public_key||!current())throw fail();
          return post({location,isTopLevel,fetchImpl,isCurrent:current,
            body:{operation:'read',scope_id:result.scope_id,capability:credentials.capability}});
        });
        const state=await inspectBootstrapOriginals({snapshot:authenticated,scopeId:result.scope_id,reviewSha256:result.review_sha256,crypto});
        if(!current()||JSON.stringify(snapshot)!==JSON.stringify(authenticated))throw fail();
        unlocked=true;
        return Object.freeze({status:'ANCHOR_KIT_UNLOCKED_AND_SNAPSHOT_MATCHED',revision:state.revision,head_sha256:state.head_sha256,
          service_reported_create_original:state.create_original,service_reported_deploy_original:state.deploy_original,
          capability_read_matches:true,
          history_authentication_verified:false,independent_recovery_verified:false,latest_head_independently_verified:false,transaction_authorized:false});
      }catch{throw fail()}finally{passphrase='';opened?.dispose();busy=false}
    },
    /** Return only the already-encrypted envelope after a successful local
     * unlock. The service-reported history remains unverified and not latest. */
    readEncryptedCopy(){if(!unlocked||busy||!current())throw fail();return structuredClone(result)},
    destroy(){disposed=true;unlocked=false},
  });
}
