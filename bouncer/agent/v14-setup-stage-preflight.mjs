/**
 * Research-only, read-only preflight before a V14 phone setup wallet prompt.
 * Every earlier retained original is fetched from a fixed testnet RPC and its
 * exact receipt graph checked; the last original also gets a fresh cumulative
 * state verification. Stage zero instead requires the candidate to be absent
 * at a fresh FINAL block and the reviewed owner key to be FullAccess.
 *
 * This is not a consensus proof, a reservation of chain state, a fee quote,
 * owner consent, a durable witness, loader review, or proof of no in-flight
 * transaction. The caller must separately verify the independent one-shot
 * claim. No live HTTP endpoint or wallet currently uses this module.
 */
import {isDeepStrictEqual} from 'node:util';
import {ReadOnlyNearReceiptProvider} from './read-only-near-receipts.mjs';
import {V14_SETUP_TESTNET_RPC,createV14SetupRpcVerifier} from './v14-setup-rpc-verifier.mjs';
import {inspectV14Readiness} from './native-v14-readiness.mjs';
import {verifyV14PhoneResearchPlan} from './native-v14-phone-plan.mjs';
import {deriveV14OriginalBinding} from './v14-original-witness.mjs';
import {prepareV14PhoneAttempt,inspectV14PhoneAttempt} from './native-v14-phone-receipts.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';

const exact=(x,fields)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).length===fields.length&&fields.every(field=>Object.hasOwn(x,field));
const success=new Set(['FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH','FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH']);
const fail=()=>new Error('V14 stage preflight is unavailable or inconsistent; preserve originals and do not repeat a claimed prompt');

/** Inputs and trusted review digest/artifact pins must already be independently
 * retained. The callback itself never trusts pins supplied in an HTTP request. */
export function createV14SetupStagePreflight({planInputs,provider,now=Date.now}={}) {
  if(!(provider instanceof ReadOnlyNearReceiptProvider)||provider.connection?.url!==V14_SETUP_TESTNET_RPC||typeof now!=='function')throw fail();
  let inputs,plan,verifyLast;
  try {inputs=structuredClone(planInputs);plan=verifyV14PhoneResearchPlan(inputs);verifyLast=createV14SetupRpcVerifier({planInputs:inputs,provider,now});}
  catch{throw fail()}
  const reviewed=plan.review;
  return async function preflight({review,scopeId,stageId,prior}={}) {
    try {
      // Snapshot all caller data before RPC awaits; a mutable client must not
      // replace a prior original while verification is in progress.
      review=structuredClone(review);prior=structuredClone(prior);
      if(provider.connection?.url!==V14_SETUP_TESTNET_RPC||!isDeepStrictEqual(review,reviewed)||
          !Array.isArray(prior)||!/^[a-f0-9]{32}$/.test(scopeId??''))throw fail();
      const binding=deriveV14OriginalBinding({...inputs,scopeId}),index=reviewed.stages.findIndex(stage=>stage.id===stageId);
      if(index<0||prior.length!==index||prior.some((item,i)=>!exact(item,['stage_id','tx_hash','recorded_final_block_hash'])||
          item.stage_id!==reviewed.stages[i].id||!isTransactionHash(item.tx_hash)||!isTransactionHash(item.recorded_final_block_hash))||
          new Set(prior.map(item=>item.tx_hash)).size!==prior.length)throw fail();
      const started=now();if(!Number.isSafeInteger(started))throw fail();
      let blockHash,initialBlock;
      if(index===0) {
        const readiness=await inspectV14Readiness({owner:reviewed.owner,vault:reviewed.vault,provider,now});
        if(readiness.status!=='READ_ONLY_CHECKS_PASSED_NOT_AUTHORIZED'||readiness.candidate_presence!=='ABSENT_AT_FINAL_BLOCK'||
            BigInt(readiness.estimated_owner_available_yocto)<BigInt(reviewed.vault_storage_funding_yocto)+
              BigInt(reviewed.native_deposit_yocto)+14n)throw fail();
        blockHash=readiness.block_hash;
        const [key,keys]=await Promise.all([
          provider.query({request_type:'view_access_key',account_id:reviewed.owner,
            public_key:reviewed.owner_public_key,block_id:blockHash}),
          provider.query({request_type:'view_access_key_list',account_id:reviewed.owner,block_id:blockHash}),
        ]);
        if(key?.block_hash!==blockHash||key.permission!=='FullAccess'||pinnedAccessKeyNonce(key.nonce)===null||
            keys?.block_hash!==blockHash||!Array.isArray(keys.keys)||keys.keys.length>1000||
            keys.keys.some(item=>typeof item?.public_key!=='string')||
            new Set(keys.keys.map(item=>item.public_key)).size!==keys.keys.length||
            Object.values(reviewed.agent_public_keys).some(agent=>keys.keys.some(item=>item.public_key===agent)))throw fail();
        initialBlock=await provider.viewBlock({blockId:blockHash});
      } else {
        if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw fail();
        // Read older originals before the last-state check so the FINAL state
        // returned to the caller is the latest observation in this preflight.
        for(const item of prior.slice(0,-1)) {
          const result=await provider.txStatusReceipts(item.tx_hash,reviewed.owner,'FINAL');
          const attempt=prepareV14PhoneAttempt({...inputs,stageId:item.stage_id,trustedOriginalHash:item.tx_hash});
          const inspected=inspectV14PhoneAttempt({...inputs,attempt,result,trustedOriginalHash:item.tx_hash});
          if(!success.has(inspected.status)||inspected.tx_hash!==item.tx_hash)throw fail();
        }
        const last=prior.at(-1),verified=await verifyLast({binding,stageId:last.stage_id,txHash:last.tx_hash});
        if(verified.tx_hash!==last.tx_hash||!isTransactionHash(verified.final_block_hash))throw fail();
        blockHash=verified.final_block_hash;
      }
      const finished=now();if(!Number.isSafeInteger(finished)||finished<started||finished-started>120_000||
        provider.connection?.url!==V14_SETUP_TESTNET_RPC)throw fail();
      if(initialBlock&&assertFreshFinalBlock(initialBlock,finished).hash!==blockHash)throw fail();
      return {status:'V14_SETUP_PREFLIGHT_MATCH',network:'testnet',owner:reviewed.owner,vault:reviewed.vault,stage_id:stageId,
        review_sha256:reviewed.review_sha256,action_commitment_sha256:reviewed.stages[index].action_commitment_sha256,
        prior_original_hashes:prior.map(item=>item.tx_hash),final_block_hash:blockHash,checked_at_ms:finished,
        wallet_transaction_authorized:false,transaction_sent:false};
    } catch {throw fail()}
  };
}
