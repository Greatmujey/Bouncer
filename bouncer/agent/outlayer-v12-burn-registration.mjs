/** First stage only: register the backed-up V3 owner and keyless V12 vault for the
 * reviewed fake OutLayer FT. The token is NOT Circle USDC. This creates no
 * provider order and proves no delivery. A public signed bearer can be relayed
 * outside this runner, so an unknown original must never be retried. */
import {isDeepStrictEqual} from 'node:util';
import {verifySignedOutlayerBurnStage} from './outlayer-v12-burn-signed.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v12-burn-plan.mjs';
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {inspectOutlayerBurnStage} from './outlayer-v12-burn-preflight.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';

const TOKEN='usdc.fakes.testnet', STORAGE='1250000000000000000000', MAX_AGE=3600;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const num=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?BigInt(x):
 typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)?BigInt(x):null;
const height=x=>Number.isSafeInteger(x)&&x>=0;
function actionsMatch(actual,expected){
 return Array.isArray(actual)&&actual.length===expected.length&&expected.every((e,i)=>{
  const a=actual[i],x=a?.FunctionCall,y=e.functionCall;
  return record(a)&&Object.keys(a).join(',')==='FunctionCall'&&record(x)&&y&&x.method_name===y.methodName&&
   typeof x.args==='string'&&Buffer.from(x.args,'base64').toString('base64')===x.args&&
   Buffer.from(x.args,'base64').equals(Buffer.from(y.args))&&num(x.gas)===y.gas&&num(x.deposit)===y.deposit;
 });
}
function validSuccess(status){return record(status)&&Object.keys(status).length===1&&
 (typeof status.SuccessValue==='string'||isTransactionHash(status.SuccessReceiptId))}
function systemRefund(r,o,owner){
 const b=r?.receipt?.Action,a=b?.actions?.[0]?.Transfer;
 return r?.predecessor_id==='system'&&r.receiver_id===owner.account_id&&record(r.receipt)&&Object.keys(r.receipt).join(',')==='Action'&&
  b?.signer_id===owner.account_id&&b.signer_public_key===owner.public_key&&Array.isArray(b.actions)&&b.actions.length===1&&
  Object.keys(b.actions[0]).join(',')==='Transfer'&&record(a)&&Object.keys(a).join(',')==='deposit'&&num(a.deposit)>0n&&
  o?.executor_id===owner.account_id&&isDeepStrictEqual(o.status,{SuccessValue:''})&&Array.isArray(o.receipt_ids)&&o.receipt_ids.length===0;
}
/** Verify the exact original transaction, two registration actions, their
 * root and all linked successful refund outcomes. This is trusted-RPC evidence,
 * not a consensus proof or a current state view. */
