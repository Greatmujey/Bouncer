/**
 * Research-only V14 phone wallet adapter. It rebuilds the entire unsigned
 * plan, requires a branded two-copy browser witness, checks a fresh trusted
 * preflight before AND after retaining a one-shot claim, then calls the wallet
 * at most once. It is not wired or enabled on the live site.
 *
 * `verifyPreflight` must independently inspect every prior original receipt
 * and cumulative state at a fresh FINAL testnet block; its presence alone is
 * not proof. This module cannot prevent a compromised origin, server, wallet,
 * simultaneous rollback of both stores, or a chain-state race while the user
 * approves. A missing wallet result or uncertain write never permits a retry.
 */
import {verifyV14BrowserPhonePlan} from './v14-phone-wallet-plan.mjs';
import {isV14BrowserOriginalWitness} from './v14-browser-original-witness.mjs';
import {V14_ENROLLMENT_SITE} from './v14-checkpoint-enrollment.mjs';

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fail=()=>new Error('V14 wallet setup is unavailable or uncertain; preserve the original and do not repeat a claimed prompt');
const exact=(value,fields)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const usedClaims=new Set(); // defense within one JS realm only; both stores are the actual fence
function hash32(value) {
  if(typeof value!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  let number=0n;for(const char of value)number=number*58n+BigInt(B58.indexOf(char));
  let bytes=0;while(number){bytes++;number>>=8n}for(let i=0;value[i]==='1';i++)bytes++;
  return bytes===32;
}
function validatePreflight(result,{review,stage,prior,now}) {
  const fields=['status','network','owner','vault','stage_id','review_sha256','action_commitment_sha256',
    'prior_original_hashes','final_block_hash','checked_at_ms','wallet_transaction_authorized','transaction_sent'];
  if(!exact(result,fields)||result.status!=='V14_SETUP_PREFLIGHT_MATCH'||result.network!=='testnet'||
      result.owner!==review.owner||result.vault!==review.vault||result.stage_id!==stage.id||
      result.review_sha256!==review.review_sha256||result.action_commitment_sha256!==stage.action_commitment_sha256||
      !same(result.prior_original_hashes,prior.map(item=>item.tx_hash))||!hash32(result.final_block_hash)||
      !Number.isSafeInteger(result.checked_at_ms)||!Number.isSafeInteger(now)||now<result.checked_at_ms||
      now-result.checked_at_ms>5_000||result.wallet_transaction_authorized!==false||result.transaction_sent!==false)throw fail();
}

/** Prepare without a wallet prompt. Call `invoke` only after the owner sees and
 * explicitly approves this stage's actual amounts, gas, keys and actions. */
export async function prepareV14PhoneWalletPrompt({review,trustedReviewSha256,trustedArtifacts,loaderBytes,compressedBytes,
    scopeId,stageId,witness,wallet,verifyPreflight,location=globalThis.location,isTopLevel,isCurrent,now=Date.now,
    crypto=globalThis.crypto}={}) {
  if(location?.origin!==V14_ENROLLMENT_SITE||isTopLevel!==true||!isV14BrowserOriginalWitness(witness)||
      typeof isCurrent!=='function'||typeof verifyPreflight!=='function'||typeof now!=='function'||
      !wallet||typeof wallet.signAndSendTransaction!=='function'||wallet.manifest?.features?.signAndSendTransaction!==true||
      typeof scopeId!=='string'||!/^[a-f0-9]{32}$/.test(scopeId))throw fail();
  const current=()=>{if(isCurrent()!==true)throw fail()};current();
  const plan=await verifyV14BrowserPhonePlan({review,trustedReviewSha256,trustedArtifacts,loaderBytes,compressedBytes,crypto});current();
  const stage=plan.stages.find(item=>item.id===stageId);
  if(!stage)throw fail();
  const immutableReview=structuredClone(plan.review),immutableStage=structuredClone(stage);let invoked=false;
  return Object.freeze({
    stage_id:stage.id,owner:immutableReview.owner,receiver_id:stage.receiver_id,
    review_sha256:immutableReview.review_sha256,wallet_prompt_authorized:false,
    async invoke() {
      if(invoked)throw fail();invoked=true;current();
      const before=await witness.inspect();current();
      const index=immutableReview.stages.findIndex(item=>item.id===stage.id);
      if(before.scope_id!==scopeId||before.review?.review_sha256!==immutableReview.review_sha256||before.pending!==null||
          before.next_setup_stage!==stage.id||!Array.isArray(before.setup)||before.setup.length!==index)throw fail();
      const prior=structuredClone(before.setup);
      async function preflight() {
        const result=await verifyPreflight({review:structuredClone(immutableReview),scopeId,stageId:stage.id,prior:structuredClone(prior)});
        current();validatePreflight(result,{review:immutableReview,stage:immutableStage,prior,now:now()});
      }
      await preflight();
      const claimed=await witness.claimWalletStage(stage.id);current();
      if(claimed.scope_id!==scopeId||claimed.review?.review_sha256!==immutableReview.review_sha256||
          claimed.revision!==before.revision+1||claimed.pending?.type!=='wallet'||claimed.pending.stage_id!==stage.id||
          claimed.pending.tx_hash!==null||!same(claimed.setup,prior))throw fail();
      // Failure here leaves an explicit one-shot claim. It is NOT permission
      // to prompt again; reconciliation must determine what happened.
      await preflight();
      const reread=await witness.inspect();current();
      if(reread.revision!==claimed.revision||reread.head_sha256!==claimed.head_sha256||
          !same(reread.pending,claimed.pending)||!same(reread.setup,prior))throw fail();
      const localClaim=[scopeId,immutableReview.review_sha256,stage.id].join('|');
      if(usedClaims.has(localClaim))throw fail();
      usedClaims.add(localClaim); // before executing wallet code, even a synchronous throw
      let outcome;
      try {outcome=await wallet.signAndSendTransaction({network:'testnet',signerId:immutableReview.owner,
        receiverId:immutableStage.receiver_id,actions:structuredClone(immutableStage.actions)});}
      catch {return {status:'WALLET_RESULT_UNKNOWN',original_hash:null,do_not_retry:true,final_execution_verified:false};}
      const candidates=[outcome?.transaction?.hash,outcome?.transaction_outcome?.id].filter(value=>value!==undefined);
      if(!candidates.length||candidates.some(value=>!hash32(value))||new Set(candidates).size!==1) {
        return {status:'WALLET_RESULT_UNKNOWN',original_hash:null,do_not_retry:true,final_execution_verified:false};
      }
      const originalHash=candidates[0];
      try {
        // Even if the wallet/session changed while it was open, preserve the
        // exact returned hash before doing anything else. This is not a receipt.
        await witness.retainWalletOriginal({stageId:stage.id,txHash:originalHash});
      }catch{return {status:'ORIGINAL_RETENTION_UNCERTAIN',original_hash:originalHash,do_not_retry:true,final_execution_verified:false};}
      return {status:'ORIGINAL_HASH_RETAINED',original_hash:originalHash,do_not_retry:true,final_execution_verified:false};
    },
  });
}
