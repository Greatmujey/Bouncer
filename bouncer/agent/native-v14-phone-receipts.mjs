/**
 * Offline, trusted-RPC evidence for an independently retained original of the
 * unsigned V14 research plan. This does not send or prompt, verify current
 * state, authorize the next stage, establish consent, or permit any retry.
 */
import { isDeepStrictEqual } from 'node:util';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { graph, rootOf, statusKind, protocolGasRefund, onlyProtocolGasRefund } from './setup-receipt-graph.mjs';
import { verifyV14PhoneResearchPlan } from './native-v14-phone-plan.mjs';

const fields=['kind','status','network','review_sha256','stage_id','action_commitment_sha256','tx_hash','signer_id','signer_public_key','receiver_id'];
const record=x=>x && typeof x==='object' && !Array.isArray(x);
const exact=(x,keys)=>record(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const numeric=x=>typeof x==='number' && Number.isSafeInteger(x) && x>=0?String(x):
  typeof x==='string' && /^(0|[1-9][0-9]{0,38})$/.test(x)?x:null;
function metadata(receipt) {
  const a=receipt?.receipt?.Action;
  return exact(receipt?.receipt,['Action']) && record(a) &&
    Object.keys(a).every(k=>['signer_id','signer_public_key','gas_price','input_data_ids','output_data_receivers','actions','is_promise_yield','refund_to'].includes(k)) &&
    Array.isArray(a.input_data_ids) && a.input_data_ids.length===0 && Array.isArray(a.output_data_receivers) && a.output_data_receivers.length===0 &&
    (a.is_promise_yield===undefined || a.is_promise_yield===false) && (a.refund_to===undefined || a.refund_to===null);
}
function attemptFor(plan,stageId,originalHash) {
  const stage=plan.review.stages.find(s=>s.id===stageId);
  if (!stage || !isTransactionHash(originalHash)) throw new Error('reviewed V14 stage and independently retained original hash are required');
  return {kind:'research-v14-phone-attempt-v1',status:'pending',network:'testnet',review_sha256:plan.review.review_sha256,
    stage_id:stage.id,action_commitment_sha256:stage.action_commitment_sha256,tx_hash:originalHash,
    signer_id:stage.signer_id,signer_public_key:plan.review.owner_public_key,receiver_id:stage.receiver_id};
}
/** Record only a separately retained hash; a caller-supplied hash is not itself an independent fence. */
export function prepareV14PhoneAttempt({stageId,trustedOriginalHash,...inputs} = {}) {
  return attemptFor(verifyV14PhoneResearchPlan(inputs),stageId,trustedOriginalHash);
}
function upgradeGraph(result,root,g,attempt,review) {
  const out=root.outcome,id=out.status?.SuccessReceiptId;
  if (statusKind(out.status)!=='receipt' || !out.receipt_ids.includes(id) ||
      result.transaction_outcome.outcome.receipt_ids.length!==1 || result.transaction_outcome.outcome.receipt_ids[0]!==root.id) {
    throw new Error('original V14 loader does not link its unique self-upgrade');
  }
  const receipt=g.receipts.get(id),outcome=g.outcomes.get(id),action=receipt?.receipt?.Action,calls=action?.actions;
  const code=Buffer.from(review.artifacts.vault_sha256,'hex').toString('base64');
  const newArgs=Buffer.from(JSON.stringify({owner:review.owner})).toString('base64');
  if (id===root.id || receipt?.predecessor_id!==review.vault || receipt?.receiver_id!==review.vault || !metadata(receipt) ||
      action.signer_id!==attempt.signer_id || action.signer_public_key!==attempt.signer_public_key ||
      !Array.isArray(calls) || calls.length!==2 || !exact(calls[0],['DeployContract']) || !exact(calls[0].DeployContract,['code']) ||
      calls[0].DeployContract.code!==code || !exact(calls[1],['FunctionCall']) || !exact(calls[1].FunctionCall,['method_name','args','gas','deposit']) ||
      calls[1].FunctionCall.method_name!=='new' || calls[1].FunctionCall.args!==newArgs ||
      numeric(calls[1].FunctionCall.gas)!=='30000000000000' || numeric(calls[1].FunctionCall.deposit)!=='0' ||
      outcome?.executor_id!==review.vault || !isDeepStrictEqual(outcome?.status,{SuccessValue:''}) || !isDeepStrictEqual(result.status,outcome.status)) {
    throw new Error('linked self-upgrade differs from the reviewed V14 code and owner');
  }
  const known=new Set([root.id,id]);
  for(const [parent,required] of [[out,[id]],[outcome,[]]]) {
    if (!Array.isArray(parent.receipt_ids) || required.some(child=>!parent.receipt_ids.includes(child))) throw new Error('incomplete V14 loader graph');
    const extra=parent.receipt_ids.filter(child=>!required.includes(child));
    if(extra.length>1)throw new Error('unexpected V14 loader descendant');
    for(const child of extra) {
      if(known.has(child) || !protocolGasRefund(g.receipts.get(child),g.outcomes.get(child),attempt)) throw new Error('unexpected V14 loader descendant');
      known.add(child);
    }
  }
  if(g.receipts.size!==known.size || g.outcomes.size!==known.size || [...known].some(child=>!g.receipts.has(child)||!g.outcomes.has(child))) {
    throw new Error('unlinked or incomplete V14 loader graph');
  }
  return id;
}
/** Inspect only the independently retained original. Failure or uncertainty never authorizes retry/refund. */
export function inspectV14PhoneAttempt({attempt,result,trustedOriginalHash,...inputs} = {}) {
  if (!exact(attempt,fields)) throw new Error('separately retained V14 research attempt required');
  const plan=verifyV14PhoneResearchPlan(inputs),expected=attemptFor(plan,attempt.stage_id,trustedOriginalHash);
  if(!isDeepStrictEqual(attempt,expected))throw new Error('V14 attempt differs from its retained original');
  const index=plan.review.stages.findIndex(s=>s.id===attempt.stage_id),batch=plan.batches[index];
  if(!record(result) || result.final_execution_status!=='FINAL' || !['value','failure'].includes(statusKind(result.status))) {
    throw new Error('original V14 transaction is not terminal FINAL; preserve it and do not resend');
  }
  const g=graph(result,attempt.stage_id==='install_restricted_agents'),root=rootOf(result,batch,attempt,g);
  if(!root.localReceiptOmitted && !metadata(root.receipt))throw new Error('unexpected V14 action receipt metadata');
  const base={stage_id:attempt.stage_id,tx_hash:trustedOriginalHash,do_not_resend:true,current_state_verified:false,
    independent_prompt_fence_verified:false,wallet_prompt_authorized:false,owner_approval_verified:false,independent_delivery_verified:false};
  if(statusKind(result.status)==='failure' || [...g.outcomes.values()].some(out=>statusKind(out.status)==='failure')) {
    return {...base,status:'FINAL_FAILURE_NEEDS_STATE_REVIEW'};
  }
  let upgrade;
  if(attempt.stage_id==='create_v14_research_vault') upgrade=upgradeGraph(result,root,g,attempt,plan.review);
  else if(!isDeepStrictEqual(result.status,{SuccessValue:''}) || !isDeepStrictEqual(root.outcome.status,result.status) ||
    result.transaction_outcome.outcome.receipt_ids.length!==1 || result.transaction_outcome.outcome.receipt_ids[0]!==root.id ||
    !onlyProtocolGasRefund(root.outcome,g,attempt,root.localReceiptOmitted) ||
    (attempt.stage_id==='fund_native_vault' && (!Array.isArray(root.outcome.logs) || !root.outcome.logs.includes('BOUNCER native deposit received')))) {
    throw new Error('unexpected, incomplete or nonterminal V14 setup receipt graph');
  }
  return {...base,status:root.localReceiptOmitted?'FINAL_LOCAL_ADD_KEYS_OUTCOME_MATCH':
    upgrade?'FINAL_RESEARCH_V14_LOADER_AND_UPGRADE_MATCH':'FINAL_RESEARCH_V14_SETUP_RECEIPT_MATCH',
    root_receipt:root.id,...(upgrade?{self_upgrade_receipt:upgrade}:{}),local_receipt_body_omitted:root.localReceiptOmitted,
    scope:'trusted-RPC original and bounded receipt graph only; fresh state, independent fence, consent and delivery need separate checks'};
}
