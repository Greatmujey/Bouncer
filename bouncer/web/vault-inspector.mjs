// Public testnet reads only: no wallet connection, key material or transaction.
// A snapshot does not establish ownership control, complete history or readiness.
const RPC='https://test.rpc.fastnear.com/';
const CODE='3kWXAzXhFXaYMTbHogVFRwJpTGXTj9jd5J6jUMrBPSFR';
const VERSION='bouncer-agent-v14-native-storage-testnet';
const HASH=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function validVaultAccount(id) {
  return typeof id==='string'&&id.length<=64&&/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/.test(id);
}
async function bounded(response,max=131_072) {
  if(!response?.ok||!response.body?.getReader)throw Error('unavailable');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(total+=value.length)>max){await reader.cancel();throw Error('invalid')};chunks.push(value)}}
  finally{reader.releaseLock()}
  const data=new Uint8Array(total);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
}
async function rpc(fetchImpl,id,method,params,signal,max=131_072) {
  const response=await fetchImpl(RPC,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
    headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal});
  const value=await bounded(response,max);
  if(value?.jsonrpc!=='2.0'||value.id!==id||value.error||!value.result||typeof value.result!=='object')throw Error('invalid');
  return value.result;
}
function view(result,hash,height) {
  if(result.block_hash!==hash||result.block_height!==height||!Array.isArray(result.result)||result.result.length>1024||
      !result.result.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw Error('invalid');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(result.result)));
}
export async function inspectVault(accountId,{fetch:fetchImpl=globalThis.fetch,signal}={}) {
  if(!validVaultAccount(accountId)||typeof fetchImpl!=='function')throw Error('invalid');
  if((await rpc(fetchImpl,'vault-status','status',[],signal)).chain_id!=='testnet')throw Error('wrong network');
  const block=await rpc(fetchImpl,'vault-block','block',{finality:'final'},signal),hash=block.header?.hash,height=block.header?.height;
  if(!HASH.test(hash??'')||!Number.isSafeInteger(height)||height<0)throw Error('invalid block');
  const base={account_id:accountId,block_id:hash};
  const requests=[
    rpc(fetchImpl,'vault-account','query',{...base,request_type:'view_account'},signal),
    rpc(fetchImpl,'vault-keys','query',{...base,request_type:'view_access_key_list'},signal),
    rpc(fetchImpl,'vault-owner','query',{...base,request_type:'call_function',method_name:'get_owner',args_base64:'e30='},signal),
    rpc(fetchImpl,'vault-version','query',{...base,request_type:'call_function',method_name:'contract_version',args_base64:'e30='},signal),
  ];
  const [account,keys,owner,version]=await Promise.allSettled(requests);
  const at=x=>x?.block_hash===hash&&x?.block_height===height;
  let code='unknown',fullAccessKeys=null,ownerId=null,versionStatus=null;
  if(account.status==='fulfilled'&&at(account.value)&&HASH.test(account.value.code_hash??''))code=account.value.code_hash===CODE?'matches V14':'different from V14';
  if(keys.status==='fulfilled'&&at(keys.value)&&Array.isArray(keys.value.keys)&&keys.value.keys.length<=1000&&
      keys.value.keys.every(x=>x?.access_key?.permission==='FullAccess'||(x?.access_key?.permission&&
        typeof x.access_key.permission==='object'&&!Array.isArray(x.access_key.permission)&&x.access_key.permission.FunctionCall))) {
    fullAccessKeys=keys.value.keys.filter(x=>x.access_key.permission==='FullAccess').length;
  }
  try{if(owner.status==='fulfilled'){const x=view(owner.value,hash,height);if(validVaultAccount(x))ownerId=x}}catch{}
  try{if(version.status==='fulfilled'){const x=view(version.value,hash,height);if(typeof x==='string'&&x.length<=100)versionStatus=x===VERSION?'matches V14':'different from V14'}}catch{}
  return {accountId,blockHeight:height,code,owner:ownerId,version:versionStatus,fullAccessKeys};
}
export function setupVaultInspector(doc,{fetch:fetchImpl=globalThis.fetch}={}) {
  const form=doc.querySelector('#vault-inspector-form'),input=doc.querySelector('#vault-inspector-account'),
    button=doc.querySelector('#vault-inspector-submit'),result=doc.querySelector('#vault-inspector-result');
  if(!form||!input||!button||!result)return;
  let generation=0;
  input.addEventListener('input',()=>{generation++;result.textContent='Account changed. Run the check again.'});
  form.addEventListener('submit',async event=>{
    event.preventDefault();const id=input.value.trim(),current=++generation;
    if(!validVaultAccount(id)){result.textContent='Enter a valid account ending in .testnet.';return}
    button.disabled=true;result.textContent='Checking public testnet data…';
    try {
      const response=await fetchImpl(`/api/railway-connection?vault=${encodeURIComponent(id)}`,{method:'GET',credentials:'omit',
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20_000)});
      // A server-side network outage is not an empty vault. For this public
      // read only, the user's browser can try the same fixed RPC directly.
      const check=response.status===503?await inspectVault(id,{fetch:fetchImpl,signal:AbortSignal.timeout(15_000)}):await bounded(response,4096);
      if(!check||Array.isArray(check)||Object.keys(check).sort().join(',')!=='accountId,blockHeight,code,fullAccessKeys,owner,version'||
          check.accountId!==id||!Number.isSafeInteger(check.blockHeight)||check.blockHeight<0||
          !['unknown','matches V14','different from V14'].includes(check.code)||
          !(check.fullAccessKeys===null||(Number.isSafeInteger(check.fullAccessKeys)&&check.fullAccessKeys>=0&&check.fullAccessKeys<=1000))||
          !(check.owner===null||validVaultAccount(check.owner))||
          !(check.version===null||['matches V14','different from V14'].includes(check.version)))throw Error('invalid');
      if(current!==generation)return;
      const keys=check.fullAccessKeys===null?'unknown':String(check.fullAccessKeys);
      const warning=check.fullAccessKeys>0?' A FullAccess key can move funds and change code.':'';
      result.textContent=`Final block ${check.blockHeight}\nContract code: ${check.code}\nContract owner: ${check.owner??'unknown'}\nContract version: ${check.version??'unknown'}\nFullAccess keys: ${keys}.${warning}\nThis snapshot does not verify wallet control, transaction history, backups, or mission readiness.`;
    }catch {if(current===generation)result.textContent='Testnet check unavailable. Vault state, keys and history are unknown; no transaction was sent.'}
    finally{button.disabled=false}
  });
}


