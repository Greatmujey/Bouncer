/** Original-bound fake-token funding for the OutLayer testnet diagnostic.
 * A public signature is a bearer and can be independently relayed. Each stage
 * requires prior FINAL receipts, a fresh pinned state and an original fence;
 * an uncertain submission is reconciled by the same hash, never resent. */
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v11-burn-plan.mjs';
import {verifySignedOutlayerBurnStage} from './outlayer-v11-burn-signed.mjs';
import {inspectOutlayerBurnStage} from './outlayer-v11-burn-preflight.mjs';
import {verifyOutlayerAcquisitionLineage,validateOutlayerAcquisitionState,assertOutlayerOriginalReference} from './outlayer-burn-acquisition.mjs';
import {verifyFakeTestnetVaultReceiptGraph} from './keyless-vault-circle-runner.mjs';
import {readPinnedJsonView} from './read-only-near-rpc.mjs';
import {assertFreshFinalBlock} from '../shared/fresh-final-block.mjs';

const TOKEN='usdc.fakes.testnet', AMOUNT='10000';
function signedFunding(envelope,plan,owner,swap){
 const signed=verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='fund-vault'||swap?.stage!=='swap-fake'||BigInt(envelope.nonce)!==BigInt(swap.nonce)+1n){
  throw new Error('vault funding is not consecutive after the original swap');
 }
 return signed;
}
function expectedOwner(prior,spent){
 const output=prior?.swap?.fake_token_output?.amount_atoms;
 if(typeof output!=='string'||!/^\d+$/.test(output)||BigInt(output)<BigInt(AMOUNT))throw new Error('original fake-token output is unknown');
 return (BigInt(output)-(spent?BigInt(AMOUNT):0n)).toString();
}
async function balances({state,plan,owner,prior,readView,provider,now,funded}){
 const [ownerAtoms,vaultAtoms,trackedAtoms]=await Promise.all([
  readView(provider,state.block_hash,TOKEN,'ft_balance_of',{account_id:owner.account_id}),
  readView(provider,state.block_hash,TOKEN,'ft_balance_of',{account_id:plan.vault}),
  readView(provider,state.block_hash,plan.vault,'vault_balance',{token:TOKEN}),
 ]);
 assertFreshFinalBlock({header:{hash:state.block_hash,timestamp_nanosec:state.block_timestamp_nanosec}},now());
 if(ownerAtoms!==expectedOwner(prior,funded)||vaultAtoms!==(funded?AMOUNT:'0')||trackedAtoms!==(funded?AMOUNT:'0')){
  throw new Error('pinned fake-token owner, actual vault or tracked vault balance differs');
 }
 return {owner_fake_atoms:ownerAtoms,vault_actual_fake_atoms:vaultAtoms,vault_tracked_fake_atoms:trackedAtoms};
}

/** Read-only original-bound preflight. Safe to run repeatedly; it never signs
 * or broadcasts. Prior receipts and all views are trusted RPC observations. */
export async function inspectOutlayerFundingBefore({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,swap,provider,now=Date.now,
 inspect=inspectOutlayerBurnStage,readView=readPinnedJsonView}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 if(!provider||typeof provider.txStatusReceipts!=='function'||typeof inspect!=='function'||typeof readView!=='function'||typeof now!=='function'){
  throw new Error('original-bound read-only funding dependencies required');
 }
 const prior=await verifyOutlayerAcquisitionLineage({plan,ownerPlan:owner,original,control,registration,wrap,swap,provider});
 const state=await inspect({plan,ownerPlan:owner,stage:'fund-vault',provider,now});
 const nonce=validateOutlayerAcquisitionState(state,'fund-vault',plan,owner,now);
 if(nonce!==BigInt(swap.nonce))throw new Error('funding preflight nonce differs from original swap');
 const balance=await balances({state,plan,owner,prior,readView,provider,now,funded:false});
 return {...state,balance,prior,scope:'read-only original FINAL receipt lineage and fresh pinned fake-token state; no signature, send or provider payment'};
}

