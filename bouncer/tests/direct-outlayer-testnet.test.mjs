import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';
import {createRemoteDirectFence} from '../web-src/direct-test-remote-fence.mjs';
import {DIRECT_PREVIEW_ORIGIN,DIRECT_OWNER,DIRECT_PAYEE,DIRECT_DEPOSIT,DIRECT_GAS,DIRECT_PROJECT,DIRECT_UUID,DIRECT_VERSION,DIRECT_INPUT,
  directOutlayerArgs,directOutlayerTransaction,inspectDirectOutlayerReadiness,verifyDirectOutlayerReceipt,createDirectOutlayerTest} from '../web-src/direct-outlayer-testnet.mjs';

const hash=n=>encodeBase58(new Uint8Array(32).fill(n)),original=hash(7),block=hash(9),requestId=hash(10),completionId=hash(11),refundId=hash(12);
const input=directOutlayerArgs(),source={WasmUrl:{url:`https://wasmhub.testnet.fastfs.io/fastfs.testnet/${DIRECT_VERSION}.wasm`,hash:DIRECT_VERSION,build_target:'wasm32-wasip2'}};
const b64=x=>Buffer.from(JSON.stringify(x)).toString('base64');
const event=(name,data)=>`EVENT_JSON:${JSON.stringify({standard:'near-outlayer',version:'1.0.0',event:name,data:[data]})}`;
const now=Date.now(),output={success:true,token_id:'near',source:'custom',price_usd:2.75,timestamp:Math.floor(now/1000)};
const outcome=(id,executor_id,status,logs=[])=>({id,block_hash:block,outcome:{executor_id,status,logs}});
const receipt=(receipt_id,predecessor_id,receiver_id,actions)=>({receipt_id,predecessor_id,receiver_id,receipt:{Action:{actions}}});
function final(){
  const request={sender_id:DIRECT_OWNER,predecessor_id:DIRECT_OWNER,payment:DIRECT_DEPOSIT,input_data:DIRECT_INPUT,
    code_source:source,project_id:DIRECT_PROJECT,project_uuid:DIRECT_UUID,attached_usd:'0'};
  const charge='1111600000000000000000',refund=(BigInt(DIRECT_DEPOSIT)-BigInt(charge)).toString();
  const completion={success:true,sender_id:DIRECT_OWNER,code_source:source,payment_charged:charge,payment_refunded:refund};
  const call={method_name:'request_execution',deposit:DIRECT_DEPOSIT,gas:Number(DIRECT_GAS),args:b64(input)};
  return {final_execution_status:'FINAL',status:{SuccessValue:b64(output)},transaction_outcome:{id:original},
    transaction:{hash:original,signer_id:DIRECT_OWNER,receiver_id:DIRECT_PAYEE,public_key:`ed25519:${hash(4)}`,actions:[{FunctionCall:call}]},
    receipts_outcome:[outcome(requestId,DIRECT_PAYEE,{SuccessReceiptId:completionId},[event('execution_requested',{request_data:JSON.stringify(request)})]),
      outcome(completionId,DIRECT_PAYEE,{SuccessValue:b64(output)},[event('execution_completed',completion)]),
      outcome(refundId,DIRECT_OWNER,{SuccessValue:''})],
    receipts:[receipt(requestId,DIRECT_OWNER,DIRECT_PAYEE,[{FunctionCall:call}]),receipt(refundId,DIRECT_PAYEE,DIRECT_OWNER,[{Transfer:{deposit:refund}}])]};
}
function rpc(mutator=()=>{}){
  return async(_url,options)=>{
    const request=JSON.parse(options.body);let result;
    if(request.method==='status')result={chain_id:'testnet'};
    else if(request.method==='block')result={header:{hash:block,height:123,timestamp_nanosec:String(BigInt(now)*1000000n)}};
    else if(request.method==='EXPERIMENTAL_protocol_config')result={chain_id:'testnet',runtime_config:{storage_amount_per_byte:'10000000000000000000'}};
    else if(request.method==='EXPERIMENTAL_tx_status')result=final();
    else if(request.method==='query'){
      const p=request.params;
      if(p.request_type==='view_account')result={block_hash:block,amount:'22000000000000000000000000',storage_usage:1024};
      else if(p.request_type==='view_access_key_list')result={block_hash:block,keys:[{public_key:`ed25519:${hash(4)}`,access_key:{permission:'FullAccess'}}]};
      else if(p.request_type==='call_function'){
        const value=p.method_name==='get_project'?{project_id:DIRECT_PROJECT,uuid:DIRECT_UUID,owner:'zavodil2.testnet'}:
          p.method_name==='get_version'?{wasm_hash:DIRECT_VERSION,source}:null;
        result={block_hash:block,result:[...Buffer.from(JSON.stringify(value))]};
      }else throw Error('unexpected query');
    }else throw Error('unexpected method');
    const box={result};mutator(request,box);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,...box}),{status:200,headers:{'content-type':'application/json'}});
  };
}
function environment({wallet:givenWallet,fetch=rpc(),isCurrent=()=>true}={}){
  const indexedDB=new IDBFactory(),storage={persist:async()=>true,persisted:async()=>true};let sends=0;
  const wallet=givenWallet??{manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(tx){
    sends++;assert.deepEqual(tx,directOutlayerTransaction());return {transaction:{hash:original},transaction_outcome:{id:original}}}};
  const args={wallet,origin:DIRECT_PREVIEW_ORIGIN,isTopLevel:true,indexedDB,storage,fetch,isCurrent,now:()=>now};
  return {args,create:()=>createDirectOutlayerTest(args),sends:()=>sends};
}