// Recovery by a known public original only. Never guesses missing hashes or
// treats an unavailable lookup as permission to try a transaction again.
const ORIGINAL_SIGNER='great_mujey.testnet',ORIGINAL_RECEIVER='native.great_mujey.testnet';
export function validOriginalHash(value) {
  if(typeof value!=='string'||!HASH.test(value))return false;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number=0n;for(const ch of value)number=number*58n+BigInt(alphabet.indexOf(ch));
  let bytes=0;for(let n=number;n>0n;n>>=8n)bytes++;
  for(const ch of value){if(ch!=='1')break;bytes++}
  return bytes===32;
}
export async function inspectOriginalTransaction(hash,{fetch:fetchImpl=globalThis.fetch,signal}={}) {
  if(!validOriginalHash(hash)||typeof fetchImpl!=='function')throw Error('invalid');
  if((await rpc(fetchImpl,'original-status','status',[],signal)).chain_id!=='testnet')throw Error('wrong network');
  const found=await rpc(fetchImpl,'original-receipts','EXPERIMENTAL_tx_status',
    {tx_hash:hash,sender_account_id:ORIGINAL_SIGNER,wait_until:'FINAL'},signal,4_000_000);
  if(found.transaction?.hash!==hash||found.transaction?.signer_id!==ORIGINAL_SIGNER||
      found.transaction?.receiver_id!==ORIGINAL_RECEIVER)throw Error('original mismatch');
  if(found.final_execution_status!=='FINAL')return {hash,state:'unresolved',receiptFailures:null};
  const status=found.status;
  if(!status||typeof status!=='object'||Array.isArray(status)||Object.keys(status).length!==1)throw Error('invalid');
  let state;
  if(typeof status.SuccessValue==='string')state='final_success';
  else if(status.Failure&&typeof status.Failure==='object'&&!Array.isArray(status.Failure))state='final_failure';
  else return {hash,state:'unresolved',receiptFailures:null};
  if(!Array.isArray(found.receipts_outcome)||found.receipts_outcome.length>10_000)throw Error('invalid');
  let failures=0;
  for(const receipt of found.receipts_outcome){
    const outcome=receipt?.outcome?.status;
    if(!outcome||typeof outcome!=='object'||Array.isArray(outcome)||Object.keys(outcome).length!==1)throw Error('invalid');
    if(outcome.Failure&&typeof outcome.Failure==='object')failures++;
    else if(typeof outcome.SuccessValue!=='string'&&typeof outcome.SuccessReceiptId!=='string')throw Error('invalid');
  }
  return {hash,state,receiptFailures:failures};
}
export function setupOriginalInspector(doc,{fetch:fetchImpl=globalThis.fetch}={}) {
  const form=doc.querySelector('#original-inspector-form'),input=doc.querySelector('#original-inspector-hash'),
    button=doc.querySelector('#original-inspector-submit'),result=doc.querySelector('#original-inspector-result');
  if(!form||!input||!button||!result)return;
  let generation=0,busy=false;
  input.addEventListener('input',()=>{generation++;result.textContent='Hash changed. Run the check again.'});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;const hash=input.value.trim(),current=++generation;
    if(!validOriginalHash(hash)){result.textContent='Enter the original testnet transaction hash.';return}
    busy=true;button.disabled=true;result.textContent='Checking the original transaction…';
    try {
      const response=await fetchImpl(`/api/railway-connection?original=${encodeURIComponent(hash)}`,{method:'GET',credentials:'omit',
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20_000)});
      const check=response.status===503?await inspectOriginalTransaction(hash,{fetch:fetchImpl,signal:AbortSignal.timeout(15_000)}):await bounded(response,4096);
      if(!check||Array.isArray(check)||Object.keys(check).sort().join(',')!=='hash,receiptFailures,state'||check.hash!==hash||
          !['unresolved','final_success','final_failure'].includes(check.state)||
          !(check.state==='unresolved'?check.receiptFailures===null:
            Number.isSafeInteger(check.receiptFailures)&&check.receiptFailures>=0&&check.receiptFailures<=10_000))throw Error('invalid');
      if(current!==generation)return;
      const label={unresolved:'Not final or unresolved',final_success:'Final transaction result: success',final_failure:'Final transaction result: failure'}[check.state];
      const failures=check.receiptFailures===null?'unknown':String(check.receiptFailures);
      result.textContent=`${label}\nFailed receipt outcomes reported: ${failures}\nThis checks only the supplied hash, not all history or mission delivery. Do not resend an uncertain transaction.`;
    }catch{if(current===generation)result.textContent='Original lookup unavailable or does not match this vault. Its status and history remain unknown; do not resend.'}
    finally{busy=false;button.disabled=false}
  });
}
