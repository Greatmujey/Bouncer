import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {createV14BootstrapDeploymentVerifier,inspectBootstrapDeploymentReceipt} from '../web-src/v14-bootstrap-deployment-verifier.mjs';
import {V14_BOOTSTRAP_READ_RPC} from '../web-src/v14-bootstrap-create-verifier.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,clock=1_800_000_000_000,now=()=>clock,scope='ab'.repeat(16);
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const randomHash=()=>encodeBase58(crypto.randomBytes(32));
const emptyCode='11111111111111111111111111111111';
const OWNER='buyer.testnet',VAULT='store.buyer.testnet',FUNDING=String(6n*10n**24n);
const view=(block,value)=>({block_hash:block,result:[...Buffer.from(JSON.stringify(value))]});

async function fixture({rootBody=false}={}){
  const plan=await buildV14TemporaryBootstrapPlan({owner:OWNER,ownerPublicKey:String(owner.getPublicKey()),vault:VAULT,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:FUNDING,compressedV14:compressed,crypto:webcrypto});
  const review=plan.review,original=randomHash(),root=randomHash(),block=randomHash();
  assert.equal(review.vault_code_hash,V14_TESTNET_ARTIFACT.near_code_hash);
  const actions=[{DeployContract:{code:Buffer.from(review.vault_wasm_sha256,'hex').toString('base64')}},
    {FunctionCall:{method_name:'new',args:Buffer.from(JSON.stringify({owner:OWNER})).toString('base64'),gas:30000000000000,deposit:'0'}},
    {DeleteKey:{public_key:review.temporary_vault_public_key}}];
  const action={signer_id:VAULT,signer_public_key:review.temporary_vault_public_key,gas_price:'100000000',
    input_data_ids:[],output_data_receivers:[],actions};
  const receipt={predecessor_id:VAULT,receiver_id:VAULT,receipt_id:root,receipt:{Action:action}};
  const outcome={id:root,outcome:{executor_id:VAULT,status:{SuccessValue:''},receipt_ids:[]}};
  const result={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:original,signer_id:VAULT,
    public_key:review.temporary_vault_public_key,receiver_id:VAULT,actions:structuredClone(actions)},
    transaction_outcome:{id:original,outcome:{executor_id:VAULT,status:{SuccessReceiptId:root},receipt_ids:[root]}},
    receipts:rootBody?[receipt]:[],receipts_outcome:[outcome]};
  const state={chain:'testnet',result,block:{header:{hash:block,height:200,timestamp_nanosec:String(BigInt(clock)*1_000_000n)}},
    owner:{block_hash:block,code_hash:emptyCode},vault:{block_hash:block,code_hash:V14_TESTNET_ARTIFACT.near_code_hash,amount:FUNDING,locked:'0',storage_usage:500000},
    ownerKeys:{block_hash:block,keys:[{public_key:review.owner_public_key,access_key:{nonce:1,permission:'FullAccess'}}]},
    vaultKeys:{block_hash:block,keys:[]},version:view(block,'bouncer-agent-v14-native-storage-testnet'),vaultOwner:view(block,OWNER)};
  const methods=[];let current=true;
  async function fetch(url,options){
    assert.equal(url,V14_BOOTSTRAP_READ_RPC);assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');
    const req=JSON.parse(options.body);methods.push(req.method);
    let value;
    switch(req.method){
      case 'status':value={chain_id:state.chain};break;
      case 'EXPERIMENTAL_tx_status':
        assert.deepEqual(req.params,{tx_hash:original,sender_account_id:VAULT,wait_until:'FINAL'});value=state.result;break;
      case 'block':assert.deepEqual(req.params,{finality:'final'});value=state.block;break;
      case 'query': {
        assert.equal(req.params.block_id,block);
        const {request_type,account_id,method_name,args_base64}=req.params;
        if(request_type==='view_account')value=account_id===OWNER?state.owner:state.vault;
        else if(request_type==='view_access_key_list')value=account_id===OWNER?state.ownerKeys:state.vaultKeys;
        else if(request_type==='call_function'){
          assert.equal(account_id,VAULT);assert.equal(args_base64,'e30=');
          if(method_name==='contract_version')value=state.version;
          else if(method_name==='get_owner')value=state.vaultOwner;else throw Error('unexpected view');
        }else throw Error('unexpected read');break;
      }
      default:throw Error('a transaction or other RPC method was attempted');
    }
    return Response.json({jsonrpc:'2.0',id:req.id,result:value});
  }
  const verifier=()=>createV14BootstrapDeploymentVerifier({review,compressedV14:compressed,fetch,crypto:webcrypto,now,isCurrent:()=>current});
  const binding={scope_id:scope,review_sha256:review.review_sha256,original_hash:original};
  return {review,original,root,block,state,methods,fetch,verifier,binding,invalidate:()=>{current=false}};
}
function addRefund(f){
  const id=randomHash(),review=f.review,action={signer_id:VAULT,signer_public_key:review.temporary_vault_public_key,gas_price:'0',
    input_data_ids:[],output_data_receivers:[],actions:[{Transfer:{deposit:'123'}}]};
  f.state.result.receipts_outcome[0].outcome.receipt_ids.push(id);
  f.state.result.receipts.push({receipt_id:id,predecessor_id:'system',receiver_id:VAULT,receipt:{Action:action}});
  f.state.result.receipts_outcome.push({id,outcome:{executor_id:VAULT,status:{SuccessValue:''},receipt_ids:[]}});
}

