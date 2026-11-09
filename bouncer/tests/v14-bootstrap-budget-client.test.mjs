import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {inspectV14BootstrapBudget} from '../web-src/v14-bootstrap-budget-client.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const nowValue=1_800_000_000_000,now=()=>nowValue,block=encodeBase58(crypto.randomBytes(32)),owner='great_mujey.testnet',vault=`native.${owner}`;
const f=(send_sir,send_not_sir,execution)=>({send_sir,send_not_sir,execution});
const txFees={action_receipt_creation_config:f(108059500000,108059500000,108059500000),action_creation_config:{
  create_account_cost:f(500000000000,500000000000,7200000000000),transfer_cost:f(115123062500,115123062500,115123062500),
  add_key_cost:{full_access_cost:f(101765125000,101765125000,101765125000)},deploy_contract_cost:f(184765750000,184765750000,184765750000),
  deploy_contract_cost_per_byte:f(6812999,47683715,64572944),function_call_cost:f(200000000000,200000000000,780000000000),
  function_call_cost_per_byte:f(2235934,47683715,2235934),delete_key_cost:f(94946625000,94946625000,94946625000)}};
function fixture(){
  const state={chain:'testnet',candidate:'absent',errorBlock:block,ownerAmount:String(26n*10n**24n),ownerCode:'11111111111111111111111111111111',
    keys:[{public_key:'ed25519:fixture',access_key:{permission:'FullAccess'}}],now:nowValue,feeConfig:structuredClone(txFees),price:'100000000'};
  const calls=[];
  const fetch=async(url,opts)=>{
    assert.equal(url,'https://rpc.testnet.near.org');const req=JSON.parse(opts.body);calls.push(req.method);
    let result,error;
    switch(req.method){
      case 'status':result={chain_id:state.chain};break;
      case 'block':result={header:{hash:block,height:123,timestamp_nanosec:String(BigInt(state.now)*1_000_000n)}};break;
      case 'EXPERIMENTAL_protocol_config':result={chain_id:'testnet',protocol_version:90,runtime_config:{storage_amount_per_byte:'10000000000000000000',
        min_gas_purchase_price:'1000000000',account_creation_charge:'7000000000000000000000',transaction_costs:state.feeConfig}};break;
      case 'gas_price':result={gas_price:state.price};break;
      case 'query':{
        assert.equal(req.params.block_id,block);
        if(req.params.account_id===vault) {
          if(state.candidate==='absent')error={cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:vault,block_hash:state.errorBlock}}};
          else if(state.candidate==='present')result={block_hash:block};else error={message:'timeout'};
        } else if(req.params.request_type==='view_account')result={block_hash:block,code_hash:state.ownerCode,amount:state.ownerAmount,storage_usage:264};
        else if(req.params.request_type==='view_access_key_list')result={block_hash:block,keys:state.keys};
        else throw Error('unexpected read');break;
      }
      default:throw Error('unexpected RPC method');
    }
    return Response.json({jsonrpc:'2.0',id:req.id,...(error?{error}:{result})});
  };
  return {state,calls,fetch};
}

test('browser obtains one fresh public cost review without signing or sending',async()=>{
  const x=fixture(),r=await inspectV14BootstrapBudget({fetch:x.fetch,now});
  assert.equal(r.status,'READ_ONLY_REVIEW_NOT_AUTHORIZED');assert.equal(r.candidate_presence,'ABSENT_AT_FINAL_BLOCK');
  assert.equal(r.owner_available_yocto,String(26n*10n**24n-264n*10n**19n));
  assert.equal(r.budget.proposed_vault_funding_yocto,String(6n*10n**24n));
  assert.equal(r.budget.storage_estimate_yocto,'5590630000000000000000000');
  assert.equal(r.budget.create.gas_upfront_estimate_yocto,'7607442456250000000000');
  assert.equal(r.budget.deployment.initializer_prepaid_gas,'30000000000000');
  assert.equal(r.budget.receipt_purchase_price_yocto_per_gas,'1000000000');
  assert.equal(r.transaction_authorized,false);assert.equal(r.transaction_sent,false);assert.equal(r.independent_recovery_verified,false);
  assert.deepEqual(x.calls.sort(),['status','block','query','query','query','EXPERIMENTAL_protocol_config','gas_price'].sort());
});

test('a reviewed session key must itself be current FullAccess at the budget block',async()=>{
  const key=String(KeyPair.fromRandom('ed25519').getPublicKey()),other=String(KeyPair.fromRandom('ed25519').getPublicKey());
  const x=fixture();x.state.keys=[{public_key:key,access_key:{permission:'FullAccess',nonce:7}}];
  const ok=await inspectV14BootstrapBudget({fetch:x.fetch,now,expectedOwnerPublicKey:key});
  assert.equal(ok.status,'READ_ONLY_REVIEW_NOT_AUTHORIZED');assert.equal(ok.checks.reviewed_owner_key_full_access,true);
  assert.equal(ok.owner_wallet_control_proven,false);assert.equal(ok.independent_recovery_verified,false);
  assert.equal(ok.transaction_authorized,false);assert.equal(ok.transaction_sent,false);
  for(const keys of [
    [{public_key:other,access_key:{permission:'FullAccess',nonce:7}}],
    [{public_key:other,access_key:{permission:'FullAccess',nonce:7}},{public_key:key,access_key:{permission:{FunctionCall:{}},nonce:7}}],
    [{public_key:key,access_key:{permission:'FullAccess',nonce:Number.MAX_SAFE_INTEGER}}],
    [{public_key:key,access_key:{permission:'FullAccess'}}],
  ]) {
    const changed=fixture();changed.state.keys=keys;
    const blocked=await inspectV14BootstrapBudget({fetch:changed.fetch,now,expectedOwnerPublicKey:key});
    assert.equal(blocked.status,'BLOCKED_OR_UNKNOWN');assert(blocked.blockers.includes('reviewed_owner_key_full_access'));
  }
  const invalid=fixture();await assert.rejects(inspectV14BootstrapBudget({fetch:invalid.fetch,now,expectedOwnerPublicKey:'ed25519:fixture'}));
  assert.equal(invalid.calls.length,0);
});

test('present vault, insufficient funding and restricted owner are explicit blockers',async()=>{
  for(const [change,expected] of [[s=>{s.candidate='present'},'candidate_absent_at_block'],
    [s=>{s.ownerAmount=String(2n*10n**24n)},'owner_covers_example_vault_and_create_upfront'],
    [s=>{s.keys[0].access_key.permission={FunctionCall:{}}},'owner_has_full_access_key'],
    [s=>{s.ownerCode=encodeBase58(crypto.randomBytes(32))},'owner_has_plain_account_profile']]) {
    const x=fixture();change(x.state);const r=await inspectV14BootstrapBudget({fetch:x.fetch,now});
    assert.equal(r.status,'BLOCKED_OR_UNKNOWN');assert(r.blockers.includes(expected));assert.equal(r.transaction_authorized,false);
  }
});

test('unknown account result, mismatched block, stale header and missing costs do not become a fake quote',async()=>{
  for(const change of [s=>{s.candidate='unknown'},s=>{s.errorBlock=encodeBase58(crypto.randomBytes(32))},
    s=>{s.now=nowValue-121_000},s=>{s.chain='mainnet'},s=>{s.feeConfig={}},s=>{s.price='0'}]) {
    const x=fixture();change(x.state);await assert.rejects(inspectV14BootstrapBudget({fetch:x.fetch,now}));
  }
});
