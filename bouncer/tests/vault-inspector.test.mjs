import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectVault,setupVaultInspector,validVaultAccount} from '../web/vault-inspector.mjs';
import {createRailwayConnectionHandler as createVaultInspectorHandler} from '../web/api/railway-connection.mjs';
const vault='native.great_mujey.testnet',owner='great_mujey.testnet',block='1'.repeat(32),height=123,
  code='3kWXAzXhFXaYMTbHogVFRwJpTGXTj9jd5J6jUMrBPSFR';
function fakeRpc({fail=[],mismatch=[]}={}) {
  const calls=[];
  const fetch=async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,options,body});
    if(fail.includes(body.id))throw Error('offline');
    let result;
    const pinned={block_hash:mismatch.includes(body.id)?'2'.repeat(32):block,block_height:height};
    switch(body.id){
      case 'vault-status':result={chain_id:'testnet'};break;
      case 'vault-block':result={header:{hash:block,height}};break;
      case 'vault-account':result={...pinned,code_hash:code};break;
      case 'vault-keys':result={...pinned,keys:[{access_key:{permission:'FullAccess'}}]};break;
      case 'vault-owner':result={...pinned,result:[...Buffer.from(JSON.stringify(owner))]};break;
      case 'vault-version':result={...pinned,result:[...Buffer.from(JSON.stringify('bouncer-agent-v14-native-storage-testnet'))]};break;
      default:throw Error('unexpected method');
    }
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  };
  return {fetch,calls};
}
async function call(handler,method,url) {
  let status,headers,body;await handler({method,url},{writeHead(code,h){status=code;headers=h},end(text){body=JSON.parse(text)}});
  return {status,headers,body};
}
test('vault inspection queries only read-only RPC methods at one final testnet block',async()=>{
  const rpc=fakeRpc(),result=await inspectVault(vault,{fetch:rpc.fetch});
  assert.deepEqual(result,{accountId:vault,blockHeight:height,code:'matches V14',owner,version:'matches V14',fullAccessKeys:1});
  assert.equal(rpc.calls.length,6);
  for(const {url,body} of rpc.calls){
    assert.equal(url,'https://test.rpc.fastnear.com/');assert.ok(['status','block','query'].includes(body.method));
    if(body.method==='query'){assert.equal(body.params.block_id,block);assert.equal(body.params.account_id,vault)}
  }
  assert.equal(validVaultAccount('great_mujey.testnet'),true);assert.equal(validVaultAccount('great.near'),false);
  assert.equal(validVaultAccount('x..testnet'),false);
});
test('failed or inconsistent key and view queries remain unknown, never an empty list',async()=>{
  const rpc=fakeRpc({fail:['vault-keys'],mismatch:['vault-owner']}),result=await inspectVault(vault,{fetch:rpc.fetch});
  assert.equal(result.fullAccessKeys,null);assert.equal(result.owner,null);assert.equal(result.code,'matches V14');
  await assert.rejects(inspectVault(vault,{fetch:fakeRpc({fail:['vault-block']}).fetch}));
});
test('same-origin endpoint rejects writes, duplicate parameters and invalid accounts without RPC calls',async()=>{
  const rpc=fakeRpc(),handler=createVaultInspectorHandler({fetch:rpc.fetch});
  for(const [method,url,status] of [['POST',`/api/railway-connection?vault=${vault}`,405],
    ['GET','/api/railway-connection?vault=owner.near',400],['GET',`/api/railway-connection?vault=${vault}&other=1`,400],
    ['GET',`/api/railway-connection?vault=${vault}&account_id=other.testnet`,400]]) {
    assert.equal((await call(handler,method,url)).status,status);
  }
  assert.equal(rpc.calls.length,0);
  const success=await call(handler,'GET',`/api/railway-connection?vault=${vault}`);
  assert.equal(success.status,200);assert.equal(success.body.owner,owner);assert.equal(success.headers['cache-control'],'no-store');
  const unavailable=await call(createVaultInspectorHandler({fetch:fakeRpc({fail:['vault-status']}).fetch}),'GET',`/api/railway-connection?vault=${vault}`);
  assert.equal(unavailable.status,503);assert.equal(unavailable.body.status,'unavailable');
});
test('UI is opt-in, uses the same-origin backend, clears stale state and never requests a wallet',async()=>{
  function node(){return {handlers:{},textContent:'',value:'',disabled:false,addEventListener(name,fn){this.handlers[name]=fn}}}
  const form=node(),input=node(),button=node(),result=node(),nodes={'#vault-inspector-form':form,'#vault-inspector-account':input,
    '#vault-inspector-submit':button,'#vault-inspector-result':result};input.value=vault;
  const calls=[],fetch=async(url,options)=>{calls.push({url,options});return Response.json({accountId:vault,blockHeight:height,
    code:'matches V14',owner,version:'matches V14',fullAccessKeys:1})};
  setupVaultInspector({querySelector:selector=>nodes[selector]},{fetch});assert.equal(calls.length,0);
  let prevented=false;await form.handlers.submit({preventDefault(){prevented=true}});
  assert.equal(prevented,true);assert.equal(calls[0].url,`/api/railway-connection?vault=${vault}`);
  assert.equal(calls[0].options.credentials,'omit');assert.match(result.textContent,/FullAccess keys: 1/);
  assert.match(result.textContent,/can move funds and change code/);assert.match(result.textContent,/does not verify wallet control/);
  input.handlers.input();assert.doesNotMatch(result.textContent,/FullAccess keys: 1/);
  input.value='not-mainnet.near';await form.handlers.submit({preventDefault(){}});assert.match(result.textContent,/valid account/);
  assert.equal(calls.length,1);
});
test('vault UI falls back to the fixed public RPC on server outage, not on throttling',async()=>{
  function node(){return {handlers:{},textContent:'',value:'',disabled:false,addEventListener(name,fn){this.handlers[name]=fn}}}
  const form=node(),input=node(),button=node(),result=node(),nodes={'#vault-inspector-form':form,'#vault-inspector-account':input,
    '#vault-inspector-submit':button,'#vault-inspector-result':result};input.value=vault;
  const upstream=fakeRpc();let status=503;
  const fetch=async(url,options)=>url.startsWith('/api/')?new Response('{}',{status}):upstream.fetch(url,options);
  setupVaultInspector({querySelector:selector=>nodes[selector]},{fetch});
  await form.handlers.submit({preventDefault(){}});assert.match(result.textContent,/FullAccess keys: 1/);
  assert.equal(upstream.calls.length,6);status=429;
  await form.handlers.submit({preventDefault(){}});assert.match(result.textContent,/unavailable/);assert.equal(upstream.calls.length,6);
});
