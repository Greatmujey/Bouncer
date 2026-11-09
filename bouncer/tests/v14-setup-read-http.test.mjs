// Fabricated public reviews and loopback servers only. No wallet or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {fixture,scope,owner,vault} from './v14-witness-fixture.mjs';
import {createRailwayNativeStandby,STANDBY_STATUS} from '../scripts/start-railway-native.mjs';
import {createV14SetupReadHttpHandler} from '../agent/v14-setup-read-http.mjs';
import {createVercelNativeMissionProxy} from '../agent/native-mission-proxy.mjs';
import {createV14SetupReadClient} from '../web-src/v14-setup-read-client.mjs';

const site='https://bouncer-near.vercel.app',siteHost='bouncer-near.vercel.app',backend='https://bouncer-synthetic.up.railway.app',
  backendHost='bouncer-synthetic.up.railway.app',secret='ab'.repeat(32),block=nearApi.utils.serialize.base_encode(Buffer.alloc(32,9));
const listen=server=>new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
function request(server,{path,method='POST',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}
function httpFetch(server,hostname,forwarded=false) {
  return (url,options)=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:new URL(url,site).pathname,method:options.method,
      headers:{...options.headers,host:hostname,...(forwarded?{'x-forwarded-proto':'https'}:{origin:site})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),
        {status:res.statusCode,headers:{'content-type':res.headers['content-type']}})));
    });req.on('error',reject);req.end(options.body);
  });
}
function fakeService(review,calls) {
  return {
    async preflight(input){calls.push(['preflight',input]);const stage=review.stages.find(item=>item.id===input.stageId);
      return {status:'V14_SETUP_PREFLIGHT_MATCH',network:'testnet',owner,vault,stage_id:input.stageId,review_sha256:review.review_sha256,
        action_commitment_sha256:stage.action_commitment_sha256,prior_original_hashes:input.prior.map(item=>item.tx_hash),
        final_block_hash:block,checked_at_ms:10_000,wallet_transaction_authorized:false,transaction_sent:false}},
    async receipt(input){calls.push(['receipt',input]);return {tx_hash:input.txHash,final_block_hash:block}},
  };
}

test('read-only setup endpoints are separately default-off and secret gated',async()=>{
  const calls=[],{review}=fixture(),service=fakeService(review,calls),handler=createV14SetupReadHttpHandler({service,
    siteOrigin:site,backendOrigin:backend,proxySecret:secret,now:()=>10_000});
  const standby=createRailwayNativeStandby(),enabled=createRailwayNativeStandby({setupHandler:handler});await listen(standby);await listen(enabled);
  const path='/api/native-mission/v14-preflight',good={host:backendHost,origin:site,'x-forwarded-proto':'https',
    'x-bouncer-proxy-secret':secret,'x-bouncer-native-mission':'v1','content-type':'application/json'},
    payload=JSON.stringify({review,scopeId:scope,stageId:review.stages[0].id,prior:[]});
  try {
    assert.equal((await request(standby,{path,headers:good,body:payload})).status,404);
    assert.deepEqual(JSON.parse((await request(enabled,{path:'/healthz',method:'GET'})).body),STANDBY_STATUS);
    for(const change of [{host:'evil.example'},{origin:'https://evil.example'},{'x-forwarded-proto':'http'},
      {'x-bouncer-proxy-secret':'cd'.repeat(32)},{'x-bouncer-native-mission':'wrong'}]) {
      assert.equal((await request(enabled,{path,headers:{...good,...change},body:payload})).status,403);
    }
    assert.equal((await request(enabled,{path,headers:good,body:'{"private_key":"not-accepted"}'})).status,400);
    const response=await request(enabled,{path,headers:good,body:payload});assert.equal(response.status,200);
    assert.equal(JSON.parse(response.body).wallet_transaction_authorized,false);assert.equal(calls.length,1);
    assert.equal((await request(enabled,{path:'/api/native-mission/execute',headers:good,body:'{}'})).status,404);
    assert.equal((await request(enabled,{path:path+'?x=1',headers:good,body:payload})).status,404);
  }finally{await close(standby);await close(enabled)}
});

test('same-origin browser client reaches only the separately enabled proxy and pins each response',async()=>{
  const calls=[],{review,binding}=fixture(),service=fakeService(review,calls),handler=createV14SetupReadHttpHandler({service,
    siteOrigin:site,backendOrigin:backend,proxySecret:secret,now:()=>10_000});
  const railway=createRailwayNativeStandby({setupHandler:handler});await listen(railway);
  const env={BOUNCER_V14_SETUP_PROXY_ENABLED:'1',BOUNCER_WALLET_ORIGIN:site,
    BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:backend,BOUNCER_NATIVE_MISSION_PROXY_SECRET:secret};
  const upstream=httpFetch(railway,backendHost,true);
  const proxies=Object.fromEntries(['v14-preflight','v14-receipt','execute'].map(action=>[action,createVercelNativeMissionProxy({action,env,fetchImpl:upstream})]));
  const proxy=http.createServer((req,res)=>{const action=req.url.split('/').at(-1);void proxies[action](req,res)});await listen(proxy);
  let requests=0;const network=httpFetch(proxy,siteHost),fetch=async(url,options)=>{requests++;return network(url,options)};
  try {
    const client=await createV14SetupReadClient({review,trustedReviewSha256:review.review_sha256,scopeId:scope,
      location:{origin:site,host:siteHost},fetch,isCurrent:()=>true,crypto:webcrypto,now:()=>10_001});
    const stageId=review.stages[0].id,preflight=await client.preflight({review,scopeId:scope,stageId,prior:[]});
    assert.equal(preflight.status,'V14_SETUP_PREFLIGHT_MATCH');assert.equal(preflight.transaction_sent,false);
    const txHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,10));
    assert.deepEqual(await client.verifySetupReceipt({binding,stageId,txHash}),{tx_hash:txHash,final_block_hash:block});
    assert.equal(requests,2);assert.deepEqual(calls.map(item=>item[0]),['preflight','receipt']);
    const off=await request(proxy,{path:'/api/native-mission/execute',headers:{host:siteHost,origin:site,
      'content-type':'application/json','x-bouncer-native-mission':'v1'},body:'{}'});assert.equal(off.status,404);
    await assert.rejects(client.verifySetupReceipt({binding,stageId,txHash,proof:{fake:true}}),/never repeat/);
    const altered=structuredClone(review);altered.owner='evil.testnet';
    await assert.rejects(client.preflight({review:altered,scopeId:scope,stageId,prior:[]}),/never repeat/);
    assert.equal(requests,2);
  }finally{await close(proxy);await close(railway)}
});
