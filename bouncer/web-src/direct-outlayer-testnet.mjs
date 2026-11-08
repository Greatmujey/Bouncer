/**
 * One opt-in DIRECT OutLayer testnet purchase from great_mujey.testnet.
 * This bypasses Bouncer's firewall, policies and agent. It is NOT evidence of
 * the autonomous Bouncer flow. No owner private key is handled here. The
 * wallet is invoked at most once after a strict local write-ahead claim.
 * Browser deletion, storage rollback, other devices and other origins are not
 * fenced; an unknown result must never be retried. RPC/provider data is trusted
 * only for the receipt check, not proof of market accuracy or a TEE attestation.
 */
import {decodeNativeHash32} from './native-oracle-transaction.mjs';

export const DIRECT_OWNER='great_mujey.testnet';
export const DIRECT_PAYEE='outlayer.testnet';
export const DIRECT_DEPOSIT='100000000000000000000000'; // 0.1 test NEAR, plus gas
export const DIRECT_GAS='300000000000000';
export const DIRECT_PROJECT='zavodil2.testnet/price-oracle';
export const DIRECT_UUID='p0000000000000007';
export const DIRECT_VERSION='3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0';
export const DIRECT_INPUT='{"command":"fetch_external","token_id":"near","source":{"custom":{"url":"https://api.coinbase.com/v2/prices/NEAR-USD/spot","json_path":"data.amount","value_type":"number","method":"GET"}}}';
const RPC='https://rpc.testnet.near.org',DB='bouncer-one-direct-outlayer-v1',STORE='claims',KEY='great_mujey.testnet:outlayer-direct-test-v1';
const LIMITS=Object.freeze({max_instructions:10000000000,max_memory_mb:256,max_execution_seconds:60});
const SOURCE=Object.freeze({WasmUrl:Object.freeze({url:`https://wasmhub.testnet.fastfs.io/fastfs.testnet/${DIRECT_VERSION}.wasm`,hash:DIRECT_VERSION,build_target:'wasm32-wasip2'})});
const fail=()=>new Error('Direct test unavailable or uncertain. Do not repeat a wallet transaction; reconcile the original.');
const plain=x=>x!==null && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const stable=x=>Array.isArray(x)?x.map(stable):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const hash=x=>{try{decodeNativeHash32(x);return true}catch{return false}};
const amount=x=>typeof x==='string' && /^(?:0|[1-9][0-9]{0,38})$/.test(x)?BigInt(x):null;
const safeOrigin=(origin,isTopLevel)=>{
  try{const u=new URL(origin);return isTopLevel===true && u.protocol==='https:' && u.origin===origin &&
    /^4173-[a-z0-9-]+\.e2b\.app$/i.test(u.hostname) && !u.username && !u.password}
  catch{return false}
};
export function directOutlayerArgs(){return {source:{Project:{project_id:DIRECT_PROJECT,version_key:DIRECT_VERSION}},resource_limits:{...LIMITS},
  input_data:DIRECT_INPUT,secrets_ref:null,response_format:'Json',payer_account_id:DIRECT_OWNER,params:null}}
export function directOutlayerTransaction(){return {network:'testnet',signerId:DIRECT_OWNER,receiverId:DIRECT_PAYEE,
  actions:[{type:'FunctionCall',params:{methodName:'request_execution',args:directOutlayerArgs(),gas:DIRECT_GAS,deposit:DIRECT_DEPOSIT}}]}}

async function bounded(response,maximum){
  const length=response.headers?.get?.('content-length');
  if(length!=null && (!/^\d+$/.test(length) || Number(length)>maximum))throw fail();
  if(!response.body?.getReader)throw fail();const reader=response.body.getReader(),parts=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maximum){await reader.cancel();throw fail()}parts.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
async function call(fetchImpl,method,params,maximum=1_000_000){
  const id='bouncer-direct-outlayer-test';
  const response=await fetchImpl(RPC,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',
    headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),
    signal:AbortSignal.timeout(25_000)});
  const body=await bounded(response,maximum);
  if(!response.ok || body?.jsonrpc!=='2.0' || body.id!==id || body.error || !Object.hasOwn(body,'result'))throw fail();
  return body.result;
}
const encode=x=>btoa(unescape(encodeURIComponent(JSON.stringify(x))));
function decoded(value,limit=16384){
  if(typeof value!=='string' || value.length>Math.ceil(limit/3)*4+4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw fail();
  const text=atob(value),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));if(bytes.length>limit)throw fail();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function viewResult(value,block){
  if(value?.block_hash!==block || !Array.isArray(value.result) || value.result.length>65536 ||
     value.result.some(v=>!Number.isInteger(v)||v<0||v>255))throw fail();
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(value.result)));
}

