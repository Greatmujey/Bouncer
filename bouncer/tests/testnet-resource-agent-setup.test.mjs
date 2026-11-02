import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {createTestnetResourceAgentKeyring} from '../agent/testnet-resource-agent-keyring.mjs';
import {inspectTestnetResourceAgentSetup,signTestnetResourceAgentSetup,verifySignedTestnetResourceAgentSetup} from '../agent/testnet-resource-agent-setup.mjs';
import {V11_NEAR_CODE_HASH} from '../agent/keyless-vault-bootstrap.mjs';
import {verifyTestnetResourceAgentReceipt} from '../agent/testnet-resource-agent-evidence.mjs';
const hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,8));
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-plan-'));fs.chmodSync(root,0o700);
 const key=nearApi.KeyPair.fromRandom('ed25519');
 const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(key.getPublicKey())};
 const p=createTestnetResourceAgentKeyring({dir:path.join(root,'agent'),ownerPlan:owner}).plan,now=Date.now();
 const snapshot={network:'testnet',owner:owner.account_id,public_key:owner.public_key,vault:p.vault,agent_public_key:p.public_key,
  circle_token:p.token,vault_code_hash:V11_NEAR_CODE_HASH,vault_key_count:0,vault_circle_registration:'REGISTERED_AT_VIEW',owner_circle_atoms:'0',
  vault_actual_circle_atoms:'6907',vault_tracked_circle_atoms:'6907',signed:false,sent:false,seller_contacted:false,
  owner_key_nonce:'42',block_hash:hash,block_timestamp_nanosec:(BigInt(now)*1000000n).toString(),
  policy:null,agent_granted:false,guard_probe_eligible:true,configure_eligible:true,install_eligible:false};
 return {root,key,owner,p,now,snapshot,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('probe, owner policy and restricted access-key actions are exact, independently signed and testnet-only',async()=>{
 const f=fixture();try{
  for(const stage of ['guard-probe','configure','install']){
   const s=structuredClone(f.snapshot);
   if(stage==='install'){s.policy={token:f.p.token,per_tx_cap:'3000',daily_cap:'6907'};s.agent_granted=true;s.install_eligible=true}
   const e=await signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:s,stage,keyPair:f.key,nowMs:f.now});
   const tx=verifySignedTestnetResourceAgentSetup(e,f.owner,f.p).transaction;
   assert.equal(e.nonce,'43');assert.equal(e.do_not_blindly_resend,true);assert.ok(!JSON.stringify(e).includes('private_key'));
   if(stage==='guard-probe'){assert.equal(tx.receiverId,f.p.vault);assert.equal(tx.actions.length,1);assert.equal(tx.actions[0].functionCall.deposit,0n)}
   if(stage==='configure'){
    assert.equal(tx.actions.length,2);assert.deepEqual(tx.actions.map(x=>x.functionCall.methodName),['set_policy','grant_agent_key']);
    assert.deepEqual(tx.actions.map(x=>x.functionCall.deposit),[1n,1n]);
   }
   if(stage==='install'){
    assert.equal(tx.receiverId,f.owner.account_id);const add=tx.actions[0].addKey;
    assert.deepEqual(Buffer.from(add.publicKey.ed25519Key.data),Buffer.from(nearApi.utils.PublicKey.from(f.p.public_key).ed25519Key.data));
    const perm=add.accessKey.permission.functionCall;
    assert.equal(perm.receiverId,f.p.vault);assert.deepEqual(perm.methodNames,['execute','execute_ft_call']);
    assert.equal(perm.allowance,100000000000000000000000n);
   }
   const bad={...e,signed_tx_base64:e.signed_tx_base64.slice(0,-4)+'AAAA'};
   assert.throws(()=>verifySignedTestnetResourceAgentSetup(bad,f.owner,f.p));
   assert.throws(()=>verifySignedTestnetResourceAgentSetup({...e,stage:stage==='install'?'configure':'install'},f.owner,f.p));
  }
 }finally{f.cleanup()}
});
test('refuses stale, inconsistent, wrong-key or not-yet-configured snapshots',async()=>{
 const f=fixture();try{
  for(const patch of [{vault_key_count:1},{vault_actual_circle_atoms:'6906'},{seller_contacted:true},{policy:{}},
    {circle_token:'fake.testnet'},{owner_key_nonce:'9007199254740992'},{block_timestamp_nanosec:'1'}]){
   await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:{...f.snapshot,...patch},stage:'configure',keyPair:f.key,nowMs:f.now}));
  }
  await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:f.snapshot,stage:'install',keyPair:f.key,nowMs:f.now}));
  await assert.rejects(signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot:f.snapshot,stage:'configure',keyPair:nearApi.KeyPair.fromRandom('ed25519'),nowMs:f.now}));
 }finally{f.cleanup()}
});


