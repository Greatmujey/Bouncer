// Offline only: synthetic origins, loopback servers and a fabricated service.
// No wallet, Railway, Vercel, blockchain, credentials or provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createVercelNativeMissionProxy, validateNativeProxySiteOrigin, validateRailwayNativeBackend, validateNativeProxySecret } from '../agent/native-mission-proxy.mjs';
import { createRailwayNativeMissionBackend } from '../agent/native-mission-railway.mjs';
import { resolveNativeMissionListener, classifyNativeMissionStartupError } from '../scripts/start-native-mission-site.mjs';

const site='https://bouncer-near.vercel.app', siteHost='bouncer-near.vercel.app';
const backend='https://bouncer-synthetic.up.railway.app', backendHost='bouncer-synthetic.up.railway.app';
const secret='ab'.repeat(32), otherSecret='cd'.repeat(32);
const env={BOUNCER_NATIVE_MISSION_PROXY_ENABLED:'1',BOUNCER_WALLET_ORIGIN:site,
  BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:backend,BOUNCER_NATIVE_MISSION_PROXY_SECRET:secret};
const listen=server=>new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
function request(server,{path='/api/native-mission/config',method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{host:siteHost,...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}
const marker={'x-bouncer-native-mission':'v1'}, post={...marker,origin:site,'content-type':'application/json'};
async function useProxy(options, run) {
  const proxy=createVercelNativeMissionProxy(options), server=http.createServer((req,res)=>void proxy(req,res));
  await listen(server);try{return await run(server)}finally{await close(server)}
}
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});

test('proxy is off by default and invalid configuration fails closed before an upstream call', async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return response({enabled:true})};
  await useProxy({action:'config',env:{},fetchImpl},async server=>{
    const r=await request(server,{headers:marker});assert.equal(r.status,404);assert.equal(calls,0);
  });
  for(const bad of [{...env,BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:'http://127.0.0.1'},
    {...env,BOUNCER_NATIVE_MISSION_PROXY_SECRET:'short'}, {...env,BOUNCER_WALLET_ORIGIN:'https://evil.github.io'}]) {
    await useProxy({action:'config',env:bad,fetchImpl},async server=>assert.equal((await request(server,{headers:marker})).status,503));
  }
  assert.equal(calls,0);
});

test('only a fixed dedicated wallet origin, fixed Railway HTTPS host and full secret are accepted',()=>{
  assert.equal(validateNativeProxySiteOrigin(site),site);assert.equal(validateRailwayNativeBackend(backend),backend);
  assert.equal(validateNativeProxySecret(secret),secret);
  for(const bad of ['http://bouncer-near.vercel.app','https://user@bouncer-near.vercel.app','https://bouncer-near.vercel.app/',
    'https://127.0.0.1','https://foo.local','https://x.github.io','https://madethis.website','https://foo..example']) {
    assert.throws(()=>validateNativeProxySiteOrigin(bad));
  }
  for(const bad of ['http://bouncer-synthetic.up.railway.app','https://127.0.0.1','https://evil.example',
    'https://up.railway.app','https://bouncer-synthetic.up.railway.app/path','https://user@bouncer-synthetic.up.railway.app',
    'https://bouncer-synthetic.up.railway.app:8443','https://a.b.up.railway.app','https://bouncer-synthetic.up.railway.app?q=x']) {
    assert.throws(()=>validateRailwayNativeBackend(bad));
  }
  for(const bad of ['', 'a'.repeat(63),'A'.repeat(64), 'g'.repeat(64)])assert.throws(()=>validateNativeProxySecret(bad));
  assert.throws(()=>createVercelNativeMissionProxy({action:'../config',env,fetchImpl:()=>{}}));
});