/** Fresh public, pinned-block checks only. Never authorizes a wallet call. */
export async function inspectDirectOutlayerReadiness({fetch:fetchImpl=globalThis.fetch,now=Date.now}={}){
  if(typeof fetchImpl!=='function' || typeof now!=='function')throw fail();
  const status=await call(fetchImpl,'status',[]);if(status?.chain_id!=='testnet')throw fail();
  const block=await call(fetchImpl,'block',{finality:'final'}),header=block?.header;
  if(!hash(header?.hash) || !Number.isSafeInteger(header?.height) || header.height<1)throw fail();
  const timestamp=Number(header.timestamp_nanosec),clock=now();
  if(!Number.isFinite(timestamp) || !Number.isSafeInteger(clock) || Math.abs(clock-timestamp/1_000_000)>120_000)throw fail();
  const at=header.hash,query=(type,account,extra={})=>call(fetchImpl,'query',{request_type:type,account_id:account,block_id:at,...extra});
  const view=(method,args)=>query('call_function',DIRECT_PAYEE,{method_name:method,args_base64:encode(args)}).then(v=>viewResult(v,at));
  const [account,keys,payee,protocol,project,version,pricing]=await Promise.all([
    query('view_account',DIRECT_OWNER),query('view_access_key_list',DIRECT_OWNER),query('view_account',DIRECT_PAYEE),
    call(fetchImpl,'EXPERIMENTAL_protocol_config',{block_id:at}),view('get_project',{project_id:DIRECT_PROJECT}),
    view('get_version',{project_id:DIRECT_PROJECT,version_key:DIRECT_VERSION}),view('get_project_pricing',{project_id:DIRECT_PROJECT}),
  ]);
  const balance=amount(account?.amount),cost=amount(protocol?.runtime_config?.storage_amount_per_byte);
  if(account?.block_hash!==at || balance===null || !Number.isSafeInteger(account.storage_usage) || account.storage_usage<0 ||
     keys?.block_hash!==at || !Array.isArray(keys.keys) || !keys.keys.some(k=>k?.access_key?.permission==='FullAccess') ||
     payee?.block_hash!==at || cost===null || cost===0n || protocol?.chain_id!=='testnet' ||
     project?.project_id!==DIRECT_PROJECT || project?.uuid!==DIRECT_UUID || project?.owner!=='zavodil2.testnet' ||
     version?.wasm_hash!==DIRECT_VERSION || !equal(version?.source,SOURCE) || pricing!==null)throw fail();
  const available=balance-BigInt(account.storage_usage)*cost;
  if(available < 300000000000000000000000n)throw fail(); // deposit plus conservative gas headroom
  const finished=now();if(!Number.isSafeInteger(finished) || finished<clock || Math.abs(finished-timestamp/1_000_000)>120_000)throw fail();
  return Object.freeze({network:'testnet',owner:DIRECT_OWNER,payee:DIRECT_PAYEE,project_id:DIRECT_PROJECT,block_hash:at,block_height:header.height,
    owner_available_yocto:available.toString(),checked_at_ms:finished,maximum_yocto:DIRECT_DEPOSIT,gas:DIRECT_GAS,gas_extra:true,firewall_used:false,transaction_sent:false});
}

function openDb(indexedDB){return new Promise((resolve,reject)=>{
  let request,settled=false;try{request=indexedDB.open(DB,1)}catch{reject(fail());return}
  request.onupgradeneeded=e=>{if(e.oldVersion!==0){request.transaction.abort();return}request.result.createObjectStore(STORE,{keyPath:'key'})};
  const unavailable=()=>{if(!settled){settled=true;reject(fail())}};request.onerror=unavailable;request.onblocked=unavailable;
  request.onsuccess=()=>{const db=request.result;if(settled){db.close();return}settled=true;
    if(db.version!==1 || db.objectStoreNames.length!==1 || !db.objectStoreNames.contains(STORE)){db.close();reject(fail());return}
    db.onversionchange=()=>db.close();resolve(db)};
})}
const validRow=(row,origin)=>plain(row)&&Object.keys(row).sort().join(',')==='claimed_at_ms,hash,key,origin,owner' && row.key===KEY &&
  row.owner===DIRECT_OWNER && row.origin===origin && Number.isSafeInteger(row.claimed_at_ms) && row.claimed_at_ms>0 &&
  (row.hash===null || hash(row.hash));
