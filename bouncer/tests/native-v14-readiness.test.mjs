// Synthetic RPC views only. No wallet, signer, provider job or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectV14Readiness } from '../agent/native-v14-readiness.mjs';
import { V14_TESTNET_ARTIFACT } from '../shared/v14-testnet-artifact.mjs';
import { estimateV14BootstrapBudget } from '../shared/v14-bootstrap-budget.mjs';
import { ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-testnet-registry.mjs';
import { V11_SELECTED_WASM_FEATURES } from '../agent/svalin-setup-preflight.mjs';
import { NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { mockHash } from './mock-guarded-payment.mjs';
import nearApi from 'near-api-js';

test('the identified CI artifact hash is internally consistent',()=>{
  assert.equal(nearApi.utils.serialize.base_encode(Buffer.from(V14_TESTNET_ARTIFACT.sha256,'hex')),V14_TESTNET_ARTIFACT.near_code_hash);
});

const NOW=1_800_000_000_000, BLOCK=mockHash('v14-preflight-block'), OTHER=mockHash('different-v14-block');
const ONE=10n**24n, owner='buyer.testnet',vault=`native.${owner}`;
const f=(send_sir,send_not_sir,execution)=>({send_sir,send_not_sir,execution});
const fees={action_receipt_creation_config:f(108059500000,108059500000,108059500000),action_creation_config:{
  create_account_cost:f(500000000000,500000000000,7200000000000),transfer_cost:f(115123062500,115123062500,115123062500),
  add_key_cost:{full_access_cost:f(101765125000,101765125000,101765125000)},
  deploy_contract_cost:f(184765750000,184765750000,184765750000),
  deploy_contract_cost_per_byte:f(6812999,47683715,64572944),function_call_cost:f(200000000000,200000000000,780000000000),
  function_call_cost_per_byte:f(2235934,47683715,2235934),delete_key_cost:f(94946625000,94946625000,94946625000)}};
function fixture(o={}) {
  const calls=[],p=ORACLE_TESTNET_PROGRAM;
  const project={project_id:ORACLE_PROJECT_ID,uuid:ORACLE_PROJECT_UUID,owner:o.changedProject?'other.testnet':'zavodil2.testnet'};
  const version={wasm_hash:p.sha256,source:{WasmUrl:{url:p.url,hash:p.sha256,build_target:p.build_target}}};
  const provider={
    async viewNodeStatus(){calls.push('status');return {chain_id:o.mainnet?'mainnet':'testnet'}},
    async viewBlock(ref){calls.push('block');assert.deepEqual(ref,{finality:'final'});
      return {header:{hash:BLOCK,height:123,timestamp_nanosec:String(BigInt(NOW-(o.stale?121_000:0))*1_000_000n)}}},
    async query(q){calls.push('query');assert.equal(q.block_id,BLOCK);const block_hash=o.mixed?OTHER:BLOCK;
      if(q.request_type==='view_account'&&q.account_id===owner)return {block_hash,code_hash:o.ownerCode?mockHash('owner-code'):NO_LOCAL_CONTRACT_HASH,
        amount:String((o.lowNear?2n:16n)*ONE),storage_usage:264};
      if(q.request_type==='view_access_key_list'&&q.account_id===owner)return {block_hash,keys:[{access_key:{permission:o.restricted?{FunctionCall:{}}:'FullAccess'}}]};
      if(q.request_type==='view_account'&&q.account_id==='outlayer.testnet')return {block_hash,code_hash:mockHash('outlayer-code')};
      throw Error('unexpected query');},
    async viewTestnetAccountPresenceAt(id,block){calls.push('presence');assert.equal(id,vault);assert.equal(block,BLOCK);
      if(o.unknown)throw Error('unknown');return {block_hash:o.badPresence?OTHER:BLOCK,exists:!!o.exists}},
    async experimental_protocolConfig(ref){calls.push('protocol');assert.deepEqual(ref,{blockId:BLOCK});
      return {chain_id:'testnet',protocol_version:90,runtime_config:{storage_amount_per_byte:'10000000000000000000',
        min_gas_purchase_price:'1000000000',account_creation_charge:'7000000000000000000000',
        ...(o.noFees?{}:{transaction_costs:structuredClone(fees)}),
        wasm_config:Object.fromEntries(V11_SELECTED_WASM_FEATURES.map(f=>[f,!o.featureOff]))}}},
    async gasPrice(block){calls.push('gas');assert.equal(block,BLOCK);return {gas_price:'100000000'}},
    async callFunctionRaw(account,method,args,ref){calls.push('view');assert.equal(account,'outlayer.testnet');assert.deepEqual(ref,{blockId:BLOCK});
      assert.equal(args.project_id,ORACLE_PROJECT_ID);
      const value={get_project:project,get_version:version,get_project_pricing:null}[method];
      if(value===undefined)throw Error('unexpected view');return {block_hash:o.mixedView?OTHER:BLOCK,result:[...Buffer.from(JSON.stringify(value))]};},
  };
  return {owner,vault,provider,now:()=>NOW,calls};
}

test('V14 public preflight calculates an explicit unapproved storage estimate and leaves all authority off',async()=>{
  const f=fixture(),r=await inspectV14Readiness(f);
  assert.deepEqual(r.blockers,[]);assert.equal(r.status,'READ_ONLY_CHECKS_PASSED_NOT_AUTHORIZED');
  assert.equal(r.candidate_presence,'ABSENT_AT_FINAL_BLOCK');assert.deepEqual(r.artifact,V14_TESTNET_ARTIFACT);
  assert.equal(r.estimated_vault_storage_funding_yocto,((BigInt(V14_TESTNET_ARTIFACT.bytes)+50_000n)*10n**19n+ONE/10n).toString());
  assert.equal(r.illustrative_mission_max_yocto,(3n*10n**21n).toString());
  assert.equal(r.bootstrap_budget.status,'SNAPSHOT_ESTIMATE_NOT_AUTHORIZED');
  assert.equal(r.bootstrap_budget.create.deposit_yocto,String(6n*ONE));
  assert.equal(r.bootstrap_budget.create.gas_upfront_estimate_yocto,'7607442456250000000000');
  assert.equal(r.bootstrap_budget.account_creation_charge_yocto,'7000000000000000000000');
  assert.equal(r.bootstrap_budget.deployment.initializer_prepaid_gas,'30000000000000');
  assert.equal(r.bootstrap_budget.funding_covers_estimated_storage_and_deploy_upfront,true);
  assert.equal(r.bootstrap_budget.funding_is_approved,false);
  for(const key of ['wallet_control_proven','wallet_approval_obtained','transaction_sent','provider_execution_requested',
    'independent_original_backup_verified','vault_deployed_by_this_check'])assert.equal(r[key],false);
  assert(f.calls.every(x=>['status','block','query','presence','protocol','gas','view'].includes(x)));
});

test('existing, unconfirmed, low-funding, changed policy and incompatible public views remain blockers',async()=>{
  for(const [opts,key] of [[{exists:true},'candidate_vault_absent_at_block'],[{unknown:true},'candidate_vault_absent_at_block'],
    [{lowNear:true},'available_covers_example_storage_and_cap_before_gas'],[{ownerCode:true},'owner_has_plain_account_profile'],
    [{restricted:true},'owner_has_a_full_access_key'],[{featureOff:true},'selected_protocol_features'],[{changedProject:true},'pinned_oracle_registry']]) {
    const r=await inspectV14Readiness(fixture(opts));assert.equal(r.checks[key],false);assert(r.blockers.includes(key));
    if(opts.unknown)assert.equal(r.candidate_presence,'UNKNOWN');
  }
});

test('unavailable temporary-key estimate does not change the separate research-loader readiness',async()=>{
  const r=await inspectV14Readiness(fixture({noFees:true}));
  assert.equal(r.status,'READ_ONLY_CHECKS_PASSED_NOT_AUTHORIZED');
  assert.equal(r.bootstrap_budget,null);assert.equal(r.bootstrap_budget_status,'BLOCKED_OR_UNKNOWN');
  assert(r.bootstrap_budget_blockers.includes('bootstrap_gas_estimate_available'));
  assert.equal(r.transaction_sent,false);
});

test('gas estimate uses action-specific send and receipt prices without treating 30 Tgas as the whole fee',()=>{
  const protocol={chain_id:'testnet',protocol_version:90,runtime_config:{transaction_costs:fees,storage_amount_per_byte:'10000000000000000000',
    min_gas_purchase_price:'1000000000',account_creation_charge:'7000000000000000000000'}};
  const low=estimateV14BootstrapBudget({protocol,gasPrice:'100000000',owner});
  assert.equal(low.receipt_purchase_price_yocto_per_gas,'1000000000');
  const expectedSend=108059500000n+184765750000n+499063n*6812999n+200000000000n+
    BigInt(Buffer.byteLength('new')+Buffer.byteLength(JSON.stringify({owner})))*2235934n+94946625000n;
  const expectedExec=108059500000n+184765750000n+499063n*64572944n+780000000000n+
    BigInt(Buffer.byteLength('new')+Buffer.byteLength(JSON.stringify({owner})))*2235934n+94946625000n;
  assert.equal(low.deployment.send_gas,String(expectedSend));assert.equal(low.deployment.receipt_execution_gas,String(expectedExec));
  assert.equal(low.deployment.gas_upfront_estimate_yocto,String(expectedSend*100000000n+(expectedExec+30n*10n**12n)*1000000000n));
  assert(BigInt(low.deployment.gas_upfront_estimate_yocto)>30n*10n**12n*1000000000n);
  const high=estimateV14BootstrapBudget({protocol,gasPrice:'2000000000',owner});
  assert.equal(high.receipt_purchase_price_yocto_per_gas,'2000000000');
  assert.equal(high.transaction_authorized,false);assert.equal(high.transaction_sent,false);
  assert.throws(()=>estimateV14BootstrapBudget({protocol:{...protocol,protocol_version:84},gasPrice:'100000000',owner}));
  assert.throws(()=>estimateV14BootstrapBudget({protocol,gasPrice:'100000000',owner,fundingYocto:String(11n*ONE)}));
  const broken=structuredClone(protocol);delete broken.runtime_config.transaction_costs.action_creation_config.deploy_contract_cost_per_byte;
  assert.throws(()=>estimateV14BootstrapBudget({protocol:broken,gasPrice:'100000000',owner}));
});

test('stale, mixed-block, wrong-network and unrelated or retired owners fail closed',async()=>{
  for(const opts of [{mainnet:true},{stale:true},{mixed:true},{mixedView:true},{badPresence:true}])await assert.rejects(inspectV14Readiness(fixture(opts)));
  const unrelated=fixture();unrelated.vault='deep.native.buyer.testnet';await assert.rejects(inspectV14Readiness(unrelated));
  const retired=fixture();retired.owner='bouncer-owner-12f343b795633e357ae5560d.testnet';retired.vault=`native.${retired.owner}`;
  await assert.rejects(inspectV14Readiness(retired));
});
