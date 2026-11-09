/** Recovery-only browser coordinator for the temporary-vault checkpoint.
 * It may ask the connected owner to sign a non-spending NEP-413 message, but
 * cannot create, sign, broadcast, or authorize a NEAR transaction. A recovered
 * encrypted kit and hash chain do not prove the latest head or final receipts.
 * No key, capability, or passphrase is returned from this interface. */
import {prepareBootstrapRecovery,signBootstrapRecovery} from './v14-bootstrap-checkpoint.mjs';
import {V14_BOOTSTRAP_ENDPOINT,recoverBootstrapCheckpoint,createBootstrapRemoteStore} from './v14-bootstrap-remote-store.mjs';
import {V14_RAILWAY_ANCHOR_ENDPOINT,createV14BootstrapRailwayStore,recoverV14BootstrapRailwayAnchor} from './v14-bootstrap-railway-store.mjs';
import {V14_BOOTSTRAP_ORIGINS,verifyBootstrapAttestation,verifyBootstrapEnrollmentContents} from '../shared/v14-bootstrap-protocol.mjs';
import {inspectBootstrapOriginals} from './v14-bootstrap-originals.mjs';
import {openV14BootstrapRecoveryKit} from './v14-bootstrap-recovery-kit.mjs';
import {verifyV14BootstrapCandidate} from './v14-bootstrap-candidate.mjs';
import {V14_EXAMPLE_VAULT_FUNDING_YOCTO} from '../shared/v14-bootstrap-budget.mjs';

