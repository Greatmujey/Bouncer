import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {createV14BootstrapCreatePreflight,isV14BootstrapCreatePreflight} from '../web-src/v14-bootstrap-create-preflight.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,clock=1_800_000_000_000,now=()=>clock;
const owner='great_mujey.testnet',vault=`native.${owner}`,funding=String(6n*10n**24n);
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const pair=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const block=encodeBase58(crypto.randomBytes(32));
const f=(send_sir,send_not_sir,execution)=>({send_sir,send_not_sir,execution});
const costs={action_receipt_creation_config:f(108059500000,108059500000,108059500000),action_creation_config:{
  create_account_cost:f(500000000000,500000000000,7200000000000),transfer_cost:f(115123062500,115123062500,115123062500),
  add_key_cost:{full_access_cost:f(101765125000,101765125000,101765125000)},deploy_contract_cost:f(184765750000,184765750000,184765750000),
  deploy_contract_cost_per_byte:f(6812999,47683715,64572944),function_call_cost:f(200000000000,200000000000,780000000000),
  function_call_cost_per_byte:f(2235934,47683715,2235934),delete_key_cost:f(94946625000,94946625000,94946625000)}};
async function fixture(){
  const {review}=await buildV14TemporaryBootstrapPlan({owner,ownerPublicKey:String(pair.getPublicKey()),vault,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:funding,compressedV14:compressed,crypto:webcrypto});
  const state={chain:'testnet',present:false,clock,amount:String(26n*10n**24n),
    keys:[{public_key:review.owner_public_key,access_key:{nonce:9,permission:'FullAccess'}}]};
  const methods=[];let current=true;
  const fetch=async(url,opts)=>{
    assert.equal(url,'https://rpc.testnet.near.org');assert.equal(opts.method,'POST');
    const req=JSON.parse(opts.body);methods.push(req.method);let result,error;
    switch(req.method){
      case 'status':result={chain_id:state.chain};break;
      case 'block':result={header:{hash:block,height:100,timestamp_nanosec:String(BigInt(state.clock)*1_000_000n)}};break;
      case 'EXPERIMENTAL_protocol_config':result={chain_id:'testnet',protocol_version:90,runtime_config:{
        storage_amount_per_byte:'10000000000000000000',min_gas_purchase_price:'1000000000',
        account_creation_charge:'7000000000000000000000',transaction_costs:costs}};break;
      case 'gas_price':result={gas_price:'100000000'};break;
      case 'query':
        assert.equal(req.params.block_id,block);
        if(req.params.account_id===vault){
          if(state.present)result={block_hash:block};
          else error={cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:vault,block_hash:block}}};
        }else if(req.params.request_type==='view_account')result={block_hash:block,amount:state.amount,
          code_hash:'11111111111111111111111111111111',storage_usage:264};
        else if(req.params.request_type==='view_access_key_list')result={block_hash:block,keys:state.keys};
        else throw Error('unexpected query');break;
      default:throw Error('a send or other RPC method was attempted');
    }
    return Response.json({jsonrpc:'2.0',id:req.id,...(error?{error}:{result})});
  };
  const prepare=(given=review)=>createV14BootstrapCreatePreflight({review:given,compressedV14:compressed,
    fetch,crypto:webcrypto,now,isCurrent:()=>current});
  return {review,state,methods,prepare,stop:()=>{current=false}};
}

test('preflight binds the pinned plan and its exact owner key to one fresh read-only budget snapshot',async()=>{
  const x=await fixture(),preflight=await x.prepare();
  assert.equal(isV14BootstrapCreatePreflight(preflight,x.review.review_sha256),true);
  assert.equal(isV14BootstrapCreatePreflight(preflight,'0'.repeat(64)),false);
  const proof=await preflight();
  assert.equal(proof.status,'CREATE_PREFLIGHT_MATCH');assert.equal(proof.final_block_hash,block);
  assert.equal(proof.review_sha256,x.review.review_sha256);assert.equal(proof.owner_public_key,x.review.owner_public_key);
  assert.equal(proof.create_action_commitment_sha256,x.review.stages[0].action_commitment_sha256);
  assert.equal(proof.budget.proposed_vault_funding_yocto,funding);assert.equal(proof.checked_at_ms,clock);
  assert.equal(Object.isFrozen(proof.budget),true);assert.equal(Object.isFrozen(proof.budget.create),true);
  assert.equal(proof.wallet_control_verified,false);assert.equal(proof.independent_recovery_verified,false);
  assert.equal(proof.latest_head_independently_verified,false);assert.equal(proof.transaction_authorized,false);
  assert.equal(proof.transaction_sent,false);
  assert.deepEqual(x.methods.sort(),['status','block','query','query','query','EXPERIMENTAL_protocol_config','gas_price'].sort());
});

test('present vault, a different or restricted owner key, low funding and stale blocks fail closed',async()=>{
  const other=String(KeyPair.fromRandom('ed25519').getPublicKey());
  for(const change of [s=>{s.present=true},s=>{s.chain='mainnet'},s=>{s.amount='1'},
    s=>{s.keys=[{public_key:other,access_key:{nonce:9,permission:'FullAccess'}}]},
    s=>{s.keys[0].access_key.permission={FunctionCall:{}}},s=>{s.keys[0].access_key.nonce=Number.MAX_SAFE_INTEGER},
    s=>{s.clock=clock-121_000}]) {
    const x=await fixture(),preflight=await x.prepare();change(x.state);await assert.rejects(preflight());
  }
  const x=await fixture(),preflight=await x.prepare();x.stop();await assert.rejects(preflight());assert.equal(x.methods.length,0);
});

test('a modified or differently funded plan is rejected before any RPC read',async()=>{
  const x=await fixture();
  await assert.rejects(x.prepare({...x.review,vault_funding_yocto:'1'}));
  const {review:different}=await buildV14TemporaryBootstrapPlan({owner,ownerPublicKey:String(pair.getPublicKey()),vault,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:String(5n*10n**24n),compressedV14:compressed,crypto:webcrypto});
  await assert.rejects(x.prepare(different));assert.equal(x.methods.length,0);
});

test('preflight captures review inputs before asynchronous verification',async()=>{
  const x=await fixture(),mutable=structuredClone(x.review),creating=x.prepare(mutable);
  mutable.vault_funding_yocto='1';mutable.stages[0].actions[1].deposit_yocto='1';
  const proof=await (await creating)();assert.equal(proof.review_sha256,x.review.review_sha256);
  assert.equal(proof.budget.proposed_vault_funding_yocto,funding);
});
