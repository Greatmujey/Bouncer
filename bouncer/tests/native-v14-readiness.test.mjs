// Synthetic RPC views only. No wallet, signer, provider job or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectV14Readiness } from '../agent/native-v14-readiness.mjs';
import { V14_TESTNET_ARTIFACT } from '../shared/v14-testnet-artifact.mjs';
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

test('stale, mixed-block, wrong-network and unrelated or retired owners fail closed',async()=>{
  for(const opts of [{mainnet:true},{stale:true},{mixed:true},{mixedView:true},{badPresence:true}])await assert.rejects(inspectV14Readiness(fixture(opts)));
  const unrelated=fixture();unrelated.vault='deep.native.buyer.testnet';await assert.rejects(inspectV14Readiness(unrelated));
  const retired=fixture();retired.owner='bouncer-owner-12f343b795633e357ae5560d.testnet';retired.vault=`native.${retired.owner}`;
  await assert.rejects(inspectV14Readiness(retired));
});