test('the one reviewed action is direct to OutLayer, fixed at 0.1 test NEAR plus gas',()=>{
  const tx=directOutlayerTransaction();assert.equal(tx.network,'testnet');assert.equal(tx.signerId,DIRECT_OWNER);assert.equal(tx.receiverId,DIRECT_PAYEE);
  assert.equal(tx.actions.length,1);assert.equal(tx.actions[0].params.methodName,'request_execution');
  assert.equal(tx.actions[0].params.deposit,DIRECT_DEPOSIT);assert.equal(tx.actions[0].params.gas,DIRECT_GAS);
  assert.deepEqual(tx.actions[0].params.args,input);
});

test('fresh public registry and account checks are required before a review',async()=>{
  const ready=await inspectDirectOutlayerReadiness({fetch:rpc(),now:()=>now});assert.equal(ready.owner,DIRECT_OWNER);assert.equal(ready.firewall_used,false);
  for(const mutate of [
    (q,b)=>{if(q.method==='status')b.result.chain_id='mainnet'},
    (q,b)=>{if(q.method==='block')b.result.header.timestamp_nanosec=String(BigInt(now-121000)*1000000n)},
    (q,b)=>{if(q.method==='query' && q.params.request_type==='view_account' && q.params.account_id===DIRECT_OWNER)b.result.amount='1'},
    (q,b)=>{if(q.method==='query' && q.params.method_name==='get_version')b.result.result=[...Buffer.from('{}')]},
    (q,b)=>{if(q.method==='query' && q.params.method_name==='get_project_pricing')b.result.result=[...Buffer.from('{}')]},
  ])await assert.rejects(inspectDirectOutlayerReadiness({fetch:rpc(mutate),now:()=>now}));
});

test('receipt verification requires the exact direct original, provider events and successful refund',()=>{
  const proof=verifyDirectOutlayerReceipt(original,final());assert.equal(proof.status,'FINAL_DIRECT_OUTLAYER_DELIVERY_MATCH');
  assert.equal(proof.firewall_used,false);assert.equal(proof.charged_yocto,'1111600000000000000000');assert.equal(proof.price_usd,2.75);
  const mutations=[
    x=>{x.final_execution_status='EXECUTED'},x=>{x.transaction.signer_id='other.testnet'},x=>{x.transaction.receiver_id='other.testnet'},
    x=>{x.transaction.actions[0].FunctionCall.deposit='1'},x=>{x.transaction.actions.push(x.transaction.actions[0])},
    x=>{x.transaction.actions[0].FunctionCall.args=b64({...input,payer_account_id:'other.testnet'})},
    x=>{x.receipts_outcome[0].outcome.logs=[]},x=>{x.receipts_outcome[1].outcome.logs=[]},
    x=>{x.receipts[1].receiver_id='other.testnet'},x=>{x.receipts_outcome[2].outcome.status={Failure:{}}},
    x=>{x.status.SuccessValue=b64({...output,price_usd:-1});x.receipts_outcome[1].outcome.status.SuccessValue=x.status.SuccessValue},
    x=>{delete x.receipts},
  ];
  for(const mutate of mutations){const value=final();mutate(value);assert.throws(()=>verifyDirectOutlayerReceipt(original,value))}
});

