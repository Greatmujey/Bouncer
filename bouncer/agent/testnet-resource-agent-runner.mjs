/** Narrow one-shot testnet setup and original-hash reconciliation. Published
 * signatures are bearer transactions. A timeout, crash, RPC error or unexpected
 * preflight is ambiguous: retain the original and NEVER sign/send a replacement. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan } from './testnet-resource-agent-keyring.mjs';
import { inspectTestnetResourceAgentSetup, verifySignedTestnetResourceAgentSetup } from './testnet-resource-agent-setup.mjs';
import { verifyTestnetResourceAgentReceipt } from './testnet-resource-agent-evidence.mjs';
import { inspectInstalledTestnetResourceAgent } from './testnet-resource-agent-state.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
const statusFor=stage=>stage==='guard-probe'?'ONE_YOCTO_GUARD_REJECTED_AT_FINAL':
 stage==='configure'?'RESOURCE_POLICY_CONFIGURED_AT_FINAL':'RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL';

/** Read-only original receipt plus fresh pinned post-state. No signature or send. */
export async function reconcileTestnetResourceAgent({ownerPlan,agentPlan,envelope,expectedCircleCodeHash,provider,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),agent=validateTestnetResourceAgentPlan(agentPlan,owner);
 verifySignedTestnetResourceAgentSetup(envelope,owner,agent);
 if(!isTransactionHash(expectedCircleCodeHash)||!provider||typeof provider.txStatusReceipts!=='function')throw new Error('original hash and pinned Circle code required');
 const receipt=verifyTestnetResourceAgentReceipt({ownerPlan:owner,agentPlan:agent,envelope,
  result:await provider.txStatusReceipts(envelope.tx_hash,owner.account_id,'FINAL')});
 const state=envelope.stage==='install'?
  await inspectInstalledTestnetResourceAgent({ownerPlan:owner,agentPlan:agent,expectedCircleCodeHash,provider,now}):
  await inspectTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,provider,now});
 if(state.circle_code_hash!==expectedCircleCodeHash||BigInt(state.owner_key_nonce)<BigInt(envelope.nonce)||
   (envelope.stage==='guard-probe'&&!(state.guard_probe_eligible===true&&state.policy===null&&state.agent_granted===false))||
   (envelope.stage==='configure'&&state.install_eligible!==true)||
   (envelope.stage==='install'&&state.status!=='RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL')){
  throw new Error('resource-agent original receipt and pinned post-state do not agree');
 }
 return {version:1,status:statusFor(envelope.stage),stage:envelope.stage,network:'testnet',owner:owner.account_id,vault:agent.vault,
  agent_public_key:agent.public_key,tx_hash:envelope.tx_hash,receipt,state,reconciliation_only:true,signed:false,sent:false,
  seller_contacted:false,do_not_resend:true,scope:'trusted-RPC original FINAL receipt and pinned state; no backup, audit or seller delivery'};
}

/** Requires a durable, exact original-hash fence and a one-shot testnet
 * transport. A returned status for guard-probe is intentionally Failure. */
export async function broadcastTestnetResourceAgentOnce({ownerPlan,agentPlan,envelope,expectedCircleCodeHash,provider,persistAttempt,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),agent=validateTestnetResourceAgentPlan(agentPlan,owner);
 const signed=verifySignedTestnetResourceAgentSetup(envelope,owner,agent);
 if(!isTransactionHash(expectedCircleCodeHash)||!provider||provider.enforcesSetupBeforeSubmitGuard!==true||
  ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','sendTransactionOnce','txStatusReceipts']
   .some(k=>typeof provider[k]!=='function')||typeof persistAttempt!=='function') throw new Error('guarded testnet transport and durable original-hash fence required');
 let before;
 try{before=await inspectTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,provider,now})}
 catch(error){throw new Error(`original ${envelope.stage} ${envelope.tx_hash} preflight is unknown; inspect it, never resend: ${error?.message??'unknown'}`)}
 const eligible=envelope.stage==='guard-probe'?before.guard_probe_eligible:envelope.stage==='configure'?before.configure_eligible:before.install_eligible;
 if(!eligible||before.owner_key_nonce!==(BigInt(envelope.nonce)-1n).toString()||before.circle_code_hash!==expectedCircleCodeHash){
  throw new Error(`original ${envelope.stage} ${envelope.tx_hash} no longer matches fresh preflight; inspect it, never resend`);
 }
 if(await persistAttempt({stage:envelope.stage,tx_hash:envelope.tx_hash,owner:owner.account_id,vault:agent.vault,
   agent_public_key:agent.public_key,preflight_block_hash:before.block_hash})!==true)throw new Error('original resource-agent fence was not established; do not resend');
 try{
  const sent=await provider.sendTransactionOnce(signed,'FINAL',{beforeSubmit:()=>{
   verifySignedTestnetResourceAgentSetup(envelope,owner,agent);
   assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
  }});
  if(sent?.transaction_outcome?.id!==envelope.tx_hash||sent.final_execution_status!=='FINAL')throw new Error('submission did not identify original FINAL hash');
  const confirmed=await reconcileTestnetResourceAgent({ownerPlan:owner,agentPlan:agent,envelope,expectedCircleCodeHash,provider,now});
  return {...confirmed,reconciliation_only:false,sent:true,submission_response_received:true};
 }catch(error){throw new Error(`original ${envelope.stage} ${envelope.tx_hash} is not safely confirmed; retain the hash and reconcile, never resend: ${error?.message??'unknown'}`)}
}
