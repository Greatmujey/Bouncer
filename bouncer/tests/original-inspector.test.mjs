import test from 'node:test';
import assert from 'node:assert/strict';
import {validOriginalHash,inspectOriginalTransaction,setupOriginalInspector} from '../web/vault-inspector.mjs';
import {createRailwayConnectionHandler as createOriginalInspectorHandler} from '../web/api/railway-connection.mjs';
const original='E7zq24WLG4FQAoF9NmWesfQUm8figE9U1EDQ67kDf1fa';
function rpc({chain='testnet',status='success',final='FINAL',wrongHash=false,signer='great_mujey.testnet',
  receiver='native.great_mujey.testnet',failures=0,offline=false,malformed=false}={}) {
  const calls=[];
  return {calls,fetch:async(url,options)=>{
    const request=JSON.parse(options.body);calls.push({url,options,request});
    if(offline)throw Error('offline');
    const result=request.method==='status'?{chain_id:chain}:{final_execution_status:final,
      transaction:{hash:wrongHash?'1'.repeat(32):original,signer_id:signer,receiver_id:receiver},
      status:status==='success'?{SuccessValue:''}:status==='failure'?{Failure:{ActionError:{}}}:{Unknown:null},
      receipts_outcome:malformed?[{outcome:{status:{Unknown:null}}}]:Array.from({length:failures+1},(_,i)=>
        ({outcome:{status:i<failures?{Failure:{ActionError:{}}}:{SuccessValue:''}}}))};
    return Response.json({jsonrpc:'2.0',id:request.id,result});
  }};
}
async function call(handler,method,url) {
  let status,headers,body;await handler({method,url},{writeHead(code,h){status=code;headers=h},end(text){body=JSON.parse(text)}});
  return {status,headers,body};
}
test('checks the exact original with a fixed testnet signer and receiver without a wallet or send',async()=>{
  assert.equal(validOriginalHash(original),true);assert.equal(validOriginalHash('1'.repeat(32)),true);
  assert.equal(validOriginalHash('1'.repeat(33)),false);assert.equal(validOriginalHash('0'.repeat(44)),false);
  const transport=rpc(),result=await inspectOriginalTransaction(original,{fetch:transport.fetch});
  assert.deepEqual(result,{hash:original,state:'final_success',receiptFailures:0});
  assert.deepEqual(transport.calls.map(c=>c.request.method),['status','EXPERIMENTAL_tx_status']);
  assert.ok(transport.calls.every(c=>c.url==='https://test.rpc.fastnear.com/'&&c.options.redirect==='error'));
  assert.deepEqual(transport.calls[1].request.params,{tx_hash:original,sender_account_id:'great_mujey.testnet',wait_until:'FINAL'});
});
test('distinguishes final failure, receipt failures, unresolved and unknown responses',async()=>{
  assert.deepEqual(await inspectOriginalTransaction(original,{fetch:rpc({status:'failure'}).fetch}),
    {hash:original,state:'final_failure',receiptFailures:0});
  assert.deepEqual(await inspectOriginalTransaction(original,{fetch:rpc({failures:2}).fetch}),
    {hash:original,state:'final_success',receiptFailures:2});
  assert.deepEqual(await inspectOriginalTransaction(original,{fetch:rpc({final:'EXECUTED'}).fetch}),
    {hash:original,state:'unresolved',receiptFailures:null});
  assert.deepEqual(await inspectOriginalTransaction(original,{fetch:rpc({status:'unknown'}).fetch}),
    {hash:original,state:'unresolved',receiptFailures:null});
  for(const bad of [{chain:'mainnet'},{wrongHash:true},{signer:'other.testnet'},
    {receiver:'other.testnet'},{offline:true},{malformed:true}])
    await assert.rejects(inspectOriginalTransaction(original,{fetch:rpc(bad).fetch}));
});
test('original endpoint rejects changes, invalid and duplicate input without calling the chain',async()=>{
  const transport=rpc(),handler=createOriginalInspectorHandler({fetch:transport.fetch});
  for(const [method,url,status] of [['POST',`/api/railway-connection?original=${original}`,405],
    ['GET','/api/railway-connection?original=bad',400],['GET',`/api/railway-connection?original=${original}&hash=${original}`,400],
    ['GET',`/api/railway-connection?original=${original}&rpc=other`,400]])
    assert.equal((await call(handler,method,url)).status,status);
  assert.equal(transport.calls.length,0);
  const success=await call(handler,'GET',`/api/railway-connection?original=${original}`);
  assert.equal(success.status,200);assert.equal(success.body.state,'final_success');assert.equal(success.headers['cache-control'],'no-store');
  const unavailable=await call(createOriginalInspectorHandler({fetch:rpc({offline:true}).fetch}),'GET',`/api/railway-connection?original=${original}`);
  assert.equal(unavailable.status,503);assert.equal(unavailable.body.status,'unavailable');
});
test('phone-friendly recovery check is opt-in, clears stale answers, and never prompts wallet',async()=>{
  function node(){return {handlers:{},textContent:'',value:'',disabled:false,addEventListener(name,fn){this.handlers[name]=fn}}}
  const form=node(),input=node(),button=node(),result=node(),nodes={'#original-inspector-form':form,
    '#original-inspector-hash':input,'#original-inspector-submit':button,'#original-inspector-result':result};input.value=original;
  const calls=[],fetch=async(url,options)=>{calls.push({url,options});return Response.json({hash:original,state:'final_success',receiptFailures:1})};
  setupOriginalInspector({querySelector:selector=>nodes[selector]},{fetch});assert.equal(calls.length,0);
  await form.handlers.submit({preventDefault(){}});
  assert.equal(calls[0].url,`/api/railway-connection?original=${original}`);assert.equal(calls[0].options.credentials,'omit');
  assert.match(result.textContent,/Final transaction result: success/);assert.match(result.textContent,/Failed receipt outcomes reported: 1/);
  assert.match(result.textContent,/not all history or mission delivery/);assert.match(result.textContent,/Do not resend/);
  input.handlers.input();assert.doesNotMatch(result.textContent,/success/);
  input.value='not-a-hash';await form.handlers.submit({preventDefault(){}});assert.equal(calls.length,1);
});
test('endpoint limits concurrent read-only requests and remains available after they complete',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve}),transport=rpc();
  const handler=createOriginalInspectorHandler({fetch:async(url,options)=>{await gate;return transport.fetch(url,options)}});
  const request=()=>call(handler,'GET',`/api/railway-connection?original=${original}`);
  const pending=Array.from({length:4},request);
  assert.equal((await request()).status,429);release();
  assert.ok((await Promise.all(pending)).every(x=>x.status===200));assert.equal((await request()).status,200);
});
test('changing the original while lookup is in flight never shows the old result',async()=>{
  function node(){return {handlers:{},textContent:'',value:'',disabled:false,addEventListener(name,fn){this.handlers[name]=fn}}}
  const form=node(),input=node(),button=node(),result=node(),nodes={'#original-inspector-form':form,
    '#original-inspector-hash':input,'#original-inspector-submit':button,'#original-inspector-result':result};input.value=original;
  let release;const gate=new Promise(resolve=>{release=resolve});
  setupOriginalInspector({querySelector:selector=>nodes[selector]},{fetch:async()=>{await gate;return Response.json({hash:original,state:'final_success',receiptFailures:0})}});
  const pending=form.handlers.submit({preventDefault(){}});input.value='1'.repeat(32);input.handlers.input();release();await pending;
  assert.match(result.textContent,/Hash changed/);assert.doesNotMatch(result.textContent,/success/);assert.equal(button.disabled,false);
});
test('original UI falls back only on a server outage, without leaking credentials',async()=>{
  function node(){return {handlers:{},textContent:'',value:'',disabled:false,addEventListener(name,fn){this.handlers[name]=fn}}}
  const form=node(),input=node(),button=node(),result=node(),nodes={'#original-inspector-form':form,
    '#original-inspector-hash':input,'#original-inspector-submit':button,'#original-inspector-result':result};input.value=original;
  const transport=rpc();let status=503;
  const fetch=async(url,options)=>url.startsWith('/api/')?new Response('{}',{status}):transport.fetch(url,options);
  setupOriginalInspector({querySelector:selector=>nodes[selector]},{fetch});
  await form.handlers.submit({preventDefault(){}});assert.match(result.textContent,/Final transaction result: success/);
  assert.equal(transport.calls.length,2);assert.ok(transport.calls.every(c=>c.options.credentials==='omit'));
  status=429;await form.handlers.submit({preventDefault(){}});assert.match(result.textContent,/unavailable/);
  assert.equal(transport.calls.length,2);
});
