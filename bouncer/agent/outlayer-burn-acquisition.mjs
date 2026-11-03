/** Fixed testnet wNEAR acquisition stages for the OutLayer diagnostic.
 * These use the fake USDC.e pool, not Circle. The original registration and
 * its earlier nonce fence are verified first. A signed bearer can be relayed
 * outside this runner; uncertain originals are reconciled, never resent. */
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v11-burn-plan.mjs';
import {verifySignedOutlayerBurnStage} from './outlayer-v11-burn-signed.mjs';
import {verifyOutlayerBurnRegistration} from './outlayer-burn-registration.mjs';
import {verifyOutlayerRegistrationControlReceipt} from './outlayer-registration-control-runner.mjs';
import {inspectOutlayerBurnStage} from './outlayer-v11-burn-preflight.mjs';
import {readPinnedJsonView} from './read-only-near-rpc.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {isTransactionHash} from '../shared/direct-payment-settlement.mjs';
const WRAP='wrap.testnet',REF='ref-finance-101.testnet',TOKEN='usdc.fakes.testnet',INPUT='100000000000000',MIN=15000n,MAX=25000n,MAX_AGE=3600;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const num=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?BigInt(x):typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)?BigInt(x):null;
const height=x=>Number.isSafeInteger(x)&&x>=0;
const json64=x=>{if(typeof x!=='string'||Buffer.from(x,'base64').toString('base64')!==x)throw new Error('invalid acquisition receipt arguments');
 try{return JSON.parse(Buffer.from(x,'base64').toString('utf8'))}catch{throw new Error('invalid acquisition receipt arguments')}};
function actionsMatch(actual,expected){
 return Array.isArray(actual)&&actual.length===expected.length&&expected.every((e,i)=>{
  const a=actual[i],x=a?.FunctionCall,y=e.functionCall;
  return record(a)&&Object.keys(a).join(',')==='FunctionCall'&&record(x)&&y&&x.method_name===y.methodName&&
   typeof x.args==='string'&&Buffer.from(x.args,'base64').toString('base64')===x.args&&
   Buffer.from(x.args,'base64').equals(Buffer.from(y.args))&&num(x.gas)===y.gas&&num(x.deposit)===y.deposit;
 });
}
/** Original wrap or swap receipt; the fake-token transfer log is not proof of
 * a deployed implementation by itself. Callers must also pin token code and
 * verify the resulting balance at a fresh FINAL block, as reconciliation does. */
