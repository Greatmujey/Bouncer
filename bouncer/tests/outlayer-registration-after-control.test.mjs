import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan} from '../agent/outlayer-v11-burn-plan.mjs';
import {signOutlayerBurnStage,verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {signOutlayerRegistrationControl,verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {validatePostControlRegistration,broadcastPostControlRegistrationOnce,reconcilePostControlRegistration} from '../agent/outlayer-registration-after-control.mjs';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),ownerKey=key(),existing=key(),fund=key(),project=key();
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(ownerKey.getPublicKey())};
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:String(existing.getPublicKey()),fundingPublicKey:String(fund.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
const now=Date.parse('2026-11-02T23:00:00.000Z'),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),block=hash(3);
const snap=(stage,nonce)=>({version:1,stage,network:'testnet',owner:owner.account_id,vault:plan.vault,block_hash:block,
 block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:owner.public_key,signer_key_nonce:nonce,eligible:true,blockers:[],
 control_policy:null,control_eligible:true,signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false});
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
const action=a=>({FunctionCall:{method_name:a.functionCall.methodName,args:Buffer.from(a.functionCall.args).toString('base64'),gas:a.functionCall.gas.toString(),deposit:a.functionCall.deposit.toString()}});
function result(envelope,signed,receiver,status,root){
 const actions=signed.transaction.actions.map(action);
 return {final_execution_status:'FINAL',status,transaction:{hash:envelope.tx_hash,signer_id:owner.account_id,receiver_id:receiver,
  public_key:owner.public_key,nonce:envelope.nonce,actions:structuredClone(actions)},
  transaction_outcome:{id:envelope.tx_hash,outcome:{executor_id:owner.account_id,status:{SuccessReceiptId:root},receipt_ids:[root]}},
  receipts:[{receipt_id:root,predecessor_id:owner.account_id,receiver_id:receiver,receipt:{Action:{signer_id:owner.account_id,
   signer_public_key:owner.public_key,actions:structuredClone(actions)}}}],receipts_outcome:[{id:root,outcome:{executor_id:receiver,status,receipt_ids:[],logs:[]}}]};
}
async function fixture(){
 const original=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap('register-fake','123'),keyPair:ownerKey,nowMs:now});
 const control=await signOutlayerRegistrationControl({plan,ownerPlan:owner,original,snapshot:snap('register-fake','123'),keyPair:ownerKey,nowMs:now});
 const envelope=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap('register-fake','125'),keyPair:ownerKey,nowMs:now});
 const failure={Failure:{ActionError:{kind:{FunctionCallError:{ExecutionError:'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'}}}}};
 const controlResult=result(control,verifySignedOutlayerRegistrationControl(control,original,plan,owner),plan.vault,failure,hash(4));
 const registerResult=result(envelope,verifySignedOutlayerBurnStage(envelope,plan,owner),'usdc.fakes.testnet',
  {SuccessValue:encode({total:'1250000000000000000000',available:'0'})},hash(5));
 const state={sends:0,controlLookups:0,registerLookups:0,persisted:false};
 const provider={enforcesSetupBeforeSubmitGuard:true,async viewNodeStatus(){return {chain_id:'testnet'}},async query(){},async callFunctionRaw(){},async gasPrice(){},
  async experimental_protocolConfig(){return {chain_id:'testnet',transaction_validity_period:86400}},async viewBlock(){return {header:{hash:block,height:100}}},
  async txStatusReceipts(h){if(h===control.tx_hash){state.controlLookups++;return structuredClone(controlResult)}
   if(h===envelope.tx_hash){state.registerLookups++;return structuredClone(registerResult)}throw Error('unexpected original lookup')},
  async sendTransactionOnce(s,w,{beforeSubmit}){state.sends++;assert.equal(state.persisted,true);beforeSubmit();return {final_execution_status:'FINAL',transaction_outcome:{id:envelope.tx_hash}}},
 };
 const inspectControl=async()=>snap('register-fake','125'),inspectRegistration=async({stage})=>snap(stage,stage==='wrap'?'126':'125');
 const inspectStage=async()=>{throw Error('unexpected stage')},persistAttempt=async()=>{state.persisted=true;return true};
 const controlProof={status:'OUTLAYER_REGISTRATION_NONCE_FENCED_AT_FINAL',control_tx_hash:control.tx_hash,original_tx_hash:original.tx_hash,
  receipt:{tx_hash:control.tx_hash,guard_rejection_verified:true,original_cannot_be_accepted_after_control:true},
  registration_state:'REGISTRATIONS_ABSENT_AT_FINAL_VIEW',provider_paid:false,do_not_resend_original:true,do_not_resend_control:true};
 return {original,control,envelope,provider,state,inspectControl,inspectStage,inspectRegistration,persistAttempt,controlProof};
}
const args=f=>({plan,ownerPlan:owner,original:f.original,control:f.control,envelope:f.envelope,provider:f.provider,
 inspectControl:f.inspectControl,inspectStage:f.inspectStage,inspectRegistration:f.inspectRegistration,persistAttempt:f.persistAttempt,now:()=>now});
test('a new registration follows the exact finalized fence, then sends and verifies only its new original',async()=>{
 const f=await fixture();validatePostControlRegistration({...args(f),controlProof:f.controlProof});
 const x=await broadcastPostControlRegistrationOnce(args(f));
 assert.equal(x.tx_hash,f.envelope.tx_hash);assert.equal(x.superseded_original_tx_hash,f.original.tx_hash);assert.equal(x.verified_control_tx_hash,f.control.tx_hash);
 assert.equal(x.provider_paid,false);assert.equal(f.state.sends,1);assert.equal(f.state.controlLookups,1);assert.equal(f.state.registerLookups,1);
 const y=await reconcilePostControlRegistration(args(f));assert.equal(y.reconciliation_only,true);assert.equal(f.state.sends,1);
});
test('wrong prior control, unverified guard, changed old nonce or present registrations prevent a new action',async()=>{
 const f=await fixture();for(const mutate of [p=>{p.control_tx_hash=hash(9)},p=>{p.original_tx_hash=hash(9)},p=>{p.receipt.guard_rejection_verified=false},
  p=>{p.receipt.original_cannot_be_accepted_after_control=false},p=>{p.registration_state='REGISTRATIONS_PRESENT_AT_FINAL_VIEW'},
  p=>{p.provider_paid=true},p=>{p.do_not_resend_original=false}]){
  const proof=structuredClone(f.controlProof);mutate(proof);assert.throws(()=>validatePostControlRegistration({...args(f),controlProof:proof}));
 }
 assert.throws(()=>validatePostControlRegistration({...args(f),envelope:f.original,controlProof:f.controlProof}));
 const send=f.provider.sendTransactionOnce;f.provider.txStatusReceipts=async()=>{throw Error('control unavailable')};
 await assert.rejects(broadcastPostControlRegistrationOnce(args(f)));assert.equal(f.state.sends,0);f.provider.sendTransactionOnce=send;
});
