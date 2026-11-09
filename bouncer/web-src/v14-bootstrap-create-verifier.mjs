/** Read-only verification of the ONE independently retained create original.
 * The reviewed plan is rebuilt from the pinned artifact before any RPC call.
 * A FINAL, receipt-inclusive response and a fresh pinned-block account/key
 * view are both required. This trusts one testnet RPC; it is not a consensus
 * proof, a backup/freshness proof, transaction approval, or proof that another
 * transaction is not in flight. It never signs, broadcasts, or retries an
 * uncertain original. The wallet/deployment path is deliberately not wired. */
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {decodeNativeHash32} from './native-oracle-transaction.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';

export const V14_BOOTSTRAP_READ_RPC='https://rpc.testnet.near.org';
const verifiers=new WeakMap();
// In-realm type/binding check only: the injected fetch and RPC are still trusted.
export const isV14BootstrapCreateVerifier=(value,reviewSha256)=>verifiers.has(value)&&
  (reviewSha256===undefined||verifiers.get(value)===reviewSha256);
const EMPTY_CODE='11111111111111111111111111111111';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,MAX=(1n<<128n)-1n;
const fail=()=>new Error('Bootstrap create original or fresh vault state is unresolved; stop and do not repeat a wallet prompt or send');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>object(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
const absent=(x,key)=>!Object.hasOwn(x,key)||x[key]===null;
const hash=x=>{try{decodeNativeHash32(x);return true}catch{return false}};
const uint=x=>typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<=MAX?BigInt(x):null;
const number=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?String(x):
  typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)?x:null;
const success=x=>exact(x,['SuccessValue'])&&x.SuccessValue==='';
function metadata(receipt) {
  const a=receipt?.receipt?.Action;
  return exact(receipt?.receipt,['Action'])&&object(a)&&
    Object.keys(a).every(k=>['signer_id','signer_public_key','gas_price','input_data_ids','output_data_receivers','actions','is_promise_yield','refund_to'].includes(k))&&
    number(a.gas_price)!==null&&Array.isArray(a.input_data_ids)&&a.input_data_ids.length===0&&
    Array.isArray(a.output_data_receivers)&&a.output_data_receivers.length===0&&
    (a.is_promise_yield===undefined||a.is_promise_yield===false)&&(a.refund_to===undefined||a.refund_to===null);
}
function createActionsMatch(actions,review) {
  const transfer=actions?.[1]?.Transfer,add=actions?.[2]?.AddKey,access=add?.access_key;
  return Array.isArray(actions)&&actions.length===3&&actions[0]==='CreateAccount'&&
    exact(actions[1],['Transfer'])&&exact(transfer,['deposit'])&&number(transfer.deposit)===review.vault_funding_yocto&&
    exact(actions[2],['AddKey'])&&exact(add,['public_key','access_key'])&&add.public_key===review.temporary_vault_public_key&&
    exact(access,['nonce','permission'])&&number(access.nonce)==='0'&&access.permission==='FullAccess';
}
function gasRefund(receipt,outcome,review) {
  const a=receipt?.receipt?.Action,actions=a?.actions,transfer=actions?.[0]?.Transfer,value=number(transfer?.deposit);
  return receipt?.predecessor_id==='system'&&receipt?.receiver_id===review.owner&&metadata(receipt)&&
    a.signer_id===review.owner&&a.signer_public_key===review.owner_public_key&&number(a.gas_price)==='0'&&
    Array.isArray(actions)&&actions.length===1&&exact(actions[0],['Transfer'])&&exact(transfer,['deposit'])&&
    value!==null&&BigInt(value)>0n&&BigInt(value)<=MAX&&outcome?.executor_id===review.owner&&success(outcome.status)&&
    Array.isArray(outcome.receipt_ids)&&outcome.receipt_ids.length===0;
}
/** Only the expected create/fund/key receipt and an optional protocol gas
 * refund are accepted. Incomplete, failed, duplicated or unrelated graphs
 * are uncertain, never permission to create again. */
