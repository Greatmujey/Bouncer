/** Read-only verification of ONE separately retained temporary-key deployment.
 *
 * The reviewed plan is reconstructed from the pinned V14 bytes before any RPC
 * request. An exact FINAL transaction/outcome and fresh, same-block code,
 * owner, and key views are required. nearcore may omit the body of a local
 * (signer === receiver) root receipt; when it does, the result explicitly says
 * so and relies on the trusted RPC's transaction and root outcome instead.
 *
 * This is not an independent backup, latest-head, custody, consent, audit, or
 * consensus proof, and does not rule out another transaction in flight. It
 * never signs, sends or retries. The live deployment path remains unwired. */
import {buildV14TemporaryBootstrapPlan} from './v14-bootstrap-plan.mjs';
import {V14_BOOTSTRAP_READ_RPC} from './v14-bootstrap-create-verifier.mjs';
import {decodeNativeHash32} from './native-oracle-transaction.mjs';
import {decodePublicKey} from './cli-login.mjs';
import {isTestnetAccount} from '../shared/account-id.mjs';
import {pinnedAccessKeyNonce} from '../shared/pinned-access-key-nonce.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';

const EMPTY_CODE='11111111111111111111111111111111';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,MAX=(1n<<128n)-1n;
const fail=()=>new Error('Bootstrap deployment original or final vault state is unresolved; preserve the original and do not resend');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,fields)=>object(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
const absent=(x,key)=>!Object.hasOwn(x,key)||x[key]===null;
const hash=x=>{try{decodeNativeHash32(x);return true}catch{return false}};
const uint=x=>typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<=MAX?BigInt(x):null;
const number=x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?String(x):
  typeof x==='string'&&/^(?:0|[1-9][0-9]{0,38})$/.test(x)?x:null;
const success=x=>exact(x,['SuccessValue'])&&x.SuccessValue==='';
const text=new TextEncoder();
const base64=bytes=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join(''));
const hexBytes=value=>Uint8Array.from(value.match(/../g),x=>parseInt(x,16));
function basicReview(review) {
  if(!object(review)||!isTestnetAccount(review.owner)||!isTestnetAccount(review.vault)||
    !review.vault.endsWith(`.${review.owner}`)||review.vault.slice(0,-review.owner.length-1).includes('.')||
    review.vault_wasm_sha256!==V14_TESTNET_ARTIFACT.sha256)return false;
  try{decodePublicKey(review.temporary_vault_public_key);return true}catch{return false}
}
function metadata(receipt) {
  const a=receipt?.receipt?.Action;
  return exact(receipt?.receipt,['Action'])&&object(a)&&
    Object.keys(a).every(k=>['signer_id','signer_public_key','gas_price','input_data_ids','output_data_receivers','actions','is_promise_yield','refund_to'].includes(k))&&
    number(a.gas_price)!==null&&Array.isArray(a.input_data_ids)&&a.input_data_ids.length===0&&
    Array.isArray(a.output_data_receivers)&&a.output_data_receivers.length===0&&
    (a.is_promise_yield===undefined||a.is_promise_yield===false)&&(a.refund_to===undefined||a.refund_to===null);
}
function deploymentActionsMatch(actions,review) {
  // NEAR's ActionView reports base64(SHA-256(WASM)), not base64(WASM).
  const code=actions?.[0]?.DeployContract,call=actions?.[1]?.FunctionCall,del=actions?.[2]?.DeleteKey;
  return review.vault_wasm_sha256===V14_TESTNET_ARTIFACT.sha256&&Array.isArray(actions)&&actions.length===3&&
    exact(actions[0],['DeployContract'])&&exact(code,['code'])&&code.code===base64(hexBytes(V14_TESTNET_ARTIFACT.sha256))&&
    exact(actions[1],['FunctionCall'])&&exact(call,['method_name','args','gas','deposit'])&&call.method_name==='new'&&
    call.args===base64(text.encode(JSON.stringify({owner:review.owner})))&&number(call.gas)==='30000000000000'&&number(call.deposit)==='0'&&
    exact(actions[2],['DeleteKey'])&&exact(del,['public_key'])&&del.public_key===review.temporary_vault_public_key;
}
function gasRefund(receipt,outcome,review) {
  const a=receipt?.receipt?.Action,actions=a?.actions,transfer=actions?.[0]?.Transfer,value=number(transfer?.deposit);
  return receipt?.predecessor_id==='system'&&receipt?.receiver_id===review.vault&&metadata(receipt)&&
    a.signer_id===review.vault&&a.signer_public_key===review.temporary_vault_public_key&&number(a.gas_price)==='0'&&
    Array.isArray(actions)&&actions.length===1&&exact(actions[0],['Transfer'])&&exact(transfer,['deposit'])&&
    value!==null&&BigInt(value)>0n&&BigInt(value)<=MAX&&outcome?.executor_id===review.vault&&success(outcome.status)&&
    Array.isArray(outcome.receipt_ids)&&outcome.receipt_ids.length===0;
}

