/** Read-only discovery of one independently operated testnet data offer.
 * It never signs a voucher, opens a channel, pays, or follows redirects. The
 * offer is native NEAR, not USDC; V12 has no Tollgate channel-opening method.
 * HTTP and the single pinned testnet RPC are trusted observations, not proof
 * of provider fulfillment, source equivalence, or an independent audit. */
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { newTestnetVaultId } from './keyless-vault-v12-readiness.mjs';
import { V12_NEAR_CODE_HASH } from './keyless-vault-v12.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

export const TOLLGATE_RESOURCE='https://near-tollgate.vercel.app/v1/quakes?min_magnitude=5';
export const TOLLGATE_CONTRACT='channels.tollgate-busel.testnet';
export const TOLLGATE_SELLER='seller.tollgate-busel.testnet';
const PUBLISHED_CODE='2ANyRzxbZF3mXMpp5EqwDUWq6DoeuyPCDnYHcRKQmQqj';
const PRICE='1000000000000000000000', MINIMUM='10000000000000000000000';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);

async function boundedBody(response,max=16_384){
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^(0|[1-9][0-9]{0,8})$/.test(declared)||Number(declared)>max))throw Error('offer body exceeds limit');
 if(!response.body?.getReader)throw Error('streaming offer body required');
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw Error('offer body exceeds limit')}chunks.push(Buffer.from(value));}
 }finally{reader.releaseLock()}
 return Buffer.concat(chunks).toString('utf8');
}
/** Fetch only the fixed public endpoint. Return observed fields, never an
 * executable quote; unexpected terms fail closed instead of being normalized. */
export async function inspectTollgateOffer({fetchImpl=fetch}={}){
 if(typeof fetchImpl!=='function')throw new Error('read-only fetch required');
 const res=await fetchImpl(TOLLGATE_RESOURCE,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{accept:'application/json'}});
 if(res.status!==402||res.redirected||!/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type')??''))throw new Error('expected a non-redirected 402 JSON offer');
 let body;try{body=JSON.parse(await boundedBody(res))}catch{throw new Error('invalid or oversized provider offer')}
 const a=Array.isArray(body?.accepts)&&body.accepts.length===1?body.accepts[0]:null, x=a?.extra, channel=x?.openChannel;
 const headers={scheme:res.headers.get('x-tollgate-scheme'),network:res.headers.get('x-tollgate-network'),
  contract:res.headers.get('x-tollgate-contract'),seller:res.headers.get('x-tollgate-seller'),price:res.headers.get('x-tollgate-price')};
 const recognized=body?.x402Version===1&&body.error==='payment required'&&object(a)&&a.scheme==='near-channel'&&a.network==='near-testnet'&&
  a.asset==='NEAR'&&a.payTo===TOLLGATE_SELLER&&a.maxAmountRequired===PRICE&&a.mimeType==='application/json'&&a.maxTimeoutSeconds===60&&
  object(x)&&x.contract===TOLLGATE_CONTRACT&&x.price===PRICE&&x.header==='X-PAYMENT'&&
  x.voucher==='tollgate:v1:{contract}:{channel_id}:{cumulative_yocto}:{nonce}'&&
  x.minDisputeWindowSec===15&&x.minRemainingSec===120&&object(channel)&&channel.contract===TOLLGATE_CONTRACT&&
  channel.method==='open_channel'&&channel.args?.seller===TOLLGATE_SELLER&&
  channel.args?.agent_pubkey==='ed25519:<channel public key>'&&channel.args?.expires_in_sec==='86400'&&channel.args?.dispute_window_sec==='15'&&
  headers.scheme==='near-channel'&&headers.network==='near-testnet'&&headers.contract===TOLLGATE_CONTRACT&&
  headers.seller===TOLLGATE_SELLER&&headers.price===PRICE;
 const resource=typeof a?.resource==='string'&&a.resource.length<=2048?a.resource:null;
 return {http_status:402,offer_recognized:recognized,asset:a?.asset??null,price_yocto:a?.maxAmountRequired??null,
  seller:a?.payTo??null,channel_contract:x?.contract??null,requested_resource:TOLLGATE_RESOURCE,
  offered_resource:resource,exact_resource_match:resource===TOLLGATE_RESOURCE,headers,contacted:true,
  payment_sent:false,voucher_signed:false,fulfillment_verified:false};
}