export function inspectBootstrapCreateReceipt({result,review,originalHash}={}) {
  if(!object(review)||!hash(originalHash)||!object(result)||result.final_execution_status!=='FINAL'||!success(result.status)||
    !Array.isArray(result.receipts)||!Array.isArray(result.receipts_outcome)||
    result.receipts.length<1||result.receipts.length>2||result.receipts_outcome.length!==result.receipts.length)throw fail();
  const tx=result.transaction,t=result.transaction_outcome?.outcome;
  if(tx?.hash!==originalHash||tx.signer_id!==review.owner||tx.public_key!==review.owner_public_key||tx.receiver_id!==review.vault||
    !createActionsMatch(tx.actions,review)||result.transaction_outcome?.id!==originalHash||t?.executor_id!==review.owner||
    !exact(t.status,['SuccessReceiptId'])||!hash(t.status.SuccessReceiptId)||!Array.isArray(t.receipt_ids)||
    t.receipt_ids.length!==1||t.receipt_ids[0]!==t.status.SuccessReceiptId)throw fail();
  const receipts=new Map(),outcomes=new Map();
  for(const r of result.receipts){if(!hash(r?.receipt_id)||receipts.has(r.receipt_id))throw fail();receipts.set(r.receipt_id,r)}
  for(const o of result.receipts_outcome){if(!hash(o?.id)||outcomes.has(o.id)||!object(o.outcome)||
      !Array.isArray(o.outcome.receipt_ids)||o.outcome.receipt_ids.some(id=>!hash(id))||
      new Set(o.outcome.receipt_ids).size!==o.outcome.receipt_ids.length)throw fail();outcomes.set(o.id,o.outcome)}
  const id=t.status.SuccessReceiptId,root=receipts.get(id),out=outcomes.get(id),a=root?.receipt?.Action;
  if(root?.predecessor_id!==review.owner||root.receiver_id!==review.vault||!metadata(root)||
    a.signer_id!==review.owner||a.signer_public_key!==review.owner_public_key||!createActionsMatch(a.actions,review)||
    out?.executor_id!==review.vault||!success(out.status)||out.receipt_ids.length>1)throw fail();
  const children=out.receipt_ids;
  if(receipts.size!==1+children.length||outcomes.size!==1+children.length)throw fail();
  if(children.length&&(children[0]===id||!gasRefund(receipts.get(children[0]),outcomes.get(children[0]),review)))throw fail();
  return Object.freeze({original_hash:originalHash,root_receipt_id:id,final_execution_verified:true,transaction_sent:false});
}
async function boundedJson(response,maximum) {
  const length=response.headers?.get?.('content-length');
  if(length!=null&&(!/^\d+$/.test(length)||BigInt(length)>BigInt(maximum)))throw fail();
  if(!response.body?.getReader)throw fail();
  const reader=response.body.getReader(),parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>maximum){await reader.cancel();throw fail()}parts.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.byteLength}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function freshBlock(block,now) {
  const h=block?.header,n=h?.timestamp_nanosec;
  if(!hash(h?.hash)||!Number.isSafeInteger(h.height)||h.height<1||typeof n!=='string'||!/^[1-9][0-9]{0,19}$/.test(n)||
    !Number.isSafeInteger(now)||now<1)throw fail();
  const ms=BigInt(n)/1_000_000n,time=BigInt(now);
  if(ms<time-120_000n||ms>time+30_000n)throw fail();
  return h.hash;
}
function emptyContract(account,block) {
  return object(account)&&account.block_hash===block&&account.code_hash===EMPTY_CODE&&
    absent(account,'global_contract_hash')&&absent(account,'global_contract_account_id')&&
    absent(account,'bootstrap_nonce')&&(!Object.hasOwn(account,'state')||account.state==='initialized');
}
function keyList(view,block) {
  if(view?.block_hash!==block||!Array.isArray(view.keys)||view.keys.length>1000||
    view.keys.some(k=>!object(k)||typeof k.public_key!=='string'||!object(k.access_key))||
    new Set(view.keys.map(k=>k.public_key)).size!==view.keys.length)throw fail();
  return view.keys;
}

