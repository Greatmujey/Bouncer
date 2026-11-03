import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { inspectTollgateOffer,inspectTollgateV12Readiness,TOLLGATE_RESOURCE,TOLLGATE_CONTRACT,TOLLGATE_SELLER } from '../agent/tollgate-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from '../agent/keyless-vault-v12.mjs';
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey())};
const vault=`vault.${owner.account_id}`,hash='1'.repeat(32),now=Date.now();
function offerFixture(){
 const a={scheme:'near-channel',network:'near-testnet',maxAmountRequired:'1000000000000000000000',asset:'NEAR',payTo:TOLLGATE_SELLER,
  resource:TOLLGATE_RESOURCE,description:'Recent earthquakes',mimeType:'application/json',maxTimeoutSeconds:60,extra:{contract:TOLLGATE_CONTRACT,
   price:'1000000000000000000000',priceNear:'0.001',voucher:'tollgate:v1:{contract}:{channel_id}:{cumulative_yocto}:{nonce}',
   signature:'ed25519 over the UTF-8 voucher string, base64, made with the channel key',header:'X-PAYMENT',
   headerFormat:'base64(JSON {scheme, network, payload:{contract, channel_id, cumulative, nonce, signature}})',minDisputeWindowSec:15,minRemainingSec:120,
   openChannel:{contract:TOLLGATE_CONTRACT,method:'open_channel',args:{seller:TOLLGATE_SELLER,agent_pubkey:'ed25519:<channel public key>',expires_in_sec:'86400',dispute_window_sec:'15'}}}};
 const s={body:{x402Version:1,error:'payment required',accepts:[a]},status:402,redirected:false,type:'application/json; charset=utf-8',length:null,calls:0};
 const fetchImpl=async(url,options)=>{s.calls++;assert.equal(url,TOLLGATE_RESOURCE);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  assert.deepEqual(options.headers,{accept:'application/json'});assert.ok(options.signal instanceof AbortSignal);
  const headers={'content-type':s.type,'x-tollgate-scheme':'near-channel','x-tollgate-network':'near-testnet','x-tollgate-contract':TOLLGATE_CONTRACT,
   'x-tollgate-seller':TOLLGATE_SELLER,'x-tollgate-price':'1000000000000000000000',...(s.length===null?{}:{'content-length':s.length})};
  const r=new Response(typeof s.body==='string'?s.body:JSON.stringify(s.body),{status:s.status,headers});
  return s.redirected?{status:r.status,headers:r.headers,body:r.body,redirected:true}:r;
 };return {s,fetchImpl};
}
function chainFixture(){
 const s={chain:'testnet',code:V12_NEAR_CODE_HASH,version:'bouncer-agent-v12-exact-ft-testnet',vaultKeys:[],mixed:false,sends:0,
  config:{voucher_domain:'tollgate:v1',min_dispute_window_sec:'15',max_expiry_sec:'2592000',min_channel_deposit:'10000000000000000000000'}};
 const provider={async viewNodeStatus(){return {chain_id:s.chain}},async viewBlock(){return {header:{hash,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}},
  async query(q){assert.equal(q.block_id,hash);if(q.request_type==='view_account')return {block_hash:s.mixed?'2'.repeat(32):hash,code_hash:q.account_id===vault?s.code:hash};
   if(q.request_type==='view_access_key_list')return {block_hash:hash,keys:q.account_id===vault?s.vaultKeys:[]};throw Error('unexpected query')},
  async callFunctionRaw(id,method,args,ref){assert.equal(ref.blockId,hash);let value;
   if(method==='get_owner')value=owner.account_id;else if(method==='contract_version')value=s.version;else if(method==='get_config')value=s.config;else throw Error('unexpected view');
   return {block_hash:hash,result:[...Buffer.from(JSON.stringify(value))]};},
  async sendTransactionOnce(){s.sends++;throw Error('must never send')}};
 return {s,provider};
}
test('pinned public offer is discovery only; no voucher, channel, payment or fulfillment',async()=>{
 const h=offerFixture(),c=chainFixture(),out=await inspectTollgateV12Readiness({ownerPlan:owner,provider:c.provider,fetchImpl:h.fetchImpl,now:()=>now});
 assert.equal(out.offer.offer_recognized,true);assert.equal(out.offer.exact_resource_match,true);assert.equal(out.channel.config_recognized,true);
 assert.equal(out.v12_channel_open_supported,false);assert.equal(out.transaction_authorized,false);assert.equal(out.fulfillment_verified,false);
 assert.ok(out.blockers.includes('VOUCHER_DOES_NOT_BIND_HTTP_RESOURCE'));assert.ok(out.blockers.includes('NATIVE_NEAR_NOT_CIRCLE_USDC'));
 assert.equal(h.s.calls,1);assert.equal(c.s.sends,0);
});
test('advertised resource mismatch and unrecognized terms fail closed without payment',async()=>{
 const h=offerFixture(),c=chainFixture();h.s.body.accepts[0].resource='https://near-tollgate.vercel.app/v1/quakes';
 let r=await inspectTollgateV12Readiness({ownerPlan:owner,provider:c.provider,fetchImpl:h.fetchImpl,now:()=>now});
 assert.equal(r.offer.exact_resource_match,false);assert.ok(r.blockers.includes('OFFER_RESOURCE_DIFFERS_FROM_REQUEST'));assert.equal(r.transaction_authorized,false);
 const h2=offerFixture();h2.s.body.accepts[0].payTo='attacker.testnet';r=await inspectTollgateOffer({fetchImpl:h2.fetchImpl});assert.equal(r.offer_recognized,false);assert.equal(r.payment_sent,false);
 const h3=offerFixture();h3.s.body.accepts[0].extra.openChannel.args.dispute_window_sec='1';r=await inspectTollgateOffer({fetchImpl:h3.fetchImpl});assert.equal(r.offer_recognized,false);
 const h4=offerFixture();h4.s.body.accepts.push(h4.s.body.accepts[0]);r=await inspectTollgateOffer({fetchImpl:h4.fetchImpl});assert.equal(r.offer_recognized,false);
});
test('refuses redirects, wrong status/type and oversized/malformed bodies',async()=>{
 for(const [key,value] of [['redirected',true],['status',200],['type','text/html'],['length','99999999'],['body','x'.repeat(20_000)],['body','{bad']]){
  const h=offerFixture();h.s[key]=value;await assert.rejects(inspectTollgateOffer({fetchImpl:h.fetchImpl}));
 }
});
test('unknown channel config stays blocked; incorrect chain, mixed snapshot, vault or stale time throws',async()=>{
 const c=chainFixture(),h=offerFixture();c.s.config.min_channel_deposit='0';
 const r=await inspectTollgateV12Readiness({ownerPlan:owner,provider:c.provider,fetchImpl:h.fetchImpl,now:()=>now});assert.equal(r.channel.config_recognized,false);assert.ok(r.blockers.includes('UNRECOGNIZED_CHANNEL_CONFIG'));
 for(const [key,value] of [['chain','mainnet'],['code',hash],['version','old'],['vaultKeys',[{}]],['mixed',true]]){
  const f=chainFixture(),g=offerFixture();f.s[key]=value;await assert.rejects(inspectTollgateV12Readiness({ownerPlan:owner,provider:f.provider,fetchImpl:g.fetchImpl,now:()=>now}));assert.equal(f.s.sends,0);
 }
 await assert.rejects(inspectTollgateV12Readiness({ownerPlan:owner,provider:chainFixture().provider,fetchImpl:offerFixture().fetchImpl,now:()=>now+180_000}),/stale/);
});
