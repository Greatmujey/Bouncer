// Default-OFF server-to-server ciphertext backup handler. The capability is a
// bearer secret, NOT a NEAR key. The service-role key remains in this runtime.
// It cannot enroll, sign, broadcast, decrypt, verify receipts, or authorize a
// wallet prompt. Never log request bodies. No browser CORS and no retry.
const PROJECT='jiouaqwxkvlkmvyumzwc';
const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=()=>new Error('unavailable');
async function boundedText(stream,limit) {
  if(!stream||typeof stream.getReader!=='function')throw fail();
  const reader=stream.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(size+=value.byteLength)>limit){await reader.cancel();throw fail()}chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export function createV14MissionJournalBackupHandler({getEnv,fetch:fetchImpl,crypto}={}) {
  return async request=>{
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_MISSION_BACKUP_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    if(request.headers.has('origin'))return respond(403,{error:'unavailable'});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      const length=request.headers.get('content-length');
      if(length&&(!/^\d+$/.test(length)||Number(length)>300_000))throw fail();
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw fail();
      const data=JSON.parse(await boundedText(request.body,300_000));
      const base=['scope_id','capability','operation','goal_id','phase'];
      if(!data||!SCOPE.test(data.scope_id??'')||!HEX.test(data.capability??'')||!ID.test(data.goal_id??'')||
          !['pending','completed'].includes(data.phase)||!['read','append'].includes(data.operation)||
          !(data.operation==='read'?exact(data,base):exact(data,[...base,'expected_revision','expected_head_sha256','record'])))throw fail();
      let serialized=null;
      if(data.operation==='append') {
        if(!Number.isSafeInteger(data.expected_revision)||data.expected_revision<19||data.expected_revision>31||
            !HEX.test(data.expected_head_sha256??'')||!data.record||typeof data.record!=='object'||Array.isArray(data.record))throw fail();
        serialized=JSON.stringify(data.record);
        if(new TextEncoder().encode(serialized).length>270_000||data.record.scope_id!==data.scope_id||
            data.record.goal_id!==data.goal_id||data.record.phase!==data.phase||data.record.witness_revision!==data.expected_revision||
            data.record.witness_head_sha256!==data.expected_head_sha256)throw fail();
      }
      const hashBytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.capability)));
      const capabilityHash=Array.from(hashBytes,b=>b.toString(16).padStart(2,'0')).join('');
      const url=getEnv('SUPABASE_URL'),key=getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if(url!==`https://${PROJECT}.supabase.co`||typeof key!=='string'||!key)throw fail();
      const upstream=await fetchImpl(`${url}/rest/v1/rpc/bouncer_v14_mission_journal_backup_v1`,{
        method:'POST',redirect:'error',headers:{'content-type':'application/json',apikey:key,authorization:`Bearer ${key}`},
        body:JSON.stringify({p_scope_id:data.scope_id,p_capability_hash:capabilityHash,p_operation:data.operation,
          p_goal_id:data.goal_id,p_phase:data.phase,p_expected_revision:data.expected_revision??null,
          p_expected_head_sha256:data.expected_head_sha256??null,p_record:serialized}),signal:AbortSignal.timeout(12_000),
      });
      if(!upstream.ok)throw fail();
      const result=JSON.parse(await boundedText(upstream.body,300_000));
      if(exact(result,['status'])&&result.status==='MISSING'&&data.operation==='read')return respond(200,result);
      if(!exact(result,['status','record'])||result.status!=='EXISTING_BACKUP'||!result.record||
          result.record.scope_id!==data.scope_id||result.record.goal_id!==data.goal_id||result.record.phase!==data.phase)throw fail();
      return respond(200,result);
    }catch{return respond(503,{error:'unavailable'});}
  };
}
