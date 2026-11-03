import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan} from '../agent/outlayer-v11-burn-plan.mjs';
import {signOutlayerBurnStage,verifySignedOutlayerBurnStage} from '../agent/outlayer-v11-burn-signed.mjs';
import {signOutlayerRegistrationControl,verifySignedOutlayerRegistrationControl} from '../agent/outlayer-registration-control.mjs';
import {verifyOutlayerAcquisitionReceipt,reconcileOutlayerAcquisition,broadcastOutlayerAcquisitionOnce} from '../agent/outlayer-burn-acquisition.mjs';
import {inspectOutlayerFundingBefore,verifyOutlayerFundingReceipt,reconcileOutlayerFunding,broadcastOutlayerFundingOnce} from '../agent/outlayer-burn-funding.mjs';
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
async function fixture(stage='wrap'){
 const original=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap('register-fake','123'),keyPair:ownerKey,nowMs:now});
 const control=await signOutlayerRegistrationControl({plan,ownerPlan:owner,original,snapshot:snap('register-fake','123'),keyPair:ownerKey,nowMs:now});
 const registration=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'register-fake',snapshot:snap('register-fake','125'),keyPair:ownerKey,nowMs:now});
 const wrap=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'wrap',snapshot:snap('wrap','126'),keyPair:ownerKey,nowMs:now});
 const swap=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'swap-fake',snapshot:snap('swap-fake','127'),keyPair:ownerKey,nowMs:now});
 const controlFailure={Failure:{ActionError:{kind:{FunctionCallError:{ExecutionError:'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'}}}}};
 const controlResult=result(control,verifySignedOutlayerRegistrationControl(control,original,plan,owner),plan.vault,controlFailure,hash(4));
 const registrationResult=result(registration,verifySignedOutlayerBurnStage(registration,plan,owner),'usdc.fakes.testnet',
  {SuccessValue:encode({total:'1250000000000000000000',available:'0'})},hash(5));
 const wrapResult=result(wrap,verifySignedOutlayerBurnStage(wrap,plan,owner),'wrap.testnet',{SuccessValue:''},hash(6));
 const swapResult=result(swap,verifySignedOutlayerBurnStage(swap,plan,owner),'wrap.testnet',{SuccessValue:encode('100000000000000')},hash(7));
 const hook=hash(8),resolver=hash(9),transfer=hash(10),outer=JSON.parse(Buffer.from(verifySignedOutlayerBurnStage(swap,plan,owner).transaction.actions[0].functionCall.args).toString());
 swapResult.receipts_outcome[0].outcome.status={SuccessReceiptId:resolver};swapResult.receipts_outcome[0].outcome.receipt_ids=[hook,resolver];
 swapResult.receipts.push({receipt_id:hook,predecessor_id:'wrap.testnet',receiver_id:'ref-finance-101.testnet',receipt:{Action:{output_data_receivers:[{receiver_id:'wrap.testnet',data_id:hash(11)}],actions:[{FunctionCall:{method_name:'ft_on_transfer',deposit:'0',args:encode({sender_id:owner.account_id,amount:'100000000000000',msg:outer.msg})}}]}}},
  {receipt_id:resolver,predecessor_id:'wrap.testnet',receiver_id:'wrap.testnet',receipt:{Action:{input_data_ids:[hash(11)],actions:[{FunctionCall:{method_name:'ft_resolve_transfer',deposit:'0',args:encode({sender_id:owner.account_id,receiver_id:'ref-finance-101.testnet',amount:'100000000000000'})}}]}}},
  {receipt_id:transfer,predecessor_id:'ref-finance-101.testnet',receiver_id:'usdc.fakes.testnet',receipt:{Action:{actions:[{FunctionCall:{method_name:'ft_transfer',deposit:'1',args:encode({receiver_id:owner.account_id,amount:'21645'})}}]}}});
 swapResult.receipts_outcome.push({id:hook,outcome:{executor_id:'ref-finance-101.testnet',status:{SuccessValue:encode('0')},receipt_ids:[transfer],logs:[]}},
  {id:resolver,outcome:{executor_id:'wrap.testnet',status:{SuccessValue:encode('100000000000000')},receipt_ids:[],logs:[]}},
  {id:transfer,outcome:{executor_id:'usdc.fakes.testnet',status:{SuccessValue:''},receipt_ids:[],logs:['EVENT_JSON:'+JSON.stringify({standard:'nep141',version:'1.0.0',event:'ft_transfer',data:[{old_owner_id:'ref-finance-101.testnet',new_owner_id:owner.account_id,amount:'21645'}]})]}});
 const envelope=stage==='wrap'?wrap:swap,previousWrap=stage==='wrap'?undefined:wrap;
 const all=new Map([[control.tx_hash,controlResult],[registration.tx_hash,registrationResult],[wrap.tx_hash,wrapResult],[swap.tx_hash,swapResult]]);
 const state={sends:0,persisted:false,before:snap(stage,(BigInt(envelope.nonce)-1n).toString()),after:snap(stage==='wrap'?'swap-fake':'fund-vault',envelope.nonce),
  fence:true,canonical:block,validity:86400,loseResponse:false,balance:'21645'};
 const provider={enforcesSetupBeforeSubmitGuard:true,async viewNodeStatus(){return {chain_id:'testnet'}},async query(){},async callFunctionRaw(){},async gasPrice(){},
  async experimental_protocolConfig(){return {chain_id:'testnet',transaction_validity_period:state.validity}},async viewBlock(){return {header:{hash:state.canonical,height:100}}},
  async txStatusReceipts(h){if(!all.has(h))throw Error('original unavailable');return structuredClone(all.get(h))},
  async sendTransactionOnce(s,w,{beforeSubmit}){state.sends++;assert.equal(state.persisted,true);beforeSubmit();if(state.loseResponse)throw Error('lost');
   return {final_execution_status:'FINAL',transaction_outcome:{id:envelope.tx_hash}}},
 };
 const inspect=async({stage:asked})=>structuredClone(asked===stage?state.before:state.after),readView=async()=>state.balance;
 const persistAttempt=async()=>{state.persisted=true;return state.fence};
 return {original,control,registration,wrap:previousWrap,envelope,wrapResult,swapResult,provider,state,inspect,readView,persistAttempt,all};
}
const args=f=>({plan,ownerPlan:owner,original:f.original,control:f.control,registration:f.registration,wrap:f.wrap,envelope:f.envelope,
 provider:f.provider,inspect:f.inspect,readView:f.readView,persistAttempt:f.persistAttempt,now:()=>now});
