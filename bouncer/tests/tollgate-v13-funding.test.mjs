import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import {inspectTollgateV13Funding,V13_FUNDING_YOCTO,OWNER_FEE_RESERVE_YOCTO} from '../agent/tollgate-v13-funding.mjs';
import {V12_NEAR_CODE_HASH} from '../agent/keyless-vault-v12.mjs';
import {CIRCLE_TESTNET_CODE_HASH} from '../agent/keyless-vault-v12-readiness.mjs';
import {CIRCLE_TESTNET_USDC} from '../scripts/circle-testnet-setup.mjs';
const h='1'.repeat(32),other='2'.repeat(32),now=Date.now(),NEAR=10n**24n;
const pub=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const plan={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',public_key:pub};
const v12=`vault.${plan.account_id}`,v13=`data.${plan.account_id}`;
function fixture(){
 const s={chain:'testnet',mixed:false,ownerCode:'11111111111111111111111111111111',ownerAmount:String(396n*NEAR/100n),ownerStorage:182,
  ownerKeys:[{public_key:pub,access_key:{permission:'FullAccess'}}],v12Code:V12_NEAR_CODE_HASH,v12Keys:[],v12Amount:String(6n*NEAR),
  v12Storage:537_100,trackedNative:'0',v12Owner:plan.account_id,circleCode:CIRCLE_TESTNET_CODE_HASH,circleTracked:'6898',circleActual:'6898',
  childExists:false,storageCost:'10000000000000000000',rpcSends:0};
 const response=x=>({block_hash:h,result:[...Buffer.from(JSON.stringify(x))]});
 const provider={async viewNodeStatus(){return{chain_id:s.chain}},async viewBlock(){return{header:{hash:h,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}},
  async viewTestnetAccountPresenceAt(id,b){assert.equal(id,v13);assert.equal(b,h);return{block_hash:h,exists:s.childExists}},
  async experimental_protocolConfig(ref){assert.equal(ref.blockId,h);return{chain_id:s.chain,runtime_config:{storage_amount_per_byte:s.storageCost}}},
  async query(q){assert.equal(q.block_id,h);const bh=s.mixed?other:h;
   if(q.request_type==='view_access_key_list')return{block_hash:bh,keys:q.account_id===plan.account_id?s.ownerKeys:s.v12Keys};
   if(q.request_type==='view_account'){
    if(q.account_id===plan.account_id)return{block_hash:bh,code_hash:s.ownerCode,amount:s.ownerAmount,locked:'0',storage_usage:s.ownerStorage};
    if(q.account_id===v12)return{block_hash:bh,code_hash:s.v12Code,amount:s.v12Amount,storage_usage:s.v12Storage};
    if(q.account_id===CIRCLE_TESTNET_USDC)return{block_hash:bh,code_hash:s.circleCode};
   }throw Error('unexpected query')},
  async callFunctionRaw(id,method,args,ref){assert.equal(ref.blockId,h);
   if(method==='get_owner')return response(s.v12Owner);
   if(method==='vault_balance')return response(args.token==='native'?s.trackedNative:s.circleTracked);
   if(method==='ft_balance_of')return response(s.circleActual);throw Error('unexpected view')},
  async sendTransactionOnce(){s.rpcSends++;throw Error('never sign or send')}};
 return{s,provider};
}
test('one-block estimate distinguishes owner liquid, upper-bound surplus and fixed planning shortfalls',async()=>{
 const f=fixture(),r=await inspectTollgateV13Funding({ownerPlan:plan,provider:f.provider,now:()=>now});
 assert.equal(r.proposed_v13,v13);assert.equal(r.proposed_child_absent_at_view,true);assert.equal(r.v12_circle_actual_atoms,'6898');
 assert.equal(r.planning_fund_covers_minimum,true);assert.equal(r.owner_transaction_authorized,false);assert.equal(r.private_key_checked,false);
 const liquid=396n*NEAR/100n-182n*10n**19n,surplus=6n*NEAR-537100n*10n**19n-5n*NEAR/100n;
 assert.equal(r.owner_liquid_estimate_yocto,liquid.toString());assert.equal(r.v12_surplus_upper_bound_yocto,surplus.toString());
 assert.equal(r.owner_liquid_shortfall_yocto,(BigInt(V13_FUNDING_YOCTO)+BigInt(OWNER_FEE_RESERVE_YOCTO)-liquid).toString());
 assert.equal(r.shortfall_even_if_full_v12_surplus_recovered_yocto,(BigInt(V13_FUNDING_YOCTO)+BigInt(OWNER_FEE_RESERVE_YOCTO)-liquid-surplus).toString());
 assert.equal(f.s.rpcSends,0);
});
test('an existing proposed child is reported, not treated as absent or usable',async()=>{
 const f=fixture();f.s.childExists=true;const r=await inspectTollgateV13Funding({ownerPlan:plan,provider:f.provider,now:()=>now});
 assert.equal(r.proposed_child_absent_at_view,false);assert.equal(r.owner_transaction_authorized,false);
});
test('unknown, altered or mixed chain state fails closed without sending',async()=>{
 const mutations=[s=>s.chain='mainnet',s=>s.mixed=true,s=>s.ownerCode=other,s=>s.ownerKeys=[],s=>s.v12Code=other,
  s=>s.v12Keys=[{}],s=>s.v12Owner='attacker.testnet',s=>s.circleCode=other,s=>s.circleActual='6899',
  s=>s.ownerAmount='bad',s=>s.v12Storage=-1,s=>s.storageCost='0',s=>s.childExists=null];
 for(const mutate of mutations){const f=fixture();mutate(f.s);await assert.rejects(inspectTollgateV13Funding({ownerPlan:plan,provider:f.provider,now:()=>now}));assert.equal(f.s.rpcSends,0)}
});
test('reported V12 surplus is never negative or treated as a funded transfer',async()=>{
 const f=fixture();f.s.trackedNative=String(9n*NEAR);
 const r=await inspectTollgateV13Funding({ownerPlan:plan,provider:f.provider,now:()=>now});
 assert.equal(r.v12_surplus_upper_bound_yocto,'0');assert.equal(r.shortfall_even_if_full_v12_surplus_recovered_yocto,r.owner_liquid_shortfall_yocto);
 assert.equal(r.sent,false);
});