test('exact FINAL local deployment outcome and fresh keyless V14 state yield a read-only proof',async()=>{
  const f=await fixture();addRefund(f);
  const verify=await f.verifier(),proof=await verify(f.binding);
  assert.deepEqual(proof,{status:'DEPLOYMENT_FINAL_AND_KEYLESS_VAULT_VERIFIED',network:'testnet',...f.binding,
    final_block_hash:f.block,checked_at_ms:clock,local_root_receipt_body_omitted:true,
    final_transaction_and_outcome_verified:true,pinned_v14_code_verified:true,owner_verified:true,temporary_key_absent:true,
    all_vault_access_keys_absent:true,independent_recovery_verified:false,latest_history_verified:false,
    wallet_approval_verified:false,transaction_authorized:false,transaction_sent:false});
  assert.deepEqual(f.methods.sort(),['status','EXPERIMENTAL_tx_status','block','query','query','query','query','query','query'].sort());
  assert.equal(inspectBootstrapDeploymentReceipt({result:f.state.result,review:f.review,originalHash:f.original}).root_receipt_id,f.root);
});

test('a present matching root action receipt is checked, never treated as omitted',async()=>{
  const f=await fixture({rootBody:true});addRefund(f);
  const verify=await f.verifier();assert.equal((await verify(f.binding)).local_root_receipt_body_omitted,false);
  f.state.result.receipts[0].receipt.Action.actions[2].DeleteKey.public_key=String(owner.getPublicKey());
  await assert.rejects(verify(f.binding));
});

test('failed, incomplete, changed, duplicated or unlinked deployment receipts fail closed',async()=>{
  const changes=[
    f=>{f.state.result.final_execution_status='EXECUTED'},
    f=>{f.state.result.status={Failure:{error:'failed'}}},
    f=>{f.state.result.transaction.hash=randomHash()},
    f=>{f.state.result.transaction.signer_id=OWNER},
    f=>{f.state.result.transaction.public_key=String(owner.getPublicKey())},
    f=>{f.state.result.transaction.receiver_id=OWNER},
    f=>{f.state.result.transaction.actions[0].DeployContract.code=Buffer.alloc(32).toString('base64')},
    f=>{f.state.result.transaction.actions[1].FunctionCall.args=Buffer.from('{"owner":"other.testnet"}').toString('base64')},
    f=>{f.state.result.transaction.actions[1].FunctionCall.gas='1'},
    f=>{f.state.result.transaction.actions[1].FunctionCall.deposit='1'},
    f=>{f.state.result.transaction.actions[2].DeleteKey.public_key=String(owner.getPublicKey())},
    f=>{f.state.result.transaction.actions.push({Transfer:{deposit:'1'}})},
    f=>{f.state.result.transaction_outcome.outcome.receipt_ids.push(randomHash())},
    f=>{f.state.result.receipts_outcome=[]},
    f=>{f.state.result.receipts_outcome[0].outcome.status={Failure:{error:'failed'}}},
    f=>{f.state.result.receipts_outcome[0].outcome.executor_id=OWNER},
    f=>{f.state.result.receipts_outcome[0].outcome.receipt_ids.push(randomHash())},
    f=>{f.state.result.receipts_outcome.push(structuredClone(f.state.result.receipts_outcome[0]))},
    f=>{addRefund(f);f.state.result.receipts[0].receiver_id=OWNER},
    f=>{addRefund(f);f.state.result.receipts[0].predecessor_id=VAULT},
    f=>{addRefund(f);f.state.result.receipts_outcome[1].outcome.receipt_ids.push(randomHash())},
  ];
  for(const change of changes){const f=await fixture();change(f);const verify=await f.verifier();await assert.rejects(verify(f.binding));}
});

