/** One-shot zero-yocto control and original-hash reconciliation. The expected
 * FINAL outcome is a guard Failure. Even a confirmed nonce fence says nothing
 * by itself about whether the original registration ran earlier. */
import {isDeepStrictEqual} from 'node:util';
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v11-burn-plan.mjs';
import {inspectOutlayerBurnStage} from './outlayer-v11-burn-preflight.mjs';
import {inspectOutlayerRegistrationControl,verifySignedOutlayerRegistrationControl} from './outlayer-registration-control.mjs';
import {verifyOutlayerBurnRegistration} from './outlayer-burn-registration.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
const MAX_AGE=3600,guard='ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const num=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?BigInt(x):
 typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)?BigInt(x):null;
const height=x=>Number.isSafeInteger(x)&&x>=0;
function match(a,e){
 const x=a?.FunctionCall,y=e?.functionCall;
 return record(a)&&Object.keys(a).join(',')==='FunctionCall'&&record(x)&&y&&x.method_name===y.methodName&&
  typeof x.args==='string'&&Buffer.from(x.args,'base64').toString('base64')===x.args&&
  Buffer.from(x.args,'base64').equals(Buffer.from(y.args))&&num(x.gas)===y.gas&&num(x.deposit)===0n;
}
function systemRefund(r,o,owner){
 const b=r?.receipt?.Action,a=b?.actions?.[0]?.Transfer;
 return r?.predecessor_id==='system'&&r.receiver_id===owner.account_id&&record(r.receipt)&&Object.keys(r.receipt).join(',')==='Action'&&
  b?.signer_id===owner.account_id&&b.signer_public_key===owner.public_key&&Array.isArray(b.actions)&&b.actions.length===1&&
  Object.keys(b.actions[0]).join(',')==='Transfer'&&record(a)&&Object.keys(a).join(',')==='deposit'&&num(a.deposit)>0n&&
  o?.executor_id===owner.account_id&&isDeepStrictEqual(o.status,{SuccessValue:''})&&Array.isArray(o.receipt_ids)&&o.receipt_ids.length===0;
}
export function verifyOutlayerRegistrationControlReceipt(result,control,original,rawPlan,rawOwner){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 const signed=verifySignedOutlayerRegistrationControl(control,original,plan,owner),expected=signed.transaction.actions;
 const t=result?.transaction,txo=result?.transaction_outcome,top=txo?.outcome;
 if(result?.final_execution_status!=='FINAL'||!record(result.status)||Object.keys(result.status).join(',')!=='Failure'||
  !record(result.status.Failure)||!JSON.stringify(result.status.Failure).includes(guard)||t?.hash!==control.tx_hash||
  t.signer_id!==owner.account_id||t.public_key!==owner.public_key||t.receiver_id!==plan.vault||num(t.nonce)!==BigInt(control.nonce)||
  !Array.isArray(t.actions)||t.actions.length!==1||!match(t.actions[0],expected[0])||txo?.id!==control.tx_hash||
  top?.executor_id!==owner.account_id||!isTransactionHash(top?.status?.SuccessReceiptId)||
  !Array.isArray(top.receipt_ids)||top.receipt_ids.length!==1||top.receipt_ids[0]!==top.status.SuccessReceiptId||
  !Array.isArray(result.receipts)||!Array.isArray(result.receipts_outcome)||result.receipts.length<1||result.receipts.length>16||
  result.receipts_outcome.length<1||result.receipts_outcome.length>16)throw new Error('original control transaction or expected guard failure differs');
 const receipts=new Map(),outcomes=new Map();
 for(const r of result.receipts){if(!isTransactionHash(r?.receipt_id)||receipts.has(r.receipt_id))throw new Error('invalid control receipt graph');receipts.set(r.receipt_id,r)}
 for(const x of result.receipts_outcome){const o=x?.outcome;
  if(!isTransactionHash(x?.id)||outcomes.has(x.id)||!record(o)||!Array.isArray(o.receipt_ids)||
   new Set(o.receipt_ids).size!==o.receipt_ids.length||o.receipt_ids.some(id=>!isTransactionHash(id)))throw new Error('invalid control outcome graph');
  outcomes.set(x.id,o);
 }
 const rootId=top.status.SuccessReceiptId,root=receipts.get(rootId),outcome=outcomes.get(rootId),body=root?.receipt?.Action;
 if(root?.predecessor_id!==owner.account_id||root.receiver_id!==plan.vault||!record(root.receipt)||Object.keys(root.receipt).join(',')!=='Action'||
  body?.signer_id!==owner.account_id||body.signer_public_key!==owner.public_key||!Array.isArray(body.actions)||body.actions.length!==1||
  !match(body.actions[0],expected[0])||outcome?.executor_id!==plan.vault||!isDeepStrictEqual(outcome.status,result.status)||
  outcome.receipt_ids.some(id=>!systemRefund(receipts.get(id),outcomes.get(id),owner))||
  outcomes.size!==1+outcome.receipt_ids.length||receipts.size!==outcomes.size)throw new Error('control root failure or linked refunds differ');
 return {tx_hash:control.tx_hash,root_receipt_id:rootId,guard_rejection_verified:true,
  original_tx_hash:original.tx_hash,original_nonce:original.nonce,control_nonce:control.nonce,
  original_cannot_be_accepted_after_control:true,original_history_proven:false,trusted_rpc_not_consensus_proof:true};
}
function stateNonce(s,plan,owner,now){
 const nonce=pinnedAccessKeyNonce(s?.signer_key_nonce);
 if(!s||s.network!=='testnet'||s.owner!==owner.account_id||s.vault!==plan.vault||s.signer_public_key!==owner.public_key||nonce===null||
  s.signed!==false||s.sent!==false||s.seller_contacted!==false||s.independent_fulfillment_verified!==false)throw new Error('control state identity differs');
 assertFreshFinalBlock({header:{hash:s.block_hash,timestamp_nanosec:s.block_timestamp_nanosec}},now());return nonce;
}
/** Reconcile the distinct control only, then observe whether the original
 * registrations are present. A missing original receipt remains UNKNOWN. */