function readRow(db){return new Promise((resolve,reject)=>{
  let tx,request;try{tx=db.transaction(STORE,'readonly');const s=tx.objectStore(STORE);if(s.keyPath!=='key'||s.indexNames.length!==0)throw fail();request=s.get(KEY)}catch{reject(fail());return}
  let value;request.onsuccess=()=>{value=request.result};request.onerror=()=>{try{tx.abort()}catch{}};
  tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(fail());tx.onerror=()=>{};
})}
async function readClaim(indexedDB,origin){const db=await openDb(indexedDB);try{const row=await readRow(db);if(row!==undefined && !validRow(row,origin))throw fail();return row??null}finally{db.close()}}
async function makeClaim(indexedDB,origin,clock){const db=await openDb(indexedDB);try{
  const row={key:KEY,owner:DIRECT_OWNER,origin,claimed_at_ms:clock,hash:null};if(!validRow(row,origin))throw fail();
  await new Promise((resolve,reject)=>{
    let tx;try{tx=db.transaction(STORE,'readwrite',{durability:'strict'});if(tx.durability!=='strict')throw fail();
      const s=tx.objectStore(STORE);if(s.keyPath!=='key'||s.indexNames.length!==0)throw fail();const request=s.add(row);
      request.onerror=e=>{e.preventDefault();try{tx.abort()}catch{}}}catch{try{tx?.abort()}catch{}reject(fail());return}
    tx.oncomplete=resolve;tx.onabort=()=>reject(fail());tx.onerror=()=>{};
  });
  const saved=await readRow(db);if(!validRow(saved,origin)||!equal(saved,row))throw fail();return saved;
}finally{db.close()}}
async function recordHash(indexedDB,origin,original){if(!hash(original))throw fail();const db=await openDb(indexedDB);try{
  await new Promise((resolve,reject)=>{
    let tx;try{tx=db.transaction(STORE,'readwrite',{durability:'strict'});if(tx.durability!=='strict')throw fail();
      const s=tx.objectStore(STORE);if(s.keyPath!=='key'||s.indexNames.length!==0)throw fail();const request=s.get(KEY);
      request.onsuccess=()=>{const old=request.result;if(!validRow(old,origin)||(old.hash!==null&&old.hash!==original)){tx.abort();return}
        s.put({...old,hash:original})};request.onerror=()=>{try{tx.abort()}catch{}}}
    catch{try{tx?.abort()}catch{}reject(fail());return}
    tx.oncomplete=resolve;tx.onabort=()=>reject(fail());tx.onerror=()=>{};
  });
  const row=await readRow(db);if(!validRow(row,origin)||row.hash!==original)throw fail();return row;
}finally{db.close()}}

function successful(status){return plain(status) && status.Failure===undefined &&
  ((typeof status.SuccessValue==='string'&&status.SuccessReceiptId===undefined)||(typeof status.SuccessReceiptId==='string'&&status.SuccessValue===undefined))}
function events(result,name){const found=[];for(const r of result.receipts_outcome){if(r?.outcome?.executor_id!==DIRECT_PAYEE)continue;
  for(const log of r.outcome.logs??[]){if(typeof log!=='string'||!log.startsWith('EVENT_JSON:')||log.length>32768)continue;
    try{const e=JSON.parse(log.slice(11));if(e.standard==='near-outlayer' && e.event===name && Array.isArray(e.data))
      for(const data of e.data)found.push({data,id:r.id,outcome:r.outcome})}catch{}}
}return found}
function actions(receipt,predecessor,receiver){return receipt?.predecessor_id===predecessor&&receipt?.receiver_id===receiver&&
  Array.isArray(receipt.receipt?.Action?.actions)?receipt.receipt.Action.actions:null}