test('review is read-only; a single user action retains the original and verifies it without a second send',async()=>{
  const env=environment(),flow=env.create();await flow.review();assert.equal(flow.getState().phase,'reviewed');assert.equal(env.sends(),0);
  await flow.send();assert.equal(env.sends(),1);assert.equal(flow.getState().originalHash,original);await flow.check();
  assert.equal(flow.getState().phase,'verified');assert.equal(flow.getState().receipt.firewall_used,false);
  await assert.rejects(flow.send());const other=env.create();await other.review();assert.equal(other.getState().phase,'retained');
  await assert.rejects(other.send());assert.equal(env.sends(),1);
});

test('unknown or rejected wallet results permanently block another local prompt and allow receipt-only recovery',async()=>{
  let calls=0;const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(){calls++;throw Error('unknown')}};
  const env=environment({wallet}),flow=env.create();await flow.review();await flow.send();assert.equal(flow.getState().phase,'unknown');
  await assert.rejects(flow.send());const reloaded=env.create();await reloaded.review();assert.equal(reloaded.getState().phase,'unknown');
  await reloaded.recover(original);assert.equal(reloaded.getState().phase,'verified');assert.equal(calls,1);
});

test('returned hash is retained even if the wallet session changes during approval',async()=>{
  let resolveSend,active=true,calls=0;const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},
    signAndSendTransaction(){calls++;return new Promise(resolve=>{resolveSend=resolve})}};
  const env=environment({wallet,isCurrent:()=>active}),flow=env.create();await flow.review();const pending=flow.send();
  while(!resolveSend)await new Promise(resolve=>setTimeout(resolve,1));active=false;
  resolveSend({transaction:{hash:original},transaction_outcome:{id:original}});await pending;active=true;
  const another=env.create();await another.review();assert.equal(another.getState().phase,'retained');assert.equal(another.getState().originalHash,original);assert.equal(calls,1);
});

test('older-original recovery can fall back to archival RPC without another wallet call',async()=>{
  const base=rpc(),urls=[];
  const fetch=async(url,options)=>{urls.push(url);const q=JSON.parse(options.body);
    if(url==='https://rpc.testnet.near.org'&&q.method==='EXPERIMENTAL_tx_status')return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32000}}));
    return base(url,options);
  };
  const env=environment({fetch}),flow=env.create();await flow.review();await flow.send();await flow.check();
  assert.equal(flow.getState().phase,'verified');assert.ok(urls.includes('https://archival-rpc.testnet.near.org'));assert.equal(env.sends(),1);
});

test('wrong wallets, accounts, or origins never produce a wallet request',async()=>{
  const env=environment();assert.throws(()=>createDirectOutlayerTest({...env.args,origin:'https://example.com'}));
  assert.throws(()=>createDirectOutlayerTest({...env.args,isTopLevel:false}));
  assert.throws(()=>createDirectOutlayerTest({...env.args,wallet:{...env.args.wallet,manifest:{id:'other',features:{signAndSendTransaction:true}}}}));
  const noPersistence=environment();noPersistence.args.storage={persist:async()=>false,persisted:async()=>false};
  const flow=noPersistence.create();await flow.review();await assert.rejects(flow.send());assert.equal(noPersistence.sends(),0);
});