test('the public proxy requires the exact host, same origin, marker, method and route',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return response({ok:true})};
  await useProxy({action:'preview',env,fetchImpl},async server=>{
    const payload=JSON.stringify({missionSha256:'a'.repeat(64)});
    const bad=[
      {path:'/api/native-mission/preview',method:'POST',headers:{...post,host:'wrong.example'},body:payload},
      {path:'/api/native-mission/preview',method:'POST',headers:{...post,origin:'https://evil.example'},body:payload},
      {path:'/api/native-mission/preview',method:'POST',headers:{origin:site,'content-type':'application/json'},body:payload},
      {path:'/api/native-mission/preview',method:'POST',headers:{...post,'x-forwarded-proto':'http'},body:payload},
      {path:'/api/native-mission/preview?extra=1',method:'POST',headers:post,body:payload},
      {path:'/api/native-mission/execute',method:'POST',headers:post,body:payload},
      {path:'/api/native-mission/preview',method:'GET',headers:post},
      {path:'/api/native-mission/preview',method:'POST',headers:{...post,origin:undefined},body:payload},
      {path:'/api/native-mission/preview',method:'POST',headers:{...post,'content-type':'text/plain'},body:payload},
    ];
    for(const options of bad) {
      if(options.headers.origin===undefined)delete options.headers.origin;
      assert.ok([403,404].includes((await request(server,options)).status));
    }
    assert.equal(calls,0);
    assert.equal((await request(server,{path:'/api/native-mission/preview',method:'POST',headers:post,body:'not-json'})).status,400);
    assert.equal((await request(server,{path:'/api/native-mission/preview',method:'POST',headers:post,body:JSON.stringify({x:'a'.repeat(9000)})})).status,400);
    assert.equal(calls,0);
  });
});

test('proxy strips browser cookies and headers, never exposes the proxy secret or follows redirects',async()=>{
  const seen=[];const fetchImpl=async(url,options)=>{seen.push({url,options});return response({status:'READY'},200,{'set-cookie':'secret=never'})};
  await useProxy({action:'preview',env,fetchImpl},async server=>{
    const body=JSON.stringify({missionSha256:'a'.repeat(64)});
    const r=await request(server,{path:'/api/native-mission/preview',method:'POST',headers:{...post,cookie:'private=1',
      authorization:'Bearer fake','x-bouncer-proxy-secret':otherSecret},body});
    assert.equal(r.status,200);assert.equal(JSON.parse(r.body).status,'READY');assert.equal(r.headers['set-cookie'],undefined);
    assert.ok(!r.body.includes(secret));assert.equal(r.headers['cache-control'],'no-store');
    assert.equal(seen.length,1);assert.equal(seen[0].url,`${backend}/api/native-mission/preview`);
    assert.equal(seen[0].options.redirect,'error');assert.equal(seen[0].options.headers['x-bouncer-proxy-secret'],secret);
    assert.equal(seen[0].options.headers.cookie,undefined);assert.equal(seen[0].options.headers.authorization,undefined);
    assert.equal(Buffer.from(seen[0].options.body).toString(),body);
  });
});

test('an ambiguous upstream result is returned once with do-not-retry and never echoed secrets',async()=>{
  for(const fetchImpl of [async()=>{throw Error('simulated timeout')},async()=>response({error:secret}),
    async()=>new Response('',{status:302,headers:{location:'https://evil.example'}})]) {
    let calls=0;await useProxy({action:'execute',env,fetchImpl:async(...args)=>{calls++;return fetchImpl(...args)}},async server=>{
      const r=await request(server,{path:'/api/native-mission/execute',method:'POST',headers:post,body:'{}'});
      assert.equal(r.status,503);assert.equal(JSON.parse(r.body).do_not_retry,true);assert.ok(!r.body.includes(secret));assert.equal(calls,1);
    });
  }
});

test('Railway ingress rejects direct requests and only exposes the secret-gated mission API',async()=>{
  const calls=[], service={getReview:()=>({format:'synthetic'}),
    ...Object.fromEntries(['preview','issue','execute','originals','recover'].map(name=>[name,async input=>{calls.push([name,input]);return {status:name}}]))};
  const server=createRailwayNativeMissionBackend({siteOrigin:site,backendOrigin:backend,proxySecret:secret,service});await listen(server);
  try {
    const good={host:backendHost,'x-forwarded-proto':'https','x-bouncer-proxy-secret':secret,...marker};
    const health=await request(server,{path:'/healthz'});
    assert.equal(health.status,200);assert.deepEqual(JSON.parse(health.body),{service:'bouncer-testnet-native-backend',status:'ONLINE'});
    assert.equal((await request(server,{path:'/healthz?x=1'})).status,403);
    for(const headers of [{...good,'x-bouncer-proxy-secret':otherSecret},{...good,'x-bouncer-proxy-secret':undefined},
      {...good,host:'wrong.example'},{...good,'x-forwarded-proto':'http'}]) {
      if(headers['x-bouncer-proxy-secret']===undefined)delete headers['x-bouncer-proxy-secret'];
      assert.equal((await request(server,{headers})).status,403);
    }
    assert.equal((await request(server,{headers:good})).status,200);
    assert.equal((await request(server,{path:'/',headers:good})).status,404);
    assert.equal((await request(server,{path:'/api/native-mission/preview?x=1',headers:good})).status,404);
    const wrongOrigin={...good,origin:'https://evil.example','content-type':'application/json'};
    assert.equal((await request(server,{path:'/api/native-mission/execute',method:'POST',headers:wrongOrigin,body:'{}'})).status,403);
    assert.equal(calls.length,0);
  } finally {await close(server)}
});

