/**
 * Browser-only public testnet cost review for the named owner and candidate
 * vault. Every value comes from one fresh FINAL block on a fixed trusted RPC.
 * If a specific Ed25519 key is supplied, its current FullAccess permission
 * and representable nonce are checked as well as the account-wide budget.
 * This is not wallet ownership, independent original retention, an approval,
 * a transaction, or a guarantee about future balances, gas or account state.
 */
import {PublicKey} from '@near-js/crypto';
import {decodeNativeHash32} from './native-oracle-transaction.mjs';
import {estimateV14BootstrapBudget} from '../shared/v14-bootstrap-budget.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';

const RPC='https://rpc.testnet.near.org',OWNER='great_mujey.testnet',VAULT=`native.${OWNER}`;
const EMPTY_CODE='11111111111111111111111111111111',MAX=(1n<<128n)-1n;
const fail=()=>new Error('Live testnet review unavailable; no wallet transaction was requested');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>{try{decodeNativeHash32(x);return true}catch{return false}};
const uint=x=>typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<=MAX?BigInt(x):null;
const absent=(x,key)=>!Object.hasOwn(x,key)||x[key]===null;
async function bounded(response,limit){
  const len=response.headers?.get?.('content-length');if(len!==null&&len!==undefined&&(!/^\d+$/.test(len)||Number(len)>limit))throw fail();
  if(!response.body?.getReader)throw fail();
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.length)>limit){await reader.cancel();throw fail()}parts.push(value)}}
  finally{reader.releaseLock()}
  const data=new Uint8Array(size);let offset=0;for(const p of parts){data.set(p,offset);offset+=p.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
}
function fresh(block,clock){
  const h=block?.header,n=h?.timestamp_nanosec;
  if(!hash(h?.hash)||!Number.isSafeInteger(h.height)||h.height<1||typeof n!=='string'||!/^[1-9][0-9]{0,19}$/.test(n)||
      !Number.isSafeInteger(clock)||clock<1)throw fail();
  const t=BigInt(n)/1_000_000n,now=BigInt(clock);if(t<now-120_000n||t>now+30_000n)throw fail();return h.hash;
}
function plain(account,block){
  return object(account)&&account.block_hash===block&&account.code_hash===EMPTY_CODE&&
    absent(account,'global_contract_hash')&&absent(account,'global_contract_account_id')&&absent(account,'bootstrap_nonce')&&
    (!Object.hasOwn(account,'state')||account.state==='initialized');
}
/** Only an exact structured UNKNOWN_ACCOUNT at the pinned block is treated as
 * absence. An RPC error, timeout or mismatched block stays UNKNOWN. */
export async function inspectV14BootstrapBudget({fetch:fetchImpl=globalThis.fetch,now=Date.now,isCurrent=()=>true,
  expectedOwnerPublicKey}={}){
  if(typeof fetchImpl!=='function'||typeof now!=='function'||typeof isCurrent!=='function'||isCurrent()!==true)throw fail();
  if(expectedOwnerPublicKey!==undefined){
    try {
      const key=PublicKey.from(expectedOwnerPublicKey);
      if(typeof expectedOwnerPublicKey!=='string'||!expectedOwnerPublicKey.startsWith('ed25519:')||
        key.keyType!==0||key.ed25519Key?.data?.length!==32||String(key)!==expectedOwnerPublicKey)throw fail();
    }catch{throw fail()}
  }
  async function rpc(method,params,{presence=false,limit=512_000}={}){
    if(isCurrent()!==true)throw fail();const id='bouncer-v14-bootstrap-budget';
    const response=await fetchImpl(RPC,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15_000)});
    const data=await bounded(response,limit);
    if(isCurrent()!==true||!response.ok||data?.jsonrpc!=='2.0'||data.id!==id)throw fail();
    if(presence&&data.error?.cause?.name==='UNKNOWN_ACCOUNT'&&data.error?.cause?.info?.requested_account_id===VAULT&&
      data.error?.cause?.info?.block_hash===params.block_id&&!Object.hasOwn(data,'result'))return {exists:false,block_hash:params.block_id};
    if(data.error||!object(data.result))throw fail();
    if(presence){if(data.result.block_hash!==params.block_id)throw fail();return {exists:true,block_hash:params.block_id}}
    return data.result;
  }
  try{
    const started=now();if(!Number.isSafeInteger(started))throw fail();
    if((await rpc('status',[]))?.chain_id!=='testnet')throw fail();
    const block=await rpc('block',{finality:'final'}),at=fresh(block,now());
    const query=(type,account,options)=>rpc('query',{request_type:type,account_id:account,block_id:at},options);
    const [owner,keys,vault,protocol,gas]=await Promise.all([
      query('view_account',OWNER),query('view_access_key_list',OWNER),query('view_account',VAULT,{presence:true}),
      rpc('EXPERIMENTAL_protocol_config',{block_id:at}),rpc('gas_price',[at]),
    ]);
    const balance=uint(owner?.amount),storagePrice=uint(protocol?.runtime_config?.storage_amount_per_byte);
    if(owner?.block_hash!==at||balance===null||!Number.isSafeInteger(owner.storage_usage)||owner.storage_usage<0||
      keys?.block_hash!==at||!Array.isArray(keys.keys)||keys.keys.length>1000||
      keys.keys.some(k=>!object(k)||typeof k.public_key!=='string'||!object(k.access_key))||
      new Set(keys.keys.map(k=>k.public_key)).size!==keys.keys.length||storagePrice===null||storagePrice===0n)throw fail();
    const used=BigInt(owner.storage_usage)*storagePrice,available=balance>used?balance-used:0n;
    const budget=estimateV14BootstrapBudget({protocol,gasPrice:gas.gas_price,owner:OWNER});
    const checks={candidate_absent_at_block:vault.exists===false,owner_has_plain_account_profile:plain(owner,at),
      owner_has_full_access_key:keys.keys.some(k=>k.access_key.permission==='FullAccess'),
      owner_covers_example_vault_and_create_upfront:available>=BigInt(budget.create.owner_total_upfront_estimate_yocto),
      example_covers_storage_and_deploy_upfront:budget.funding_covers_estimated_storage_and_deploy_upfront};
    if(expectedOwnerPublicKey!==undefined){
      const reviewed=keys.keys.find(k=>k.public_key===expectedOwnerPublicKey);
      checks.reviewed_owner_key_full_access=reviewed?.access_key?.permission==='FullAccess'&&
        pinnedAccessKeyNonce(reviewed.access_key.nonce)!==null;
    }
    const finished=now();if(!Number.isSafeInteger(finished)||finished<started||isCurrent()!==true||fresh(block,finished)!==at)throw fail();
    const blockers=Object.keys(checks).filter(k=>!checks[k]);
    return Object.freeze({status:blockers.length?'BLOCKED_OR_UNKNOWN':'READ_ONLY_REVIEW_NOT_AUTHORIZED',network:'testnet',owner:OWNER,vault:VAULT,
      observed_at:new Date(finished).toISOString(),block_height:block.header.height,block_hash:at,
      candidate_presence:vault.exists?'PRESENT':'ABSENT_AT_FINAL_BLOCK',owner_available_yocto:available.toString(),budget,checks,blockers,
      owner_wallet_control_proven:false,independent_recovery_verified:false,transaction_authorized:false,transaction_sent:false});
  }catch{throw fail()}
}
