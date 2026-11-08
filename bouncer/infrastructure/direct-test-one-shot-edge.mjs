// Public testnet-only one-shot endpoint. It never signs, broadcasts, or holds a
// wallet key. The project service-role key is read only by this server runtime
// and is never returned, logged, or accepted from the browser.
const PROJECT='itzqbvbpmbnimvpyaige';
const ORIGIN=/^https:\/\/[a-z0-9]{4,20}\.csb\.app$/;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const HASH=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createDirectOneShotHandler({getEnv,fetch:fetchImpl,crypto}) {
  return async request=>{
    const origin=request.headers.get('origin') || '';
    const headers={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type','access-control-max-age':'600',vary:'Origin',
      'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(!ORIGIN.test(origin))return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try{
      const declared=request.headers.get('content-length');
      if(declared && (!/^\d+$/.test(declared)||Number(declared)>2048))return respond(400,{error:'unavailable'});
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return respond(400,{error:'unavailable'});
      const raw=await request.text();if(raw.length>2048)throw Error('oversized');
      const data=JSON.parse(raw),keys=Object.keys(data||{}).sort().join(',');
      if(!data || !['capability,operation','capability,operation,original_hash'].includes(keys) ||
         !TOKEN.test(data.capability||'') || !['read','claim','retain'].includes(data.operation) ||
         (data.operation==='retain' ? !HASH.test(data.original_hash||'') : Object.hasOwn(data,'original_hash')))throw Error('invalid');
      const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.capability)));
      const digest=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      const projectUrl=getEnv('SUPABASE_URL'),key=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(projectUrl!==`https://${PROJECT}.supabase.co` || typeof key!=='string' || !key)throw Error('not configured');
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_direct_test_v1`,{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',apikey:key,authorization:`Bearer ${key}`},
        body:JSON.stringify({p_capability_hash:digest,p_origin:origin,p_operation:data.operation,p_original_hash:data.original_hash||null}),
        signal:AbortSignal.timeout(12000),
      });
      if(!upstream.ok)throw Error('journal unavailable');
      const result=await upstream.json();
      if(!result || result.error || !['direct','probe'].includes(result.scope) || !['ready','claimed','retained'].includes(result.state) ||
         typeof result.claim_acquired!=='boolean' || typeof result.expired!=='boolean' ||
         (result.original_hash!==null&&!HASH.test(result.original_hash)))throw Error('invalid journal response');
      return respond(200,{scope:result.scope,state:result.state,original_hash:result.original_hash,
        claim_acquired:result.claim_acquired,expired:result.expired});
    }catch{return respond(503,{error:'unavailable'});}
  };
}

if(typeof Deno!=='undefined') {
  Deno.serve(createDirectOneShotHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