export function verifyOutlayerAcquisitionReceipt(result,envelope,rawPlan,rawOwner){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 const signed=verifySignedOutlayerBurnStage(envelope,plan,owner),expected=signed.transaction.actions;
 if(!['wrap','swap-fake'].includes(envelope.stage))throw new Error('unsupported OutLayer acquisition original');
 const t=result?.transaction,txo=result?.transaction_outcome,top=txo?.outcome;
 if(result?.final_execution_status!=='FINAL'||!record(result.status)||Object.keys(result.status).join(',')!=='SuccessValue'||
  typeof result.status.SuccessValue!=='string'||t?.hash!==envelope.tx_hash||t.signer_id!==owner.account_id||t.public_key!==owner.public_key||
  t.receiver_id!==WRAP||num(t.nonce)!==BigInt(envelope.nonce)||!actionsMatch(t.actions,expected)||txo?.id!==envelope.tx_hash||
  top?.executor_id!==owner.account_id||!isTransactionHash(top?.status?.SuccessReceiptId)||!Array.isArray(top.receipt_ids)||
  top.receipt_ids.length!==1||top.receipt_ids[0]!==top.status.SuccessReceiptId||!Array.isArray(result.receipts)||
  !Array.isArray(result.receipts_outcome)||result.receipts.length<1||result.receipts.length>100||
  result.receipts_outcome.length<1||result.receipts_outcome.length>100)throw new Error('original OutLayer acquisition transaction differs or is not FINAL');
 const rootId=top.status.SuccessReceiptId,roots=result.receipts.filter(r=>r?.receipt_id===rootId),
  rootOutcomes=result.receipts_outcome.filter(x=>x?.id===rootId),root=roots[0],body=root?.receipt?.Action;
 if(roots.length!==1||rootOutcomes.length!==1||root.predecessor_id!==owner.account_id||root.receiver_id!==WRAP||
  !record(root.receipt)||Object.keys(root.receipt).join(',')!=='Action'||body?.signer_id!==owner.account_id||
  body.signer_public_key!==owner.public_key||!actionsMatch(body.actions,expected)||rootOutcomes[0].outcome?.executor_id!==WRAP){
  throw new Error('OutLayer acquisition root receipt differs');
 }
 const receiptIds=result.receipts.map(r=>r?.receipt_id);
 if(receiptIds.some(id=>!isTransactionHash(id))||new Set(receiptIds).size!==receiptIds.length)throw new Error('invalid acquisition receipt identifiers');
 const outcomes=new Map();
 for(const item of result.receipts_outcome){const o=item?.outcome;
  if(!isTransactionHash(item?.id)||outcomes.has(item.id)||!record(o?.status)||Object.keys(o.status).length!==1||
   !(typeof o.status.SuccessValue==='string'||isTransactionHash(o.status.SuccessReceiptId))||!Array.isArray(o.receipt_ids)||
   new Set(o.receipt_ids).size!==o.receipt_ids.length||o.receipt_ids.some(id=>!isTransactionHash(id))){
   throw new Error('OutLayer acquisition graph has a failure or malformed outcome');
  }
  outcomes.set(item.id,o);
 }
 const seen=new Set(),pending=[rootId];while(pending.length){const id=pending.pop();if(seen.has(id)||!outcomes.has(id))throw new Error('OutLayer acquisition graph incomplete or cyclic');seen.add(id);pending.push(...outcomes.get(id).receipt_ids)}
 if(seen.size!==outcomes.size)throw new Error('OutLayer acquisition graph has unlinked outcomes');
 if(envelope.stage==='wrap'&&rootOutcomes[0].outcome.status?.SuccessValue!==result.status.SuccessValue){
  throw new Error('wrapped-token return is not bound to the original root');
 }
 let output=null;
 if(envelope.stage==='swap-fake'){
  const outer=JSON.parse(Buffer.from(expected[0].functionCall.args).toString('utf8'));
  const children=rootOutcomes[0].outcome.receipt_ids,hooks=result.receipts.filter(r=>children.includes(r?.receipt_id)&&
   r.predecessor_id===WRAP&&r.receiver_id===REF&&r.receipt?.Action?.actions?.length===1&&
   r.receipt.Action.actions[0]?.FunctionCall?.method_name==='ft_on_transfer');
  if(hooks.length!==1)throw new Error('unique Ref swap hook not verified');
  const hook=hooks[0],call=hook.receipt.Action.actions[0].FunctionCall,out=outcomes.get(hook.receipt_id),args=json64(call.args),value=json64(out?.status?.SuccessValue);
  if(num(call.deposit)!==0n||out?.executor_id!==REF||value!=='0'||args?.sender_id!==owner.account_id||args.amount!==INPUT||args.msg!==outer.msg){
   throw new Error('Ref swap hook differs from fixed fake-token route');
  }
  const resolvers=result.receipts.filter(r=>children.includes(r?.receipt_id)&&r.predecessor_id===WRAP&&r.receiver_id===WRAP&&
   r.receipt?.Action?.actions?.length===1&&r.receipt.Action.actions[0]?.FunctionCall?.method_name==='ft_resolve_transfer');
  if(resolvers.length!==1)throw new Error('unique wrapped-token resolver not verified');
  const resolver=resolvers[0],resolverCall=resolver.receipt.Action.actions[0].FunctionCall,resolverOutcome=outcomes.get(resolver.receipt_id),
   resolverArgs=json64(resolverCall.args),outputs=hook.receipt.Action.output_data_receivers,inputs=resolver.receipt.Action.input_data_ids;
  if(num(resolverCall.deposit)!==0n||resolverOutcome?.executor_id!==WRAP||rootOutcomes[0].outcome.status?.SuccessReceiptId!==resolver.receipt_id||
   resolverOutcome.status?.SuccessValue!==result.status.SuccessValue||json64(resolverOutcome.status?.SuccessValue)!==INPUT||
   resolverArgs?.sender_id!==owner.account_id||resolverArgs.receiver_id!==REF||resolverArgs.amount!==INPUT||
   !Array.isArray(outputs)||outputs.length!==1||outputs[0]?.receiver_id!==WRAP||!isTransactionHash(outputs[0]?.data_id)||
   !Array.isArray(inputs)||inputs.length!==1||inputs[0]!==outputs[0].data_id)throw new Error('wrapped-token resolver is not linked to the Ref hook');
  const transfers=[];
  for(const r of result.receipts){
   if(r?.predecessor_id!==REF||r.receiver_id!==TOKEN||!out.receipt_ids.includes(r.receipt_id)||
      !Array.isArray(r.receipt?.Action?.actions)||r.receipt.Action.actions.length!==1)continue;
   const x=r.receipt.Action.actions[0]?.FunctionCall,o=outcomes.get(r.receipt_id);
   if(x?.method_name!=='ft_transfer'||num(x.deposit)!==1n||o?.executor_id!==TOKEN||o.status?.SuccessValue!=='')continue;
   let a;try{a=json64(x.args)}catch{continue}const amount=num(a?.amount);
   if(a?.receiver_id!==owner.account_id||amount===null||amount<MIN||amount>MAX||!Array.isArray(o.logs))continue;
   const events=o.logs.flatMap(log=>{
    if(typeof log!=='string'||!log.startsWith('EVENT_JSON:')||log.length>16384)return [];
    try{const e=JSON.parse(log.slice(11));return e.standard==='nep141'&&e.version==='1.0.0'&&e.event==='ft_transfer'?[e]:[]}catch{return []}
   });
   const nep141=events.length===1&&Array.isArray(events[0].data)&&events[0].data.length===1&&
    events[0].data[0]?.old_owner_id===REF&&events[0].data[0]?.new_owner_id===owner.account_id&&events[0].data[0]?.amount===amount.toString();
   // The pinned testnet USDC.e contract predates NEP-141 structured events.
   // Its exact legacy transfer log is accepted only for this fixed TOKEN,
   // after the signed swap, linked successful ft_transfer and arguments match.
   // Reconciliation also checks the pinned token code and the owner's balance.
   const legacyLogs=o.logs.filter(log=>typeof log==='string'&&log.startsWith('Transfer '));
   const legacy=!o.logs.some(log=>typeof log==='string'&&log.startsWith('EVENT_JSON:'))&&legacyLogs.length===1&&
    legacyLogs[0]===`Transfer ${amount} from ${REF} to ${owner.account_id}`;
   if(nep141||legacy)transfers.push({receipt_id:r.receipt_id,amount_atoms:amount.toString(),
    transfer_event_verified:nep141,legacy_transfer_log_verified:legacy});
  }
  if(transfers.length!==1)throw new Error('unique successful Ref-to-owner fake-token transfer not verified');
  output=transfers[0];
 }
 return {stage:envelope.stage,tx_hash:envelope.tx_hash,root_receipt_id:rootId,linked_successful_outcomes:seen.size,
  fake_token_output:output,trusted_rpc_not_consensus_proof:true};
}
async function priorProof({plan,owner,original,control,registration,wrap,envelope,provider}){
 verifySignedOutlayerBurnStage(registration,plan,owner);verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(registration.stage!=='register-fake'||BigInt(registration.nonce)!==BigInt(control.nonce)+1n)throw new Error('new registration is not bound to original control');
 const controlReceipt=verifyOutlayerRegistrationControlReceipt(await provider.txStatusReceipts(control.tx_hash,owner.account_id,'FINAL'),control,original,plan,owner);
 const regReceipt=verifyOutlayerBurnRegistration(await provider.txStatusReceipts(registration.tx_hash,owner.account_id,'FINAL'),registration,plan,owner);
 let wrapReceipt=null;
 if(envelope.stage==='wrap'){
  if(wrap!==undefined||BigInt(envelope.nonce)!==BigInt(registration.nonce)+1n)throw new Error('wrap is not consecutive after verified registration');
 }else if(envelope.stage==='swap-fake'){
  if(!wrap||wrap.stage!=='wrap'||BigInt(wrap.nonce)!==BigInt(registration.nonce)+1n||BigInt(envelope.nonce)!==BigInt(wrap.nonce)+1n){
   throw new Error('swap is not consecutive after original wrap');
  }
  wrapReceipt=verifyOutlayerAcquisitionReceipt(await provider.txStatusReceipts(wrap.tx_hash,owner.account_id,'FINAL'),wrap,plan,owner);
 }else throw new Error('unsupported acquisition stage');
 return {control:controlReceipt,registration:regReceipt,...(wrapReceipt?{wrap:wrapReceipt}:{})};
}