/** Inspect a trusted RPC response against a separately validated plan and
 * original hash. The sole permitted descendant is the protocol gas refund.
 * The missing local root *body* is marked, not invented; its unique linked
 * outcome, exact transaction actions and the later state checks remain needed. */
export function inspectBootstrapDeploymentReceipt({result,review,originalHash}={}) {
  if(!basicReview(review)||!hash(originalHash)||!object(result)||result.final_execution_status!=='FINAL'||!success(result.status)||
    !Array.isArray(result.receipts)||result.receipts.length>2||!Array.isArray(result.receipts_outcome)||
    result.receipts_outcome.length<1||result.receipts_outcome.length>2)throw fail();
  const tx=result.transaction,t=result.transaction_outcome?.outcome;
  if(tx?.hash!==originalHash||tx.signer_id!==review.vault||tx.public_key!==review.temporary_vault_public_key||
    tx.receiver_id!==review.vault||!deploymentActionsMatch(tx.actions,review)||result.transaction_outcome?.id!==originalHash||
    t?.executor_id!==review.vault||!exact(t.status,['SuccessReceiptId'])||!hash(t.status.SuccessReceiptId)||
    !Array.isArray(t.receipt_ids)||t.receipt_ids.length!==1||t.receipt_ids[0]!==t.status.SuccessReceiptId)throw fail();
  const receipts=new Map(),outcomes=new Map();
  for(const r of result.receipts){if(!hash(r?.receipt_id)||receipts.has(r.receipt_id))throw fail();receipts.set(r.receipt_id,r)}
  for(const o of result.receipts_outcome){if(!hash(o?.id)||outcomes.has(o.id)||!object(o.outcome)||
    !Array.isArray(o.outcome.receipt_ids)||o.outcome.receipt_ids.some(id=>!hash(id))||
    new Set(o.outcome.receipt_ids).size!==o.outcome.receipt_ids.length)throw fail();outcomes.set(o.id,o.outcome)}
  const id=t.status.SuccessReceiptId,root=receipts.get(id),out=outcomes.get(id),a=root?.receipt?.Action;
  const omitted=root===undefined;
  if(!omitted&&(root.predecessor_id!==review.vault||root.receiver_id!==review.vault||!metadata(root)||
    a.signer_id!==review.vault||a.signer_public_key!==review.temporary_vault_public_key||!deploymentActionsMatch(a.actions,review)))throw fail();
  if(out?.executor_id!==review.vault||!success(out.status)||out.receipt_ids.length>1)throw fail();
  const children=out.receipt_ids;
  if(receipts.size!==(omitted?0:1)+children.length||outcomes.size!==1+children.length)throw fail();
  if(children.length&&(children[0]===id||!gasRefund(receipts.get(children[0]),outcomes.get(children[0]),review)))throw fail();
  return Object.freeze({original_hash:originalHash,root_receipt_id:id,local_root_receipt_body_omitted:omitted,
    final_transaction_and_outcome_verified:true,transaction_sent:false});
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
  if(ms<time-120_000n||ms>time+30_000n)throw fail();return h.hash;
}
function localAccount(account,block,codeHash) {
  return object(account)&&account.block_hash===block&&account.code_hash===codeHash&&
    absent(account,'global_contract_hash')&&absent(account,'global_contract_account_id')&&
    absent(account,'bootstrap_nonce')&&(!Object.hasOwn(account,'state')||account.state==='initialized');
}
function keyList(view,block) {
  if(view?.block_hash!==block||!Array.isArray(view.keys)||view.keys.length>1000||
    view.keys.some(k=>!object(k)||typeof k.public_key!=='string'||!object(k.access_key))||
    new Set(view.keys.map(k=>k.public_key)).size!==view.keys.length)throw fail();
  return view.keys;
}
function jsonView(view,block) {
  if(view?.block_hash!==block||!Array.isArray(view.result)||view.result.length<1||view.result.length>1024||
    view.result.some(x=>!Number.isInteger(x)||x<0||x>255))throw fail();
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(view.result)))}catch{throw fail()}
}

/** Read-only completion verifier. The caller must separately retain its review
 * and both original transaction hashes, prove backup/recovery and decide what
 * to do next. Supplying a hash to this function does not prove retention. */
