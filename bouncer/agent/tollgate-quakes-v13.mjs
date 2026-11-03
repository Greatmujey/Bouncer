/** One narrowly reviewed experimental testnet data purchase over Tollgate.
 * The vault caps the whole native-NEAR channel deposit, not each voucher.
 * The HTTP resource is NOT bound by the provider's voucher signature. The
 * post-open authorization view is advisory for a cooperative client and can
 * race a revocation; it cannot revoke an already issued voucher or stolen key.
 * An upgradeable provider and a single trusted RPC remain trust assumptions.
 * A response is a seller claim, not proof of on-chain settlement or upstream
 * provenance. Never retry an ambiguous voucher; retain the durable fence. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { TOLLGATE_CONTRACT, TOLLGATE_RESOURCE, TOLLGATE_SELLER, inspectTollgateOffer } from './tollgate-v12-readiness.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { readBoundedBytes } from '../shared/bounded-json.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

// Two matching builds from 45a6706 and an isolated local-seller lifecycle in
// run 41653914001. This is experimental testnet code, not an audit or a live
// deployment. The seller's source equivalence is a separate trust assumption.
export const V13_VOUCHER_SHA256='ed1bb4fb01313576f88c719d5c7283d2366a60c580295863a759f5f9ee699231';
export const V13_VOUCHER_CODE_HASH='Gxa8TQsZxJuU15wCCwdAU7TcrJhh3AyzQ6hiiqiRy2xx';
export const TOLLGATE_CHANNEL_CODE_HASH='2ANyRzxbZF3mXMpp5EqwDUWq6DoeuyPCDnYHcRKQmQqj';
export const CHANNEL_BUDGET_YOCTO='20000000000000000000000'; // 0.02 test NEAR, including channel storage
export const QUAKES_PRICE_YOCTO='1000000000000000000000'; // 0.001 test NEAR
const MIN_DEPOSIT='10000000000000000000000';
const REVIEW_DOMAIN='bouncer:v13:tollgate-quakes-review:v1\n';
const MAX_U64=(1n<<64n)-1n, MAX_U128=(1n<<128n)-1n;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const decimal=(v,max=MAX_U128)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(v)&&BigInt(v)<=max;
function publicKey(value){
 try{
  const k=nearApi.utils.PublicKey.from(value);
  if(typeof value!=='string'||k.keyType!==0||String(k)!==value||!value.startsWith('ed25519:'))throw Error();
  return value;
 }catch{throw Error('canonical ed25519 public key required')}
}
function expiry(value){
 if(!decimal(value,BigInt(Number.MAX_SAFE_INTEGER))||BigInt(value)<1_000_000_000_000n)throw Error('invalid review expiry');
 return value;
}
function intent(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value))throw Error('invalid one-shot intent ID');
 return value;
}

/** Exact public preimage the owner can review and hash into set_tollgate_intent.
 * The dedicated voucher key must be generated and stored privately elsewhere;
 * this function neither generates a key nor signs anything. */
export function makeTollgateQuakesReview({ownerPlan,intentId,agentPublicKey,voucherPublicKey,expiresAtMs}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),agent=publicKey(agentPublicKey),voucher=publicKey(voucherPublicKey);
 if(voucher===agent||voucher===owner.public_key)throw Error('a dedicated voucher key is required');
 const vault=`data.${owner.account_id}`;
 if(vault.length>64)throw Error('testnet vault ID too long');
 return {version:1,purpose:'v13-one-quakes-request',network:'testnet',owner:owner.account_id,
  owner_public_key:owner.public_key,vault,vault_code_hash:V13_VOUCHER_CODE_HASH,
  channel_contract:TOLLGATE_CONTRACT,channel_code_hash:TOLLGATE_CHANNEL_CODE_HASH,seller:TOLLGATE_SELLER,
  resource:TOLLGATE_RESOURCE,method:'GET',asset:'native',intent_id:intent(intentId),policy_id:'data',
  channel_budget_yocto:CHANNEL_BUDGET_YOCTO,price_yocto:QUAKES_PRICE_YOCTO,expires_at_ms:expiry(expiresAtMs),
  channel_lifetime_sec:'600',dispute_window_sec:'15',agent_public_key:agent,voucher_public_key:voucher};
}