test('wrong network, stale or mixed views, changed code, owner or retained key block completion',async()=>{
  const changes=[
    f=>{f.state.chain='mainnet'},
    f=>{f.state.block.header.timestamp_nanosec=String(BigInt(clock-121_000)*1_000_000n)},
    f=>{f.state.vault.block_hash=randomHash()},
    f=>{f.state.ownerKeys.block_hash=randomHash()},
    f=>{f.state.version.block_hash=randomHash()},
    f=>{f.state.vault.code_hash=randomHash()},
    f=>{delete f.state.vault.code_hash},
    f=>{f.state.vault.code_hash=emptyCode},
    f=>{f.state.vault.global_contract_hash=randomHash()},
    f=>{f.state.vault.locked='1'},
    f=>{f.state.vaultKeys.keys=[{public_key:f.review.temporary_vault_public_key,access_key:{nonce:1,permission:'FullAccess'}}]},
    f=>{f.state.owner.code_hash=randomHash()},
    f=>{f.state.ownerKeys.keys[0].access_key.permission={FunctionCall:{}}},
    f=>{f.state.ownerKeys.keys[0].access_key.nonce=-1},
    f=>{f.state.version=view(f.block,'not-v14')},
    f=>{f.state.vaultOwner=view(f.block,'other.testnet')},
    f=>{f.state.vaultOwner={block_hash:f.block,result:[255]}},
  ];
  for(const change of changes){const f=await fixture();change(f);const verify=await f.verifier();await assert.rejects(verify(f.binding));}
});

test('mismatched review, binding or changed session never reaches a usable proof',async()=>{
  const f=await fixture();
  await assert.rejects(createV14BootstrapDeploymentVerifier({review:{...f.review,vault_funding_yocto:'1'},compressedV14:compressed,
    fetch:f.fetch,crypto:webcrypto,now}));
  const verify=await f.verifier();
  await assert.rejects(verify({...f.binding,review_sha256:'0'.repeat(64)}));
  await assert.rejects(verify({...f.binding,original_hash:'not-a-hash'}));
  await assert.rejects(verify({...f.binding,extra:true}));
  assert.equal(f.methods.length,0);
  f.invalidate();await assert.rejects(verify(f.binding));assert.equal(f.methods.length,0);
});

test('binding is captured before network reads and a stale session is stopped in flight',async()=>{
  const f=await fixture(),expected=structuredClone(f.binding);
  const fetch=async(url,options)=>{
    const request=JSON.parse(options.body);
    if(request.method==='status')Object.assign(f.binding,{scope_id:'ff'.repeat(16),review_sha256:'0'.repeat(64),original_hash:randomHash()});
    return f.fetch(url,options);
  };
  const verify=await createV14BootstrapDeploymentVerifier({review:f.review,compressedV14:compressed,fetch,crypto:webcrypto,now});
  const proof=await verify(f.binding);
  assert.equal(proof.original_hash,expected.original_hash);assert.equal(proof.scope_id,expected.scope_id);
  assert.equal(proof.review_sha256,expected.review_sha256);

  const stale=await fixture();
  const staleFetch=async(url,options)=>{const response=await stale.fetch(url,options);stale.invalidate();return response};
  const check=await createV14BootstrapDeploymentVerifier({review:stale.review,compressedV14:compressed,
    fetch:staleFetch,crypto:webcrypto,now,isCurrent:()=>stale.methods.length===0});
  await assert.rejects(check(stale.binding));assert.deepEqual(stale.methods,['status']);
});