export async function inspectTollgateV12Readiness({ownerPlan,provider,fetchImpl=fetch,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),vault=newTestnetVaultId(owner);
 if(!provider||['viewNodeStatus','viewBlock','query','callFunctionRaw'].some(k=>typeof provider[k]!=='function')||typeof now!=='function')throw Error('read-only pinned testnet provider required');
 if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw Error('testnet RPC required');
 const start=now(),block=await provider.viewBlock({finality:'final'}),hash=assertFreshFinalBlock(block,start).hash;
 const query=(type,id)=>provider.query({request_type:type,account_id:id,block_id:hash});
 const view=(id,method)=>readPinnedJsonView(provider,hash,id,method,{});
 const [vaultAccount,vaultKeys,vaultOwner,vaultVersion,channel,channelKeys,config,offer]=await Promise.all([
  query('view_account',vault),query('view_access_key_list',vault),view(vault,'get_owner'),view(vault,'contract_version'),
  query('view_account',TOLLGATE_CONTRACT),query('view_access_key_list',TOLLGATE_CONTRACT),view(TOLLGATE_CONTRACT,'get_config'),inspectTollgateOffer({fetchImpl})
 ]);
 if(vaultAccount?.block_hash!==hash||vaultAccount.code_hash!==V12_NEAR_CODE_HASH||vaultKeys?.block_hash!==hash||
  !Array.isArray(vaultKeys.keys)||vaultKeys.keys.length!==0||vaultOwner!==owner.account_id||vaultVersion!=='bouncer-agent-v12-exact-ft-testnet')throw Error('V12 vault identity or keyless state differs');
 if(channel?.block_hash!==hash||!isTransactionHash(channel.code_hash)||channelKeys?.block_hash!==hash||!Array.isArray(channelKeys.keys)||channelKeys.keys.length>1000)throw Error('invalid channel contract view');
 const configRecognized=object(config)&&config.voucher_domain==='tollgate:v1'&&config.min_dispute_window_sec==='15'&&
  config.max_expiry_sec==='2592000'&&config.min_channel_deposit===MINIMUM;
 const end=now();if(!Number.isSafeInteger(end)||end<start)throw Error('local clock moved backwards');assertFreshFinalBlock(block,end);
 return {version:1,network:'testnet',owner:owner.account_id,vault,block_hash:hash,block_timestamp_nanosec:block.header.timestamp_nanosec,
  observed_at:new Date(end).toISOString(),offer,channel:{account_id:TOLLGATE_CONTRACT,code_hash:channel.code_hash,
   matches_published_code_hash:channel.code_hash===PUBLISHED_CODE,key_count:channelKeys.keys.length,
   full_access_keys:channelKeys.keys.filter(k=>k?.access_key?.permission==='FullAccess').length,config,config_recognized:configRecognized},
  v12_channel_open_supported:false,transaction_authorized:false,payment_sent:false,fulfillment_verified:false,
  blockers:['V12_HAS_NO_CHANNEL_OPEN_METHOD','VOUCHER_DOES_NOT_BIND_HTTP_RESOURCE','NATIVE_NEAR_NOT_CIRCLE_USDC',
   ...(!offer.exact_resource_match?['OFFER_RESOURCE_DIFFERS_FROM_REQUEST']:[]),...(!offer.offer_recognized?['UNRECOGNIZED_HTTP_OFFER']:[]),
   ...(!configRecognized?['UNRECOGNIZED_CHANNEL_CONFIG']:[])],
  scope:'unpaid public HTTP offer and one trusted-RPC FINAL snapshot only; no channel, voucher, payment, delivery or source/audit proof'};
}
