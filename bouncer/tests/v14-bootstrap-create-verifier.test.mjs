import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {createV14BootstrapCreateVerifier,inspectBootstrapCreateReceipt,V14_BOOTSTRAP_READ_RPC} from '../web-src/v14-bootstrap-create-verifier.mjs';
import {createBootstrapTwoCopyWitness} from '../web-src/v14-bootstrap-originals.mjs';
import {createBootstrapOriginalRetainer} from '../web-src/v14-bootstrap-original-retainer.mjs';
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,clock=1_800_000_000_000,now=()=>clock,scope='ab'.repeat(16);
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const randomHash=()=>encodeBase58(crypto.randomBytes(32));
const emptyCode='11111111111111111111111111111111';
const OWNER='buyer.testnet',VAULT='store.buyer.testnet',FUNDING=String(6n*10n**24n);
async function fixture(){
  const plan=await buildV14TemporaryBootstrapPlan({owner:OWNER,ownerPublicKey:String(owner.getPublicKey()),vault:VAULT,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:FUNDING,compressedV14:compressed,crypto:webcrypto});
  const review=plan.review,original=randomHash(),root=randomHash(),block=randomHash();
  const actions=['CreateAccount',{Transfer:{deposit:FUNDING}},{AddKey:{public_key:review.temporary_vault_public_key,
    access_key:{nonce:0,permission:'FullAccess'}}}];
  const action={signer_id:OWNER,signer_public_key:review.owner_public_key,gas_price:'100000000',
    input_data_ids:[],output_data_receivers:[],actions};
  const receipt={predecessor_id:OWNER,receiver_id:VAULT,receipt_id:root,receipt:{Action:action}};
  const outcome={id:root,outcome:{executor_id:VAULT,status:{SuccessValue:''},receipt_ids:[]}};
  const result={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:original,signer_id:OWNER,
    public_key:review.owner_public_key,receiver_id:VAULT,actions:structuredClone(actions)},
    transaction_outcome:{id:original,outcome:{executor_id:OWNER,status:{SuccessReceiptId:root},receipt_ids:[root]}},
    receipts:[receipt],receipts_outcome:[outcome]};
  const state={chain:'testnet',result,block:{header:{hash:block,height:200,timestamp_nanosec:String(BigInt(clock)*1_000_000n)}},
    owner:{block_hash:block,code_hash:emptyCode},vault:{block_hash:block,code_hash:emptyCode,amount:FUNDING,locked:'0',storage_usage:200},
    ownerKeys:{block_hash:block,keys:[{public_key:review.owner_public_key,access_key:{nonce:1,permission:'FullAccess'}}]},
    vaultKeys:{block_hash:block,keys:[{public_key:review.temporary_vault_public_key,access_key:{nonce:0,permission:'FullAccess'}}]}};
  const methods=[];
  async function fetch(url,options){
    assert.equal(url,V14_BOOTSTRAP_READ_RPC);assert.equal(options.method,'POST');
    const req=JSON.parse(options.body);methods.push(req.method);
    let value;
    switch(req.method){
      case 'status':value={chain_id:state.chain};break;
      case 'EXPERIMENTAL_tx_status':
        assert.deepEqual(req.params,{tx_hash:original,sender_account_id:OWNER,wait_until:'FINAL'});value=state.result;break;
      case 'block':assert.deepEqual(req.params,{finality:'final'});value=state.block;break;
      case 'query': {
        assert.equal(req.params.block_id,block);
        const {request_type,account_id}=req.params;
        if(request_type==='view_account')value=account_id===OWNER?state.owner:state.vault;
        else if(request_type==='view_access_key_list')value=account_id===OWNER?state.ownerKeys:state.vaultKeys;
        else throw Error('unexpected read');break;
      }
      default:throw Error('a transaction or other RPC method was attempted');
    }
    return Response.json({jsonrpc:'2.0',id:req.id,result:value});
  }
  const verifier=()=>createV14BootstrapCreateVerifier({review,compressedV14:compressed,fetch,crypto:webcrypto,now});
  const binding={scope_id:scope,review_sha256:review.review_sha256,original_hash:original};
  return {review,original,root,block,state,methods,fetch,verifier,binding};
}
function addRefund(f){
  const id=randomHash(),action={signer_id:OWNER,signer_public_key:f.state.result.transaction.public_key,gas_price:'0',
    input_data_ids:[],output_data_receivers:[],actions:[{Transfer:{deposit:'123'}}]};
  f.state.result.receipts_outcome[0].outcome.receipt_ids.push(id);
  f.state.result.receipts.push({receipt_id:id,predecessor_id:'system',receiver_id:OWNER,receipt:{Action:action}});
  f.state.result.receipts_outcome.push({id,outcome:{executor_id:OWNER,status:{SuccessValue:''},receipt_ids:[]}});
}
function memoryStore(initial={revision:0,head_sha256:'0'.repeat(64),events:[]}) {
  let data=structuredClone(initial);
  return {read:async()=>structuredClone(data),append:async({expected_revision,expected_head_sha256,record})=>{
    assert.equal(data.revision,expected_revision);assert.equal(data.head_sha256,expected_head_sha256);
    data={revision:expected_revision+1,head_sha256:await bootstrapSha256(webcrypto,record),events:[...data.events,record]};return structuredClone(data);
  }};
}

