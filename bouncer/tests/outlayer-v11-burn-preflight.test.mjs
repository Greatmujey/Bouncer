import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan,buildOutlayerBurnStage} from '../agent/outlayer-v11-burn-plan.mjs';
import {inspectOutlayerBurnStage} from '../agent/outlayer-v11-burn-preflight.mjs';
import {ReadOnlyNearRpcProvider} from '../agent/read-only-near-rpc.mjs';
import {CIRCLE_TESTNET_USDC as CIRCLE} from '../scripts/circle-testnet-setup.mjs';

const owner=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url)));
const snapshot=JSON.parse(fs.readFileSync(new URL('../evidence/testnet-owner-v2/outlayer-readonly-20261102.json',import.meta.url)));
const publicKey=()=>String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const existing=publicKey(),funding=publicKey(),projectKey=publicKey();
const plan=createOutlayerBurnPlan({ownerPlan:owner,existingResourcePublicKey:existing,fundingPublicKey:funding,projectPublicKey:projectKey});
const F='usdc.fakes.testnet',W='wrap.testnet',O='outlayer.testnet',R='ref-finance-101.testnet';
const P='connectors.outlayer.testnet/connector-probe',h='11111111111111111111111111111111',now=Date.parse('2026-11-02T21:51:42Z');
const reg={total:'1250000000000000000000',available:'0'},allowance='100000000000000000000000';
const perm=(methods,gasAllowance=allowance)=>({FunctionCall:{receiver_id:plan.vault,method_names:methods,allowance:gasAllowance}});
const row=(public_key,permission,nonce=10)=>({public_key,access_key:{nonce,permission}});
const stored=name=>structuredClone(snapshot.observations[name].value);
const route=JSON.parse(Buffer.from(buildOutlayerBurnStage({ownerPlan:owner,plan,stage:'run-project'}).actions[0].functionCall.args).toString()).expected_route;
const policy=(token,per_tx_cap)=>({token,per_tx_cap,daily_cap:per_tx_cap});
function fixture(stage='register-fake'){
 const stages=['register-fake','wrap','swap-fake','fund-vault','configure','install-keys','fund-provider','run-project'];
 const n=stages.indexOf(stage),configured=n>=5,installed=n>=6,received=n>=4,providerPaid=n>=7;
 const state={chain:'testnet',blockHash:h,ownerNonce:10,ownerAmount:'4000000000000000000000000',vaultAmount:'6000000000000000000000000',vaultStorage:500000,
  fakeCode:'E1E1CJYxT5FjzVSF55QoEWzv6dbqTe2yB6Hpmjks7JJ7',providerCode:'5waWVnt6g3FZfjR6vfYXZzpAi3sZdFy8cK2sLz4EJQDt',
  providerKeyCount:1,fakeKeyCount:1,circleActual:'6006907',circleTracked:'6006907',ownerReg:n>=1?reg:null,vaultReg:n>=1?reg:null,
  ownerFake:n>=3?'21645':'0',vaultFake:received&&!providerPaid?'10000':'0',tracked:received&&!providerPaid?'10000':'0',native:configured?'20000000000000000000000':'0',
  credit:providerPaid?'10000':'0',providerCredit:providerPaid?'10000':'0',wrapBalance:n===2?'100000000000000':'0',
  fundPolicy:configured?policy(F,'10000'):null,usdPolicy:configured?policy(F,'10000'):null,nativePolicy:configured?policy('native','20000000000000000000000'):null,
  fundRoute:configured?{token:F,msg:'{"action":"deposit_balance"}',policy_revision:1,route_revision:1,active:true}:null,
  projectRoute:configured?route:null,fundGrant:configured,usdGrant:configured,nativeGrant:configured,fundLock:false,usdLock:false,pairLock:false,
  fundSpent:providerPaid?'10000':'0',usdSpent:'0',nativeSpent:'0',fundVerdict:[true,'ok'],nativeVerdict:[true,'ok'],
  version:stored('project_version'),pricing:stored('pricing'),quote:'21645',
  keys:[row(plan.owner_public_key,'FullAccess'),row(existing,perm(['execute','execute_ft_call']))],
  cost:'10000000000000000000',gasPrice:'1000000000',blockOffsetMs:0,mixedBlock:false,unavailable:null};
 if(installed)state.keys.push(row(funding,perm(['execute_ft_call'],'500000000000000000000000')),row(projectKey,perm(['execute_outlayer_project'],'500000000000000000000000')));
 const account=(id)=>({block_hash:state.mixedBlock?'22222222222222222222222222222222':h,
   code_hash:id===plan.vault?plan.vault_code_hash:id===F?state.fakeCode:id===O?state.providerCode:id===W?'DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa':'11111111111111111111111111111111',
   amount:id===plan.vault?state.vaultAmount:state.ownerAmount,storage_usage:id===plan.vault?state.vaultStorage:100});
 const provider={
  async viewNodeStatus(){return {chain_id:state.chain}},
  async viewBlock(){return {header:{hash:state.blockHash,timestamp_nanosec:String(BigInt(now+state.blockOffsetMs)*1000000n)}}},
  async experimental_protocolConfig(){return {chain_id:state.chain,runtime_config:{storage_amount_per_byte:state.cost}}},
  async gasPrice(block){assert.equal(block,h);return {gas_price:state.gasPrice}},
  async query(q){assert.equal(q.block_id,h);if(q.request_type==='view_account')return account(q.account_id);
   if(q.request_type==='view_access_key_list')return {block_hash:h,keys:q.account_id===plan.vault?[]:q.account_id===plan.owner?state.keys:
      Array.from({length:q.account_id===O?state.providerKeyCount:state.fakeKeyCount},()=>row(publicKey(),'FullAccess'))};throw Error('unexpected query')},
  async callFunctionRaw(id,method,args,options){assert.equal(options.blockId,h);if(state.unavailable===method)throw Error('unavailable');let v;
   if(id===plan.vault){
    if(method==='get_owner')v=plan.owner;
    else if(method==='vault_balance')v=args.token===CIRCLE?state.circleTracked:args.token==='native'?state.native:state.tracked;
    else if(method==='outlayer_prepaid_balance')v=state.credit;
    else if(method==='get_policy')v=args.policy_id==='circle-resources'?{token:CIRCLE,per_tx_cap:'3000',daily_cap:'6907'}:args.policy_id==='ol-funding'?state.fundPolicy:args.policy_id==='ol-project-usd'?state.usdPolicy:state.nativePolicy;
    else if(method==='get_ft_call_route')v=state.fundRoute;
    else if(method==='get_outlayer_project')v=state.projectRoute;
    else if(method==='is_agent_key_allowed')v=args.policy_id==='circle-resources'?true:args.policy_id==='ol-funding'?state.fundGrant:args.policy_id==='ol-project-usd'?state.usdGrant:state.nativeGrant;
    else if(method==='is_exact_ft_policy_locked')v=args.policy_id==='ol-funding'?state.fundLock:state.usdLock;
    else if(method==='is_exact_ft_payee_locked')v=state.pairLock;
    else if(method==='daily_spent')v=args.policy_id==='circle-resources'?'0':args.policy_id==='ol-funding'?state.fundSpent:args.policy_id==='ol-project-usd'?state.usdSpent:state.nativeSpent;
    else if(method==='check')v=args.policy_id==='ol-funding'?state.fundVerdict:state.nativeVerdict;
   }else if(id===CIRCLE&&method==='ft_balance_of')v=state.circleActual;
   else if(id===F){if(method==='ft_metadata')v=stored('fake_token_metadata');else if(method==='storage_balance_bounds')v=stored('fake_storage_bounds');
    else if(method==='storage_balance_of')v=args.account_id===plan.owner?state.ownerReg:args.account_id===plan.vault?state.vaultReg:reg;
    else if(method==='ft_balance_of')v=args.account_id===plan.owner?state.ownerFake:state.vaultFake;
   }else if(id===W){if(method==='ft_metadata')v={symbol:'wNEAR',decimals:24};else if(method==='storage_balance_of')v=reg;else if(method==='ft_balance_of')v=state.wrapBalance;
   }else if(id===O){if(method==='get_payment_token_contract')v=F;else if(method==='get_user_stablecoin_balance')v=state.providerCredit;
    else if(method==='get_project')v=stored('project');else if(method==='get_version')v=state.version;
    else if(method==='get_project_pricing')v={author_account_id:state.pricing.author_account_id,operations:[state.pricing.operation]};
    else if(method==='estimate_execution_cost')v=stored('native_estimate');
   }else if(id===R){if(method==='get_pool')v=stored('pool');else if(method==='get_return')v=state.quote}
   if(v===undefined)throw Error(`unexpected ${id}.${method}`);return {block_hash:state.mixedBlock?'22222222222222222222222222222222':h,result:[...Buffer.from(JSON.stringify(v))]};
  },
 };
 return {state,provider};
}
async function inspect(stage,f=fixture(stage)){return inspectOutlayerBurnStage({ownerPlan:owner,plan,stage,provider:f.provider,now:()=>now})}

