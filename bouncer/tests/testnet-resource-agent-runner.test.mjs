import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {createTestnetResourceAgentKeyring} from '../agent/testnet-resource-agent-keyring.mjs';
import {inspectTestnetResourceAgentSetup,signTestnetResourceAgentSetup,verifySignedTestnetResourceAgentSetup} from '../agent/testnet-resource-agent-setup.mjs';
import {broadcastTestnetResourceAgentOnce,reconcileTestnetResourceAgent} from '../agent/testnet-resource-agent-runner.mjs';
import {V11_NEAR_CODE_HASH} from '../agent/keyless-vault-bootstrap.mjs';

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-agent-runner-'));fs.chmodSync(dir,0o700);
 const key=nearApi.KeyPair.fromRandom('ed25519'),owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',
  account_id:'bouncer-owner-0123456789abcdef01234567.testnet',public_key:String(key.getPublicKey())};
 const agent=createTestnetResourceAgentKeyring({dir:path.join(dir,'agent'),ownerPlan:owner}).plan;
 const now=Date.now(),hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,8)),root=nearApi.utils.serialize.base_encode(Buffer.alloc(32,9));
 const min='1250000000000000000000';let phase=0,nonce=42,sends=0,lookups=0,active,lost=false;
 const agentAccess={nonce:0,permission:{FunctionCall:{allowance:agent.gas_allowance_yocto,receiver_id:agent.vault,method_names:agent.methods}}};
 const p={enforcesSetupBeforeSubmitGuard:true,get sends(){return sends},get lookups(){return lookups},
  set active(e){active=e},set lost(x){lost=x},
  async viewNodeStatus(){return {chain_id:'testnet'}},
  async viewBlock(){return {header:{hash,timestamp_nanosec:(BigInt(now)*1000000n).toString()}}},
  async query(q){assert.equal(q.block_id,hash);const full={nonce,permission:'FullAccess'};
   if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:q.account_id===agent.vault?[]:
    [{public_key:owner.public_key,access_key:full},...(phase===2?[{public_key:agent.public_key,access_key:agentAccess}]:[])]};
   if(q.request_type==='view_access_key')return {block_hash:hash,...(q.public_key===owner.public_key?full:agentAccess)};
   if(q.request_type==='view_account')return q.account_id===owner.account_id?
    {block_hash:hash,code_hash:'11111111111111111111111111111111',amount:'3000000000000000000000000',locked:'0',storage_usage:150}:
    q.account_id===agent.vault?{block_hash:hash,code_hash:V11_NEAR_CODE_HASH,amount:'6000000000000000000000000',storage_usage:540000}:
    {block_hash:hash,code_hash:hash};
   throw Error('unexpected query');
  },
  async experimental_protocolConfig({blockId}){assert.equal(blockId,hash);return {chain_id:'testnet',runtime_config:{storage_amount_per_byte:'10000000000000000000'}}},
  async callFunctionRaw(account,method,args,ref){assert.equal(ref.blockId,hash);let v;
   if(method==='get_owner')v=owner.account_id;
   else if(method==='contract_version')v='bouncer-agent-v11-exact-ft-testnet';
   else if(method==='vault_balance')v='6907';
   else if(method==='ft_metadata')v={symbol:'USDC',decimals:6};
   else if(method==='storage_balance_bounds')v={min,max:null};
   else if(method==='storage_balance_of')v={total:min,available:'0'};
   else if(method==='ft_balance_of')v=args.account_id===agent.vault?'6907':'0';
   else if(method==='get_policy')v=phase>=1?{token:agent.token,per_tx_cap:'3000',daily_cap:'6907'}:null;
   else if(method==='is_agent_key_allowed')v=phase>=1;
   else if(method==='daily_spent')v='0';
   else throw Error('unexpected view');
   return {block_hash:hash,result:[...Buffer.from(JSON.stringify(v))]};
  },
  async sendTransactionOnce(signed,wait,{beforeSubmit}){
   assert.equal(wait,'FINAL');assert.equal(String(signed.transaction.nonce),active.nonce);beforeSubmit();sends++;nonce++;
   if(active.stage==='configure')phase=1;if(active.stage==='install')phase=2;
   if(lost){lost=false;throw Error('simulated lost acknowledgement')}
   return {final_execution_status:'FINAL',transaction_outcome:{id:active.tx_hash}};
  },
  async txStatusReceipts(h,account,wait){lookups++;assert.equal(h,active.tx_hash);assert.equal(account,owner.account_id);assert.equal(wait,'FINAL');
   const signed=verifySignedTestnetResourceAgentSetup(active,owner,agent),receiver=active.stage==='install'?owner.account_id:agent.vault;
   const actions=signed.transaction.actions.map(a=>a.functionCall?{FunctionCall:{method_name:a.functionCall.methodName,
    args:Buffer.from(a.functionCall.args).toString('base64'),gas:a.functionCall.gas.toString(),deposit:a.functionCall.deposit.toString()}}:
    {AddKey:{public_key:agent.public_key,access_key:{nonce:0,permission:{FunctionCall:{allowance:agent.gas_allowance_yocto,
     receiver_id:agent.vault,method_names:agent.methods}}}}});
   const fail={ActionError:{kind:{FunctionCallError:{ExecutionError:'ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR'}}}};
   const status=active.stage==='guard-probe'?{Failure:fail}:{SuccessValue:''};
   return {final_execution_status:'FINAL',status,transaction:{hash:active.tx_hash,signer_id:owner.account_id,public_key:owner.public_key,
    receiver_id:receiver,nonce:active.nonce,actions:structuredClone(actions)},
    transaction_outcome:{id:active.tx_hash,outcome:{executor_id:owner.account_id,status:{SuccessReceiptId:root},receipt_ids:[root]}},
    receipts:active.stage==='install'?[]:[{receipt_id:root,predecessor_id:owner.account_id,receiver_id:receiver,
     receipt:{Action:{signer_id:owner.account_id,signer_public_key:owner.public_key,actions:structuredClone(actions)}}}],
    receipts_outcome:[{id:root,outcome:{executor_id:receiver,status:structuredClone(status),receipt_ids:[]}}]};
  }
 };
 const prepare=async stage=>{
  const snapshot=await inspectTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,provider:p,now:()=>now});
  const envelope=await signTestnetResourceAgentSetup({ownerPlan:owner,agentPlan:agent,snapshot,stage,keyPair:key,nowMs:now});p.active=envelope;return envelope;
 };
 const args=envelope=>({ownerPlan:owner,agentPlan:agent,envelope,expectedCircleCodeHash:hash,provider:p,now:()=>now,
  persistAttempt:async a=>a.tx_hash===envelope.tx_hash&&a.stage===envelope.stage});
 return {owner,agent,p,prepare,args,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('one-shot setup verifies expected guard failure, recovers lost acknowledgement, and confirms restricted key state',async()=>{
 const f=fixture();try{
  const guard=await f.prepare('guard-probe'),g=await broadcastTestnetResourceAgentOnce(f.args(guard));
  assert.equal(g.status,'ONE_YOCTO_GUARD_REJECTED_AT_FINAL');assert.equal(g.sent,true);assert.equal(g.receipt.guard_failure_verified,true);
  const policy=await f.prepare('configure');f.p.lost=true;
  await assert.rejects(broadcastTestnetResourceAgentOnce(f.args(policy)),/never resend/);assert.equal(f.p.sends,2);
  const recovered=await reconcileTestnetResourceAgent(f.args(policy));assert.equal(recovered.status,'RESOURCE_POLICY_CONFIGURED_AT_FINAL');
  assert.equal(recovered.sent,false);assert.equal(recovered.reconciliation_only,true);assert.equal(f.p.sends,2);
  const install=await f.prepare('install'),i=await broadcastTestnetResourceAgentOnce(f.args(install));
  assert.equal(i.status,'RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL');assert.equal(i.state.owner_key_count,2);
  assert.equal(i.state.vault_key_count,0);assert.equal(i.state.vault_actual_circle_atoms,'6907');assert.equal(f.p.sends,3);
  await assert.rejects(broadcastTestnetResourceAgentOnce(f.args(install)),/never resend/);assert.equal(f.p.sends,3);
 }finally{f.cleanup()}
});

test('a missing original fence, changed expected code or wrong stage cannot submit',async()=>{
 const f=fixture();try{
  const guard=await f.prepare('guard-probe');
  await assert.rejects(broadcastTestnetResourceAgentOnce({...f.args(guard),persistAttempt:async()=>false}),/fence/);
  await assert.rejects(broadcastTestnetResourceAgentOnce({...f.args(guard),expectedCircleCodeHash:V11_NEAR_CODE_HASH}),/never resend/);
  await assert.rejects(broadcastTestnetResourceAgentOnce({...f.args(guard),envelope:{...guard,stage:'install'}}));
  assert.equal(f.p.sends,0);
 }finally{f.cleanup()}
});
