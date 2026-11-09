// Default-OFF, server-to-server V14 public-original checkpoint. The separate
// project service-role key stays inside this runtime. This service never signs,
// broadcasts, provisions a scope or verifies consent/receipts. A capability is
// a private bearer secret, not a wallet key. Never log request bodies.
const PROJECT='jiouaqwxkvlkmvyumzwc';
const HEX=/^[a-f0-9]{64}$/, SCOPE=/^[a-f0-9]{32}$/;
const exact=(x,keys)=>x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).length===keys.length && keys.every(k=>Object.hasOwn(x,k));
async function boundedText(stream,limit) {
  if (!stream || typeof stream.getReader!=='function') throw Error();
  const reader=stream.getReader(), chunks=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (size+=value.byteLength)>limit) { await reader.cancel(); throw Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset);offset+=chunk.byteLength; }
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}

export function createV14OriginalCheckpointHandler({getEnv,fetch:fetchImpl,crypto}) {
  return async request=>{
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    // No browser CORS: enrollment and owner authentication are not implemented.
    // The feature must be explicitly activated after provisioning/review.
    if (getEnv('BOUNCER_V14_CHECKPOINT_ENABLE')!=='1') return respond(503,{error:'unavailable'});
    if (request.headers.has('origin')) return respond(403,{error:'unavailable'});
    if (request.method!=='POST') return respond(405,{error:'unavailable'});
    try {
      const declared=request.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared)>40_000)) throw Error();
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')) throw Error();
      const text=await boundedText(request.body,40_000);
      const data=JSON.parse(text);
      const base=['scope_id','capability','operation'];
      if (!data || !SCOPE.test(data.scope_id ?? '') || !HEX.test(data.capability ?? '') ||
          !['read','append'].includes(data.operation) ||
          !(data.operation==='read' ? exact(data,base) : exact(data,[...base,'expected_revision','expected_head_sha256','record']))) throw Error();
      if (data.operation==='append' && (!Number.isSafeInteger(data.expected_revision) || data.expected_revision<0 || data.expected_revision>=32 ||
          !HEX.test(data.expected_head_sha256 ?? '') || typeof data.record!=='string' || !data.record ||
          new TextEncoder().encode(data.record).length>24_576 || /[\r\n]/.test(data.record))) throw Error();
      const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.capability)));
      const capabilityHash=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      const projectUrl=getEnv('SUPABASE_URL'),key=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if (projectUrl!==`https://${PROJECT}.supabase.co` || typeof key!=='string' || !key) throw Error();
      const upstream=await fetchImpl(`${projectUrl}/rest/v1/rpc/bouncer_v14_original_checkpoint_v1`,{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',apikey:key,authorization:`Bearer ${key}`},
        body:JSON.stringify({p_scope_id:data.scope_id,p_capability_hash:capabilityHash,p_operation:data.operation,
          p_expected_revision:data.expected_revision ?? null,p_expected_head_sha256:data.expected_head_sha256 ?? null,p_record:data.record ?? null}),
        signal:AbortSignal.timeout(12_000),
      });
      if (!upstream.ok) throw Error();
      const raw=await boundedText(upstream.body,900_000);
      const result=JSON.parse(raw);
      if (!exact(result,['revision','head_sha256','events']) || !Number.isSafeInteger(result.revision) || result.revision<0 || result.revision>32 ||
          !HEX.test(result.head_sha256 ?? '') || !Array.isArray(result.events) || result.events.length!==result.revision ||
          result.events.some(line=>typeof line!=='string' || new TextEncoder().encode(line).length>24_576 || /[\r\n]/.test(line))) throw Error();
      return respond(200,result);
    } catch { return respond(503,{error:'unavailable'}); }
  };
}

if (typeof Deno!=='undefined') {
  Deno.serve(createV14OriginalCheckpointHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
