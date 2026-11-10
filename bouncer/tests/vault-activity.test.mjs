import test from 'node:test';import assert from 'node:assert/strict';
import {inspectVaultActivity,setupVaultActivity} from '../web/vault-activity.mjs';
import {createRailwayConnectionHandler} from '../web/api/railway-connection.mjs';
const vault='native.great_mujey.testnet',owner='great_mujey.testnet',hash='E7zq24WLG4FQAoF9NmWesfQUm8figE9U1EDQ67kDf1fa';
const entry={transaction_hash:hash,signer_account_id:owner,receiver_account_id:vault,block:{block_height:'277015258'},actions:[{action:'FUNCTION_CALL',method:'new'}],outcomes:{status:true}};
const response=value=>Response.json(value);
async function invoke(handler,url='/api/railway-connection?activity=1',method='GET'){
 let status,body;await handler({method,url},{writeHead(n){status=n},end(v){body=JSON.parse(v)}});return{status,body};
}
test('NearBlocks v3 fetch is fixed, bounded, no auth and labels indexer evidence',async()=>{
 let call;const data=await inspectVaultActivity({fetch:async(url,opts)=>{call={url,opts};return response({data:[entry]})}});
 assert.equal(call.url,'https://api-testnet.nearblocks.io/v3/accounts/native.great_mujey.testnet/txns?limit=25');
 assert.equal(call.opts.method,'GET');assert.equal(call.opts.credentials,'omit');assert.equal(call.opts.redirect,'error');
 assert.deepEqual(data,{source:'NearBlocks testnet v3',account:vault,completeHistoryProven:false,items:[{hash,signer:owner,receiver:vault,
  blockHeight:'277015258',actions:['FUNCTION_CALL: new'],reportedSuccess:true}]});
 assert.equal((await inspectVaultActivity({fetch:async()=>response({data:[]})})).completeHistoryProven,false);
});
test('rejects retired, malformed, oversized, unrelated and untrusted indexer data',async()=>{
 const variants=[{data:null,errors:[{message:'retired'}]}, {data:[{...entry,signer_account_id:'other.testnet',receiver_account_id:'other.testnet'}]},
 {data:[{...entry,transaction_hash:'not-a-hash'}]}, {data:[{...entry,actions:[{action:'<script>',method:null}]}]},
 {data:[{...entry,block:{block_height:'bogus'}}]}, {data:Array(26).fill(entry)}, {data:[] ,extra:'x'.repeat(140000)}];
 for(const data of variants)await assert.rejects(inspectVaultActivity({fetch:async()=>response(data)}));
 await assert.rejects(inspectVaultActivity({fetch:async()=>{throw Error('offline')}}));
});
test('deployed shared endpoint reads only the fixed indexer, rejects abuse and fails closed',async()=>{
 let calls=0;const h=createRailwayConnectionHandler({fetch:async()=>{calls++;return response({data:[entry]})}});
 for(const [url,method] of [['/api/railway-connection?activity=2','GET'],['/api/railway-connection?activity=1&vault=x.testnet','GET'],['/api/railway-connection?activity=1','POST']])assert.notEqual((await invoke(h,url,method)).status,200);
 assert.equal(calls,0);const success=await invoke(h);assert.equal(success.status,200);assert.equal(success.body.items[0].hash,hash);
 const error=await invoke(createRailwayConnectionHandler({fetch:async()=>{throw Error('offline')}}));assert.equal(error.status,503);assert.deepEqual(error.body,{status:'unavailable'});
});
test('UI is explicit, escapes output via textContent, uses fixed safe links and never claims complete history',async()=>{
 const handlers={};const button={disabled:false,addEventListener:(name,cb)=>handlers[name]=cb};
 const status={textContent:''},list={children:[],replaceChildren(){this.children=[]},append(x){this.children.push(x)}};
 const doc={querySelector:s=>({'#vault-activity-check':button,'#vault-activity-status':status,'#vault-activity-list':list}[s]),
  createElement:tag=>({tag,children:[],textContent:'',append(...xs){this.children.push(...xs)}})};
 let calls=0;const sample=await inspectVaultActivity({fetch:async()=>response({data:[entry]})});
 setupVaultActivity(doc,{fetch:async(url,opts)=>{calls++;assert.equal(url,'/api/railway-connection?activity=1');assert.equal(opts.credentials,'omit');return response(sample)}});
 assert.equal(calls,0);await handlers.click();assert.match(status.textContent,/may be incomplete/);assert.equal(list.children.length,1);
 assert.equal(list.children[0].children[1].href,`https://testnet.nearblocks.io/txns/${hash}`);assert.equal(button.disabled,false);
});
