/** Default-off HTTP adapter for the independent Railway recovery anchor.
 * Narrow fixed origins, bounded JSON, no key custody or transaction routes.
 * Writes are separately disabled unless explicitly opted in by the caller;
 * the hosted standby does not opt in while initialization is uncertain.
 * An HTTP failure after a write is uncertain and must not be retried. */
import {V14_BOOTSTRAP_ORIGINS} from '../shared/v14-bootstrap-protocol.mjs';

export const V14_RAILWAY_ANCHOR_PATH='/api/v14-bootstrap-anchor';
const HOST='bouncer-production-6df1.up.railway.app';
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
async function body(req){
  const len=req.headers['content-length'];if(len!==undefined&&(!/^\d+$/.test(len)||Number(len)>48_000))throw Error();
  const chunks=[];let size=0;
  for await(const part of req){size+=part.length;if(size>48_000)throw Error();chunks.push(part)}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
}
export function createV14BootstrapRailwayAnchorHttp({anchor,fetch:fetchImpl=globalThis.fetch,now=Date.now,allowWrites=false}={}) {
  if(!anchor||['initialize','read','append','recoverByOwner','inspectByOwner'].some(name=>typeof anchor[name]!=='function')||
    typeof fetchImpl!=='function'||typeof now!=='function'||typeof allowWrites!=='boolean')throw Error('invalid recovery anchor');
  let active=0;
  return async function handle(req,res){
    const origin=req.headers.origin||'',allowed=V14_BOOTSTRAP_ORIGINS.includes(origin);
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
      'referrer-policy':'no-referrer',vary:'Origin',...(allowed?{'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}:{})};
    const respond=(code,result)=>{res.writeHead(code,headers);res.end(result===null?undefined:JSON.stringify(result))};
    if(req.url!==V14_RAILWAY_ANCHOR_PATH||req.headers.host!==HOST||
      (req.headers['x-forwarded-proto']&&req.headers['x-forwarded-proto']!=='https')||!allowed){req.resume();return respond(403,{error:'unavailable'})}
    if(req.method==='OPTIONS'){req.resume();return respond(204,null)}
    if(req.method!=='POST'){req.resume();return respond(405,{error:'unavailable'})}
    if(req.headers.cookie||req.headers.authorization||req.headers.apikey||
      !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){req.resume();return respond(403,{error:'unavailable'})}
    if(active>=4){req.resume();return respond(429,{error:'unavailable'})}active++;
    try {
      const timer=setTimeout(()=>req.destroy(),10_000);timer.unref?.();let data;
      try{data=await body(req)}finally{clearTimeout(timer)}
      let result;
      if(data?.operation==='initialize'){
        if(!allowWrites||!exact(data,['operation','scope_id','review_sha256','capability','initialization_signature','review_text','sealed_kit','owner_attestation']))throw Error();
        const {operation,...input}=data;result=await anchor.initialize(input);
      }else if(data?.operation==='read'){
        if(!exact(data,['operation','scope_id','capability']))throw Error();
        result=await anchor.read({scope_id:data.scope_id,capability:data.capability});
      }else if(data?.operation==='append'){
        if(!allowWrites||!exact(data,['operation','scope_id','capability','expected_revision','expected_head_sha256','record']))throw Error();
        const {operation,...input}=data;result=await anchor.append(input);
      }else if(data?.operation==='recover_owner'||data?.operation==='inspect_owner'){
        if(!exact(data,['operation','terms','nonce_base64','signature_base64']))throw Error();
        const {operation,...signed}=data,request={signed,origin,fetch:fetchImpl,now};
        result=operation==='recover_owner'?await anchor.recoverByOwner(request):await anchor.inspectByOwner(request);
      }else throw Error();
      return respond(200,result);
    }catch{return respond(503,{error:'unavailable'})}finally{active--}
  };
}
