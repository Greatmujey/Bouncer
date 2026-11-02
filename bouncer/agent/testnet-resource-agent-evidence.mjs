/** Trusted-RPC, original-hash evidence for the bounded testnet resource-agent
 * planner. This verifies a receipt graph, NOT current chain state or backups.
 * It has no signer, broadcaster, journal, or ability to contact a provider. */
import { isDeepStrictEqual } from 'node:util';
import { verifySignedTestnetResourceAgentSetup } from './testnet-resource-agent-setup.mjs';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan } from './testnet-resource-agent-keyring.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,names)=>record(x)&&Object.keys(x).sort().join(',')===[...names].sort().join(',');
const num=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?BigInt(x):typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)?BigInt(x):null;
function matchAction(actual,expected,p){
 if(expected.functionCall){
  const a=actual?.FunctionCall,e=expected.functionCall;
  return keys(actual,['FunctionCall'])&&keys(a,['method_name','args','gas','deposit'])&&a.method_name===e.methodName&&
   typeof a.args==='string'&&Buffer.from(a.args,'base64').toString('base64')===a.args&&Buffer.from(a.args,'base64').equals(Buffer.from(e.args))&&
   num(a.gas)===e.gas&&num(a.deposit)===e.deposit;
 }
 if(expected.addKey){
  const a=actual?.AddKey,k=a?.access_key,perm=k?.permission?.FunctionCall,e=expected.addKey.accessKey.permission.functionCall;
  return keys(actual,['AddKey'])&&keys(a,['public_key','access_key'])&&a.public_key===p.public_key&&
   keys(k,['nonce','permission'])&&num(k.nonce)===0n&&keys(k.permission,['FunctionCall'])&&
   keys(perm,['allowance','receiver_id','method_names'])&&num(perm.allowance)===e.allowance&&
   perm.receiver_id===e.receiverId&&isDeepStrictEqual(perm.method_names,e.methodNames);
 }
 return false;
}
function matches(actual,expected,p){return Array.isArray(actual)&&actual.length===expected.length&&expected.every((e,i)=>matchAction(actual[i],e,p))}
function systemRefund(receipt,outcome,owner){
 const body=receipt?.receipt?.Action,a=body?.actions?.[0]?.Transfer;
 return receipt?.predecessor_id==='system'&&receipt.receiver_id===owner.account_id&&keys(receipt.receipt,['Action'])&&
  body?.signer_id===owner.account_id&&body?.signer_public_key===owner.public_key&&Array.isArray(body.actions)&&body.actions.length===1&&
  keys(body.actions[0],['Transfer'])&&keys(a,['deposit'])&&num(a.deposit)!==null&&num(a.deposit)>0n&&
  outcome?.executor_id===owner.account_id&&isDeepStrictEqual(outcome.status,{SuccessValue:''})&&
  Array.isArray(outcome.receipt_ids)&&outcome.receipt_ids.length===0;
}
export function verifyTestnetResourceAgentReceipt({ownerPlan,agentPlan,envelope,result}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),p=validateTestnetResourceAgentPlan(agentPlan,owner);
 const signed=verifySignedTestnetResourceAgentSetup(envelope,owner,p),expected=signed.transaction.actions;
 const receiver=envelope.stage==='install'?owner.account_id:p.vault,t=result?.transaction,txo=result?.transaction_outcome,top=txo?.outcome;
 if(result?.final_execution_status!=='FINAL'||t?.hash!==envelope.tx_hash||t.signer_id!==owner.account_id||
  t.public_key!==owner.public_key||t.receiver_id!==receiver||num(t.nonce)!==BigInt(envelope.nonce)||!matches(t.actions,expected,p)||
  txo?.id!==envelope.tx_hash||top?.executor_id!==owner.account_id||!isTransactionHash(top?.status?.SuccessReceiptId)||
  !Array.isArray(top.receipt_ids)||top.receipt_ids.length!==1||top.receipt_ids[0]!==top.status.SuccessReceiptId||
  !Array.isArray(result.receipts)||!Array.isArray(result.receipts_outcome)||result.receipts.length>16||
  result.receipts_outcome.length<1||result.receipts_outcome.length>16) throw new Error('original resource-agent transaction is not matching FINAL');
 const receipts=new Map(),outcomes=new Map();
 for(const r of result.receipts){if(!isTransactionHash(r?.receipt_id)||receipts.has(r.receipt_id))throw new Error('invalid resource-agent receipt graph');receipts.set(r.receipt_id,r)}
 for(const x of result.receipts_outcome){
  const o=x?.outcome;
  if(!isTransactionHash(x?.id)||outcomes.has(x.id)||!record(o)||!record(o.status)||Object.keys(o.status).length!==1||
    !Array.isArray(o.receipt_ids)||new Set(o.receipt_ids).size!==o.receipt_ids.length||o.receipt_ids.some(v=>!isTransactionHash(v))) throw new Error('invalid resource-agent outcome graph');
  outcomes.set(x.id,o);
 }
 const rootId=top.status.SuccessReceiptId,root=receipts.get(rootId),outcome=outcomes.get(rootId),omitted=!root;
 if(!outcome||outcome.executor_id!==receiver)throw new Error('resource-agent root outcome missing or mismatched');
 if(omitted){
  if(envelope.stage!=='install'||owner.account_id!==receiver||expected.length!==1||!expected[0].addKey) throw new Error('resource-agent root receipt missing');
 }else{
  const body=root.receipt?.Action;
  if(root.predecessor_id!==owner.account_id||root.receiver_id!==receiver||!keys(root.receipt,['Action'])||
   body?.signer_id!==owner.account_id||body.signer_public_key!==owner.public_key||!matches(body.actions,expected,p)) throw new Error('resource-agent root receipt differs');
 }
 if(outcome.receipt_ids.length>1||outcomes.size!==1+outcome.receipt_ids.length||receipts.size!==(omitted?0:1)+outcome.receipt_ids.length||
  outcome.receipt_ids.some(id=>!systemRefund(receipts.get(id),outcomes.get(id),owner))) throw new Error('resource-agent receipt graph has unknown children');
 if(envelope.stage==='guard-probe'){
  if(!record(result.status?.Failure)||Object.keys(result.status).length!==1||!isDeepStrictEqual(outcome.status,result.status)||
    !JSON.stringify(result.status.Failure).includes('ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'))
     throw new Error('original probe did not fail at the one-yocto owner guard');
 }else if(!isDeepStrictEqual(result.status,{SuccessValue:''})||!isDeepStrictEqual(outcome.status,{SuccessValue:''})){
  throw new Error('resource-agent configuration or key installation did not succeed');
 }
 return {stage:envelope.stage,tx_hash:envelope.tx_hash,root_receipt_id:rootId,local_receipt_body_omitted:omitted,
  guard_failure_verified:envelope.stage==='guard-probe',trusted_rpc_not_consensus_proof:true,current_state_verified:false,do_not_resend:true};
}