/** Exact transaction, provider events, output and refund; trusted RPC, not a TEE proof. */
export function verifyDirectOutlayerReceipt(original,result){
  if(!hash(original) || result?.final_execution_status!=='FINAL' || typeof result?.status?.SuccessValue!=='string' ||
     result?.transaction_outcome?.id!==original || result?.transaction?.hash!==original || result.transaction.signer_id!==DIRECT_OWNER ||
     result.transaction.receiver_id!==DIRECT_PAYEE || !Array.isArray(result.transaction.actions) || result.transaction.actions.length!==1)throw fail();
  const signed=result.transaction.actions[0]?.FunctionCall;
  if(!signed || signed.method_name!=='request_execution' || String(signed.deposit)!==DIRECT_DEPOSIT || String(signed.gas)!==DIRECT_GAS ||
     !equal(decoded(signed.args),directOutlayerArgs()) || !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome) ||
     !result.receipts_outcome.length || result.receipts_outcome.some(r=>!successful(r?.outcome?.status)))throw fail();
  const requests=result.receipts.flatMap(r=>{const a=actions(r,DIRECT_OWNER,DIRECT_PAYEE);return a?.length===1 && a[0]?.FunctionCall?.method_name==='request_execution'?[{receipt:r,call:a[0].FunctionCall}]:[]});
  if(requests.length!==1 || String(requests[0].call.deposit)!==DIRECT_DEPOSIT || String(requests[0].call.gas)!==DIRECT_GAS ||
     !equal(decoded(requests[0].call.args),directOutlayerArgs()) ||
     !result.receipts_outcome.some(r=>r.id===requests[0].receipt.receipt_id&&successful(r.outcome?.status)))throw fail();
  const requested=events(result,'execution_requested').filter(({data,id})=>{
    if(id!==requests[0].receipt.receipt_id)return false;
    try{const d=JSON.parse(data.request_data);return d.sender_id===DIRECT_OWNER && d.predecessor_id===DIRECT_OWNER && d.payment===DIRECT_DEPOSIT &&
      d.input_data===DIRECT_INPUT && equal(d.code_source,SOURCE) && d.project_id===DIRECT_PROJECT && d.project_uuid===DIRECT_UUID && String(d.attached_usd)==='0'}catch{return false}});
  const completed=events(result,'execution_completed').filter(({data,outcome})=>data?.success===true && data.sender_id===DIRECT_OWNER &&
    equal(data.code_source,SOURCE) && outcome.status?.SuccessValue===result.status.SuccessValue);
  if(requested.length!==1 || completed.length!==1)throw fail();
  const charged=amount(completed[0].data.payment_charged),refund=amount(completed[0].data.payment_refunded),maximum=BigInt(DIRECT_DEPOSIT);
  if(charged===null||refund===null||charged===0n||charged+refund!==maximum)throw fail();
  if(refund>0n){const transfers=result.receipts.filter(r=>{const a=actions(r,DIRECT_PAYEE,DIRECT_OWNER);
    return a?.length===1 && String(a[0]?.Transfer?.deposit)===refund.toString() &&
      result.receipts_outcome.some(o=>o.id===r.receipt_id&&successful(o.outcome?.status))});if(transfers.length!==1)throw fail()}
  const output=decoded(result.status.SuccessValue,4096),allowed=new Set(['success','token_id','source','price_usd','timestamp','warning']);
  if(!plain(output)||Object.keys(output).some(k=>!allowed.has(k))||output.success!==true||output.token_id!=='near'||output.source!=='custom'||
     typeof output.price_usd!=='number'||!Number.isFinite(output.price_usd)||output.price_usd<=0||
     !Number.isSafeInteger(output.timestamp)||output.timestamp<=0||
     (output.warning!==undefined&&(typeof output.warning!=='string'||output.warning.length>512)))throw fail();
  return Object.freeze({status:'FINAL_DIRECT_OUTLAYER_DELIVERY_MATCH',original_hash:original,owner:DIRECT_OWNER,provider:DIRECT_PAYEE,
    maximum_yocto:DIRECT_DEPOSIT,charged_yocto:charged.toString(),refunded_to_owner_yocto:refund.toString(),price_usd:output.price_usd,
    firewall_used:false,scope:'Direct testnet provider receipt from a trusted RPC; not Bouncer firewall, TEE or price accuracy proof.'});
}