test('read-only setup preflight pins every view and refuses unexpected policy, balances or keys',async()=>{
 const f=fixture();try{
  let configured=false,mixed=false,badBlock=false,extraKey=false,badBalance=false;
  const calls=[],access={nonce:42,permission:'FullAccess'},min='1250000000000000000000';
  const provider={
   async viewNodeStatus(){return {chain_id:'testnet'}},
   async viewBlock(){return {header:{hash,timestamp_nanosec:(BigInt(f.now)*1000000n).toString()}}},
   async query(q){
    assert.equal(q.block_id,hash);calls.push(q.request_type);
    if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:q.account_id===f.p.vault?[]:
      [{public_key:f.owner.public_key,access_key:access},...(extraKey?[{public_key:f.p.public_key,access_key:access}]:[])]};
    if(q.request_type==='view_access_key')return {block_hash:hash,...access};
    if(q.request_type==='view_account')return q.account_id===f.owner.account_id?
      {block_hash:hash,code_hash:'11111111111111111111111111111111',amount:'3000000000000000000000000',locked:'0',storage_usage:150}:
      q.account_id===f.p.vault?{block_hash:hash,code_hash:V11_NEAR_CODE_HASH,amount:'6000000000000000000000000',storage_usage:540000}:
      {block_hash:hash,code_hash:hash,amount:'3000000000000000000000000',locked:'0',storage_usage:150};
    throw Error('unexpected query');
   },
   async experimental_protocolConfig({blockId}){assert.equal(blockId,hash);return {chain_id:'testnet',runtime_config:{storage_amount_per_byte:'10000000000000000000'}}},
   async callFunctionRaw(contract,method,args,ref){
    assert.equal(ref.blockId,hash);calls.push(method);let value;
    if(method==='get_owner')value=f.owner.account_id;
    else if(method==='contract_version')value='bouncer-agent-v11-exact-ft-testnet';
    else if(method==='vault_balance')value=badBalance?'6906':'6907';
    else if(method==='ft_metadata')value={symbol:'USDC',decimals:6};
    else if(method==='storage_balance_bounds')value={min,max:null};
    else if(method==='storage_balance_of')value={total:min,available:'0'};
    else if(method==='ft_balance_of')value=args.account_id===f.p.vault?'6907':'0';
    else if(method==='get_policy')value=configured?{daily_cap:'6907',token:f.p.token,per_tx_cap:'3000'}:null;
    else if(method==='is_agent_key_allowed')value=configured||mixed;
    else throw Error('unexpected view');
    return {block_hash:badBlock&&method==='get_policy'?nearApi.utils.serialize.base_encode(Buffer.alloc(32,9)):hash,result:[...Buffer.from(JSON.stringify(value))]};
   }
  };
  const inspect=()=>inspectTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,provider,now:()=>f.now});
  let s=await inspect();assert.equal(s.guard_probe_eligible,true);assert.equal(s.configure_eligible,true);assert.equal(s.install_eligible,false);
  assert.equal(s.vault_actual_circle_atoms,'6907');assert.equal(s.signed,false);assert.equal(s.sent,false);
  configured=true;s=await inspect();assert.equal(s.install_eligible,true);assert.equal(s.configure_eligible,false);
  configured=false;mixed=true;s=await inspect();assert.equal(s.configure_eligible,false);assert.equal(s.install_eligible,false);
  mixed=false;badBalance=true;await assert.rejects(inspect(),/funded vault state/);badBalance=false;
  extraKey=true;await assert.rejects(inspect(),/sole full-access key/);extraKey=false;
  badBlock=true;await assert.rejects(inspect(),/invalid view/);
  assert.ok(calls.includes('get_policy')&&calls.includes('is_agent_key_allowed'));
 }finally{f.cleanup()}
});


