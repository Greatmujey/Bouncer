#!/usr/bin/env node
// Read one public historical third-party direct receipt, reshape ONLY its
// transaction-specific terms into a synthetic fixture, and exercise the parser.
// Never signs, sends, spends, or represents that receipt as the owner's purchase.
import { encodeBase58 } from '../web-src/native-oracle-transaction.mjs';
import { DIRECT_OWNER,DIRECT_PAYEE,DIRECT_DEPOSIT,DIRECT_GAS,DIRECT_PROJECT,DIRECT_UUID,DIRECT_VERSION,DIRECT_INPUT,
  directOutlayerArgs,verifyDirectOutlayerReceipt } from '../web-src/direct-outlayer-testnet.mjs';
const historical='Zaud5L7fREyeR96tX1cmgBgn9zDW3RxJqARxwKN1j5g',sender='vet402-spike-10210834.testnet';
const source={WasmUrl:{url:`https://wasmhub.testnet.fastfs.io/fastfs.testnet/${DIRECT_VERSION}.wasm`,hash:DIRECT_VERSION,build_target:'wasm32-wasip2'}};
const out={scope:'historical third-party RPC receipt, modified in memory as synthetic parser fixture; not owner payment or phone proof',
  historical_receipt_available:false,modified_fixture_verified:false,signed:false,sent:false};
try {
  const response=await fetch('https://archival-rpc.testnet.near.org',{method:'POST',headers:{'content-type':'application/json'},redirect:'error',
    signal:AbortSignal.timeout(30000),body:JSON.stringify({jsonrpc:'2.0',id:'historical-direct-probe',method:'EXPERIMENTAL_tx_status',
      params:{tx_hash:historical,sender_account_id:sender,wait_until:'FINAL'}})});
  if(!response.ok)throw Error('RPC unavailable');const text=await response.text();if(text.length>4000000)throw Error('oversized');
  const raw=JSON.parse(text);if(raw.id!=='historical-direct-probe'||!raw.result)throw Error('historical receipt unavailable');
  const r=raw.result;out.historical_receipt_available=true;
  const synthetic=encodeBase58(new Uint8Array(32).fill(7)),b64=v=>Buffer.from(JSON.stringify(v)).toString('base64');
  const call={method_name:'request_execution',gas:Number(DIRECT_GAS),deposit:DIRECT_DEPOSIT,args:b64(directOutlayerArgs())};
  if(r.transaction?.signer_id!==sender||r.transaction?.receiver_id!==DIRECT_PAYEE||r.transaction?.actions?.length!==1||
    !Array.isArray(r.receipts)||!Array.isArray(r.receipts_outcome))throw Error('unexpected historical direct receipt structure');
  r.transaction.hash=synthetic;r.transaction.signer_id=DIRECT_OWNER;r.transaction.actions=[{FunctionCall:call}];r.transaction_outcome.id=synthetic;
  const value=b64({success:true,token_id:'near',source:'custom',price_usd:2.75,timestamp:1792558890});r.status={SuccessValue:value};
  let requested=0,completed=0,action=0;
  for(const receipt of r.receipts){
    if(receipt.predecessor_id===sender&&receipt.receiver_id===DIRECT_PAYEE){
      const list=receipt.receipt?.Action?.actions;
      if(list?.length===1&&list[0]?.FunctionCall?.method_name==='request_execution'){receipt.receipt.Action.actions=[{FunctionCall:call}];action++}
    }
    if(receipt.predecessor_id===sender)receipt.predecessor_id=DIRECT_OWNER;
    if(receipt.receiver_id===sender)receipt.receiver_id=DIRECT_OWNER;
  }
  for(const item of r.receipts_outcome){
    if(item.outcome?.executor_id===sender)item.outcome.executor_id=DIRECT_OWNER;
    if(item.outcome?.executor_id!==DIRECT_PAYEE)continue;
    item.outcome.logs=(item.outcome.logs??[]).map(log=>{
      if(typeof log!=='string'||!log.startsWith('EVENT_JSON:'))return log;let ev;
      try{ev=JSON.parse(log.slice(11))}catch{return log}
      if(ev.event==='execution_requested')for(const data of ev.data??[]){
        const d=JSON.parse(data.request_data);Object.assign(d,{sender_id:DIRECT_OWNER,predecessor_id:DIRECT_OWNER,
          payment:DIRECT_DEPOSIT,input_data:DIRECT_INPUT,code_source:source,project_id:DIRECT_PROJECT,project_uuid:DIRECT_UUID,attached_usd:'0'});
        data.request_data=JSON.stringify(d);requested++;
      }
      if(ev.event==='execution_completed')for(const d of ev.data??[]){
        Object.assign(d,{sender_id:DIRECT_OWNER,code_source:source});item.outcome.status={SuccessValue:value};completed++;
      }
      return 'EVENT_JSON:'+JSON.stringify(ev);
    });
  }
  out.actual_shape={final_execution_status:r.final_execution_status,receipt_count:r.receipts.length,outcome_count:r.receipts_outcome.length,
    request_actions:action,requested_events:requested,completed_events:completed};
  verifyDirectOutlayerReceipt(synthetic,r);out.modified_fixture_verified=true;
} catch(error) { out.diagnostic=String(error.message).slice(0,180); }
console.log(JSON.stringify(out));
if(process.env.GITHUB_ACTIONS==='true')console.log('::notice title=Historical direct receipt shape (synthetic)::'+JSON.stringify(out));
if(out.historical_receipt_available && !out.modified_fixture_verified)process.exitCode=1;