test('verified registration and guard control precede a single bounded test-NEAR wrap',async()=>{
 const f=await fixture(),x=await broadcastOutlayerAcquisitionOnce(args(f));
 assert.equal(x.status,'OUTLAYER_TEST_NEAR_WRAPPED_AT_FINAL');assert.equal(x.next_stage.stage,'swap-fake');
 assert.equal(x.provider_paid,false);assert.equal(x.independent_fulfillment_verified,false);assert.equal(f.state.sends,1);
});
test('verified original wrap, Ref output event and pinned fake-token balance bind the swap',async()=>{
 const f=await fixture('swap-fake'),x=await broadcastOutlayerAcquisitionOnce(args(f));
 assert.equal(x.status,'OUTLAYER_FAKE_TOKEN_ACQUIRED_AT_FINAL');assert.equal(x.receipt.fake_token_output.amount_atoms,'21645');
 assert.equal(x.next_stage.stage,'fund-vault');assert.equal(f.state.sends,1);
 const recovered=await reconcileOutlayerAcquisition(args(f));assert.equal(recovered.reconciliation_only,true);assert.equal(f.state.sends,1);
});
test('pinned legacy fake token transfer log is checked without claiming a NEP-141 event',async()=>{
 const f=await fixture('swap-fake'),o=f.swapResult.receipts_outcome[3].outcome;
 o.logs=[`Transfer 21645 from ref-finance-101.testnet to ${owner.account_id}`];
 const verified=verifyOutlayerAcquisitionReceipt(f.swapResult,f.envelope,plan,owner);
 assert.equal(verified.fake_token_output.amount_atoms,'21645');
 assert.equal(verified.fake_token_output.transfer_event_verified,false);
 assert.equal(verified.fake_token_output.legacy_transfer_log_verified,true);
 const recovered=await reconcileOutlayerAcquisition(args(f));
 assert.equal(recovered.receipt.fake_token_output.legacy_transfer_log_verified,true);
 assert.equal(f.state.sends,0);
 for(const mutate of [
  r=>{r.receipts_outcome[3].outcome.logs=[`Transfer 21644 from ref-finance-101.testnet to ${owner.account_id}`]},
  r=>{r.receipts_outcome[3].outcome.logs=[`Transfer 21645 from someone.testnet to ${owner.account_id}`]},
  r=>{r.receipts_outcome[3].outcome.logs.push(`Transfer 1 from x.testnet to ${owner.account_id}`)},
  r=>{r.receipts_outcome[3].outcome.logs.push('EVENT_JSON:'+JSON.stringify({standard:'nep141',version:'1.0.0',event:'ft_transfer',data:[]}))},
  r=>{r.receipts_outcome[3].outcome.logs.push('EVENT_JSON:malformed')},
  r=>{r.receipts_outcome[3].outcome.status.SuccessValue=encode('not-unit')},
  r=>{r.receipts[3].receiver_id='different.testnet'},
 ]){
  const changed=structuredClone(f.swapResult);mutate(changed);
  assert.throws(()=>verifyOutlayerAcquisitionReceipt(changed,f.envelope,plan,owner));
 }
});