const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const HEX=/^[a-f0-9]{64}$/;
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('Encrypted setup recovery is unavailable or uncertain; never repeat an unresolved transaction');
function exportBody(result) {
  return {format:'bouncer-v14-bootstrap-recovery-export-v1',network:'testnet',owner:OWNER,vault:VAULT,
    scope_id:result.scope_id,review_text:result.review_text,sealed_kit:result.sealed_kit,owner_attestation:result.owner_attestation,
    revision:result.revision,head_sha256:result.head_sha256,events:result.events,
    latest_head_independently_verified:false,transaction_authorized:false};
}
export function createBootstrapRecoveryReadClient({wallet,owner,ownerPublicKey,location,isTopLevel,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true,now=Date.now}={}) {
  if(owner!==OWNER||!wallet||typeof wallet.signMessage!=='function'||isTopLevel!==true||
    !location||!V14_BOOTSTRAP_ORIGINS.includes(location.origin)||new URL(location.origin).host!==location.host||
    !crypto?.subtle||typeof crypto.getRandomValues!=='function'||typeof fetchImpl!=='function'||
    typeof isCurrent!=='function'||typeof now!=='function'||isCurrent()!==true)throw fail();
  let disposed=false,busy=false,recovered=null;
  function current(){if(disposed||isCurrent()!==true)throw fail()}
  async function enabled() {
    try {
      current();
      const response=await fetchImpl(V14_BOOTSTRAP_ENDPOINT,{method:'OPTIONS',mode:'cors',credentials:'omit',redirect:'error',
        cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8_000)});
      current();return response.status===204;
    }catch{return false}
  }
  async function anchorEnabled() {
    try {
      current();
      const response=await fetchImpl(V14_RAILWAY_ANCHOR_ENDPOINT,{method:'OPTIONS',mode:'cors',credentials:'omit',redirect:'error',
        cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8_000)});
      current();return response.status===204;
    }catch{return false}
  }
  async function run(fn){current();if(busy)throw fail();busy=true;try{return await fn()}finally{busy=false}}
  async function fetchRecovery(stillSelected=()=>true,onWalletPrompt=()=>{}) {
    const check=()=>{current();if(stillSelected()!==true)throw fail()};
    // A failed availability check is not evidence of absence.
    if(!await enabled())throw fail();check();
    onWalletPrompt();check();
    const draft=prepareBootstrapRecovery({owner,ownerPublicKey,vault:VAULT,site:location.origin,crypto,now});
    const signed=await signBootstrapRecovery({draft,wallet,location,crypto,fetch:fetchImpl,now});check();
    const result=await recoverBootstrapCheckpoint({signed,location,fetch:fetchImpl,crypto,
      isCurrent:()=>!disposed&&isCurrent()===true&&stillSelected()===true,now});
    check();return result;
  }
  async function validateResult(result) {
    if(!exact(result,['status','scope_id','review_text','sealed_kit','owner_attestation','revision','head_sha256','events',
      'transaction_authorized','latest_head_independently_verified'])||result.status!=='EXISTING_RECOVERY_ONLY'||
      result.transaction_authorized!==false||result.latest_head_independently_verified!==false)throw fail();
    const att=await verifyBootstrapAttestation({text:result.owner_attestation,crypto});
    if(att.terms.owner!==OWNER||att.terms.vault!==VAULT||att.terms.scope_id!==result.scope_id)throw fail();
    await verifyBootstrapEnrollmentContents({terms:att.terms,reviewText:result.review_text,kitText:result.sealed_kit,crypto});
    const state=await inspectBootstrapOriginals({snapshot:{revision:result.revision,head_sha256:result.head_sha256,events:result.events},
      scopeId:result.scope_id,reviewSha256:att.terms.review_sha256,crypto});current();
    return {result:structuredClone(result),terms:{...att.terms},state:{...state}};
  }
  async function retainVerified(result,expectedMac=null,source='online') {
    if((expectedMac!==null&&!HEX.test(expectedMac))||!['online','file','railway'].includes(source))throw fail();
    const checked=await validateResult(result);current();
    recovered={...checked,expectedMac,verifiedMac:null,source};
    const {state}=checked;
    // An unkeyed chain can be forged. Never present its claimed originals as
    // verified before the encrypted copy's MAC has been checked locally.
    return Object.freeze({revision:state.revision,head_sha256:state.head_sha256,create_original:null,
      deploy_original:null,next_event:null,transaction_authorized:false,
      latest_head_independently_verified:false,history_authentication_verified:false});
  }
  async function unlockRetained(passphrase) {
      if(!recovered)throw fail();const {result,terms,state,expectedMac}=recovered;
      recovered.verifiedMac=null;
      const kit=JSON.parse(result.sealed_kit);
      const opened=await openV14BootstrapRecoveryKit({kit,passphrase,crypto,expected:{owner:terms.owner,vault:terms.vault,
        ownerPublicKey:terms.owner_public_key,temporaryPublicKey:terms.temporary_public_key,
        reviewSha256:terms.review_sha256,scopeId:terms.scope_id}});
      try {
        const mac=await opened.useSecrets(async ({checkpointCapability})=>{
          const keyBytes=Uint8Array.from(checkpointCapability.match(/../g),pair=>parseInt(pair,16));
          try {
            const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
            const input=new TextEncoder().encode(`bouncer-v14-bootstrap-export-v1\0${JSON.stringify(exportBody(result))}`);
            return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,input))].map(n=>n.toString(16).padStart(2,'0')).join('');
          }finally{keyBytes.fill(0)}
        });
        current();if(expectedMac!==null&&expectedMac!==mac)throw fail();
        recovered.verifiedMac=mac;
      }finally{opened.dispose()}
      // Online history arrived without an existing MAC. Creating one now makes
      // a protected export, but does not authenticate what the service sent.
      return Object.freeze({status:'KIT_UNLOCKED_LOCALLY_NOT_AUTHORIZED',revision:state.revision,head_sha256:state.head_sha256,
        create_original:state.create_original,deploy_original:state.deploy_original,transaction_authorized:false,
        history_authentication_verified:expectedMac!==null,latest_head_independently_verified:false});
  }
  return Object.freeze({
    enabled,anchorEnabled,
    async read() {return run(async()=>{
      recovered=null; // a failed new read must not leave an older export active
      // Check before requesting an owner signature. An unavailable endpoint is
      // not evidence that no earlier checkpoint or transaction exists.
      return retainVerified(await fetchRecovery());
    })},
    /** Import only the owner's signed encrypted export. Works when the remote
     * service is off or unreachable; does not prove this is the latest copy. */
    async importEncrypted(text) {return run(async()=>{
      recovered=null; // malformed replacement must not expose a previous copy
      if(typeof text!=='string'||new TextEncoder().encode(text).length>128_000)throw fail();
      let file;try{file=JSON.parse(text)}catch{throw fail()}
      if(!exact(file,['format','network','owner','vault','scope_id','review_text','sealed_kit','owner_attestation',
        'revision','head_sha256','events','latest_head_independently_verified','transaction_authorized','history_hmac_sha256'])||
        file.format!=='bouncer-v14-bootstrap-recovery-export-v1'||file.network!=='testnet'||file.owner!==OWNER||file.vault!==VAULT||
        file.latest_head_independently_verified!==false||file.transaction_authorized!==false||!HEX.test(file.history_hmac_sha256??''))throw fail();
      return retainVerified({status:'EXISTING_RECOVERY_ONLY',scope_id:file.scope_id,review_text:file.review_text,sealed_kit:file.sealed_kit,
        owner_attestation:file.owner_attestation,revision:file.revision,head_sha256:file.head_sha256,events:file.events,
        transaction_authorized:false,latest_head_independently_verified:false},file.history_hmac_sha256,'file');
    })},
    async verifyPassphrase(passphrase) {return run(()=>unlockRetained(passphrase))},
    /** Restore from the separate service without contacting the original
     * checkpoint. The wallet signs a fresh message only; the passphrase and
     * unlocked key remain local. No returned history is claimed as latest. */
    async restoreIndependentAnchor({passphrase,compressedV14,onWalletPrompt=()=>{},stillSelected=()=>true}={}) {return run(async()=>{
      recovered=null;
      if(!(compressedV14 instanceof Uint8Array)||typeof onWalletPrompt!=='function'||typeof stillSelected!=='function'||
        stillSelected()!==true||!await anchorEnabled()||stillSelected()!==true)throw fail();
      const check=()=>{current();if(stillSelected()!==true)throw fail()};
      try {
        onWalletPrompt();check();
        const draft=prepareBootstrapRecovery({owner,ownerPublicKey,vault:VAULT,site:location.origin,crypto,now});
        const signed=await signBootstrapRecovery({draft,wallet,location,crypto,fetch:fetchImpl,now});check();
        const handle=await recoverV14BootstrapRailwayAnchor({signed,compressedV14,location,isTopLevel,
          fetch:fetchImpl,crypto,isCurrent:()=>!disposed&&isCurrent()===true&&stillSelected()===true});check();
        let backup;
        try {await handle.unlock(passphrase);backup=handle.readEncryptedCopy()}finally{handle.destroy()}
        check();await retainVerified({status:'EXISTING_RECOVERY_ONLY',scope_id:backup.scope_id,review_text:backup.review_text,
          sealed_kit:backup.sealed_kit,owner_attestation:backup.owner_attestation,revision:backup.revision,
          head_sha256:backup.head_sha256,events:backup.events,transaction_authorized:false,
          latest_head_independently_verified:false},null,'railway');
        check();const history=await unlockRetained(passphrase);check();return history;
      }catch{recovered=null;throw fail()}finally{passphrase=''}
    })},
    /** Copy the existing owner-signed encrypted kit to the independent Railway
     * anchor, without replacing the Supabase enrollment. This is available
     * only from a fresh online recovery at genesis. The passphrase and both
     * secret capabilities stay in local memory, never in the result. An
     * uncertain initialization must be recovered, never retried. */
    async saveIndependentAnchor({passphrase,compressedV14,markBeforeInitialize}={}) {return run(async()=>{
      const reference=recovered;
      if(!reference||reference.source!=='online'||reference.state.revision!==0||reference.state.head_sha256!=='0'.repeat(64)||
        !(compressedV14 instanceof Uint8Array)||typeof markBeforeInitialize!=='function')throw fail();
      const {result,terms}=reference,kit=JSON.parse(result.sealed_kit),artifact=new Uint8Array(compressedV14);
      let opened,railway;
      try {
        if(!await anchorEnabled()||recovered!==reference)throw fail();
        opened=await openV14BootstrapRecoveryKit({kit,passphrase,crypto,expected:{owner:terms.owner,vault:terms.vault,
          ownerPublicKey:terms.owner_public_key,temporaryPublicKey:terms.temporary_public_key,
          reviewSha256:terms.review_sha256,scopeId:terms.scope_id}});passphrase='';
        const selected=()=>!disposed&&isCurrent()===true&&recovered===reference;
        const outcome=await opened.useSecrets(async({temporaryKey,checkpointCapability})=>{
          const remote=createBootstrapRemoteStore({location,scopeId:terms.scope_id,capability:checkpointCapability,
            reviewSha256:terms.review_sha256,crypto,fetch:fetchImpl,isCurrent:selected});
          railway=await createV14BootstrapRailwayStore({location,isTopLevel,scopeId:terms.scope_id,reviewSha256:terms.review_sha256,
            temporaryKey,compressedV14:artifact,fetch:fetchImpl,crypto,isCurrent:selected});
          return railway.initializeNew({reviewText:result.review_text,sealedKit:result.sealed_kit,
            ownerAttestation:result.owner_attestation,remoteStore:remote,markBeforeInitialize});
        });
        current();if(recovered!==reference)throw fail();return outcome;
      }catch{throw fail()}finally{passphrase='';railway?.destroy();opened?.dispose()}
    })},
    /** Check the originally saved preparation file against the enrolled kit.
     * The file, passphrase and backup ID stay on this device; only a fresh
     * owner-signed read reaches the service. The file has no history, so a
     * match cannot authenticate later events or establish the latest head. */
    async compareSavedCandidate({text,expectedFingerprint,passphrase,compressedV14,stillSelected=()=>true,onWalletPrompt=()=>{}}={}) {return run(async()=>{
      if(!(compressedV14 instanceof Uint8Array)||typeof stillSelected!=='function'||stillSelected()!==true||typeof onWalletPrompt!=='function')throw fail();
      let checked;
      try {
        checked=await verifyV14BootstrapCandidate({text,expectedFingerprint,owner:OWNER,vault:VAULT,
          vaultFundingYocto:V14_EXAMPLE_VAULT_FUNDING_YOCTO,currentOwnerPublicKey:ownerPublicKey,
          compressedV14:compressedV14.slice(),passphrase,crypto});
      } finally {passphrase='';}
      current();if(stillSelected()!==true)throw fail();
      if(checked.owner_key_matches_current!==true) return Object.freeze({status:'OWNER_KEY_CHANGED',
        file_integrity_verified:true,independent_backup_verified:false,latest_head_independently_verified:false,
        vault_or_receipts_checked:false,transaction_authorized:false,transaction_sent:false});
      const candidate=JSON.parse(text);
      const online=await validateResult(await fetchRecovery(stillSelected,onWalletPrompt));current();if(stillSelected()!==true)throw fail();
      const same=online.result.scope_id===candidate.sealed_kit.scope_id &&
        online.result.review_text===JSON.stringify(candidate.review) &&
        online.result.sealed_kit===JSON.stringify(candidate.sealed_kit);
      return Object.freeze({status:same?'MATCHED':'DIFFERENT_SETUP',file_integrity_verified:true,
        service_reported_revision:online.state.revision,history_authentication_verified:false,
        independent_backup_verified:false,latest_head_independently_verified:false,vault_or_receipts_checked:false,
        transaction_authorized:false,transaction_sent:false});
    })},
    /** Compare an unlocked, MAC-checked imported file with the current online
     * response. This is a snapshot comparison, not proof that either copy is
     * independently stored, freshest, on-chain, or authorized to transact. */
    async compareOnline() {return run(async()=>{
      const reference=recovered;
      if(!reference||reference.expectedMac===null||reference.verifiedMac!==reference.expectedMac)throw fail();
      const online=await validateResult(await fetchRecovery());current();
      if(recovered!==reference)throw fail();
      const file=reference.result,remote=online.result;
      const sameSetup=['scope_id','review_text','sealed_kit','owner_attestation'].every(key=>file[key]===remote[key]);
      let status='DIFFERENT_SETUP';
      if(sameSetup) {
        const prefix=file.events.slice(0,Math.min(file.events.length,remote.events.length));
        if(!prefix.every((event,index)=>event===remote.events[index]))status='DIVERGED';
        else if(file.revision<remote.revision)status='ONLINE_AHEAD';
        else if(file.revision>remote.revision)status='FILE_AHEAD';
        else status=file.head_sha256===remote.head_sha256?'MATCHED':'DIVERGED';
      }
      return Object.freeze({status,file_revision:file.revision,file_head_sha256:file.head_sha256,
        online_revision:remote.revision,online_head_sha256:remote.head_sha256,
        file_integrity_verified:true,independent_backup_verified:false,latest_head_independently_verified:false,
        vault_or_receipts_checked:false,transaction_authorized:false,transaction_sent:false});
    })},
    /** Export ciphertext and authenticated public history only. A valid MAC
     * detects changes by those without the kit capability; it cannot prove the
     * copy is latest or protect against a compromised service with capability. */
    exportEncrypted() {
      current();if(!recovered||busy||!HEX.test(recovered.verifiedMac??''))throw fail();
      return JSON.stringify({...exportBody(recovered.result),history_hmac_sha256:recovered.verifiedMac});
    },
    forget(){current();if(busy)throw fail();recovered=null;},
    destroy(){disposed=true;recovered=null;},
  });
}
