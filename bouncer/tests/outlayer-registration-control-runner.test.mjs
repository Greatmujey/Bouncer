import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan} from '../agent/outlayer-v11-burn-plan.mjs';
import {signOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {signOutlayerRegistrationControl,verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {verifyOutlayerRegistrationControlReceipt,reconcileOutlayerRegistrationControl,broadcastOutlayerRegistrationControlOnce} from '../agent/outlayer-registration-control-runner.mjs';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),ownerKey=key(),existing=key(),fund=key(),project=key();
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(ownerKey.getPublicKey())};
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:String(existing.getPublicKey()),fundingPublicKey:String(fund.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
const now=Date.parse('2026-11-02T23:00:00.000Z'),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),block=hash(3),root=hash(4);
const snap=nonce=>({version:1,stage:'register-fake',network:'testnet',owner:owner.account_id,vault:plan.vault,block_hash:block,
 block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:owner.public_key,signer_key_nonce:nonce,eligible:true,blockers:[],
 control_policy:null,control_eligible:true,signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false});
async function fixture(){
 const before=snap('123'),original=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:before,keyPair:ownerKey,nowMs:now});
 const control=await signOutlayerRegistrationControl({plan,ownerPlan:owner,original,snapshot:before,keyPair:ownerKey,nowMs:now});
 const signed=verifySignedOutlayerRegistrationControl(control,original,plan,owner),a=signed.transaction.actions[0].functionCall;
 const action={FunctionCall:{method_name:a.methodName,args:Buffer.from(a.args).toString('base64'),gas:a.gas.toString(),deposit:a.deposit.toString()}};
 const failure={Failure:{ActionError:{kind:{FunctionCallError:{ExecutionError:'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'}}}}};
 const result={final_execution_status:'FINAL',status:failure,transaction:{hash:control.tx_hash,signer_id:owner.account_id,receiver_id:plan.vault,
  public_key:owner.public_key,nonce:control.nonce,actions:[structuredClone(action)]},transaction_outcome:{id:control.tx_hash,
  outcome:{executor_id:owner.account_id,status:{SuccessReceiptId:root},receipt_ids:[root]}},
  receipts:[{receipt_id:root,predecessor_id:owner.account_id,receiver_id:plan.vault,receipt:{Action:{signer_id:owner.account_id,
   signer_public_key:owner.public_key,actions:[structuredClone(action)]}}}],
  receipts_outcome:[{id:root,outcome:{executor_id:plan.vault,status:failure,receipt_ids:[],logs:[]}}]};
 const state={before:{...before,block_hash:hash(5)},after:snap(control.nonce),head:110,reference:100,canonical:block,validity:86400,
  fence:true,persisted:false,sends:0,lookups:0,loseResponse:false};
 const provider={enforcesSetupBeforeSubmitGuard:true,async viewNodeStatus(){return {chain_id:'testnet'}},async query(){},async callFunctionRaw(){},async gasPrice(){},
  async experimental_protocolConfig(){return {chain_id:'testnet',transaction_validity_period:state.validity}},
  async viewBlock({blockId}){return {header:{hash:typeof blockId==='number'?state.canonical:blockId,height:typeof blockId==='number'?state.reference:blockId===block?state.reference:state.head}}},
  async sendTransactionOnce(s,w,{beforeSubmit}){state.sends++;assert.equal(state.persisted,true);assert.equal(w,'FINAL');beforeSubmit();
   if(state.loseResponse)throw Error('lost response');return {final_execution_status:'FINAL',transaction_outcome:{id:control.tx_hash}}},
  async txStatusReceipts(h){state.lookups++;if(h===control.tx_hash)return structuredClone(result);throw Error('original unknown')},
 };
 const inspectControl=async()=>structuredClone(state.sends?state.after:state.before),inspectStage=async()=>{throw Error('unexpected')};
 const persistAttempt=async v=>{assert.equal(v.control_tx_hash,control.tx_hash);assert.equal(v.original_tx_hash,original.tx_hash);state.persisted=true;return state.fence};
 return {original,control,result,state,provider,inspectControl,inspectStage,persistAttempt};
}
const args=f=>({plan,ownerPlan:owner,original:f.original,control:f.control,provider:f.provider,inspectControl:f.inspectControl,
 inspectStage:f.inspectStage,persistAttempt:f.persistAttempt,now:()=>now});
test('the original-bound zero-yocto control fences the old nonce after the expected FINAL guard rejection',async()=>{
 const f=await fixture(),proof=verifyOutlayerRegistrationControlReceipt(f.result,f.control,f.original,plan,owner);
 assert.equal(proof.guard_rejection_verified,true);assert.equal(proof.original_history_proven,false);
 const x=await broadcastOutlayerRegistrationControlOnce(args(f));assert.equal(x.status,'OUTLAYER_REGISTRATION_NONCE_FENCED_AT_FINAL');
 assert.equal(x.registration_state,'REGISTRATIONS_ABSENT_AT_FINAL_VIEW');assert.equal(x.original_history_unknown,true);
 assert.equal(x.provider_paid,false);assert.equal(x.do_not_resend_original,true);assert.equal(f.state.sends,1);
});
test('changed nonce, missing fence, stale reference and occupied policy stop before the send',async()=>{
 for(const mutate of [f=>{f.state.before.signer_key_nonce='124'},f=>{f.state.before.control_policy={}},f=>{f.state.fence=false},
  f=>{f.state.canonical=hash(7)},f=>{f.state.head=3700},f=>{f.state.validity=10}]){
  const f=await fixture();mutate(f);await assert.rejects(broadcastOutlayerRegistrationControlOnce(args(f)));assert.equal(f.state.sends,0);
 }
});
test('lost control acknowledgement is recovered by its hash without resending',async()=>{
 const f=await fixture();f.state.loseResponse=true;await assert.rejects(broadcastOutlayerRegistrationControlOnce(args(f)),/unconfirmed.*never resend/);
 const x=await reconcileOutlayerRegistrationControl(args(f));assert.equal(x.reconciliation_only,true);assert.equal(f.state.sends,1);
});
test('only the exact guard failure and linked original control receipt are accepted',async()=>{
 const f=await fixture();for(const mutate of [r=>{r.final_execution_status='EXECUTED'},r=>{r.status={SuccessValue:''}},
  r=>{r.status.Failure.ActionError.kind.FunctionCallError.ExecutionError='different failure'},r=>{r.transaction.actions[0].FunctionCall.deposit='1'},
  r=>{r.transaction.receiver_id='attacker.testnet'},r=>{r.transaction.nonce='124'},r=>{r.receipts[0].receipt.Action.actions=[]},
  r=>{r.receipts_outcome[0].outcome.status={SuccessValue:''}},r=>{r.transaction_outcome.outcome.receipt_ids=[]}]){
  const changed=structuredClone(f.result);mutate(changed);assert.throws(()=>verifyOutlayerRegistrationControlReceipt(changed,f.control,f.original,plan,owner));
 }
});