test('missing fence, prior receipt, changed nonce, balances or reference never authorize another send',async()=>{
 for(const mutate of [f=>{f.state.fence=false},f=>{f.state.before.signer_key_nonce='999'},f=>{f.state.before.eligible=false},
  f=>{f.state.canonical=hash(11)},f=>{f.state.validity=0},f=>{f.provider.txStatusReceipts=async()=>{throw Error('missing original')}}]){
  const f=await fixture();mutate(f);await assert.rejects(broadcastOutlayerAcquisitionOnce(args(f)));assert.equal(f.state.sends,0);
 }
 const g=await fixture('swap-fake');g.state.balance='21644';await assert.rejects(broadcastOutlayerAcquisitionOnce(args(g)),/unconfirmed.*never resend/);assert.equal(g.state.sends,1);
});
test('lost acknowledgement recovers the same original without resending',async()=>{
 const f=await fixture();f.state.loseResponse=true;await assert.rejects(broadcastOutlayerAcquisitionOnce(args(f)),/unconfirmed.*never resend/);
 const recovered=await reconcileOutlayerAcquisition(args(f));assert.equal(recovered.tx_hash,f.envelope.tx_hash);assert.equal(f.state.sends,1);
});
test('swap proof rejects changed actions, failures, unlinked hook, fake output or transfer event',async()=>{
 const f=await fixture('swap-fake');for(const mutate of [r=>{r.final_execution_status='EXECUTED'},r=>{r.transaction.actions[0].FunctionCall.deposit='2'},
  r=>{r.receipts_outcome[0].outcome.receipt_ids=[]},r=>{r.receipts_outcome[1].outcome.status={Failure:{}}},
  r=>{r.receipts[1].receipt.Action.actions[0].FunctionCall.args=encode({sender_id:owner.account_id,amount:'1',msg:'x'})},
  r=>{r.receipts[2].receipt.Action.input_data_ids=[hash(12)]},r=>{r.receipts_outcome[2].outcome.status.SuccessValue=encode('0')},
  r=>{r.receipts[3].receipt.Action.actions[0].FunctionCall.args=encode({receiver_id:owner.account_id,amount:'14999'})},
  r=>{r.receipts_outcome[3].outcome.logs=[]},r=>{r.receipts.push(structuredClone(r.receipts[0]))}]){
  const changed=structuredClone(f.swapResult);mutate(changed);assert.throws(()=>verifyOutlayerAcquisitionReceipt(changed,f.envelope,plan,owner));
 }
});

