// Fixed public indexer lookup. It never signs, broadcasts or proves history is complete.
import {validOriginalHash} from './vault-inspector.mjs';
const validAccount=id=>typeof id==='string'&&id.length>=2&&id.length<=64&&/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id);
export const ACTIVITY_ACCOUNT='native.great_mujey.testnet';
const URL='https://api-testnet.nearblocks.io/v3/accounts/native.great_mujey.testnet/txns?limit=25';
async function readBounded(response,max=131072) {
  if(!response?.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??'')||!response.body?.getReader)throw Error('unavailable');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(length+=value.length)>max){await reader.cancel();throw Error('too large')}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(length);let pos=0;for(const c of chunks){bytes.set(c,pos);pos+=c.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function normalize(row){
  if(!row||typeof row!=='object'||Array.isArray(row)||!validOriginalHash(row.transaction_hash)||
    !validAccount(row.signer_account_id)||!validAccount(row.receiver_account_id)||
    (row.signer_account_id!==ACTIVITY_ACCOUNT&&row.receiver_account_id!==ACTIVITY_ACCOUNT)||
    !/^[0-9]{1,20}$/.test(row.block?.block_height??'')||!Array.isArray(row.actions)||row.actions.length<1||row.actions.length>12||
    !row.actions.every(x=>x&&typeof x==='object'&&/^[A-Z_]{1,40}$/.test(x.action??'')&&
      (x.method===null||x.method===undefined||typeof x.method==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(x.method)))||
    !(typeof row.outcomes?.status==='boolean'||row.outcomes?.status===null||row.outcomes?.status===undefined))throw Error('invalid activity');
  return {hash:row.transaction_hash,signer:row.signer_account_id,receiver:row.receiver_account_id,
    blockHeight:row.block.block_height,actions:row.actions.map(x=>x.method?`${x.action}: ${x.method}`:x.action),
    reportedSuccess:row.outcomes?.status??null};
}
export async function inspectVaultActivity({fetch:fetchImpl=globalThis.fetch,signal}={}) {
  if(typeof fetchImpl!=='function')throw Error('unavailable');
  const response=await fetchImpl(URL,{method:'GET',headers:{accept:'application/json'},credentials:'omit',redirect:'error',cache:'no-store',signal});
  const body=await readBounded(response);
  if(!body||!Array.isArray(body.data)||body.data.length>25||body.errors)throw Error('invalid activity');
  return {source:'NearBlocks testnet v3',account:ACTIVITY_ACCOUNT,items:body.data.map(normalize),completeHistoryProven:false};
}
export function setupVaultActivity(doc,{fetch:fetchImpl=globalThis.fetch}={}) {
  const button=doc.querySelector('#vault-activity-check'),message=doc.querySelector('#vault-activity-status'),list=doc.querySelector('#vault-activity-list');
  if(!button||!message||!list)return;
  let busy=false;
  button.addEventListener('click',async()=>{
    if(busy)return;busy=true;button.disabled=true;list.replaceChildren();message.textContent='Checking indexed activity…';
    try {
      const response=await fetchImpl('/api/railway-connection?activity=1',{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
      const data=await readBounded(response,32_768);
      if(!data||data.source!=='NearBlocks testnet v3'||data.account!==ACTIVITY_ACCOUNT||data.completeHistoryProven!==false||
         !Array.isArray(data.items)||data.items.length>25||data.items.some(item=>!validOriginalHash(item?.hash)||
           !validAccount(item?.signer)||!validAccount(item?.receiver)||
           (item.signer!==ACTIVITY_ACCOUNT&&item.receiver!==ACTIVITY_ACCOUNT)||
           !/^[0-9]{1,20}$/.test(item.blockHeight??'')||!Array.isArray(item.actions)||item.actions.length<1||item.actions.length>12||
           !item.actions.every(a=>typeof a==='string'&&/^[A-Z_]{1,40}(?:: [A-Za-z0-9_]{1,80})?$/.test(a))||
           !(typeof item.reportedSuccess==='boolean'||item.reportedSuccess===null)))throw Error('invalid');
      for(const item of data.items){
        const li=doc.createElement('li'),description=doc.createElement('span'),link=doc.createElement('a');
        description.textContent=`${item.actions.join(', ')} · block ${item.blockHeight} · ${item.reportedSuccess===true?'indexer reports success':item.reportedSuccess===false?'indexer reports failure':'status unknown'} · ${item.signer} → ${item.receiver} `;
        link.textContent='View transaction ↗';link.href=`https://testnet.nearblocks.io/txns/${item.hash}`;
        link.target='_blank';link.rel='noopener noreferrer';li.append(description,link);list.append(li);
      }
      message.textContent=`NearBlocks reports ${data.items.length} recent transaction${data.items.length===1?'':'s'}. This indexer list may be incomplete; it cannot prove nothing else happened or authorize a retry.`;
    } catch {message.textContent='Indexed activity is unavailable. History remains unknown; do not repeat an uncertain transaction.'}
    finally{busy=false;button.disabled=false}
  });
}