test('FINAL exact create receipt and fresh temporary-key state produce only a read-only proof',async()=>{
  const f=await fixture();addRefund(f);
  const verify=await f.verifier(),proof=await verify(f.binding);
  assert.deepEqual(proof,{status:'CREATE_FINAL_AND_VAULT_KEY_VERIFIED',network:'testnet',...f.binding,
    final_block_hash:f.block,checked_at_ms:clock,final_execution_verified:true,temporary_full_access_key_present:true,transaction_sent:false});
  assert.deepEqual(f.methods.sort(),['status','EXPERIMENTAL_tx_status','block','query','query','query','query'].sort());
  assert.equal(inspectBootstrapCreateReceipt({result:f.state.result,review:f.review,originalHash:f.original}).root_receipt_id,f.root);
});

test('a wallet-selected alternative key is accepted only when both owner keys and every receipt agree',async()=>{
  const alternate=String(KeyPair.fromRandom('ed25519').getPublicKey());
  function useAlternate(f){
    f.state.result.transaction.public_key=alternate;
    f.state.result.receipts[0].receipt.Action.signer_public_key=alternate;
    f.state.ownerKeys.keys.push({public_key:alternate,access_key:{nonce:7,permission:'FullAccess'}});
    addRefund(f);
  }
  const f=await fixture();useAlternate(f);
  const inspected=inspectBootstrapCreateReceipt({result:f.state.result,review:f.review,originalHash:f.original});
  assert.equal(inspected.transaction_signing_public_key,alternate);
  assert.equal((await (await f.verifier())(f.binding)).final_execution_verified,true);
  for(const change of [
    x=>{x.state.ownerKeys.keys.pop()},
    x=>{x.state.ownerKeys.keys[1].access_key.permission={FunctionCall:{}}},
    x=>{x.state.ownerKeys.keys[1].access_key.nonce=Number.MAX_SAFE_INTEGER},
    x=>{x.state.ownerKeys.keys[0].access_key.permission={FunctionCall:{}}},
    x=>{x.state.result.receipts[0].receipt.Action.signer_public_key=x.review.owner_public_key},
    x=>{x.state.result.receipts[1].receipt.Action.signer_public_key=x.review.owner_public_key},
    x=>{x.state.result.transaction.public_key='ed25519:not-a-key'},
  ]){
    const x=await fixture();useAlternate(x);change(x);await assert.rejects((await x.verifier())(x.binding));
  }
});

test('the two-copy witness refuses a deployment claim until the real verifier checks its retained original',async()=>{
  const f=await fixture(),local=memoryStore(),remote=memoryStore(),verify=await f.verifier();
  const witness=createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:f.review.review_sha256,
    localStore:local,remoteStore:remote,verifyCreateFinal:verify,crypto:webcrypto,now});
  await witness.claimCreate();await witness.retainCreateOriginal(f.original);
  assert.equal((await witness.claimDeployment()).next_event,'deploy_original');
  assert.equal((await local.read()).revision,3);assert.deepEqual(await local.read(),await remote.read());
});