function sharedJournal({dropClaimResponse=false}={}){
  let state='ready',saved=null,expired=false,drop=dropClaimResponse;
  const fetch=async(_url,options)=>{
    const {operation,original_hash}=JSON.parse(options.body);let won=false;
    if(operation==='claim' && state==='ready' && !expired){state='claimed';won=true;}
    if(operation==='retain'){
      if(state==='ready'||(saved && saved!==original_hash))return new Response('{}',{status:503});
      state='retained';saved=original_hash;
    }
    if(operation==='claim'&&won&&drop){drop=false;throw Error('lost response')}
    return new Response(JSON.stringify({scope:'direct',state,original_hash:saved,claim_acquired:won,expired}));
  };
  return {fetch,get:()=>({state,saved})};
}
async function remoteEnvironment(journal,wallet,indexedDB=new IDBFactory(),origin='https://abcd1234.csb.app'){
  const fence=createRemoteDirectFence({origin,capability:'a'.repeat(43),fetch:journal.fetch});
  await fence.read();
  return {args:{wallet,origin,isTopLevel:true,indexedDB,storage:{persist:async()=>false,persisted:async()=>false},remoteFence:fence,
    fetch:rpc(),isCurrent:()=>true,now:()=>now},fence};
}
test('separate browser stores use the shared claim exactly once when persistence is denied',async()=>{
  const journal=sharedJournal();let calls=0;
  const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(tx){
    calls++;assert.deepEqual(tx,directOutlayerTransaction());return {transaction:{hash:original},transaction_outcome:{id:original}};}};
  const a=await remoteEnvironment(journal,wallet),b=await remoteEnvironment(journal,wallet);
  const first=createDirectOutlayerTest(a.args),second=createDirectOutlayerTest(b.args);
  await Promise.all([first.review(),second.review()]);assert.equal(calls,0);
  await Promise.all([first.send(),second.send()]);assert.equal(calls,1);
  assert.equal(journal.get().saved,original);
  const reloaded=createDirectOutlayerTest((await remoteEnvironment(journal,wallet)).args);
  await reloaded.review();assert.equal(reloaded.getState().phase,'retained');assert.equal(reloaded.getState().originalHash,original);
  await reloaded.check();assert.equal(reloaded.getState().phase,'verified');assert.equal(calls,1);
});
test('a lost shared-claim response prevents a wallet request and another browser cannot retry',async()=>{
  const journal=sharedJournal({dropClaimResponse:true});let calls=0;
  const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(){calls++;}};
  const first=createDirectOutlayerTest((await remoteEnvironment(journal,wallet)).args);await first.review();
  await assert.rejects(first.send());assert.equal(calls,0);assert.equal(journal.get().state,'claimed');
  const other=createDirectOutlayerTest((await remoteEnvironment(journal,wallet)).args);await other.review();
  assert.equal(other.getState().phase,'unknown');await assert.rejects(other.send());assert.equal(calls,0);
});
test('a verified original can be recovered on another browser without a new wallet request',async()=>{
  const journal=sharedJournal();let calls=0;
  const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(){calls++;throw Error('unknown')}};
  const first=createDirectOutlayerTest((await remoteEnvironment(journal,wallet)).args);await first.review();await first.send();
  assert.equal(first.getState().phase,'unknown');
  const other=createDirectOutlayerTest((await remoteEnvironment(journal,wallet)).args);await other.review();
  assert.equal(other.getState().phase,'unknown');await other.recover(original);
  assert.equal(other.getState().phase,'verified');assert.equal(journal.get().saved,original);assert.equal(calls,1);
});
test('an unverified or wrong-origin object cannot enable a temporary wallet host',async()=>{
  const journal=sharedJournal();let calls=0;
  const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(){calls++}};
  const {args}=await remoteEnvironment(journal,wallet);
  assert.throws(()=>createDirectOutlayerTest({...args,remoteFence:{read:async()=>({state:'ready'})}}));
  assert.throws(()=>createDirectOutlayerTest({...args,origin:'https://other123.csb.app'}));
  assert.throws(()=>createDirectOutlayerTest({...args,isTopLevel:false}));
  assert.equal(calls,0);
});

test('the public Bouncer origin requires its verified one-shot journal for the direct test',async()=>{
  const journal=sharedJournal();let calls=0;
  const wallet={manifest:{id:'meteor-wallet',features:{signAndSendTransaction:true}},async signAndSendTransaction(){calls++;return {transaction:{hash:original}}}};
  const {args}=await remoteEnvironment(journal,wallet,new IDBFactory(),'https://bouncer-near.vercel.app');
  assert.throws(()=>createDirectOutlayerTest({...args,remoteFence:null}));
  assert.throws(()=>createDirectOutlayerTest({...args,origin:'https://bouncer-near.vercel.app.evil.example'}));
  const flow=createDirectOutlayerTest(args);await flow.review();assert.equal(calls,0);
  await flow.send();assert.equal(calls,1);assert.equal(journal.get().saved,original);
});