async function fundingFixture(){
 const f=await fixture('swap-fake'),swap=f.envelope;
 const envelope=await signOutlayerBurnStage({plan,ownerPlan:owner,stage:'fund-vault',snapshot:snap('fund-vault',swap.nonce),keyPair:ownerKey,nowMs:now});
 const root=hash(20),hook=hash(21),resolver=hash(22),data=hash(23),amount='10000',token='usdc.fakes.testnet';
 const fundResult=result(envelope,verifySignedOutlayerBurnStage(envelope,plan,owner),token,{SuccessValue:encode(amount)},root);
 const ro=fundResult.receipts_outcome[0].outcome;
 ro.status={SuccessReceiptId:resolver};ro.receipt_ids=[hook,resolver];ro.logs=[`Transfer ${amount} from ${owner.account_id} to ${plan.vault}`];
 const call=(name,args)=>({FunctionCall:{method_name:name,deposit:'0',gas:'70000000000000',args:encode(args)}});
 fundResult.receipts.push({receipt_id:hook,predecessor_id:token,receiver_id:plan.vault,receipt:{Action:{signer_id:owner.account_id,signer_public_key:owner.public_key,
  actions:[call('ft_on_transfer',{sender_id:owner.account_id,amount,msg:''})],input_data_ids:[],output_data_receivers:[{receiver_id:token,data_id:data}]}}},
  {receipt_id:resolver,predecessor_id:token,receiver_id:token,receipt:{Action:{signer_id:owner.account_id,signer_public_key:owner.public_key,
   actions:[call('ft_resolve_transfer',{sender_id:owner.account_id,receiver_id:plan.vault,amount})],input_data_ids:[data],output_data_receivers:[]}}});
 fundResult.receipts_outcome.push({id:hook,outcome:{executor_id:plan.vault,status:{SuccessValue:encode('0')},receipt_ids:[],logs:['BOUNCER deposit received']}},
  {id:resolver,outcome:{executor_id:token,status:{SuccessValue:encode(amount)},receipt_ids:[],logs:[]}});
 f.all.set(envelope.tx_hash,fundResult);f.state.phase=0;f.state.before=snap('fund-vault',swap.nonce);f.state.after=snap('configure',envelope.nonce);
 f.provider.sendTransactionOnce=async(signed,wait,{beforeSubmit})=>{
  assert.equal(wait,'FINAL');assert.equal(f.state.persisted,true);assert.equal(signed.transaction.nonce,BigInt(envelope.nonce));
  beforeSubmit();f.state.sends++;f.state.phase=1;if(f.state.loseResponse)throw Error('lost');
  return {final_execution_status:'FINAL',transaction_outcome:{id:envelope.tx_hash}};
 };
 f.inspect=async({stage})=>structuredClone(stage==='fund-vault'?f.state.before:f.state.after);
 f.readView=async(_p,_block,contract,method,a)=>{
  if(contract===token&&method==='ft_balance_of'&&a.account_id===owner.account_id)return f.state.phase?'11645':'21645';
  if(contract===token&&method==='ft_balance_of'&&a.account_id===plan.vault)return f.state.phase?'10000':'0';
  if(contract===plan.vault&&method==='vault_balance'&&a.token===token)return f.state.phase?'10000':'0';
  throw Error('unexpected pinned view');
 };
 return {...f,swap,envelope,fundResult};
}
const fundingArgs=f=>({plan,ownerPlan:owner,original:f.original,control:f.control,registration:f.registration,wrap:f.wrap,swap:f.swap,envelope:f.envelope,
 provider:f.provider,inspect:f.inspect,readView:f.readView,persistAttempt:f.persistAttempt,now:()=>now});

