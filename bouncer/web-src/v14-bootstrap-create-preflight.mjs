/**
 * Read-only preflight for the exact, previously enrolled temporary-vault plan.
 * Rebuilds the pinned actions, then checks the owner, the plan's specific
 * message-signing key, the absent child, balance and gas at one FINAL testnet
 * block. This is source-only and is not wired to a wallet prompt.
 *
 * The RPC and injected fetch are trust boundaries. A valid snapshot cannot
 * prove an independent backup or the latest original history, authorize a
 * transaction, predict a wallet's chosen signing key, or prevent state
 * changing while the user approves. No signing, sending or retry occurs here.
 */
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {inspectV14BootstrapBudget} from './v14-bootstrap-budget-client.mjs';
import {V14_EXAMPLE_VAULT_FUNDING_YOCTO} from '../shared/v14-bootstrap-budget.mjs';

const OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const preflights=new WeakMap();
const fail=()=>new Error('Fresh bootstrap preflight is unavailable or blocked; no wallet transaction was requested');
function freezeTree(value){
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value)}
  return value;
}
// In-realm identity/binding only; injected fetch and the RPC remain trusted.
export const isV14BootstrapCreatePreflight=(value,reviewSha256)=>preflights.has(value)&&
  (reviewSha256===undefined||preflights.get(value)===reviewSha256);

export async function createV14BootstrapCreatePreflight({review:inputReview,compressedV14:inputCompressed,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,now=Date.now,isCurrent=()=>true}={}) {
  if(!inputReview||!(inputCompressed instanceof Uint8Array)||!crypto?.subtle||typeof fetchImpl!=='function'||
    typeof now!=='function'||typeof isCurrent!=='function'||isCurrent()!==true)throw fail();
  // Capture all mutable inputs before the first await.
  const review=structuredClone(inputReview),compressedV14=new Uint8Array(inputCompressed);
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  if(isCurrent()!==true||JSON.stringify(review)!==JSON.stringify(plan.review)||review.owner!==OWNER||review.vault!==VAULT||
    review.vault_funding_yocto!==V14_EXAMPLE_VAULT_FUNDING_YOCTO)throw fail();
  const preflight=async()=>{
    try {
      if(isCurrent()!==true)throw fail();
      const r=await inspectV14BootstrapBudget({fetch:fetchImpl,now,isCurrent,expectedOwnerPublicKey:review.owner_public_key});
      const checkedAt=Date.parse(r.observed_at),time=now();
      if(isCurrent()!==true||r.status!=='READ_ONLY_REVIEW_NOT_AUTHORIZED'||r.network!=='testnet'||
        r.owner!==OWNER||r.vault!==VAULT||r.candidate_presence!=='ABSENT_AT_FINAL_BLOCK'||r.blockers.length!==0||
        r.checks.reviewed_owner_key_full_access!==true||r.budget.proposed_vault_funding_yocto!==review.vault_funding_yocto||
        !Number.isSafeInteger(checkedAt)||!Number.isSafeInteger(time)||time<checkedAt||time-checkedAt>5_000||
        r.independent_recovery_verified!==false||r.transaction_authorized!==false||r.transaction_sent!==false)throw fail();
      return Object.freeze({status:'CREATE_PREFLIGHT_MATCH',network:'testnet',owner:OWNER,vault:VAULT,
        owner_public_key:review.owner_public_key,review_sha256:review.review_sha256,
        create_action_commitment_sha256:review.stages[0].action_commitment_sha256,
        final_block_hash:r.block_hash,final_block_height:r.block_height,checked_at_ms:checkedAt,
        owner_available_yocto:r.owner_available_yocto,budget:freezeTree(structuredClone(r.budget)),
        wallet_control_verified:false,independent_recovery_verified:false,latest_head_independently_verified:false,
        transaction_authorized:false,transaction_sent:false});
    }catch{throw fail()}
  };
  preflights.set(preflight,review.review_sha256);return preflight;
}