/** Verify the exact original chain through the fake-token swap, without making
 * assumptions about the current balance. Callers must pin the token code and
 * check relevant balances at a fresh FINAL block before using this evidence. */
export async function verifyOutlayerAcquisitionLineage({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,swap,provider}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 if(!provider||typeof provider.txStatusReceipts!=='function'||swap?.stage!=='swap-fake')throw new Error('original swap lineage required');
 const prior=await priorProof({plan,owner,original,control,registration,wrap,envelope:swap,provider});
 const receipt=verifyOutlayerAcquisitionReceipt(await provider.txStatusReceipts(swap.tx_hash,owner.account_id,'FINAL'),swap,plan,owner);
 return {...prior,swap:receipt};
}

export function validateOutlayerAcquisitionState(s,stage,plan,owner,now){
 const n=pinnedAccessKeyNonce(s?.signer_key_nonce);
 if(!s||s.version!==1||s.stage!==stage||s.network!=='testnet'||s.owner!==owner.account_id||s.vault!==plan.vault||
  s.signer_public_key!==owner.public_key||s.eligible!==true||!Array.isArray(s.blockers)||s.blockers.length!==0||n===null||
  s.signed!==false||s.sent!==false||s.seller_contacted!==false||s.independent_fulfillment_verified!==false)throw new Error('fresh acquisition stage is ineligible');
 assertFreshFinalBlock({header:{hash:s.block_hash,timestamp_nanosec:s.block_timestamp_nanosec}},now());return n;
}
export async function reconcileOutlayerAcquisition({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,envelope,provider,now=Date.now,
 inspect=inspectOutlayerBurnStage,readView=readPinnedJsonView}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 if(!provider||typeof provider.txStatusReceipts!=='function'||typeof inspect!=='function'||typeof readView!=='function')throw new Error('original acquisition receipt lookup required');
 const prior=await priorProof({plan,owner,original,control,registration,wrap,envelope,provider});
 const receipt=verifyOutlayerAcquisitionReceipt(await provider.txStatusReceipts(envelope.tx_hash,owner.account_id,'FINAL'),envelope,plan,owner);
 const nextStage=envelope.stage==='wrap'?'swap-fake':'fund-vault',next=await inspect({plan,ownerPlan:owner,stage:nextStage,provider,now});
 const nonce=validateOutlayerAcquisitionState(next,nextStage,plan,owner,now);
 if(nonce!==BigInt(envelope.nonce))throw new Error('post-acquisition nonce differs');
 if(envelope.stage==='swap-fake'){
  const balance=await readView(provider,next.block_hash,TOKEN,'ft_balance_of',{account_id:owner.account_id});
  assertFreshFinalBlock({header:{hash:next.block_hash,timestamp_nanosec:next.block_timestamp_nanosec}},now());
  if(balance!==receipt.fake_token_output?.amount_atoms)throw new Error('Ref receipt and fresh fake-token balance differ');
 }
 return {status:envelope.stage==='wrap'?'OUTLAYER_TEST_NEAR_WRAPPED_AT_FINAL':'OUTLAYER_FAKE_TOKEN_ACQUIRED_AT_FINAL',
  network:'testnet',stage:envelope.stage,tx_hash:envelope.tx_hash,receipt,prior,next_stage:next,reconciliation_only:true,
  seller_contacted:false,provider_paid:false,independent_fulfillment_verified:false,do_not_resend:true,
  scope:'original FINAL acquisition and pinned next state; fake test token only, no seller payment or fulfillment'};
}
/** Verify that the signed block reference is recent, canonical and within the
 * network's configured transaction validity period. This does not broadcast. */
