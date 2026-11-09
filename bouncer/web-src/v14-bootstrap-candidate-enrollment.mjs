/**
 * Bridge a saved local candidate to the existing, default-off recovery
 * checkpoint. This requests one owner-signed NEP-413 message and stores only
 * the encrypted kit and public review. It cannot create, sign, send or
 * authorize a transaction, and a service acknowledgement is not a verified
 * independent restore or a trusted latest history head.
 *
 * The caller must durably mark the enrollment attempt before the POST. A lost
 * acknowledgement is recovery-only, never a reason to create another scope.
 */
import {verifyV14BootstrapCandidate} from './v14-bootstrap-candidate.mjs';
import {prepareBootstrapEnrollment,signBootstrapEnrollment} from './v14-bootstrap-checkpoint.mjs';
import {V14_BOOTSTRAP_ENDPOINT,enrollBootstrapCheckpoint} from './v14-bootstrap-remote-store.mjs';
import {V14_BOOTSTRAP_ORIGINS} from '../shared/v14-bootstrap-protocol.mjs';
import {V14_EXAMPLE_VAULT_FUNDING_YOCTO} from '../shared/v14-bootstrap-budget.mjs';

const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const fail=()=>new Error('Encrypted checkpoint enrollment unavailable; no transaction is authorized');
const ownerChanged=()=>new Error('The recorded owner key changed; stop and reconcile before enrollment');
const uncertain=()=>new Error('Encrypted checkpoint enrollment may have been recorded; recover it instead of enrolling again');

export function createBootstrapCandidateEnrollmentClient({wallet,owner,ownerPublicKey,location,isTopLevel,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,isCurrent=()=>true,now=Date.now}={}) {
  if(owner!==OWNER||typeof ownerPublicKey!=='string'||!wallet||typeof wallet.signMessage!=='function'||
    isTopLevel!==true||!location||!V14_BOOTSTRAP_ORIGINS.includes(location.origin)||
    new URL(location.origin).host!==location.host||!crypto?.subtle||typeof crypto.getRandomValues!=='function'||
    typeof fetchImpl!=='function'||typeof isCurrent!=='function'||typeof now!=='function'||isCurrent()!==true)throw fail();
  let busy=false,stopped=false,disposed=false;
  function current(){if(disposed||isCurrent()!==true)throw fail()}
  async function enabled() {
    try {
      current();
      const response=await fetchImpl(V14_BOOTSTRAP_ENDPOINT,{method:'OPTIONS',mode:'cors',credentials:'omit',redirect:'error',
        cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8_000)});
      current();return response.status===204;
    }catch{return false}
  }
  return Object.freeze({
    enabled,
    async enroll({text,expectedFingerprint,passphrase,compressedV14,beforePublish}={}) {
      current();
      if(busy||stopped||typeof beforePublish!=='function'||!(compressedV14 instanceof Uint8Array))throw fail();
      busy=true;let barrierStarted=false;
      try {
        // Do not ask for even a message signature if the endpoint is off.
        if(!await enabled())throw fail();current();
        const artifact=compressedV14.slice();
        const checked=await verifyV14BootstrapCandidate({text,expectedFingerprint,owner:OWNER,vault:VAULT,
          vaultFundingYocto:V14_EXAMPLE_VAULT_FUNDING_YOCTO,currentOwnerPublicKey:ownerPublicKey,
          compressedV14:artifact,passphrase,crypto});
        current();if(checked.owner_key_matches_current!==true)throw ownerChanged();
        const candidate=JSON.parse(text);
        const draft=await prepareBootstrapEnrollment({review:candidate.review,kit:candidate.sealed_kit,
          passphrase,compressedV14:artifact,site:location.origin,crypto,now});
        current();
        if(draft.terms.review_sha256!==checked.review_sha256||draft.terms.owner_public_key!==ownerPublicKey)throw fail();
        const signed=await signBootstrapEnrollment({draft,wallet,location,crypto,fetch:fetchImpl,now});
        current();
        // The marker must survive this tab before a request can reach the
        // service. It is a local stop sign, not an independent latest head.
        barrierStarted=true;
        if(await beforePublish()!==true)throw fail();
        current();
        const result=await enrollBootstrapCheckpoint({signed,location,fetch:fetchImpl,crypto,
          isCurrent:()=>!disposed&&isCurrent()===true,now});
        stopped=true;current();
        return Object.freeze({status:result.status,scope_id:result.scope_id,revision:result.revision,
          head_sha256:result.head_sha256,review_sha256:checked.review_sha256,
          transaction_authorized:false,transaction_sent:false,independent_backup_verified:false,
          latest_head_independently_verified:false,on_chain_state_checked:false});
      }catch(error){
        if(barrierStarted){stopped=true;throw uncertain()}
        if(error?.message===ownerChanged().message)throw error;
        throw fail();
      }finally{busy=false}
    },
    destroy(){disposed=true;},
  });
}
