// Read-only browser client for a separately hosted V14 checkpoint. No wallet
// transaction, capability reset, journal recreation, or automatic retry.
// The endpoint and UI remain disabled until independently configured/reviewed.
import {validateV14RecoveryTerms} from './v14-checkpoint-recovery.mjs';
import {inspectV14PublicHistory} from './v14-checkpoint-history.mjs';
import {V14_ENROLLMENT_SITE,V14_ENROLLMENT_RECIPIENT} from './v14-checkpoint-enrollment.mjs';

export const V14_CHECKPOINT_RECOVERY_ENDPOINT='https://jiouaqwxkvlkmvyumzwc.supabase.co/functions/v1/bouncer-v14-checkpoint-recovery';
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('V14 checkpoint recovery unavailable; absence is not proven and originals must not be resent');
async function boundedText(stream,limit) {
  if(!stream || typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail();}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export function createV14CheckpointRecoveryClient({location,crypto=globalThis.crypto,fetch:fetchImpl=globalThis.fetch,isCurrent=()=>true,now=Date.now}={}) {
  if(location?.origin!==V14_ENROLLMENT_SITE || location?.host!==V14_ENROLLMENT_RECIPIENT || !crypto?.subtle ||
     typeof fetchImpl!=='function' || typeof isCurrent!=='function' || typeof now!=='function')throw fail();
  const current=()=>{if(!isCurrent())throw fail();};
  return Object.freeze({
    async enabled() {
      try {
        current();
        const response=await fetchImpl(V14_CHECKPOINT_RECOVERY_ENDPOINT,{method:'GET',mode:'cors',credentials:'omit',redirect:'error',
          cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8_000)});
        current();if(!response.ok)return false;
        const result=JSON.parse(await boundedText(response.body,1024));
        return exact(result,['status','wallet_transaction_authorized']) && result.status==='V14_READ_ONLY_RECOVERY_READY' &&
          result.wallet_transaction_authorized===false;
      }catch{return false;}
    },
    async read(submission) {
      current();
      if(!exact(submission,['terms','nonce_base64','signature_base64']) ||
         !/^[A-Za-z0-9+/]{43}=$/.test(submission.nonce_base64??'') || !/^[A-Za-z0-9+/]{86}==$/.test(submission.signature_base64??''))throw fail();
      const terms=validateV14RecoveryTerms(submission.terms,{now:now()}),body=JSON.stringify({terms,nonce_base64:submission.nonce_base64,
        signature_base64:submission.signature_base64});
      try {
        const response=await fetchImpl(V14_CHECKPOINT_RECOVERY_ENDPOINT,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',
          cache:'no-store',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(30_000)});
        current();if(!response.ok)throw fail();
        const result=JSON.parse(await boundedText(response.body,900_000));
        if(!exact(result,['status','scope_id','revision','head_sha256','events','absence_verified','wallet_transaction_authorized']) ||
           result.status!=='CHECKPOINT_HISTORY_READ' || result.absence_verified!==false || result.wallet_transaction_authorized!==false)throw fail();
        const snapshot={status:'EXISTING_CHECKPOINT',scope_id:result.scope_id,revision:result.revision,
          head_sha256:result.head_sha256,events:result.events};
        const checked=await inspectV14PublicHistory({snapshot,owner:terms.owner,vault:terms.vault,crypto});
        current();return checked;
      }catch{throw fail();}
    },
  });
}