export function verifyOutlayerFundingReceipt(result,envelope,rawPlan,rawOwner,swap){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),signed=signedFunding(envelope,plan,owner,swap);
 return verifyFakeTestnetVaultReceiptGraph(result,{...envelope,kind:'fund',amount_atoms:AMOUNT},owner,signed.transaction.actions[0]);
}

/** Verify only the retained original and post-state; never submits. */
export async function reconcileOutlayerFunding({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,swap,envelope,provider,now=Date.now,
 inspect=inspectOutlayerBurnStage,readView=readPinnedJsonView}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 signedFunding(envelope,plan,owner,swap);
 if(!provider||typeof provider.txStatusReceipts!=='function'||typeof inspect!=='function'||typeof readView!=='function'||typeof now!=='function'){
  throw new Error('read-only original funding receipt lookup required');
 }
 const prior=await verifyOutlayerAcquisitionLineage({plan,ownerPlan:owner,original,control,registration,wrap,swap,provider});
 const receipt=verifyOutlayerFundingReceipt(await provider.txStatusReceipts(envelope.tx_hash,owner.account_id,'FINAL'),envelope,plan,owner,swap);
 const next=await inspect({plan,ownerPlan:owner,stage:'configure',provider,now});
 const nonce=validateOutlayerAcquisitionState(next,'configure',plan,owner,now);
 if(nonce!==BigInt(envelope.nonce))throw new Error('post-funding owner nonce differs');
 const balance=await balances({state:next,plan,owner,prior,readView,provider,now,funded:true});
 return {status:'OUTLAYER_FAKE_TOKEN_VAULT_FUNDED_AT_FINAL',network:'testnet',stage:'fund-vault',tx_hash:envelope.tx_hash,
  receipt,prior,next_stage:next,balance,reconciliation_only:true,seller_contacted:false,provider_paid:false,
  independent_fulfillment_verified:false,do_not_resend:true,
  scope:'original FINAL fake-token funding receipt and fresh pinned balances; not Circle, seller payment or fulfillment'};
}

/** At most one fixed send, after prior receipts, state, reference and fence. */
export async function broadcastOutlayerFundingOnce({plan:rawPlan,ownerPlan:rawOwner,original,control,registration,wrap,swap,envelope,provider,persistAttempt,now=Date.now,
 inspect=inspectOutlayerBurnStage,readView=readPinnedJsonView}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner),signed=signedFunding(envelope,plan,owner,swap);
 if(!provider||provider.enforcesSetupBeforeSubmitGuard!==true||
  ['viewNodeStatus','viewBlock','query','callFunctionRaw','experimental_protocolConfig','gasPrice','sendTransactionOnce','txStatusReceipts']
   .some(k=>typeof provider[k]!=='function')||typeof persistAttempt!=='function'||typeof now!=='function'){
  throw new Error('guarded fake-token funding provider and durable original fence required');
 }
 const before=await inspectOutlayerFundingBefore({plan,ownerPlan:owner,original,control,registration,wrap,swap,provider,now,inspect,readView});
 if(BigInt(before.signer_key_nonce)!==BigInt(envelope.nonce)-1n)throw new Error('funding owner nonce differs; never resend original');
 await assertOutlayerOriginalReference({provider,state:before,envelope});
 if(await persistAttempt({stage:'fund-vault',tx_hash:envelope.tx_hash,owner:owner.account_id,vault:plan.vault})!==true){
  throw new Error('fake-token vault funding original-hash fence unavailable');
 }
 try{
  const sent=await provider.sendTransactionOnce(signed,'FINAL',{beforeSubmit:()=>{
   signedFunding(envelope,plan,owner,swap);
   assertFreshFinalBlock({header:{hash:before.block_hash,timestamp_nanosec:before.block_timestamp_nanosec}},now());
  }});
  if(sent?.final_execution_status!=='FINAL'||sent?.transaction_outcome?.id!==envelope.tx_hash)throw new Error('submission did not identify original');
  const result=await reconcileOutlayerFunding({plan,ownerPlan:owner,original,control,registration,wrap,swap,envelope,provider,now,inspect,readView});
  return {...result,reconciliation_only:false,sent:true,submission_response_received:true};
 }catch{throw new Error(`original fund-vault ${envelope.tx_hash} unconfirmed; reconcile only, never resend`)}
}
