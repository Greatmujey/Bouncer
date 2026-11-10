import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRailwayConnectionHandler} from '../web/api/railway-connection.mjs';
import {setupRailwayConnection} from '../web/railway-connection.mjs';
const status={service:'bouncer-testnet-native-backend',status:'STANDBY',mission_enabled:false,transactions_enabled:false};
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
async function invoke(handler,{method='GET',url='/api/railway-connection'}={}){
 let code,headers,body;await handler({method,url},{writeHead(c,h){code=c;headers=h},end(value){body=JSON.parse(value)}});return{code,headers,body};
}
test('fixed read-only Railway request reports standby without forwarding client data',async()=>{
 let calls=0;const handler=createRailwayConnectionHandler({fetch:async(url,opts)=>{calls++;assert.equal(url,'https://bouncer-production-6df1.up.railway.app/healthz');
 assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');assert.deepEqual(opts.headers,{accept:'application/json'});assert.equal(opts.body,undefined);return json(status)}});
 const result=await invoke(handler);assert.equal(calls,1);assert.equal(result.code,200);assert.equal(result.headers['cache-control'],'no-store');
 assert.deepEqual(result.body,{status:'connected_standby',mission_enabled:false,transactions_enabled:false});
});
test('rejects methods, paths, queries, unexpected statuses, big or malformed responses',async()=>{
 let calls=0;const h=createRailwayConnectionHandler({fetch:async()=>{calls++;return json(status)}});
 for(const request of [{method:'POST'},{url:'/api/railway-connection?url=https://example.com'},{url:'/different'}])assert.notEqual((await invoke(h,request)).code,200);
 assert.equal(calls,0);
 for(const response of [json({...status,transactions_enabled:true}),json({...status,extra:'secret'}),json('x'.repeat(5000)),new Response('not json',{headers:{'content-type':'application/json'}}),new Response('{}',{status:500,headers:{'content-type':'application/json'}})]){
  const result=await invoke(createRailwayConnectionHandler({fetch:async()=>response}));assert.equal(result.code,503);assert.deepEqual(result.body,{status:'unavailable'});
 }
 assert.equal((await invoke(createRailwayConnectionHandler({fetch:async()=>{throw Error('network failure')}}))).code,503);
});
test('limits repeated requests',async()=>{let time=1;const h=createRailwayConnectionHandler({fetch:async()=>json(status),now:()=>time});
 for(let i=0;i<40;i++)assert.equal((await invoke(h)).code,200);assert.equal((await invoke(h)).code,429);time+=60_000;assert.equal((await invoke(h)).code,200);
});
test('button makes only a same-origin GET and reports standby or unknown',async()=>{
 let click;const button={disabled:false,addEventListener(name,fn){assert.equal(name,'click');click=fn}},result={textContent:''};
 const doc={querySelector(sel){return sel==='#railway-connection-check'?button:result}};let count=0;
 setupRailwayConnection(doc,{fetch:async(url,options)=>{count++;assert.equal(url,'/api/railway-connection');assert.equal(options.method,'GET');
 assert.equal(options.credentials,'omit');return count===1?json({status:'connected_standby',mission_enabled:false,transactions_enabled:false}):json({status:'connected_standby',mission_enabled:true,transactions_enabled:true})}});
 assert.equal(count,0);await click();assert.match(result.textContent,/standby.*off/);assert.equal(button.disabled,false);
 await click();assert.match(result.textContent,/unknown/);assert.equal(count,2);
});

test('one deployed endpoint routes strictly bounded read-only vault and original checks',async()=>{
 const hash='E7zq24WLG4FQAoF9NmWesfQUm8figE9U1EDQ67kDf1fa',vault='native.great_mujey.testnet';
 const seen=[];const handler=createRailwayConnectionHandler({fetch:async(url,opts)=>{
  assert.equal(url,'https://test.rpc.fastnear.com/');assert.equal(opts.method,'POST');assert.equal(opts.credentials,'omit');
  const q=JSON.parse(opts.body);seen.push(q.method);
  if(q.method==='status')return json({jsonrpc:'2.0',id:q.id,result:{chain_id:'testnet'}});
  if(q.method==='EXPERIMENTAL_tx_status')return json({jsonrpc:'2.0',id:q.id,result:{final_execution_status:'FINAL',
   transaction:{hash,signer_id:'great_mujey.testnet',receiver_id:vault},status:{SuccessValue:''},receipts_outcome:[]}});
  throw Error('simulated block outage');
 }});
 let out=await invoke(handler,{url:`/api/railway-connection?original=${hash}`});
 assert.equal(out.code,200);assert.deepEqual(out.body,{hash,state:'final_success',receiptFailures:0});
 out=await invoke(handler,{url:`/api/railway-connection?vault=${vault}`});assert.equal(out.code,503);
 assert.equal((await invoke(handler,{url:`/api/railway-connection?vault=${vault}&original=${hash}`})).code,400);
 assert.equal((await invoke(handler,{url:'/api/railway-connection?original=bad'})).code,400);
 assert.deepEqual(seen,['status','EXPERIMENTAL_tx_status','status','block']);
});
