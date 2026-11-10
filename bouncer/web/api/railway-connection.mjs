// Public, read-only Vercel -> fixed Railway standby check. This function does
// not accept a backend URL, credentials, request body, or transaction data.
const BACKEND='https://bouncer-production-6df1.up.railway.app/healthz';
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
function reply(res,status,data){res.writeHead(status,headers);res.end(JSON.stringify(data))}
async function readJson(response){
  if(!response?.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')??'')||
    !response.body?.getReader)throw Error('unavailable');
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;
    if(!(value instanceof Uint8Array)||(length+=value.length)>4096){await reader.cancel();throw Error('invalid')};chunks.push(value)}}
  finally{reader.releaseLock()}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createRailwayConnectionHandler({fetch:fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof fetchImpl!=='function'||typeof now!=='function')throw Error('fetch and clock required');
  let active=0,count=0,started=now();
  return async(req,res)=>{
    let url;try{url=new URL(req.url,'https://bouncer.invalid')}catch{return reply(res,400,{status:'unavailable'})}
    if(url.pathname!=='/api/railway-connection'||url.search||url.hash)return reply(res,400,{status:'unavailable'});
    if(req.method!=='GET')return reply(res,405,{status:'unavailable'});
    const time=now();if(!Number.isSafeInteger(time)||time<started)return reply(res,503,{status:'unavailable'});
    if(time-started>=60_000){started=time;count=0}
    if(active>=4||count>=40)return reply(res,429,{status:'unavailable'});
    active++;count++;
    try {
      const response=await fetchImpl(BACKEND,{method:'GET',redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(7_000),
        headers:{accept:'application/json'}});
      const body=await readJson(response);
      if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='mission_enabled,service,status,transactions_enabled'||
        body.service!=='bouncer-testnet-native-backend'||body.status!=='STANDBY'||
        body.mission_enabled!==false||body.transactions_enabled!==false)throw Error('unrecognized');
      return reply(res,200,{status:'connected_standby',mission_enabled:false,transactions_enabled:false});
    }catch{return reply(res,503,{status:'unavailable'})}finally{active--}
  };
}
export default createRailwayConnectionHandler();