export function verifyOutlayerBurnRegistration(result,envelope,rawPlan,rawOwner){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 const signed=verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='register-fake')throw new Error('not the original fake-token registration');
 const t=result?.transaction,txo=result?.transaction_outcome,top=txo?.outcome,expected=signed.transaction.actions;
 if(result?.final_execution_status!=='FINAL'||!record(result.status)||Object.keys(result.status).length!==1||
  typeof result.status.SuccessValue!=='string'||t?.hash!==envelope.tx_hash||
  t.signer_id!==owner.account_id||t.public_key!==owner.public_key||t.receiver_id!==TOKEN||num(t.nonce)!==BigInt(envelope.nonce)||
  !actionsMatch(t.actions,expected)||txo?.id!==envelope.tx_hash||top?.executor_id!==owner.account_id||
  !isTransactionHash(top?.status?.SuccessReceiptId)||!Array.isArray(top.receipt_ids)||top.receipt_ids.length!==1||
  top.receipt_ids[0]!==top.status.SuccessReceiptId||!Array.isArray(result.receipts)||!Array.isArray(result.receipts_outcome)||
  result.receipts.length<1||result.receipts.length>16||result.receipts_outcome.length<1||result.receipts_outcome.length>16){
  throw new Error('original OutLayer fake-token registration transaction differs or is not FINAL');
 }
 const receipts=new Map(),outcomes=new Map();
 for(const r of result.receipts){if(!isTransactionHash(r?.receipt_id)||receipts.has(r.receipt_id))throw new Error('invalid registration receipt graph');receipts.set(r.receipt_id,r)}
 for(const x of result.receipts_outcome){const o=x?.outcome;
  if(!isTransactionHash(x?.id)||outcomes.has(x.id)||!record(o)||!validSuccess(o.status)||!Array.isArray(o.receipt_ids)||
    new Set(o.receipt_ids).size!==o.receipt_ids.length||o.receipt_ids.some(v=>!isTransactionHash(v)))throw new Error('registration receipt outcome is invalid or failed');
  outcomes.set(x.id,o);
 }
 const rootId=top.status.SuccessReceiptId,root=receipts.get(rootId),outcome=outcomes.get(rootId),body=root?.receipt?.Action;
 if(root?.predecessor_id!==owner.account_id||root.receiver_id!==TOKEN||!record(root.receipt)||Object.keys(root.receipt).join(',')!=='Action'||
  body?.signer_id!==owner.account_id||body.signer_public_key!==owner.public_key||!actionsMatch(body.actions,expected)||
  outcome?.executor_id!==TOKEN||outcome.status?.SuccessValue!==result.status.SuccessValue)throw new Error('registration root receipt differs');
 let value;try{const b=Buffer.from(result.status.SuccessValue,'base64');if(b.toString('base64')!==result.status.SuccessValue)throw Error();value=JSON.parse(b.toString('utf8'))}catch{throw new Error('registration return value invalid')}
 if(!record(value)||Object.keys(value).sort().join(',')!=='available,total'||value.total!==STORAGE||value.available!=='0'||
  outcome.receipt_ids.some(id=>!systemRefund(receipts.get(id),outcomes.get(id),owner))||
  outcomes.size!==1+outcome.receipt_ids.length||receipts.size!==outcomes.size){throw new Error('registration result or linked refunds differ')}
 return {tx_hash:envelope.tx_hash,root_receipt_id:rootId,linked_successful_outcomes:outcomes.size,
  registered_accounts:[owner.account_id,plan.vault],asset:TOKEN,trusted_rpc_not_consensus_proof:true};
}
function validateState(s,stage,plan,owner){
 const nonce=pinnedAccessKeyNonce(s?.signer_key_nonce);
 if(!s||s.version!==1||s.network!=='testnet'||s.stage!==stage||s.owner!==owner.account_id||s.vault!==plan.vault||
  s.signer_public_key!==owner.public_key||s.eligible!==true||!Array.isArray(s.blockers)||s.blockers.length!==0||nonce===null||
  s.signed!==false||s.sent!==false||s.seller_contacted!==false||s.independent_fulfillment_verified!==false)throw new Error('fresh registration state is not eligible');
 return nonce;
}
/** Reconcile the original hash and the next pinned stage, never signing or sending. */
export async function reconcileOutlayerBurnRegistration({plan:rawPlan,ownerPlan:rawOwner,envelope,provider,now=Date.now,
 inspect=inspectOutlayerBurnStage}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='register-fake'||!provider||typeof provider.txStatusReceipts!=='function'||typeof inspect!=='function')throw new Error('original registration lookup required');
 const receipt=verifyOutlayerBurnRegistration(await provider.txStatusReceipts(envelope.tx_hash,owner.account_id,'FINAL'),envelope,plan,owner);
 const state=await inspect({ownerPlan:owner,plan,stage:'wrap',provider,now});
 const nonce=validateState(state,'wrap',plan,owner);
 if(nonce!==BigInt(envelope.nonce))throw new Error('registration nonce differs from original');
 assertFreshFinalBlock({header:{hash:state.block_hash,timestamp_nanosec:state.block_timestamp_nanosec}},now());
 return {status:'OUTLAYER_FAKE_TOKEN_REGISTRATIONS_FINAL',network:'testnet',tx_hash:envelope.tx_hash,receipt,next_stage:state,
  reconciliation_only:true,seller_contacted:false,provider_paid:false,independent_fulfillment_verified:false,do_not_resend:true,
  scope:'original trusted-RPC FINAL receipt and next same-block state; fake token, not seller delivery'};
}
/** Exactly one guarded send after a durable original fence. */
export async function broadcastOutlayerBurnRegistrationOnce({plan:rawPlan,ownerPlan:rawOwner,envelope,provider,persistAttempt,
 now=Date.now,inspect=inspectOutlayerBurnStage}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),signed=verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='register-fake'||!provider||provider.enforcesSetupBeforeSubmitGuard!==true||
  ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','gasPrice','sendTransactionOnce','txStatusReceipts']
    .some(k=>typeof provider[k]!=='function')||typeof persistAttempt!=='function'||typeof inspect!=='function'||typeof now!=='function'){
  throw new Error('guarded one-shot testnet provider and original fence required');
 }
 const before=await inspect({ownerPlan:owner,plan,stage:'register-fake',provider,now});
 const nonce=validateState(before,'register-fake',plan,owner);
 assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
 if(nonce!==BigInt(envelope.nonce)-1n)throw new Error('owner nonce changed; inspect original, never resend');
 const [head,reference,protocol]=await Promise.all([provider.viewBlock({blockId:before.block_hash}),
  provider.viewBlock({blockId:envelope.block_hash}),provider.experimental_protocolConfig({blockId:before.block_hash})]);
 const headHeight=head?.header?.height,refHeight=reference?.header?.height,validity=protocol?.transaction_validity_period;
 if(head?.header?.hash!==before.block_hash||reference?.header?.hash!==envelope.block_hash||!height(headHeight)||!height(refHeight)||
   !height(validity)||validity===0||protocol?.chain_id!=='testnet'||headHeight<refHeight||headHeight-refHeight>=MAX_AGE||headHeight-refHeight>=validity){
  throw new Error('original registration reference block is too old or unknown; inspect original, never resend');
 }
 const canonical=await provider.viewBlock({blockId:refHeight});
 if(canonical?.header?.height!==refHeight||canonical.header.hash!==envelope.block_hash)throw new Error('registration reference is not canonical; inspect original, never resend');
 if(await persistAttempt({stage:'register-fake',tx_hash:envelope.tx_hash,owner:owner.account_id,vault:plan.vault,
  preflight_block_hash:before.block_hash})!==true)throw new Error('original registration fence was not established');
 try{
  const sent=await provider.sendTransactionOnce(signed,'FINAL',{beforeSubmit:()=>{
   verifySignedOutlayerBurnStage(envelope,plan,owner);
   assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
  }});
  if(sent?.final_execution_status!=='FINAL'||sent?.transaction_outcome?.id!==envelope.tx_hash)throw new Error('submission did not identify original FINAL hash');
  const confirmed=await reconcileOutlayerBurnRegistration({plan,ownerPlan:owner,envelope,provider,now,inspect});
  return {...confirmed,reconciliation_only:false,sent:true,submission_response_received:true};
 }catch{throw new Error(`original fake-token registration ${envelope.tx_hash} is unconfirmed; reconcile only, never resend`)}
}