export async function reconcileOutlayerRegistrationControl({plan:rawPlan,ownerPlan:rawOwner,original,control,provider,now=Date.now,
 inspectControl=inspectOutlayerRegistrationControl,inspectStage=inspectOutlayerBurnStage}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 verifySignedOutlayerRegistrationControl(control,original,plan,owner);
 if(!provider||typeof provider.txStatusReceipts!=='function'||typeof inspectControl!=='function'||typeof inspectStage!=='function')throw new Error('read-only control reconciliation required');
 const receipt=verifyOutlayerRegistrationControlReceipt(await provider.txStatusReceipts(control.tx_hash,owner.account_id,'FINAL'),control,original,plan,owner);
 const reg=await inspectControl({plan,ownerPlan:owner,provider,now}),nonce=stateNonce(reg,plan,owner,now);
 if(nonce!==BigInt(control.nonce)||reg.control_policy!==null)throw new Error('control nonce or guard-policy state differs');
 let registrationState='UNKNOWN',originalReceipt=null,stateBlock=reg.block_hash;
 if(reg.control_eligible===true&&reg.eligible===true&&reg.stage==='register-fake'&&Array.isArray(reg.blockers)&&reg.blockers.length===0){
  registrationState='REGISTRATIONS_ABSENT_AT_FINAL_VIEW';
 }else{
  const wrap=await inspectStage({plan,ownerPlan:owner,stage:'wrap',provider,now});
  if(stateNonce(wrap,plan,owner,now)===BigInt(control.nonce)&&wrap.stage==='wrap'&&wrap.eligible===true&&Array.isArray(wrap.blockers)&&wrap.blockers.length===0){
   registrationState='REGISTRATIONS_PRESENT_AT_FINAL_VIEW';stateBlock=wrap.block_hash;
   try{originalReceipt=verifyOutlayerBurnRegistration(await provider.txStatusReceipts(original.tx_hash,owner.account_id,'FINAL'),original,plan,owner)}catch{}
  }
 }
 if(registrationState==='UNKNOWN')throw new Error('control FINAL but post-control registration state is unknown');
 return {status:'OUTLAYER_REGISTRATION_NONCE_FENCED_AT_FINAL',network:'testnet',control_tx_hash:control.tx_hash,
  original_tx_hash:original.tx_hash,receipt,registration_state:registrationState,original_receipt_verified:originalReceipt!==null,
  ...(originalReceipt?{original_receipt:originalReceipt}:{}),state_block_hash:stateBlock,original_history_unknown:originalReceipt===null,
  reconciliation_only:true,seller_contacted:false,provider_paid:false,do_not_resend_original:true,do_not_resend_control:true,
  scope:'trusted-RPC control receipt, nonce fence and fresh state; does not prove the original historical receipt or provider fulfillment'};
}
export async function broadcastOutlayerRegistrationControlOnce({plan:rawPlan,ownerPlan:rawOwner,original,control,provider,persistAttempt,now=Date.now,
 inspectControl=inspectOutlayerRegistrationControl,inspectStage=inspectOutlayerBurnStage}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 const signed=verifySignedOutlayerRegistrationControl(control,original,plan,owner);
 if(!provider||provider.enforcesSetupBeforeSubmitGuard!==true||
  ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','gasPrice','sendTransactionOnce','txStatusReceipts']
   .some(k=>typeof provider[k]!=='function')||typeof persistAttempt!=='function'||typeof inspectControl!=='function'||typeof now!=='function'){
  throw new Error('guarded one-shot control transport and durable fence required');
 }
 const before=await inspectControl({plan,ownerPlan:owner,provider,now}),n=stateNonce(before,plan,owner,now);
 if(before.stage!=='register-fake'||before.eligible!==true||before.control_eligible!==true||before.control_policy!==null||
  !Array.isArray(before.blockers)||before.blockers.length!==0||n!==BigInt(original.nonce)-1n){
  throw new Error('original registration or control state changed; reconcile originals, never resend');
 }
 const [head,reference,protocol]=await Promise.all([provider.viewBlock({blockId:before.block_hash}),provider.viewBlock({blockId:control.block_hash}),
  provider.experimental_protocolConfig({blockId:before.block_hash})]);
 const h=head?.header?.height,r=reference?.header?.height,v=protocol?.transaction_validity_period;
 if(head?.header?.hash!==before.block_hash||reference?.header?.hash!==control.block_hash||!height(h)||!height(r)||!height(v)||v===0||
  protocol?.chain_id!=='testnet'||h<r||h-r>=MAX_AGE||h-r>=v)throw new Error('control reference block too old or unknown');
 const canonical=await provider.viewBlock({blockId:r});
 if(canonical?.header?.height!==r||canonical.header.hash!==control.block_hash)throw new Error('control reference block not canonical');
 if(await persistAttempt({control_tx_hash:control.tx_hash,original_tx_hash:original.tx_hash,owner:owner.account_id,vault:plan.vault})!==true){
  throw new Error('control original-hash fence unavailable');
 }
 try{
  const sent=await provider.sendTransactionOnce(signed,'FINAL',{beforeSubmit:()=>{
   verifySignedOutlayerRegistrationControl(control,original,plan,owner);
   assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
  }});
  if(sent?.final_execution_status!=='FINAL'||sent?.transaction_outcome?.id!==control.tx_hash)throw new Error('submission did not identify original control');
  const confirmed=await reconcileOutlayerRegistrationControl({plan,ownerPlan:owner,original,control,provider,now,inspectControl,inspectStage});
  return {...confirmed,reconciliation_only:false,sent:true,submission_response_received:true};
 }catch{throw new Error(`control ${control.tx_hash} is unconfirmed; reconcile both originals, never resend`)}
}