test('fixed fake-token vault funding requires the original lineage and a single fenced send',async()=>{
 const f=await fundingFixture(),before=await inspectOutlayerFundingBefore(fundingArgs(f));
 assert.equal(before.stage,'fund-vault');assert.equal(before.prior.swap.fake_token_output.amount_atoms,'21645');
 assert.equal(before.balance.owner_fake_atoms,'21645');assert.equal(before.balance.vault_tracked_fake_atoms,'0');assert.equal(f.state.sends,0);
 const r=await broadcastOutlayerFundingOnce(fundingArgs(f));
 assert.equal(r.status,'OUTLAYER_FAKE_TOKEN_VAULT_FUNDED_AT_FINAL');assert.equal(r.receipt.funding.full_amount_accepted,true);
 assert.equal(r.receipt.funding.transfer_event_verified,false);assert.equal(r.receipt.funding.legacy_transfer_log_verified,true);
 assert.deepEqual(r.balance,{owner_fake_atoms:'11645',vault_actual_fake_atoms:'10000',vault_tracked_fake_atoms:'10000'});
 assert.equal(r.provider_paid,false);assert.equal(r.independent_fulfillment_verified,false);assert.equal(f.state.sends,1);
});

test('vault funding rejects changed or incomplete fake-token receipts and unsafe preconditions',async()=>{
 const f=await fundingFixture();assert.equal(verifyOutlayerFundingReceipt(f.fundResult,f.envelope,plan,owner,f.swap).funding.amount_atoms,'10000');
 for(const mutate of [
  r=>{r.transaction.nonce='999'},r=>{r.transaction.receiver_id='other.testnet'},r=>{r.receipts_outcome[0].outcome.logs=[]},
  r=>{r.receipts_outcome[0].outcome.logs=[`Transfer 10001 from ${owner.account_id} to ${plan.vault}`]},
  r=>{r.receipts_outcome[0].outcome.logs.push('EVENT_JSON:malformed')},r=>{r.status.Failure={}},
  r=>{r.receipts[1].receipt.Action.output_data_receivers[0].data_id=hash(24)},
  r=>{r.receipts_outcome[1].outcome.status.SuccessValue=encode('1')},r=>{r.receipts_outcome[1].outcome.logs=[]},
  r=>{r.receipts_outcome[2].outcome.status.SuccessValue=encode('2')},r=>{r.receipts_outcome.pop()},
  r=>{r.receipts_outcome[1].outcome.status={Failure:{}}},
 ]){const bad=structuredClone(f.fundResult);mutate(bad);assert.throws(()=>verifyOutlayerFundingReceipt(bad,f.envelope,plan,owner,f.swap));}
 for(const mutate of [
  x=>{x.state.fence=false},x=>{x.state.before.signer_key_nonce='999'},x=>{x.state.before.eligible=false},
  x=>{x.state.canonical=hash(24)},x=>{x.state.validity=0},x=>{x.provider.txStatusReceipts=async()=>{throw Error('missing original')}},
  x=>{x.readView=async()=> 'unexpected'},
 ]){const bad=await fundingFixture();mutate(bad);await assert.rejects(broadcastOutlayerFundingOnce(fundingArgs(bad)));assert.equal(bad.state.sends,0);}
});

test('lost fake-token funding acknowledgement reconciles only the original hash',async()=>{
 const f=await fundingFixture();f.state.loseResponse=true;
 await assert.rejects(broadcastOutlayerFundingOnce(fundingArgs(f)),/unconfirmed.*never resend/);assert.equal(f.state.sends,1);
 const r=await reconcileOutlayerFunding(fundingArgs(f));assert.equal(r.tx_hash,f.envelope.tx_hash);assert.equal(r.reconciliation_only,true);assert.equal(f.state.sends,1);
 f.readView=async()=> 'wrong';await assert.rejects(reconcileOutlayerFunding(fundingArgs(f)),/balance differs/);assert.equal(f.state.sends,1);
});