test('a lost wallet response can be reconciled only by verifying and retaining the exact wallet-history original',async()=>{
  const f=await fixture(),local=memoryStore(),remote=memoryStore(),verify=await f.verifier();
  const witness=createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:f.review.review_sha256,
    localStore:local,remoteStore:remote,verifyCreateFinal:verify,crypto:webcrypto,now});
  const retainer=await createBootstrapOriginalRetainer({review:f.review,compressedV14:compressed,witness,verifyCreateFinal:verify,crypto:webcrypto});
  await witness.claimCreate();
  assert.equal((await retainer.retainWalletResult(undefined)).status,'WALLET_RESULT_UNKNOWN');
  assert.equal((await local.read()).revision,1);
  const recovered=await retainer.recoverCreateFromWalletHistory(f.original);
  assert.equal(recovered.status,'RECOVERED_CREATE_ORIGINAL_RETAINED');assert.equal(recovered.final_execution_verified,true);
  assert.equal(recovered.transaction_authorized,false);assert.deepEqual(await local.read(),await remote.read());
  assert.equal((await witness.claimDeployment()).next_event,'deploy_original');
  assert.equal((await local.read()).revision,3);
});

test('wrong, failed, incomplete, changed or unlinked create receipts fail closed',async()=>{
  const changes=[
    f=>{f.state.result.final_execution_status='EXECUTED'},
    f=>{f.state.result.status={Failure:{error:'failed'}}},
    f=>{f.state.result.transaction.actions[1].Transfer.deposit='1'},
    f=>{f.state.result.transaction.actions[2].AddKey.access_key.permission={FunctionCall:{}}},
    f=>{f.state.result.receipts[0].receipt.Action.actions[2].AddKey.public_key=String(owner.getPublicKey())},
    f=>{f.state.result.transaction_outcome.outcome.receipt_ids.push(randomHash())},
    f=>{f.state.result.receipts_outcome[0].outcome.receipt_ids.push(randomHash())},
    f=>{f.state.result.receipts[0].predecessor_id=VAULT},
    f=>{f.state.result.receipts_outcome[0].outcome.status={Failure:{error:'failed'}}},
    f=>{addRefund(f);f.state.result.receipts[1].receiver_id=VAULT},
  ];
  for(const change of changes){const f=await fixture();change(f);const verify=await f.verifier();await assert.rejects(verify(f.binding));}
});

test('wrong network, stale or mixed block, changed vault, key or owner fail closed',async()=>{
  const changes=[
    f=>{f.state.chain='mainnet'},
    f=>{f.state.block.header.timestamp_nanosec=String(BigInt(clock-121_000)*1_000_000n)},
    f=>{f.state.vault.block_hash=randomHash()},
    f=>{f.state.vault.code_hash=randomHash()},
    f=>{f.state.vault.amount='1'},
    f=>{f.state.vault.locked='1'},
    f=>{f.state.vaultKeys.keys=[]},
    f=>{f.state.vaultKeys.keys.push({public_key:String(owner.getPublicKey()),access_key:{nonce:0,permission:'FullAccess'}})},
    f=>{f.state.vaultKeys.keys[0].access_key.permission={FunctionCall:{}}},
    f=>{f.state.ownerKeys.keys[0].access_key.permission={FunctionCall:{}}},
  ];
  for(const change of changes){const f=await fixture();change(f);const verify=await f.verifier();await assert.rejects(verify(f.binding));}
});

test('a changed review or mismatched witness binding never reaches a usable proof',async()=>{
  const f=await fixture();
  await assert.rejects(createV14BootstrapCreateVerifier({review:{...f.review,vault_funding_yocto:'1'},compressedV14:compressed,
    fetch:f.fetch,crypto:webcrypto,now}));
  const verify=await f.verifier();
  await assert.rejects(verify({...f.binding,review_sha256:'0'.repeat(64)}));
  await assert.rejects(verify({...f.binding,original_hash:'not-a-hash'}));
  assert.equal(f.methods.length,0);
});
