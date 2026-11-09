/**
 * Shared, NOT LIVE-WIRED mechanics for a one-shot temporary-vault create.
 * The public entry point deliberately denies invocation until a real,
 * independently recoverable latest-head gate exists. The isolated sandbox
 * may exercise this core with a simulated gate and a disposable wallet.
 *
 * Neither brands, two matching stores, synthetic tests, a valid preflight nor
 * a callback prove that backups are independent or that their head is latest.
 * Never wire this core directly to a real wallet. A wallet may broadcast before
 * returning a hash: a claimed or uncertain original is NEVER a reason to
 * re-prompt. On a lost response the owner must locate and verify the original.
 */
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {isV14BootstrapCreatePreflight} from './v14-bootstrap-create-preflight.mjs';
import {isBootstrapTwoCopyWitness} from './v14-bootstrap-originals.mjs';
import {isBootstrapOriginalRetainer} from './v14-bootstrap-original-retainer.mjs';
import {V14_BOOTSTRAP_ORIGINS,bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {decodeNativeHash32} from './native-oracle-transaction.mjs';

const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ZERO='0'.repeat(64);
const fail=()=>new Error('Bootstrap create is unavailable or uncertain; preserve the existing checkpoint and never repeat a claimed wallet prompt');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const validHash=value=>{try{decodeNativeHash32(value);return true}catch{return false}};
const uint=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(value)?BigInt(value):null;
const usedClaims=new Set(); // one JS realm only; not a substitute for independent durable fencing
function freezeTree(value){
  if(value&&typeof value==='object'){for(const child of Object.values(value))freezeTree(child);Object.freeze(value)}
  return value;
}
function originalFromWallet(result){
  try {
    const values=[result?.transaction?.hash,result?.transaction_outcome?.id].filter(value=>value!==undefined);
    return values.length&&values.every(validHash)&&new Set(values).size===1?values[0]:null;
  }catch{return null}
}
function genesis(state){
  return state?.revision===0&&state.head_sha256===ZERO&&state.create_original===null&&
    state.deploy_original===null&&state.next_event==='create_claim';
}
function claimed(state){
  return state?.revision===1&&HEX.test(state.head_sha256??'')&&state.head_sha256!==ZERO&&
    state.create_original===null&&state.deploy_original===null&&state.next_event==='create_original';
}
function costs(budget){
  const values=[budget?.proposed_vault_funding_yocto,budget?.storage_estimate_yocto,
    budget?.gas_price_yocto_per_gas,budget?.receipt_purchase_price_yocto_per_gas,
    budget?.account_creation_charge_yocto,budget?.create?.gas_upfront_estimate_yocto,
    budget?.create?.owner_total_upfront_estimate_yocto,budget?.deployment?.gas_upfront_estimate_yocto].map(uint);
  if(values.some(value=>value===null)||budget?.status!=='SNAPSHOT_ESTIMATE_NOT_AUTHORIZED'||
    budget.funding_covers_estimated_storage_and_deploy_upfront!==true||budget.funding_is_approved!==false||
    budget.transaction_authorized!==false||budget.transaction_sent!==false)throw fail();
  return values;
}
function proof(result,review,now){
  if(result?.status!=='CREATE_PREFLIGHT_MATCH'||result.network!=='testnet'||result.owner!==review.owner||
    result.vault!==review.vault||result.owner_public_key!==review.owner_public_key||result.review_sha256!==review.review_sha256||
    result.create_action_commitment_sha256!==review.stages[0].action_commitment_sha256||!validHash(result.final_block_hash)||
    !Number.isSafeInteger(result.final_block_height)||result.final_block_height<1||!Number.isSafeInteger(result.checked_at_ms)||
    !Number.isSafeInteger(now)||now<result.checked_at_ms||now-result.checked_at_ms>5_000||
    uint(result.owner_available_yocto)===null||result.wallet_control_verified!==false||
    result.independent_recovery_verified!==false||result.latest_head_independently_verified!==false||
    result.transaction_authorized!==false||result.transaction_sent!==false)throw fail();
  const numbers=costs(result.budget);
  if(numbers[0]!==BigInt(review.vault_funding_yocto)||uint(result.owner_available_yocto)<numbers[6])throw fail();
  return numbers;
}
function withinReview(current,maximum){
  // Funding is exact. Each quoted estimate must not exceed what the owner saw;
  // it is still an estimate, not an enforceable cap on future network prices.
  return current[0]===maximum[0]&&current.every((value,index)=>index===0||value<=maximum[index]);
}

/** Internal mechanics. `assertRecoveryReady` is a trust boundary, not proof;
 * only the public wrapper may be integrated, and it currently always denies.
 * Callers must keep the wallet, account, session and origin current. */
export async function prepareV14BootstrapCreateOnceCore({review:inputReview,compressedV14:inputCompressed,
  witness,retainer,preflight,wallet,location,isTopLevel,isCurrent,assertRecoveryReady,
  now=Date.now,crypto=globalThis.crypto}={}) {
  if(!inputReview||!(inputCompressed instanceof Uint8Array)||!crypto?.subtle||
    !isBootstrapTwoCopyWitness(witness)||typeof isCurrent!=='function'||isCurrent()!==true||
    typeof assertRecoveryReady!=='function'||typeof now!=='function'||isTopLevel!==true||
    !location||!V14_BOOTSTRAP_ORIGINS.includes(location.origin)||new URL(location.origin).host!==location.host||
    !wallet||wallet.manifest?.features?.signAndSendTransaction!==true||typeof wallet.signAndSendTransaction!=='function')throw fail();
  const review=structuredClone(inputReview),compressedV14=new Uint8Array(inputCompressed),binding=witness.binding();
  if(!SCOPE.test(binding.scope_id??'')||!HEX.test(review.review_sha256??'')||binding.review_sha256!==review.review_sha256||
    !isV14BootstrapCreatePreflight(preflight,review.review_sha256)||
    !isBootstrapOriginalRetainer(retainer,witness,review.review_sha256))throw fail();
  const sendOnce=wallet.signAndSendTransaction.bind(wallet);
  const current=()=>{if(isCurrent()!==true)throw fail()};
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  current();if(!same(review,plan.review))throw fail();
  const initial=await witness.inspect();current();if(!genesis(initial))throw fail();
  const first=await preflight();current();const ceiling=proof(first,review,now());
  const terms=freezeTree({format:'bouncer-v14-create-review-v1',network:'testnet',owner:review.owner,vault:review.vault,
    owner_public_key:review.owner_public_key,temporary_vault_public_key:review.temporary_vault_public_key,
    review_sha256:review.review_sha256,create_actions:structuredClone(review.stages[0].actions),
    deployment_actions:structuredClone(review.stages[1].actions),budget:structuredClone(first.budget),
    owner_available_yocto:first.owner_available_yocto,final_block_hash:first.final_block_hash,final_block_height:first.final_block_height,
    limitations:[...review.limitations,
      'The wallet may select a different transaction-signing key; the returned original must be checked against its exact final receipt.',
      'Gas and storage figures are estimates, not guaranteed maximum network charges. A change before approval can block the request.',
      'This review does not prove a separate restore or an independently retained latest head. No transaction is authorized by it.']});
  const termsSha256=await bootstrapSha256(crypto,JSON.stringify(terms));current();
  const localClaim=[binding.scope_id,review.review_sha256].join('|');let invoked=false;
  return Object.freeze({terms,terms_sha256:termsSha256,transaction_authorized:false,
    independent_recovery_verified:false,latest_head_independently_verified:false,
    async invoke({approved,reviewedTermsSha256}={}) {
      if(invoked||approved!==true||reviewedTermsSha256!==termsSha256)throw fail();
      invoked=true;current();
      const reviewCurrent=()=>{
        const time=now();if(!Number.isSafeInteger(time)||time<first.checked_at_ms||time-first.checked_at_ms>120_000)throw fail();
      };
      reviewCurrent();
      // The actual live gate is intentionally unavailable. A test callback is
      // only meaningful inside an isolated chain with disposable credentials.
      if(await assertRecoveryReady(Object.freeze({scope_id:binding.scope_id,review_sha256:review.review_sha256,
        revision:initial.revision,head_sha256:initial.head_sha256}))!==true)throw fail();
      current();
      const before=await witness.inspect();current();if(!genesis(before)||!same(initial,before))throw fail();
      const pre=await preflight();current();reviewCurrent();const preCosts=proof(pre,review,now());
      if(pre.final_block_height<first.final_block_height||!withinReview(preCosts,ceiling))throw fail();
      // If either write is uncertain, stop. Even a later empty read is not
      // permission to replace the claim or open the wallet again.
      const claim=await witness.claimCreate();current();if(!claimed(claim))throw fail();
      const latest=await preflight();current();const latestCosts=proof(latest,review,now());
      if(latest.final_block_height<pre.final_block_height||!withinReview(latestCosts,ceiling))throw fail();
      const reread=await witness.inspect();current();reviewCurrent();
      if(!claimed(reread)||!same(claim,reread))throw fail();
      proof(latest,review,now());
      if(usedClaims.has(localClaim))throw fail();usedClaims.add(localClaim);
      let outcome;
      try {outcome=await sendOnce(structuredClone(plan.walletRequest))}catch{outcome=undefined}
      // Do not discard a returned hash just because the session went stale
      // while the wallet was open. Retention comes before any further work.
      const original=originalFromWallet(outcome);let held;
      try {held=await retainer.retainWalletResult(outcome)}catch{
        held={status:'ORIGINAL_RETENTION_UNCERTAIN',original_hash:original};
      }
      return Object.freeze({status:held.status,original_hash:held.original_hash,do_not_retry:true,
        wallet_request_attempted:true,wallet_may_have_broadcast:true,final_execution_verified:false,
        independent_recovery_verified:false,latest_head_independently_verified:false});
    },
  });
}