test('receipt evidence binds the original guard failure, policy actions and local AddKey outcome',async()=>{
 const f=fixture();try{
  const root=nearApi.utils.serialize.base_encode(Buffer.alloc(32,10));
  for(const stage of ['guard-probe','configure','install']){
   const snapshot=structuredClone(f.snapshot);
   if(stage==='install'){snapshot.policy={token:f.p.token,per_tx_cap:'3000',daily_cap:'6907'};snapshot.agent_granted=true;snapshot.install_eligible=true}
   const e=await signTestnetResourceAgentSetup({ownerPlan:f.owner,agentPlan:f.p,snapshot,stage,keyPair:f.key,nowMs:f.now});
   const signed=verifySignedTestnetResourceAgentSetup(e,f.owner,f.p),receiver=stage==='install'?f.owner.account_id:f.p.vault;
   const actions=signed.transaction.actions.map(a=>a.functionCall?{FunctionCall:{method_name:a.functionCall.methodName,
    args:Buffer.from(a.functionCall.args).toString('base64'),gas:a.functionCall.gas.toString(),deposit:a.functionCall.deposit.toString()}}:
    {AddKey:{public_key:f.p.public_key,access_key:{nonce:0,permission:{FunctionCall:{allowance:f.p.gas_allowance_yocto,receiver_id:f.p.vault,method_names:f.p.methods}}}}});
   const failure={ActionError:{kind:{FunctionCallError:{ExecutionError:'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'}}}};
   const status=stage==='guard-probe'?{Failure:failure}:{SuccessValue:''};
   const result={final_execution_status:'FINAL',status:structuredClone(status),transaction:{hash:e.tx_hash,signer_id:f.owner.account_id,
    public_key:f.owner.public_key,receiver_id:receiver,nonce:e.nonce,actions:structuredClone(actions)},
    transaction_outcome:{id:e.tx_hash,outcome:{executor_id:f.owner.account_id,status:{SuccessReceiptId:root},receipt_ids:[root]}},
    receipts:stage==='install'?[]:[{receipt_id:root,predecessor_id:f.owner.account_id,receiver_id:receiver,
      receipt:{Action:{signer_id:f.owner.account_id,signer_public_key:f.owner.public_key,actions:structuredClone(actions)}}}],
    receipts_outcome:[{id:root,outcome:{executor_id:receiver,status:structuredClone(status),receipt_ids:[]}}]};
   const verify=r=>verifyTestnetResourceAgentReceipt({ownerPlan:f.owner,agentPlan:f.p,envelope:e,result:r});
   const proof=verify(result);assert.equal(proof.guard_failure_verified,stage==='guard-probe');
   assert.equal(proof.local_receipt_body_omitted,stage==='install');assert.equal(proof.current_state_verified,false);
   for(const mutate of [
     r=>r.transaction.nonce='44',r=>r.transaction.receiver_id='evil.testnet',r=>r.transaction.actions[0]=null,
     r=>r.receipts_outcome[0].outcome.executor_id='evil.testnet',r=>r.transaction_outcome.outcome.receipt_ids=[],
     r=>r.receipts_outcome.push(structuredClone(r.receipts_outcome[0]))]){
    const changed=structuredClone(result);mutate(changed);assert.throws(()=>verify(changed));
   }
   if(stage==='guard-probe'){
    const changed=structuredClone(result);changed.status.Failure.ActionError.kind.FunctionCallError.ExecutionError='unrelated failure';
    changed.receipts_outcome[0].outcome.status=structuredClone(changed.status);assert.throws(()=>verify(changed),/one-yocto/);
   }
   if(stage==='install'){
    const changed=structuredClone(result);changed.transaction.actions[0].AddKey.access_key.permission.FunctionCall.method_names.push('set_policy');
    assert.throws(()=>verify(changed));
   }
   const gas=nearApi.utils.serialize.base_encode(Buffer.alloc(32,11)),withRefund=structuredClone(result);
   withRefund.receipts_outcome[0].outcome.receipt_ids=[gas];
   withRefund.receipts.push({receipt_id:gas,predecessor_id:'system',receiver_id:f.owner.account_id,receipt:{Action:{
    signer_id:f.owner.account_id,signer_public_key:f.owner.public_key,actions:[{Transfer:{deposit:'1'}}]}}});
   withRefund.receipts_outcome.push({id:gas,outcome:{executor_id:f.owner.account_id,status:{SuccessValue:''},receipt_ids:[]}});
   assert.equal(verify(withRefund).tx_hash,e.tx_hash);
   withRefund.receipts[withRefund.receipts.length-1].receiver_id='evil.testnet';assert.throws(()=>verify(withRefund),/unknown children/);
  }
 }finally{f.cleanup()}
});
