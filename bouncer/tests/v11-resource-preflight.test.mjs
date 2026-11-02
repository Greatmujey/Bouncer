import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectV11ResourceBoundary, V11_RESOURCE_VERSION } from '../agent/v11-resource-preflight.mjs';
import { V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
const hash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,8));
const other=nearApi.utils.serialize.base_encode(Buffer.alloc(32,9));
const publicKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const now=Date.now();
function fixture(){
 const opts={chain:'testnet',code:V11_NEAR_CODE_HASH,vaultKeys:[],method:'execute_ft_call',allowance:'500000000000000000000000',gasPrice:'1000000000',lockedPolicy:false,lockedPayee:false,mixed:false};
 const provider={
  async viewNodeStatus(){return {chain_id:opts.chain}},
  async gasPrice(block){assert.equal(block,hash);return {gas_price:opts.gasPrice}},
  async viewBlock(){return {header:{hash,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}},
  async query(q){
   assert.equal(q.block_id,hash);
   if(q.request_type==='view_account')return {block_hash:opts.mixed?other:hash,code_hash:opts.code};
   if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:opts.vaultKeys};
   if(q.request_type==='view_access_key')return {block_hash:hash,permission:{FunctionCall:{receiver_id:'vault.testnet',
    method_names:[opts.method],allowance:opts.allowance}}};
   throw Error('unexpected query');
  },
  async callFunctionRaw(account,method,args,ref){
   assert.equal(ref.blockId,hash);assert.equal(account,'vault.testnet');
   let value;
   if(method==='contract_version')value=V11_RESOURCE_VERSION;
   else if(method==='get_owner')value='owner.testnet';
   else if(method==='is_exact_ft_policy_locked')value=opts.lockedPolicy;
   else if(method==='is_exact_ft_payee_locked')value=opts.lockedPayee;
   else throw Error('unexpected view');
   return {block_hash:hash,result:[...Buffer.from(JSON.stringify(value))]};
  }
 };
 const args={provider,contract:'vault.testnet',owner:'owner.testnet',publicKey,method:'execute_ft_call',policyId:'fake-funding',
  token:'usdc.fakes.testnet',payee:'outlayer.testnet',now:()=>now};
 return {opts,provider,args};
}

test('V11 resource boundary pins code, zero vault keys, scoped finite allowance and both exact-intent locks',async()=>{
 const f=fixture(), state=await inspectV11ResourceBoundary(f.args);
 assert.equal(state.block_hash,hash);assert.match(state.scope,/not an audit/);
 assert.equal(state.estimated_minimum_agent_allowance_yocto,'391000000000000000000000');
 assert.equal(await state.view('vault.testnet','is_exact_ft_policy_locked',{policy_id:'fake-funding'}),false);
 for(const [field,value] of [['code',other],['vaultKeys',[{public_key:publicKey}]],['method','set_policy'],
  ['allowance',null],['allowance','0'],['allowance','100000000000000000000000'],['gasPrice','0'],['gasPrice','invalid'],
  ['lockedPolicy',true],['lockedPayee',true],['mixed',true],['chain','mainnet']]){
  const x=fixture();x.opts[field]=value;await assert.rejects(inspectV11ResourceBoundary(x.args));
 }
});

test('V11 boundary rejects non-testnet, missing pinned views, unsupported methods and stale blocks',async()=>{
 const f=fixture();
 await assert.rejects(inspectV11ResourceBoundary({...f.args,payee:'seller.near'}));
 await assert.rejects(inspectV11ResourceBoundary({...f.args,method:'execute'}));
 await assert.rejects(inspectV11ResourceBoundary({...f.args,provider:{}}));
 await assert.rejects(inspectV11ResourceBoundary({...f.args,now:()=>now+180_000}));
});
