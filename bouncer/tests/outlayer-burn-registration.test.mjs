import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan} from '../agent/outlayer-v11-burn-plan.mjs';
import {signOutlayerBurnStage,verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {verifyOutlayerBurnRegistration,broadcastOutlayerBurnRegistrationOnce,reconcileOutlayerBurnRegistration} from '../agent/outlayer-burn-registration.mjs';
const key=()=>nearApi.KeyPair.fromRandom('ed25519'),ownerKey=key(),existing=key(),fund=key(),project=key();
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(ownerKey.getPublicKey())};
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:String(existing.getPublicKey()),fundingPublicKey:String(fund.getPublicKey()),projectPublicKey:String(project.getPublicKey())});
const now=Date.parse('2026-11-02T23:00:00.000Z'),hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),block=hash(3),root=hash(4);
const snap=(stage,nonce='123')=>({version:1,stage,network:'testnet',owner:owner.account_id,vault:plan.vault,block_hash:block,
 block_timestamp_nanosec:String(BigInt(now)*1000000n),signer_public_key:owner.public_key,signer_key_nonce:nonce,eligible:true,blockers:[],
 signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false});
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64');
async function fixture(){
 const envelope=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap('register-fake'),keyPair:ownerKey,nowMs:now});
 const signed=verifySignedOutlayerBurnStage(envelope,plan,owner);
 const actions=signed.transaction.actions.map(a=>({FunctionCall:{method_name:a.functionCall.methodName,args:Buffer.from(a.functionCall.args).toString('base64'),
  gas:a.functionCall.gas.toString(),deposit:a.functionCall.deposit.toString()}}));
 const status={SuccessValue:encode({total:'1250000000000000000000',available:'0'})};
 const result={final_execution_status:'FINAL',status,transaction:{hash:envelope.tx_hash,signer_id:owner.account_id,receiver_id:'usdc.fakes.testnet',
  public_key:owner.public_key,nonce:'124',actions:structuredClone(actions)},
  transaction_outcome:{id:envelope.tx_hash,outcome:{executor_id:owner.account_id,status:{SuccessReceiptId:root},receipt_ids:[root]}},
  receipts:[{receipt_id:root,predecessor_id:owner.account_id,receiver_id:'usdc.fakes.testnet',receipt:{Action:{signer_id:owner.account_id,
   signer_public_key:owner.public_key,actions:structuredClone(actions)}}}],
  receipts_outcome:[{id:root,outcome:{executor_id:'usdc.fakes.testnet',status,receipt_ids:[],logs:[]}}]};
 const state={before:{...snap('register-fake'),block_hash:hash(5)},after:snap('wrap','124'),refHash:block,canonicalHash:block,headHeight:110,refHeight:100,validity:86400,
  fence:true,sends:0,lookups:0,loseResponse:false,persisted:false};
 const provider={enforcesSetupBeforeSubmitGuard:true,
  async viewNodeStatus(){return {chain_id:'testnet'}},async query(){},async callFunctionRaw(){},async gasPrice(){},
  async experimental_protocolConfig(){return {chain_id:'testnet',transaction_validity_period:state.validity}},
  async viewBlock({blockId}){return {header:{hash:typeof blockId==='number'?state.canonicalHash:blockId===envelope.block_hash?state.refHash:blockId,
   height:typeof blockId==='number'?state.refHeight:blockId===envelope.block_hash?state.refHeight:state.headHeight}}},
  async sendTransactionOnce(s,wait,{beforeSubmit}){state.sends++;assert.equal(state.persisted,true);assert.equal(wait,'FINAL');beforeSubmit();
   if(state.loseResponse)throw Error('lost response');return {final_execution_status:'FINAL',transaction_outcome:{id:envelope.tx_hash}}},
  async txStatusReceipts(h,account,wait){state.lookups++;assert.equal(h,envelope.tx_hash);assert.equal(account,owner.account_id);assert.equal(wait,'FINAL');return structuredClone(result)},
 };
 const inspect=async({stage})=>structuredClone(stage==='register-fake'?state.before:state.after);
 const persistAttempt=async info=>{assert.equal(info.tx_hash,envelope.tx_hash);state.persisted=true;return state.fence};
 return {envelope,result,state,provider,inspect,persistAttempt};
}
const args=f=>({plan,ownerPlan:owner,envelope:f.envelope,provider:f.provider,inspect:f.inspect,persistAttempt:f.persistAttempt,now:()=>now});
test('exact fake-token registration, next-state checks and original fence precede one send',async()=>{
 const f=await fixture(),proof=verifyOutlayerBurnRegistration(f.result,f.envelope,plan,owner);
 assert.deepEqual(proof.registered_accounts,[owner.account_id,plan.vault]);
 const x=await broadcastOutlayerBurnRegistrationOnce(args(f));
 assert.equal(x.status,'OUTLAYER_FAKE_TOKEN_REGISTRATIONS_FINAL');assert.equal(x.provider_paid,false);assert.equal(x.seller_contacted,false);
 assert.equal(x.independent_fulfillment_verified,false);assert.equal(x.do_not_resend,true);assert.equal(f.state.sends,1);assert.equal(f.state.lookups,1);
});
test('failed fence, changed nonce, noncanonical reference or ineligible state prevent broadcast',async()=>{
 for(const mutate of [f=>{f.state.fence=false},f=>{f.state.before.signer_key_nonce='124'},f=>{f.state.before.eligible=false},
  f=>{f.state.before.blockers=['unknown']},f=>{f.state.refHash=hash(9)},f=>{f.state.canonicalHash=hash(9)},
  f=>{f.state.headHeight=3700},f=>{f.state.headHeight=99},f=>{f.state.validity=10},f=>{f.state.validity=0}]){
  const f=await fixture();mutate(f);await assert.rejects(broadcastOutlayerBurnRegistrationOnce(args(f)));assert.equal(f.state.sends,0);
 }
});
test('lost acknowledgement retains original and read-only reconciliation never resends',async()=>{
 const f=await fixture();f.state.loseResponse=true;
 await assert.rejects(broadcastOutlayerBurnRegistrationOnce(args(f)),/unconfirmed.*never resend/);assert.equal(f.state.sends,1);
 const x=await reconcileOutlayerBurnRegistration(args(f));assert.equal(x.reconciliation_only,true);assert.equal(x.tx_hash,f.envelope.tx_hash);assert.equal(f.state.sends,1);
});
test('forged, partial, failed, unlinked or incorrect registration receipts are rejected',async()=>{
 const f=await fixture();for(const mutate of [
  r=>{r.final_execution_status='EXECUTED'},r=>{r.status.Failure={}},r=>{r.transaction.receiver_id='attacker.testnet'},
  r=>{r.transaction.nonce='125'},r=>{r.transaction.actions[0].FunctionCall.deposit='1'},r=>{r.receipts[0].receipt.Action.actions.pop()},
  r=>{r.receipts[0].predecessor_id='attacker.testnet'},r=>{r.receipts_outcome[0].outcome.status={Failure:{}}},
  r=>{r.receipts_outcome[0].outcome.status.SuccessValue=encode({total:'0',available:'0'})},r=>{r.transaction_outcome.outcome.receipt_ids=[]},
  r=>{r.receipts_outcome.push({id:hash(7),outcome:{executor_id:'attacker.testnet',status:{SuccessValue:''},receipt_ids:[]}})},
 ]){const changed=structuredClone(f.result);mutate(changed);assert.throws(()=>verifyOutlayerBurnRegistration(changed,f.envelope,plan,owner))}
});