test('proxy to Railway recovers the original after a lost result without submitting again',async()=>{
  const calls=[], original='synthetic-original-hash'; let sends=0;
  const service={getReview:()=>({format:'synthetic'}),
    async preview(input){calls.push(['preview',input]);return {status:'READY'}},
    async issue(input){calls.push(['issue',input]);return {status:'challenge'}},
    async execute(input){calls.push(['execute',input]);sends++;throw Error('synthetic response lost after submit')},
    async originals(input){calls.push(['originals',input]);return {status:'LOCAL_ORIGINALS',originals:[{original_hash:original}]}},
    async recover(input){calls.push(['recover',input]);return {status:'RECOVERED',new_payments:0}}};
  const upstream=createRailwayNativeMissionBackend({siteOrigin:site,backendOrigin:backend,proxySecret:secret,service});await listen(upstream);
  // Node fetch overwrites Host for a loopback URL. Simulate Railway's TLS
  // terminator with http.request so the backend still sees its fixed host.
  const fetchImpl=(url,options)=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:upstream.address().port,path:new URL(url).pathname,
      method:options.method,headers:{...options.headers,host:backendHost,'x-forwarded-proto':'https'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),
        {status:res.statusCode,headers:{'content-type':res.headers['content-type']}})));
    });req.on('error',reject);req.end(options.body);
  });
  try {
    await useProxy({action:'execute',env,fetchImpl},async server=>{
      const r=await request(server,{path:'/api/native-mission/execute',method:'POST',headers:post,
        body:JSON.stringify({missionSha256:'a'.repeat(64),ownerPublicKey:'synthetic',evidence:{}})});
      assert.equal(r.status,409);assert.equal(JSON.parse(r.body).do_not_retry,true);assert.equal(sends,1);
    });
    for(const action of ['originals','recover'])await useProxy({action,env,fetchImpl},async server=>{
      const r=await request(server,{path:`/api/native-mission/${action}`,method:'POST',headers:post,body:JSON.stringify({missionSha256:'a'.repeat(64)})});
      assert.equal(r.status,200);assert.equal(action==='originals'?JSON.parse(r.body).originals[0].original_hash:JSON.parse(r.body).new_payments,
        action==='originals'?original:0);
    });
    assert.equal(sends,1);assert.deepEqual(calls.map(c=>c[0]),['execute','originals','recover']);
  } finally {await close(upstream)}
});

test('startup diagnostics identify recovery without printing private error details',()=>{
  assert.equal(classifyNativeMissionStartupError(new Error('unclean shutdown: synthetic-private-path')),'RECOVERY_REQUIRED');
  assert.equal(classifyNativeMissionStartupError(new Error('start in recovery-only mode before enabling execution')),'INITIAL_RECOVERY_REQUIRED');
  assert.equal(classifyNativeMissionStartupError(new Error('unknown journal lock; manual recovery required')),'MANUAL_LOCK_REVIEW');
  assert.equal(classifyNativeMissionStartupError(new Error('another mission process holds the persistent-volume fence')),'VOLUME_FENCE_UNAVAILABLE');
  assert.equal(classifyNativeMissionStartupError(new Error('database password=synthetic-private-value')),'CONFIGURATION_OR_RUNTIME');
});

test('listener defaults to loopback; public bind requires explicit API-only proxy mode',()=>{
  assert.deepEqual(resolveNativeMissionListener({}),{host:'127.0.0.1',port:8789});
  assert.deepEqual(resolveNativeMissionListener({BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
    BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0',PORT:'8080'}),{host:'0.0.0.0',port:8080});
  for(const input of [{BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0'}, {BOUNCER_NATIVE_MISSION_BIND:'::'},
    {BOUNCER_NATIVE_MISSION_PORT:'0'},{BOUNCER_NATIVE_MISSION_PORT:'65536'},
    {BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0',PORT:'8080',BOUNCER_NATIVE_MISSION_PORT:'8789'}]) {
    assert.throws(()=>resolveNativeMissionListener(input));
  }
});