/** Construct the exact callback required by createBootstrapTwoCopyWitness.
 * `review` must also have been independently enrolled and retained; this
 * function does not establish that fact. `fetch` is injectable for isolated
 * tests but the requested URL is always the fixed public testnet RPC. */
export async function createV14BootstrapCreateVerifier({review:inputReview,compressedV14:inputCompressed,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,now=Date.now,isCurrent=()=>true}={}) {
  if(!inputReview||typeof fetchImpl!=='function'||!crypto?.subtle||typeof now!=='function'||typeof isCurrent!=='function'||
    !(inputCompressed instanceof Uint8Array)||isCurrent()!==true)throw fail();
  const review=structuredClone(inputReview),compressedV14=new Uint8Array(inputCompressed);
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  if(JSON.stringify(review)!==JSON.stringify(plan.review)||isCurrent()!==true)throw fail();
  async function rpc(method,params,maximum=512_000) {
    if(isCurrent()!==true)throw fail();
    const id='bouncer-v14-bootstrap-read';
    const response=await fetchImpl(V14_BOOTSTRAP_READ_RPC,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',
      cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(25_000)});
    const body=await boundedJson(response,maximum);
    if(isCurrent()!==true||!response.ok||body?.jsonrpc!=='2.0'||body.id!==id||body.error||!Object.hasOwn(body,'result'))throw fail();
    return body.result;
  }
  const verifyCreateFinal=async function({scope_id,review_sha256,original_hash}={}) {
    try {
      if(!SCOPE.test(scope_id??'')||!HEX.test(review_sha256??'')||review_sha256!==review.review_sha256||
        !hash(original_hash)||isCurrent()!==true)throw fail();
      const started=now();if(!Number.isSafeInteger(started))throw fail();
      if((await rpc('status',[]))?.chain_id!=='testnet')throw fail();
      const result=await rpc('EXPERIMENTAL_tx_status',{tx_hash:original_hash,sender_account_id:review.owner,wait_until:'FINAL'},4_000_000);
      inspectBootstrapCreateReceipt({result,review,originalHash:original_hash});
      const block=await rpc('block',{finality:'final'}),at=freshBlock(block,now());
      const query=(type,account)=>rpc('query',{request_type:type,account_id:account,block_id:at});
      const [owner,ownerKeyView,vault,vaultKeyView]=await Promise.all([
        query('view_account',review.owner),query('view_access_key_list',review.owner),
        query('view_account',review.vault),query('view_access_key_list',review.vault),
      ]);
      const ownerKeys=keyList(ownerKeyView,at),vaultKeys=keyList(vaultKeyView,at);
      const ownerKey=ownerKeys.find(k=>k.public_key===review.owner_public_key),temp=vaultKeys[0];
      if(!emptyContract(owner,at)||ownerKey?.access_key?.permission!=='FullAccess'||pinnedAccessKeyNonce(ownerKey.access_key.nonce)===null||
        !emptyContract(vault,at)||uint(vault.amount)!==BigInt(review.vault_funding_yocto)||uint(vault.locked)!==0n||
        !Number.isSafeInteger(vault.storage_usage)||vault.storage_usage<0||vaultKeys.length!==1||
        temp?.public_key!==review.temporary_vault_public_key||temp.access_key.permission!=='FullAccess'||
        pinnedAccessKeyNonce(temp.access_key.nonce)===null)throw fail();
      const finished=now();if(!Number.isSafeInteger(finished)||finished<started||isCurrent()!==true||freshBlock(block,finished)!==at)throw fail();
      return Object.freeze({status:'CREATE_FINAL_AND_VAULT_KEY_VERIFIED',network:'testnet',scope_id,review_sha256,original_hash,
        final_block_hash:at,checked_at_ms:finished,final_execution_verified:true,temporary_full_access_key_present:true,transaction_sent:false});
    }catch{throw fail()}
  };
  verifiers.set(verifyCreateFinal,review.review_sha256);return verifyCreateFinal;
}
