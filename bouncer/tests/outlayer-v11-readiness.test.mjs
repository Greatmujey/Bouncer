import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectOutlayerV11Readiness, OUTLAYER_TESTNET, OUTLAYER_FAKE_USD, OUTLAYER_PROBE } from '../agent/outlayer-v11-readiness.mjs';
import { V11_NEAR_CODE_HASH } from '../agent/keyless-vault-bootstrap.mjs';
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',
  public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey())};
const vault=`vault.${owner.account_id}`, hash='1'.repeat(32), now=Date.now(), active='a'.repeat(64);
function fixture(){
 const s={chain:'testnet',code:V11_NEAR_CODE_HASH,vaultKeys:[],mixed:false,unavailable:'',sends:0};
 const provider={
  async viewNodeStatus(){return {chain_id:s.chain}},
  async viewBlock(){return {header:{hash,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}},
  async query(q){assert.equal(q.block_id,hash);
   if(q.request_type==='view_account')return {block_hash:s.mixed?'2'.repeat(32):hash,code_hash:q.account_id===vault?s.code:hash};
   if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:q.account_id===vault?s.vaultKeys:[]};
   throw Error('unexpected query');
  },
  async callFunctionRaw(id,method,args,ref){assert.equal(ref.blockId,hash);if(method===s.unavailable)throw Error('unavailable');
   let value;
   switch(method){
    case 'get_owner':value=owner.account_id;break;
    case 'get_payment_token_contract':value=OUTLAYER_FAKE_USD;break;
    case 'ft_metadata':value={name:'Bridged USD',symbol:'USDC.e',decimals:6};break;
    case 'storage_balance_bounds':value={min:'1000',max:null};break;
    case 'storage_balance_of':value=null;break;
    case 'ft_balance_of':case 'vault_balance':case 'outlayer_prepaid_balance':case 'get_user_stablecoin_balance':value='0';break;
    case 'get_project':value={project_id:OUTLAYER_PROBE,active_version:active};break;
    case 'get_project_pricing':value={author_account_id:'author.testnet',operations:[{operation:'burn',price_usd:'10000',developer_share_bp:3333}]};break;
    case 'get_version':value={wasm_hash:active};break;
    case 'estimate_execution_cost':value='1000000';break;
    case 'get_pool':value={token_account_ids:[OUTLAYER_FAKE_USD,'wrap.testnet']};break;
    case 'get_return':value='20000';break;
    default:throw Error('unexpected view '+method);
   }
   if(method==='get_user_stablecoin_balance')assert.equal(args.account_id,vault);
   return {block_hash:hash,result:[...Buffer.from(JSON.stringify(value))]};
  },
  async sendTransactionOnce(){s.sends++;throw Error('must never send')},
 };
 return {s,provider};
}
test('OutLayer readiness uses one FINAL block and explicitly distinguishes fake credit, balances and unknown delivery',async()=>{
 const f=fixture(), result=await inspectOutlayerV11Readiness({ownerPlan:owner,provider:f.provider,now:()=>now});
 assert.equal(result.provider_terms_recognized,true);assert.equal(result.observations.configured_token.value,OUTLAYER_FAKE_USD);
 assert.equal(result.observations.provider_vault_credit.value,'0');assert.equal(result.observations.project_version.value.wasm_hash,active);
 assert.equal(result.observations.quotes.length,3);assert.equal(result.seller_contacted,false);assert.equal(result.sent,false);
 assert.match(result.scope,/diagnostic, not a commercial service/);assert.equal(f.s.sends,0);
});
test('unavailable terms remain UNKNOWN and an incorrect vault, chain or block fails closed',async()=>{
 const f=fixture();f.s.unavailable='get_payment_token_contract';const result=await inspectOutlayerV11Readiness({ownerPlan:owner,provider:f.provider,now:()=>now});
 assert.equal(result.provider_terms_recognized,false);assert.equal(result.observations.configured_token.status,'UNKNOWN');
 for(const [field,value] of [['chain','mainnet'],['code',hash],['vaultKeys',[{}]],['mixed',true]]){
  const x=fixture();x.s[field]=value;await assert.rejects(inspectOutlayerV11Readiness({ownerPlan:owner,provider:x.provider,now:()=>now}));assert.equal(x.s.sends,0);
 }
 await assert.rejects(inspectOutlayerV11Readiness({ownerPlan:owner,provider:fixture().provider,now:()=>now+180000}),/stale/);
});