/** Reject extra, omitted, altered or noncanonical fields before hashing. */
export function validateTollgateQuakesReview(review){
 if(!obj(review))throw Error('public review object required');
 const ownerPlan={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:review.owner,public_key:review.owner_public_key};
 const expected=makeTollgateQuakesReview({ownerPlan,intentId:review.intent_id,agentPublicKey:review.agent_public_key,
  voucherPublicKey:review.voucher_public_key,expiresAtMs:review.expires_at_ms});
 if(Object.keys(review).sort().join(',')!==Object.keys(expected).sort().join(',')||
    Object.keys(expected).some(k=>review[k]!==expected[k]))throw Error('public review differs from the fixed one-shot route');
 return expected;
}
export function tollgateQuakesReviewHash(review){
 return sha(Buffer.from(REVIEW_DOMAIN+JSON.stringify(validateTollgateQuakesReview(review)),'utf8'));
}

function assertRecent(block,now){
 const f=assertFreshFinalBlock(block,now);
 if(now-f.timestamp_ms>15_000||f.timestamp_ms-now>10_000)throw Error('purchase snapshot is not sufficiently fresh');
 return f;
}

/** Read all fields at one trusted-RPC FINAL block. No HTTP seller request,
 * signature, channel transaction or payment is made here. */
export async function inspectTollgateQuakesChannel({review:raw,provider,now=Date.now}={}){
 const review=validateTollgateQuakesReview(raw),reviewHash=tollgateQuakesReviewHash(review);
 if(!provider||['viewNodeStatus','viewBlock','query','callFunctionRaw'].some(k=>typeof provider[k]!=='function')||typeof now!=='function')throw Error('read-only pinned provider required');
 if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw Error('testnet RPC required');
 const started=now(),block=await provider.viewBlock({finality:'final'}),fresh=assertRecent(block,started),hash=fresh.hash;
 const query=(type,id)=>provider.query({request_type:type,account_id:id,block_id:hash});
 const view=(id,method,args={})=>readPinnedJsonView(provider,hash,id,method,args);
 const i=await view(review.vault,'get_tollgate_intent',{intent_id:review.intent_id});
 if(!obj(i)||!decimal(i.channel_id,MAX_U64)||BigInt(i.channel_id)>0xffffffffn)throw Error('a recorded channel ID is required');
 const [vaultAccount,vaultKeys,owner,version,authorized,policy,spent,channelAccount,channelKeys,config,ch]=await Promise.all([
  query('view_account',review.vault),query('view_access_key_list',review.vault),view(review.vault,'get_owner'),
  view(review.vault,'contract_version'),view(review.vault,'is_tollgate_voucher_authorized',{intent_id:review.intent_id}),
  view(review.vault,'get_policy',{policy_id:review.policy_id}),view(review.vault,'daily_spent',{policy_id:review.policy_id}),
  query('view_account',review.channel_contract),query('view_access_key_list',review.channel_contract),
  view(review.channel_contract,'get_config'),view(review.channel_contract,'get_channel',{channel_id:i.channel_id})
 ]);
 if(vaultAccount?.block_hash!==hash||vaultAccount.code_hash!==V13_VOUCHER_CODE_HASH||vaultKeys?.block_hash!==hash||
  !Array.isArray(vaultKeys.keys)||vaultKeys.keys.length!==0||owner!==review.owner||version!=='bouncer-agent-v13-tollgate-native-testnet')throw Error('reviewed keyless V13 vault identity differs');
 if(channelAccount?.block_hash!==hash||channelAccount.code_hash!==TOLLGATE_CHANNEL_CODE_HASH||channelKeys?.block_hash!==hash||
  !Array.isArray(channelKeys.keys)||channelKeys.keys.length>1000)throw Error('published channel code or pinned snapshot differs');
 if(!obj(config)||config.voucher_domain!=='tollgate:v1'||config.min_dispute_window_sec!=='15'||
  config.max_expiry_sec!=='2592000'||config.min_channel_deposit!==MIN_DEPOSIT)throw Error('channel configuration differs');
 if(!obj(policy)||policy.token!=='native'||policy.per_tx_cap!==CHANNEL_BUDGET_YOCTO||policy.daily_cap!==CHANNEL_BUDGET_YOCTO||
  spent!==CHANNEL_BUDGET_YOCTO)throw Error('one-channel native policy or rolling charge differs');
 if(i.intent_id!==review.intent_id||i.policy_id!==review.policy_id||i.channel_contract!==review.channel_contract||i.seller!==review.seller||
  i.amount!==review.channel_budget_yocto||i.agent_public_key!==review.agent_public_key||i.voucher_public_key!==review.voucher_public_key||
  i.review_hash!==reviewHash||i.expires_at_ms!==review.expires_at_ms||i.channel_lifetime_sec!==review.channel_lifetime_sec||
  i.dispute_window_sec!==review.dispute_window_sec||i.consumed!==true||i.cancelled!==false||i.callback_recorded!==true||
  i.promise_failed!==false||i.recovering!==false||i.channel_verified!==true||i.active!==false||authorized!==true)throw Error('owner-reviewed intent is not currently voucher-authorized');
 if(!obj(ch)||ch.channel_id!==i.channel_id||ch.owner!==review.vault||ch.seller!==review.seller||ch.agent_pubkey!==review.voucher_public_key||
  ch.status!=='Open'||ch.dispute_window_sec!==review.dispute_window_sec||!decimal(ch.deposit)||!decimal(ch.storage_fee)||
  BigInt(ch.deposit)+BigInt(ch.storage_fee)!==BigInt(review.channel_budget_yocto)||BigInt(ch.deposit)<BigInt(MIN_DEPOSIT)||
  ch.remaining!==ch.deposit||ch.settled!=='0'||ch.refunded!=='0'||ch.last_nonce!=='0'||ch.settlements!==0||
  !decimal(ch.opened_at_ns,MAX_U64)||!decimal(ch.expires_at_ns,MAX_U64)||
  BigInt(ch.expires_at_ns)-BigInt(ch.opened_at_ns)!==600n*1_000_000_000n||
  BigInt(ch.opened_at_ns)>BigInt(fresh.timestamp_ms+10_000)*1_000_000n||
  BigInt(ch.expires_at_ns)-BigInt(fresh.timestamp_ms)*1_000_000n<125n*1_000_000_000n)throw Error('channel is not an unused, funded, reviewed open channel');
 const finished=now();assertRecent(block,finished);
 if(finished<started||finished-started>30_000||BigInt(review.expires_at_ms)<=BigInt(finished+5_000))throw Error('review or snapshot expired');
 return {network:'testnet',owner:review.owner,vault:review.vault,review_hash:reviewHash,intent_id:review.intent_id,
  channel_id:i.channel_id,channel_deposit:ch.deposit,channel_storage_fee:ch.storage_fee,block_hash:hash,
  block_timestamp_ms:fresh.timestamp_ms,channel_expires_at_ns:ch.expires_at_ns,
  channel_full_access_keys:channelKeys.keys.filter(k=>k?.access_key?.permission==='FullAccess').length,
  seller_contacted:false,voucher_signed:false,payment_sent:false,
  scope:'trusted single-RPC FINAL views only; provider code may be upgraded and the cooperative-client view can race a policy change'};
}

