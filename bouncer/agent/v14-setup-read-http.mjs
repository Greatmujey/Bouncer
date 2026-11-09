/** Secret-gated, read-only Railway ingress for V14 setup verification.
 * It never signs, broadcasts, enrolls a checkpoint, accepts a passphrase or
 * changes the standby/mission execution mode. Off unless explicitly mounted. */
import {timingSafeEqual} from 'node:crypto';
import {validateNativeProxySiteOrigin,validateRailwayNativeBackend,validateNativeProxySecret} from './native-mission-proxy.mjs';
import {V14_ENROLLMENT_SITE} from '../web-src/v14-checkpoint-enrollment.mjs';

const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(key=>Object.hasOwn(x,key));
function reply(res,status,value) {res.writeHead(status,headers);res.end(JSON.stringify(value));}
function matches(actual,expected) {
  return typeof actual==='string'&&/^[a-f0-9]{64}$/.test(actual)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
async function body(req) {
  if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>24_000))throw Error();
  const chunks=[];let total=0;const timer=setTimeout(()=>req.destroy(),10_000);timer.unref?.();
  try {for await(const chunk of req){total+=chunk.length;if(total>24_000)throw Error();chunks.push(chunk)}} finally {clearTimeout(timer)}
  if(!total)throw Error();return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
}

export function createV14SetupReadHttpHandler({service,siteOrigin,backendOrigin,proxySecret,now=Date.now}={}) {
  const origin=validateNativeProxySiteOrigin(siteOrigin),host=new URL(validateRailwayNativeBackend(backendOrigin)).host,
    secret=validateNativeProxySecret(proxySecret);
  if(origin!==V14_ENROLLMENT_SITE||!service||typeof service.preflight!=='function'||typeof service.receipt!=='function'||typeof now!=='function')throw Error('invalid V14 read-only setup ingress');
  let active=0,count=0,windowStart=now();
  return async (req,res)=>{
    const route=req.url==='/api/native-mission/v14-preflight'?'preflight':req.url==='/api/native-mission/v14-receipt'?'receipt':null;
    if(!route||req.method!=='POST'){req.resume();return reply(res,404,{error:'unavailable'})}
    if(req.headers.host!==host||req.headers['x-forwarded-proto']!=='https'||req.headers.origin!==origin||
        req.headers['x-bouncer-native-mission']!=='v1'||!matches(req.headers['x-bouncer-proxy-secret'],secret)||
        !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){req.resume();return reply(res,403,{error:'unavailable'})}
    const time=now();if(!Number.isSafeInteger(time)||time<windowStart){req.resume();return reply(res,503,{error:'unavailable'})}
    if(time-windowStart>=120_000){windowStart=time;count=0}
    if(active>=2||count>=40){req.resume();return reply(res,429,{error:'unavailable'})}
    active++;count++;
    try {
      const value=await body(req),fields=route==='preflight'?['review','scopeId','stageId','prior']:['review','scopeId','stageId','txHash'];
      if(!exact(value,fields))return reply(res,400,{error:'unavailable'});
      return reply(res,200,await service[route](value));
    }catch{return reply(res,409,{error:'V14_SETUP_UNAVAILABLE',do_not_retry:true})}
    finally{active--}
  };
}