export async function createV14BootstrapDeploymentVerifier({review:inputReview,compressedV14:inputCompressed,
  fetch:fetchImpl=globalThis.fetch,crypto=globalThis.crypto,now=Date.now,isCurrent=()=>true}={}) {
  if(!inputReview||typeof fetchImpl!=='function'||!crypto?.subtle||typeof now!=='function'||typeof isCurrent!=='function'||
    !(inputCompressed instanceof Uint8Array)||isCurrent()!==true)throw fail();
  const review=structuredClone(inputReview),compressedV14=new Uint8Array(inputCompressed);
  const plan=await buildV14TemporaryBootstrapPlan({owner:review.owner,ownerPublicKey:review.owner_public_key,vault:review.vault,
    temporaryPublicKey:review.temporary_vault_public_key,vaultFundingYocto:review.vault_funding_yocto,compressedV14,crypto});
  if(JSON.stringify(review)!==JSON.stringify(plan.review)||isCurrent()!==true)throw fail();
  async function rpc(method,params,maximum=512_000) {
    if(isCurrent()!==true)throw fail();
    const id='bouncer-v14-bootstrap-deployment-read';
    const response=await fetchImpl(V14_BOOTSTRAP_READ_RPC,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',
      cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15_000)});
    const payload=await boundedJson(response,maximum);
    if(isCurrent()!==true||!response.ok||payload?.jsonrpc!=='2.0'||payload.id!==id||payload.error||!object(payload.result))throw fail();
    return payload.result;
  }
  return async function verifyDeploymentFinal(inputBinding) {
    if(!exact(inputBinding,['scope_id','review_sha256','original_hash']))throw fail();
    // Freeze a private copy before the first await: a caller cannot swap the
    // independently retained original or its scope during network reads.
    const binding={scope_id:inputBinding.scope_id,review_sha256:inputBinding.review_sha256,original_hash:inputBinding.original_hash};
    if(typeof binding.scope_id!=='string'||!SCOPE.test(binding.scope_id)||typeof binding.review_sha256!=='string'||
      !HEX.test(binding.review_sha256)||binding.review_sha256!==review.review_sha256||!hash(binding.original_hash)||isCurrent()!==true)throw fail();
    try {
      const started=now();if(!Number.isSafeInteger(started)||started<1)throw fail();
      if((await rpc('status',[]))?.chain_id!=='testnet')throw fail();
      const result=await rpc('EXPERIMENTAL_tx_status',{tx_hash:binding.original_hash,sender_account_id:review.vault,wait_until:'FINAL'},4_000_000);
      const receipt=inspectBootstrapDeploymentReceipt({result,review,originalHash:binding.original_hash});
      const block=await rpc('block',{finality:'final'}),at=freshBlock(block,now());
      const query=(request_type,account_id,extra={})=>rpc('query',{request_type,account_id,block_id:at,...extra});
      const view=method_name=>query('call_function',review.vault,{method_name,args_base64:'e30='});
      const [owner,ownerKeyView,vault,vaultKeyView,versionView,vaultOwnerView]=await Promise.all([
        query('view_account',review.owner),query('view_access_key_list',review.owner),
        query('view_account',review.vault),query('view_access_key_list',review.vault),view('contract_version'),view('get_owner'),
      ]);
      const ownerKeys=keyList(ownerKeyView,at),vaultKeys=keyList(vaultKeyView,at);
      const ownerKey=ownerKeys.find(k=>k.public_key===review.owner_public_key);
      if(!localAccount(owner,at,EMPTY_CODE)||ownerKey?.access_key?.permission!=='FullAccess'||
        pinnedAccessKeyNonce(ownerKey?.access_key?.nonce)===null||
        !localAccount(vault,at,review.vault_near_code_hash)||uint(vault.amount)===null||uint(vault.locked)!==0n||
        !Number.isSafeInteger(vault.storage_usage)||vault.storage_usage<0||vaultKeys.length!==0||
        jsonView(versionView,at)!=='bouncer-agent-v14-native-storage-testnet'||jsonView(vaultOwnerView,at)!==review.owner)throw fail();
      const finished=now();if(!Number.isSafeInteger(finished)||finished<started||isCurrent()!==true||freshBlock(block,finished)!==at)throw fail();
      return Object.freeze({status:'DEPLOYMENT_FINAL_AND_KEYLESS_VAULT_VERIFIED',network:'testnet',...binding,
        final_block_hash:at,checked_at_ms:finished,local_root_receipt_body_omitted:receipt.local_root_receipt_body_omitted,
        final_transaction_and_outcome_verified:true,pinned_v14_code_verified:true,owner_verified:true,temporary_key_absent:true,
        all_vault_access_keys_absent:true,independent_recovery_verified:false,latest_history_verified:false,
        wallet_approval_verified:false,transaction_authorized:false,transaction_sent:false});
    }catch{throw fail()}
  };
}