/** Exclusive fsynced local fence. The directory must remain private AND be
 * backed up persistently across runs/machines. If it is lost, the operator
 * must stop and reconcile; recreating an empty directory is not recovery. */
export class TollgateVoucherFence{
 #dir;
 get fenceScope(){return 'LOCAL_ONLY'}
 constructor(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('absolute private fence directory required');
  this.#dir=path.resolve(directory);this.#check();
 }
 #check(){
  const s=fs.lstatSync(this.#dir);
  if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||
   (typeof process.getuid==='function'&&s.uid!==process.getuid())||fs.realpathSync(this.#dir)!==this.#dir)throw Error('private, non-symlink fence directory required');
 }
 claim(review,snapshot){
  this.#check();const r=validateTollgateQuakesReview(review),reviewHash=tollgateQuakesReviewHash(r);
  if(snapshot?.review_hash!==reviewHash||snapshot.intent_id!==r.intent_id||!decimal(snapshot.channel_id,MAX_U64)||
   !isTransactionHash(snapshot.block_hash))throw Error('matching pinned channel required for fence');
  // Key-based identity prevents a local second attempt even with a new intent.
  const name=`tollgate-voucher-${sha(Buffer.from(r.voucher_public_key,'utf8'))}.fence.json`;
  const evidence={version:1,status:'DO_NOT_RETRY_AFTER_FENCE',review_hash:reviewHash,intent_id:r.intent_id,
   vault:r.vault,channel_id:snapshot.channel_id,channel_contract:r.channel_contract,voucher_public_key:r.voucher_public_key,
   price_yocto:r.price_yocto,nonce:'1',block_hash:snapshot.block_hash,
   scope:'possible one-time voucher exposure after this fence; neither a payment nor delivery proof'};
  let fd;
  try{
   fd=fs.openSync(path.join(this.#dir,name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   fs.writeFileSync(fd,JSON.stringify(evidence)+'\n');fs.fsyncSync(fd);
  }finally{if(fd!==undefined)fs.closeSync(fd)}
  const dirFd=fs.openSync(this.#dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(dirFd)}finally{fs.closeSync(dirFd)}
  return evidence;
 }
}

function paymentAcknowledgement(header,channelId){
 try{
  if(typeof header!=='string'||header.length>4096||header.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(header))return null;
  const bytes=Buffer.from(header,'base64');if(bytes.toString('base64')!==header)return null;
  const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!obj(p)||p.success!==true||p.scheme!=='near-channel'||p.network!=='near-testnet'||p.contract!==TOLLGATE_CONTRACT||
   p.channel_id!==channelId||p.cumulative!==QUAKES_PRICE_YOCTO||p.nonce!=='1'||p.paid!==QUAKES_PRICE_YOCTO)return null;
  let claimed=null;
  if(p.settlement!==null&&p.settlement!==undefined){
   if(!obj(p.settlement)||!isTransactionHash(p.settlement.tx)||p.settlement.nonce!=='1'||
    p.settlement.cumulative!==QUAKES_PRICE_YOCTO)return null;
   claimed=p.settlement.tx;
  }
  return {seller_claimed_acceptance:true,seller_claimed_settlement_tx:claimed};
 }catch{return null}
}
function validQuakes(body,channelId,now){
 if(!obj(body)||body.source!=='USGS Earthquake Hazards Program, FDSN event API'||typeof body.source_url!=='string'||
  typeof body.fetched_at!=='string'||typeof body.cached!=='boolean'||!obj(body.query)||body.query.min_magnitude!==5||
  body.query.hours!==24||body.query.limit!==10||!Number.isInteger(body.count)||body.count<0||body.count>10||
  !Array.isArray(body.quakes)||body.quakes.length!==body.count||!obj(body.paid)||body.paid.channel_id!==channelId||
  body.paid.nonce!=='1'||body.paid.price_yocto!==QUAKES_PRICE_YOCTO)return false;
 const fetched=Date.parse(body.fetched_at);if(!Number.isFinite(fetched)||fetched>now+30_000||fetched<now-600_000)return false;
 let u;try{u=new URL(body.source_url)}catch{return false}
 if(u.protocol!=='https:'||u.hostname!=='earthquake.usgs.gov'||u.port||u.username||u.password||u.hash||
  u.pathname!=='/fdsnws/event/1/query'||u.searchParams.get('format')!=='geojson'||u.searchParams.get('orderby')!=='time'||
  u.searchParams.get('minmagnitude')!=='5'||u.searchParams.get('limit')!=='10'||
  [...u.searchParams.keys()].sort().join(',')!=='format,limit,minmagnitude,orderby,starttime')return false;
 const start=Date.parse(u.searchParams.get('starttime')??'');
 if(!Number.isFinite(start)||Math.abs((fetched-24*3_600_000)-start)>300_000)return false;
 return body.quakes.every(q=>obj(q)&&typeof q.id==='string'&&q.id.length>0&&q.id.length<=128&&
  typeof q.place==='string'&&q.place.length<=500&&typeof q.magnitude==='number'&&Number.isFinite(q.magnitude)&&
  typeof q.time==='string'&&Number.isFinite(Date.parse(q.time)));
}

/** One fixed live HTTP request after a recognized unpaid offer, a reviewed
 * FINAL snapshot and an exclusive durable local fence. No automatic retry,
 * account key, NEAR transaction, channel top-up or voucher rollback. The
 * caller must preserve the fence across environments, including lost replies. */
export async function purchaseTollgateQuakesOnce({review:raw,provider,voucherKey,fence,fetchImpl=globalThis.fetch,now=Date.now}={}){
 const review=validateTollgateQuakesReview(raw);
 if(!(fence instanceof TollgateVoucherFence)||typeof fetchImpl!=='function'||typeof now!=='function'||
  !voucherKey||typeof voucherKey.getPublicKey!=='function'||typeof voucherKey.sign!=='function'||
  String(voucherKey.getPublicKey())!==review.voucher_public_key)throw Error('matching dedicated key and durable fence required');
 const offer=await inspectTollgateOffer({fetchImpl});
 if(!offer.offer_recognized||!offer.exact_resource_match)throw Error('reviewed seller offer no longer matches');
 const snapshot=await inspectTollgateQuakesChannel({review,provider,now});
 // A reviewed external fence may require an asynchronous durable reservation.
 // It must complete before any voucher is signed; the local fence remains
 // permanent even if the remote reservation is unavailable or ambiguous.
 await fence.claim(review,snapshot);
 const beforeSend=now();
 if(!Number.isSafeInteger(beforeSend)||beforeSend<snapshot.block_timestamp_ms-10_000||
  beforeSend-snapshot.block_timestamp_ms>15_000||BigInt(review.expires_at_ms)<=BigInt(beforeSend+5_000)||
  BigInt(snapshot.channel_expires_at_ns)-BigInt(beforeSend)*1_000_000n<120n*1_000_000_000n)throw Error('fenced review became stale; do not retry');
 const message=`tollgate:v1:${review.channel_contract}:${snapshot.channel_id}:${review.price_yocto}:1`;
 const signature=Buffer.from(voucherKey.sign(Buffer.from(message,'utf8')).signature);
 if(signature.length!==64||!voucherKey.getPublicKey().verify(Buffer.from(message,'utf8'),signature))throw Error('fenced voucher signature invalid; do not retry');
 const header=Buffer.from(JSON.stringify({scheme:'near-channel',network:'near-testnet',payload:{contract:review.channel_contract,
  channel_id:snapshot.channel_id,cumulative:review.price_yocto,nonce:'1',signature:signature.toString('base64')}}),'utf8').toString('base64');
 const result={network:'testnet',owner:review.owner,vault:review.vault,review_hash:snapshot.review_hash,intent_id:review.intent_id,
  channel_id:snapshot.channel_id,price_yocto:review.price_yocto,channel_budget_yocto:review.channel_budget_yocto,
  snapshot_block_hash:snapshot.block_hash,fenced:true,fence_scope:fence.fenceScope,do_not_retry:true,settlement_verified:false,upstream_provenance_verified:false,
  voucher_resource_bound:false,asset:'native NEAR (testnet)',scope:'seller response and trusted-RPC snapshot; not an audit or settlement proof'};
 let res;
 try{
  res=await fetchImpl(TOLLGATE_RESOURCE,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15_000),
   headers:{accept:'application/json','x-payment':header}});
  const ack=paymentAcknowledgement(res?.headers?.get('x-payment-response'),snapshot.channel_id);
  const bytes=await readBoundedBytes(res,{maxBytes:256*1024,label:'provider'}),bodyHash=sha(bytes);
  let body=null;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{/* untrusted body */}
  if(res?.status===200&&!res.redirected&&/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type')??'')&&
    ack&&validQuakes(body,snapshot.channel_id,now())){
   return {...result,status:'PROVIDER_RETURNED_DATA',http_status:200,...ack,response_sha256:bodyHash,data:body};
  }
  return {...result,status:ack?'SELLER_CLAIMS_ACCEPTANCE_DELIVERY_UNCONFIRMED':'PAYMENT_AND_DELIVERY_UNKNOWN',
   http_status:Number.isInteger(res?.status)?res.status:null,seller_claimed_acceptance:!!ack,
   seller_claimed_settlement_tx:ack?.seller_claimed_settlement_tx??null,response_sha256:bodyHash};
 }catch{
  return {...result,status:'PAYMENT_AND_DELIVERY_UNKNOWN',http_status:null,seller_claimed_acceptance:false,
   seller_claimed_settlement_tx:null,response_sha256:null};
 }finally{try{await res?.body?.cancel()}catch{/* response already read */}}
}