export async function assertOutlayerOriginalReference({provider,state,envelope}){
 const [head,reference,protocol]=await Promise.all([provider.viewBlock({blockId:state.block_hash}),provider.viewBlock({blockId:envelope.block_hash}),
  provider.experimental_protocolConfig({blockId:state.block_hash})]);
 const h=head?.header?.height,r=reference?.header?.height,v=protocol?.transaction_validity_period;
 if(head?.header?.hash!==state.block_hash||reference?.header?.hash!==envelope.block_hash||!height(h)||!height(r)||!height(v)||v===0||
  protocol?.chain_id!=='testnet'||h<r||h-r>=MAX_AGE||h-r>=v)throw new Error('acquisition reference too old or unknown');
 const canonical=await provider.viewBlock({blockId:r});
 if(canonical?.header?.height!==r||canonical.header.hash!==envelope.block_hash)throw new Error('acquisition reference not canonical');
}

export async function broadcastOutlayerAcquisitionOnce({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,envelope,provider,persistAttempt,now=Date.now,
 inspect=inspectOutlayerBurnStage,readView=readPinnedJsonView}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),signed=verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(!provider||provider.enforcesSetupBeforeSubmitGuard!==true||
  ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','gasPrice','sendTransactionOnce','txStatusReceipts']
   .some(k=>typeof provider[k]!=='function')||typeof persistAttempt!=='function'||typeof inspect!=='function'||typeof now!=='function'){
  throw new Error('guarded acquisition provider and durable original fence required');
 }
 await priorProof({plan,owner,original,control,registration,wrap,envelope,provider});
 const before=await inspect({plan,ownerPlan:owner,stage:envelope.stage,provider,now}),nonce=validateOutlayerAcquisitionState(before,envelope.stage,plan,owner,now);
 if(nonce!==BigInt(envelope.nonce)-1n)throw new Error('acquisition owner nonce differs; reconcile original, never resend');
 await assertOutlayerOriginalReference({provider,state:before,envelope});
 if(await persistAttempt({stage:envelope.stage,tx_hash:envelope.tx_hash,owner:owner.account_id,vault:plan.vault})!==true){
  throw new Error('acquisition original-hash fence unavailable');
 }
 try{
  const sent=await provider.sendTransactionOnce(signed,'FINAL',{beforeSubmit:()=>{
   verifySignedOutlayerBurnStage(envelope,plan,owner);
   assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
  }});
  if(sent?.final_execution_status!=='FINAL'||sent?.transaction_outcome?.id!==envelope.tx_hash)throw new Error('submission did not identify acquisition original');
  const result=await reconcileOutlayerAcquisition({plan,ownerPlan:owner,original,control,registration,wrap,envelope,provider,now,inspect,readView});
  return {...result,reconciliation_only:false,sent:true,submission_response_received:true};
 }catch{throw new Error(`original ${envelope.stage} ${envelope.tx_hash} unconfirmed; reconcile only, never resend`)}
}
