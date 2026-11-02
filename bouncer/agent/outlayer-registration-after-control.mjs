/** A new fixed fake-token registration is permitted only after the distinct
 * original nonce control is verified FINAL and both registrations are absent
 * at a fresh pinned view. The earlier original is never resent. Public bearer
 * bytes can be relayed independently, so sign only after that confirmation. */
import {validateOwnerBootstrapPlan} from './testnet-owner-bootstrap.mjs';
import {validateOutlayerBurnPlan} from './outlayer-v11-burn-plan.mjs';
import {verifySignedOutlayerBurnStage} from './outlayer-v11-burn-signed.mjs';
import {verifySignedOutlayerRegistrationControl} from './outlayer-registration-control.mjs';
import {reconcileOutlayerRegistrationControl,verifyOutlayerRegistrationControlReceipt} from './outlayer-registration-control-runner.mjs';
import {broadcastOutlayerBurnRegistrationOnce,reconcileOutlayerBurnRegistration} from './outlayer-burn-registration.mjs';

export function validatePostControlRegistration({plan:rawPlan,ownerPlan:rawOwner,original,control,envelope,controlProof}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 verifySignedOutlayerRegistrationControl(control,original,plan,owner);
 verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='register-fake'||envelope.tx_hash===original.tx_hash||envelope.nonce!==(BigInt(control.nonce)+1n).toString()||
  controlProof?.status!=='OUTLAYER_REGISTRATION_NONCE_FENCED_AT_FINAL'||controlProof.control_tx_hash!==control.tx_hash||
  controlProof.original_tx_hash!==original.tx_hash||controlProof.receipt?.tx_hash!==control.tx_hash||
  controlProof.receipt?.guard_rejection_verified!==true||controlProof.receipt?.original_cannot_be_accepted_after_control!==true||
  controlProof.registration_state!=='REGISTRATIONS_ABSENT_AT_FINAL_VIEW'||controlProof.provider_paid!==false||
  controlProof.do_not_resend_original!==true||controlProof.do_not_resend_control!==true){
  throw new Error('new registration lacks the exact finalized original control and absent registrations');
 }
 return {owner,plan};
}
/** First verifies the old original and control through the RPC, then performs
 * one separately fenced registration. Never sends either prior transaction. */
export async function broadcastPostControlRegistrationOnce({plan:rawPlan,ownerPlan:rawOwner,original,control,envelope,provider,persistAttempt,now=Date.now,
 inspectControl,inspectStage,inspectRegistration}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 verifySignedOutlayerRegistrationControl(control,original,plan,owner);verifySignedOutlayerBurnStage(envelope,plan,owner);
 const controlProof=await reconcileOutlayerRegistrationControl({plan,ownerPlan:owner,original,control,provider,now,
  ...(inspectControl?{inspectControl}:{}),...(inspectStage?{inspectStage}:{})});
 validatePostControlRegistration({plan,ownerPlan:owner,original,control,envelope,controlProof});
 const result=await broadcastOutlayerBurnRegistrationOnce({plan,ownerPlan:owner,envelope,provider,persistAttempt,now,
  ...(inspectRegistration?{inspect:inspectRegistration}:{})});
 return {...result,superseded_original_tx_hash:original.tx_hash,verified_control_tx_hash:control.tx_hash,
  original_historical_receipt_unknown:controlProof.original_history_unknown,scope:'new original registration after finalized old nonce fence; no seller payment or delivery'};
}
/** Read-only recovery of the new registration and the previously FINAL
 * control receipt, without relying on obsolete absence after registration. */
export async function reconcilePostControlRegistration({plan:rawPlan,ownerPlan:rawOwner,original,control,envelope,provider,now=Date.now,
 inspectRegistration}={}){
 const owner=validateOwnerBootstrapPlan(rawOwner),plan=validateOutlayerBurnPlan(rawPlan,owner);
 verifySignedOutlayerRegistrationControl(control,original,plan,owner);verifySignedOutlayerBurnStage(envelope,plan,owner);
 if(envelope.stage!=='register-fake'||envelope.tx_hash===original.tx_hash||envelope.nonce!==(BigInt(control.nonce)+1n).toString()){
  throw new Error('new registration does not follow the old nonce control');
 }
 const controlReceipt=verifyOutlayerRegistrationControlReceipt(await provider.txStatusReceipts(control.tx_hash,owner.account_id,'FINAL'),control,original,plan,owner);
 const result=await reconcileOutlayerBurnRegistration({plan,ownerPlan:owner,envelope,provider,now,
  ...(inspectRegistration?{inspect:inspectRegistration}:{})});
 return {...result,superseded_original_tx_hash:original.tx_hash,verified_control_tx_hash:control.tx_hash,control_receipt:controlReceipt,
  original_historical_receipt_unknown:true,scope:'new original registration and earlier control verified at FINAL; historical earlier registration receipt remains unknown'};
}