test('all eight proposed transitions admit only their exactly expected same-block state',async()=>{
 for(const stage of ['register-fake','wrap','swap-fake','fund-vault','configure','install-keys','fund-provider','run-project']){
  const result=await inspect(stage);assert.equal(result.eligible,true,`${stage}: ${result.blockers}`);assert.equal(result.signed,false);assert.equal(result.sent,false);
  assert.equal(result.seller_contacted,false);assert.equal(result.independent_fulfillment_verified,false);assert.equal(result.block_hash,h);
 }
});
test('stage order, extra full access keys, wrong restricted methods and changed balances fail closed',async()=>{
 for(const stage of ['wrap','swap-fake','fund-vault','configure','install-keys','fund-provider','run-project']){
  assert.equal((await inspect(stage,fixture('register-fake'))).eligible,false,stage);
 }
 const f=fixture('fund-provider');f.state.keys.push(row(publicKey(),'FullAccess'));
 assert.ok((await inspect('fund-provider',f)).blockers.includes('known_owner_keys'));
 const g=fixture('fund-provider');g.state.keys[2].access_key.permission.FunctionCall.method_names.push('execute');
 assert.ok((await inspect('fund-provider',g)).blockers.includes('dedicated_keys'));
 const low=fixture('fund-provider');low.state.keys[2].access_key.permission.FunctionCall.allowance='100000000000000000000000';
 assert.ok((await inspect('fund-provider',low)).blockers.includes('dedicated_keys'));
 const spentKey=fixture('run-project');spentKey.state.keys[2].access_key.permission.FunctionCall.allowance='200000000000000000000000';
 assert.equal((await inspect('run-project',spentKey)).eligible,true,'funding key may have spent gas after its one use');
 const c=fixture();c.state.circleTracked='6006906';assert.ok((await inspect('register-fake',c)).blockers.includes('circle_balance_and_policy_unchanged'));
 const stale=fixture();stale.state.circleActual='6907';stale.state.circleTracked='6907';
 assert.ok((await inspect('register-fake',stale)).blockers.includes('circle_balance_and_policy_unchanged'));
 const l=fixture('run-project');l.state.pairLock=true;assert.ok((await inspect('run-project',l)).blockers.includes('exact_ft_locks_clear'));
 const d=fixture('fund-provider');d.state.fundSpent='1';assert.ok((await inspect('fund-provider',d)).blockers.includes('rolling_spend'));
 const v=fixture('fund-provider');v.state.fundVerdict=[false,'payee not allowed'];assert.ok((await inspect('fund-provider',v)).blockers.includes('funding_payee_and_policy_verdict'));
 const n=fixture('run-project');n.state.nativeVerdict=[false,'insufficient'];assert.ok((await inspect('run-project',n)).blockers.includes('native_payee_and_policy_verdict'));
});
test('mismatched contract versions, changed price, quota and insufficient reserves fail closed',async()=>{
 const f=fixture();f.state.providerCode='11111111111111111111111111111111';assert.ok((await inspect('register-fake',f)).blockers.includes('provider_token_code'));
 const v=fixture();v.state.version.wasm_hash='0'.repeat(64);assert.ok((await inspect('register-fake',v)).blockers.includes('provider_terms'));
 const p=fixture();p.state.pricing.operation.price_usd='10001';assert.ok((await inspect('register-fake',p)).blockers.includes('provider_terms'));
 const q=fixture();q.state.quote='14999';assert.ok((await inspect('register-fake',q)).blockers.includes('bounded_ref_quote'));
 const gas=fixture();gas.state.gasPrice='1500000000';assert.ok((await inspect('register-fake',gas)).blockers.includes('bounded_agent_gas'));
 const r=fixture();r.state.vaultAmount='5000000000000000000000000';assert.ok((await inspect('register-fake',r)).blockers.includes('keyless_vault_reserve'));
});
test('read-only transport accepts only a block-pinned gas price query and still denies sends',async()=>{
 let calls=0;
 const provider=new ReadOnlyNearRpcProvider('http://127.0.0.1:9999',{fetchImpl:async(_url,request)=>{
  calls++;const body=JSON.parse(request.body);assert.equal(body.method,'gas_price');assert.deepEqual(body.params,[h]);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{gas_price:'1000000000'}}),{status:200});
 }});
 assert.equal((await provider.gasPrice(h)).gas_price,'1000000000');
 await assert.rejects(provider.gasPrice(null),/read-only RPC method denied/);
 await assert.rejects(provider.sendJsonRpc('gas_price',[h,h]),/read-only RPC method denied/);
 await assert.rejects(provider.sendJsonRpc('send_tx',{}),/read-only RPC method denied/);assert.equal(calls,1);
});
test('network, mixed block, stale block and unknown view never authorize',async()=>{
 const n=fixture();n.state.chain='mainnet';await assert.rejects(inspect('register-fake',n),/testnet/);
 const m=fixture();m.state.mixedBlock=true;await assert.rejects(inspect('register-fake',m));
 const s=fixture();s.state.blockOffsetMs=-121000;await assert.rejects(inspect('register-fake',s),/stale/);
 const u=fixture();u.state.unavailable='get_policy';await assert.rejects(inspect('register-fake',u),/view unavailable/);
});