/** Review, one wallet attempt, then read-only reconciliation. */
export function createDirectOutlayerTest({wallet,origin,isTopLevel,indexedDB,storage,fetch:fetchImpl=globalThis.fetch,isCurrent,now=Date.now,onChange=()=>{}}={}){
  if(!safeOrigin(origin,isTopLevel)||!wallet||wallet.manifest?.id!=='meteor-wallet'||wallet.manifest?.features?.signAndSendTransaction!==true||
     typeof wallet.signAndSendTransaction!=='function'||!indexedDB||typeof storage?.persist!=='function'||typeof storage?.persisted!=='function'||
     typeof fetchImpl!=='function'||typeof isCurrent!=='function'||typeof now!=='function'||typeof onChange!=='function')throw fail();
  let state={phase:'initial',busy:false,message:'No wallet transaction has been requested by this screen.'},review=null,disposed=false;
  const current=()=>{if(disposed||isCurrent()!==true)throw fail()};
  const set=patch=>{state={...state,...patch};if(!disposed)try{onChange(Object.freeze({...state}))}catch{}};
  const guard=async(allowed,work)=>{current();if(state.busy||!allowed.includes(state.phase))throw fail();const before=state.phase;set({busy:true});
    try{return await work()}catch(e){if(!disposed&&isCurrent()===true){
      if(state.phase==='claimed')set({phase:'unknown',message:'The wallet result is unknown. Find the original in Meteor history; do not approve another transaction.'});
      else if(before==='retained'||before==='unknown')set({phase:before,message:'Receipt not verified yet. You can check the original again, but do not send another transaction.'});
      else if(state.phase==='claiming')set({phase:'stopped',message:'The local one-shot record is unavailable. No wallet prompt was requested by this action; reopen the review before proceeding.'});
      else set({phase:'stopped',message:'The testnet check or phone storage is unavailable. No wallet transaction was requested by this action.'});
    }throw e}
    finally{if(!disposed&&isCurrent()===true)set({busy:false})}};
  async function readReceipt(original){const status=await call(fetchImpl,'status',[]);if(status?.chain_id!=='testnet')throw fail();
    const result=await call(fetchImpl,'EXPERIMENTAL_tx_status',{tx_hash:original,sender_account_id:DIRECT_OWNER,wait_until:'FINAL'},4_000_000);
    return verifyDirectOutlayerReceipt(original,result)}
  return Object.freeze({
    getState:()=>Object.freeze({...state}),destroy(){disposed=true},
    review:()=>guard(['initial','stopped'],async()=>{
      const prior=await readClaim(indexedDB,origin);current();
      if(prior){set({phase:prior.hash?'retained':'unknown',originalHash:prior.hash,
        message:prior.hash?'An original is already retained. Check its receipt; do not send again.':'A wallet attempt was already claimed. Find its original hash in Meteor; do not send again.'});return}
      const checked=await inspectDirectOutlayerReadiness({fetch:fetchImpl,now});current();review=checked;
      set({phase:'reviewed',message:'Direct OutLayer test is ready to review. No transaction has been requested.'});
    }),
    send:()=>guard(['reviewed'],async()=>{
      // Persistence is requested directly from the user's click. A declined or
      // unknown wallet result still consumes the claim: never retry the prompt.
      if(!(await storage.persist()) && !(await storage.persisted()))throw fail();current();
      const clock=now();if(!Number.isSafeInteger(clock)||!review||clock<review.checked_at_ms||clock-review.checked_at_ms>120_000)throw fail();
      set({phase:'claiming',message:'Saving the one-shot record. No wallet request yet.'});
      await makeClaim(indexedDB,origin,clock);current();set({phase:'claimed',message:'Opening Meteor for the one direct testnet transaction.'});
      let outcome;try{outcome=await wallet.signAndSendTransaction(directOutlayerTransaction())}catch{outcome=null}
      const candidates=[outcome?.transaction?.hash,outcome?.transaction_outcome?.id].filter(x=>x!==undefined);
      if(!candidates.length||candidates.some(x=>!hash(x))||new Set(candidates).size!==1){
        if(!disposed && isCurrent()===true)set({phase:'unknown',message:'The wallet result is unknown. Find the original in Meteor history; do not approve another transaction.'});return}
      const original=candidates[0];let retained=true;
      // Retain a returned hash even if the user closed or changed the wallet
      // session while Meteor was open. This operation cannot send anything.
      try{await recordHash(indexedDB,origin,original)}catch{retained=false}
      if(!disposed && isCurrent()===true)set({phase:'retained',originalHash:original,message:retained?
        'Original hash returned. Save it and check the receipt; do not send again.':
        'Save this original hash now. Local retention failed; do not send again.'});
    }),
    check:()=>guard(['retained','unknown'],async()=>{
      if(!hash(state.originalHash))throw fail();const receipt=await readReceipt(state.originalHash);current();
      set({phase:'verified',receipt,message:'The direct OutLayer receipt and refund were verified on testnet. This did not use the Bouncer firewall.'});
    }),
    recover:original=>guard(['unknown','retained','stopped'],async()=>{
      if(!hash(original))throw fail();const receipt=await readReceipt(original);current();
      await recordHash(indexedDB,origin,original);current();set({phase:'verified',originalHash:original,receipt,
        message:'The original direct OutLayer receipt and refund were verified. No new transaction was requested.'});
    }),
  });
}
