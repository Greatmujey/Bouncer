// Default-OFF browser bridge for the separately provisioned V14 checkpoint.
// The only authority is a random scope capability, NOT a NEAR key or owner
// signature. Anyone who learns it can read/append public original history;
// restrict access to the reviewed origin and never log the request body. This
// does not enroll a scope, authenticate an owner, sign, send or verify a
// receipt. Review abuse/rate limits and the exact deployed bundle before use.
import {createV14OriginalCheckpointHandler} from './v14-original-checkpoint-handler.mjs';
import {boundedV14Text} from './v14-owner-nep413.mjs';
import {V14_ENROLLMENT_SITE} from '../web-src/v14-checkpoint-enrollment.mjs';

export function createV14BrowserOriginalCheckpointHandler({getEnv,fetch:fetchImpl,crypto}={}) {
  const inner=createV14OriginalCheckpointHandler({
    // The independently enabled browser bridge does not turn on the separate
    // server-to-server endpoint. All other values remain the real environment.
    getEnv:key=>key==='BOUNCER_V14_CHECKPOINT_ENABLE'?'1':getEnv(key),fetch:fetchImpl,crypto,
  });
  return async request=>{
    const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff',
      'access-control-allow-origin':V14_ENROLLMENT_SITE,'access-control-allow-methods':'POST, OPTIONS',
      'access-control-allow-headers':'content-type',vary:'Origin'};
    const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers});
    if(getEnv('BOUNCER_V14_BROWSER_CHECKPOINT_ENABLE')!=='1')return respond(503,{error:'unavailable'});
    let requestUrl;
    try { requestUrl=new URL(request.url); } catch { return respond(403,{error:'unavailable'}); }
    if(requestUrl.search || requestUrl.hash || request.headers.get('origin')!==V14_ENROLLMENT_SITE)return respond(403,{error:'unavailable'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'unavailable'});
    try {
      if(request.headers.has('cookie') || request.headers.has('authorization') || request.headers.has('apikey'))throw Error();
      const length=request.headers.get('content-length'),contentType=request.headers.get('content-type')||'';
      if(length&&(!/^\d+$/.test(length)||Number(length)>40_000))throw Error();
      if(!/^application\/json(?:\s*;|$)/i.test(contentType))throw Error();
      const body=await boundedV14Text(request.body,40_000);
      // Rebuild a minimal server-side request after the browser origin check.
      // No cookie, URL parameter, bearer header or incoming Origin is forwarded.
      const forwarded=new Request('https://bouncer-checkpoint.internal/',{method:'POST',
        headers:{'content-type':'application/json'},body});
      const response=await inner(forwarded),result=await boundedV14Text(response.body,900_000);
      return new Response(result,{status:response.status,headers});
    }catch{return respond(503,{error:'unavailable'});}
  };
}
if(typeof Deno!=='undefined') {
  Deno.serve(createV14BrowserOriginalCheckpointHandler({getEnv:key=>Deno.env.get(key),fetch:globalThis.fetch.bind(globalThis),crypto:globalThis.crypto}));
}
