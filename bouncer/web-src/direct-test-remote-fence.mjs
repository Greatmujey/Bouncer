// Testnet-only coordination for one approved direct provider attempt. The
// capability is held in this module's closure and sent only to the fixed HTTPS
// endpoint. The server is not a wallet, signer, policy, or proof of delivery.
const ENDPOINT='https://itzqbvbpmbnimvpyaige.supabase.co/functions/v1/bouncer-direct-one-shot';
const ORIGIN=/^https:\/\/[a-z0-9]{4,20}\.csb\.app$/;
const CAPABILITY=/^[A-Za-z0-9_-]{43}$/;
const HASH=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SESSION_KEY='bouncer.direct-outlayer.testnet.capability.v1';
const instances=new WeakMap();
const unavailable=()=>new Error('Direct-test journal unavailable; stop and reconcile.');

export function directTestCapability(location,sessionStorage){
  if(!ORIGIN.test(location?.origin||''))return '';
  try{
    const found=new URLSearchParams((location.hash||'').replace(/^#/,'' )).get('bouncer-direct')||'';
    if(found){if(!CAPABILITY.test(found))return '';try{sessionStorage?.setItem(SESSION_KEY,found)}catch{}return found;}
    const stored=sessionStorage?.getItem(SESSION_KEY)||'';
    return CAPABILITY.test(stored)?stored:'';
  }catch{return ''}
}

export function createRemoteDirectFence({origin,capability,fetch:fetchImpl=globalThis.fetch}={}){
  if(!ORIGIN.test(origin||'')||!CAPABILITY.test(capability||'')||typeof fetchImpl!=='function')throw unavailable();
  const state={origin,verified:false};
  const request=async(operation,original)=>{
    const body={operation,capability};if(original!==undefined)body.original_hash=original;
    const response=await fetchImpl(ENDPOINT,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',
      headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw unavailable();
    const text=await response.text();if(text.length>4096)throw unavailable();let result;
    try{result=JSON.parse(text)}catch{throw unavailable()}
    if(!result || Object.keys(result).sort().join(',')!=='claim_acquired,expired,original_hash,scope,state' || result.scope!=='direct' ||
       !['ready','claimed','retained'].includes(result.state) || typeof result.expired!=='boolean' || typeof result.claim_acquired!=='boolean' ||
       (result.state==='retained'?!HASH.test(result.original_hash||''):result.original_hash!==null) ||
       (operation!=='claim'&&result.claim_acquired) || (result.claim_acquired&&(result.state!=='claimed'||result.expired)))throw unavailable();
    state.verified=true;return Object.freeze({...result});
  };
  const fence=Object.freeze({read:()=>request('read'),claim:()=>request('claim'),retain:original=>{
    if(!HASH.test(original||''))throw unavailable();return request('retain',original);
  }});
  instances.set(fence,state);return fence;
}

export function isVerifiedRemoteDirectFence(fence,origin){
  const value=instances.get(fence);return value?.origin===origin && value.verified===true;
}
