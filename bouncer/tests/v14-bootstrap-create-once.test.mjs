import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan} from '../web-src/v14-bootstrap-plan.mjs';
import {createV14BootstrapCreatePreflight} from '../web-src/v14-bootstrap-create-preflight.mjs';
import {createV14BootstrapCreateVerifier} from '../web-src/v14-bootstrap-create-verifier.mjs';
import {createBootstrapTwoCopyWitness} from '../web-src/v14-bootstrap-originals.mjs';
import {createBootstrapOriginalRetainer,isBootstrapOriginalRetainer} from '../web-src/v14-bootstrap-original-retainer.mjs';
import {prepareV14BootstrapCreateOnce} from '../web-src/v14-bootstrap-create-once.mjs';
import {prepareIsolatedBootstrapCreateOnce} from '../integration/v14-bootstrap-create-once-rehearsal.mjs';
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,clock=1_800_000_000_000,now=()=>clock,zero='0'.repeat(64);
const owner='great_mujey.testnet',vault=`native.${owner}`,funding=String(6n*10n**24n);
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const location={origin:'https://bouncer-production-6df1.up.railway.app',host:'bouncer-production-6df1.up.railway.app'};
const randomHash=()=>encodeBase58(crypto.randomBytes(32));
const f=(send_sir,send_not_sir,execution)=>({send_sir,send_not_sir,execution});
const costs={action_receipt_creation_config:f(108059500000,108059500000,108059500000),action_creation_config:{
  create_account_cost:f(500000000000,500000000000,7200000000000),transfer_cost:f(115123062500,115123062500,115123062500),
  add_key_cost:{full_access_cost:f(101765125000,101765125000,101765125000)},deploy_contract_cost:f(184765750000,184765750000,184765750000),
  deploy_contract_cost_per_byte:f(6812999,47683715,64572944),function_call_cost:f(200000000000,200000000000,780000000000),
  function_call_cost_per_byte:f(2235934,47683715,2235934),delete_key_cost:f(94946625000,94946625000,94946625000)}};
function store(){
  let snapshot={revision:0,head_sha256:zero,events:[]},lose=false;
  return {
    async read(){return structuredClone(snapshot)},
    async append({expected_revision,expected_head_sha256,record}){
      if(expected_revision!==snapshot.revision||expected_head_sha256!==snapshot.head_sha256)throw Error('conflict');
      const head=await bootstrapSha256(webcrypto,record);
      // An asynchronous digest must not make the compare-and-append non-atomic.
      if(expected_revision!==snapshot.revision||expected_head_sha256!==snapshot.head_sha256)throw Error('conflict');
      snapshot={revision:expected_revision+1,head_sha256:head,events:[...snapshot.events,record]};
      if(lose){lose=false;throw Error('response lost after write')}
      return structuredClone(snapshot);
    },
    loseNext(){lose=true},
  };
}
async function fixture({outcome='success'}={}){
  const pair=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519'),block=randomHash();
  const plan=await buildV14TemporaryBootstrapPlan({owner,ownerPublicKey:String(pair.getPublicKey()),vault,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:funding,compressedV14:compressed,crypto:webcrypto});
  const scopeId=crypto.randomBytes(16).toString('hex'),local=store(),remote=store();
  const state={amount:String(26n*10n**24n),present:false,gas:'100000000',statusCalls:0,onStatus:null};
  let current=true,walletCalls=0,walletRequest=null;
  const fetch=async(url,opts)=>{
    assert.equal(url,'https://rpc.testnet.near.org');assert.equal(opts.method,'POST');
    const req=JSON.parse(opts.body);let result,error;
    switch(req.method){
      case 'status':state.statusCalls++;state.onStatus?.(state.statusCalls);result={chain_id:'testnet'};break;
      case 'block':result={header:{hash:block,height:100,timestamp_nanosec:String(BigInt(clock)*1_000_000n)}};break;
      case 'EXPERIMENTAL_protocol_config':result={chain_id:'testnet',protocol_version:90,runtime_config:{
        storage_amount_per_byte:'10000000000000000000',min_gas_purchase_price:'1000000000',
        account_creation_charge:'7000000000000000000000',transaction_costs:costs}};break;
      case 'gas_price':result={gas_price:state.gas};break;
      case 'query':
        assert.equal(req.params.block_id,block);
        if(req.params.account_id===vault){
          if(state.present)result={block_hash:block};
          else error={cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:vault,block_hash:block}}};
        }else if(req.params.request_type==='view_account')result={block_hash:block,amount:state.amount,
          code_hash:'11111111111111111111111111111111',storage_usage:264};
        else if(req.params.request_type==='view_access_key_list')result={block_hash:block,keys:[{
          public_key:plan.review.owner_public_key,access_key:{nonce:9,permission:'FullAccess'}}]};
        else throw Error('unexpected query');break;
      default:throw Error('a network send was attempted');
    }
    return Response.json({jsonrpc:'2.0',id:req.id,...(error?{error}:{result})});
  };
  const verifyCreateFinal=await createV14BootstrapCreateVerifier({review:plan.review,compressedV14:compressed,fetch,crypto:webcrypto,now});
  const buildWitness=()=>createBootstrapTwoCopyWitness({scopeId,reviewSha256:plan.review.review_sha256,localStore:local,remoteStore:remote,
    verifyCreateFinal,crypto:webcrypto,now});
  const witness=buildWitness(),retainer=await createBootstrapOriginalRetainer({review:plan.review,compressedV14:compressed,
    witness,verifyCreateFinal,crypto:webcrypto});
  const preflight=await createV14BootstrapCreatePreflight({review:plan.review,compressedV14:compressed,fetch,crypto:webcrypto,now,
    isCurrent:()=>current});
  const txHash=randomHash();
  const wallet={manifest:{features:{signAndSendTransaction:true}},async signAndSendTransaction(request){
    walletCalls++;walletRequest=structuredClone(request);
    // The two copies must already contain the one-shot claim before a wallet
    // adapter has any opportunity to send.
    assert.equal((await local.read()).revision,1);assert.deepEqual(await local.read(),await remote.read());
    if(outcome==='throw')throw Error('response lost');
    if(outcome==='missing')return undefined;
    if(outcome==='malformed')return {transaction:{hash:txHash},transaction_outcome:{id:randomHash()}};
    if(outcome==='retention-uncertain')remote.loseNext();
    if(outcome==='change-session')current=false;
    return {transaction:{hash:txHash},transaction_outcome:{id:txHash}};
  }};
  const opts={review:plan.review,compressedV14:compressed,witness,retainer,preflight,wallet,location,isTopLevel:true,
    isCurrent:()=>current,now,crypto:webcrypto};
  const prepare=(patch={})=>prepareIsolatedBootstrapCreateOnce({...opts,...patch});
  return {plan,scopeId,local,remote,state,witness,retainer,verifyCreateFinal,preflight,opts,prepare,txHash,buildWitness,
    calls:()=>walletCalls,request:()=>walletRequest,stop:()=>{current=false}};
}
const approve=prompt=>prompt.invoke({approved:true,reviewedTermsSha256:prompt.terms_sha256});

test('live entry point shows an exact read-only review but cannot be unlocked by an injected fake recovery gate',async()=>{
  const x=await fixture();
  const p=await prepareV14BootstrapCreateOnce({...x.opts,assertRecoveryReady:async()=>true});
  assert.equal(p.transaction_authorized,false);assert.equal(p.independent_recovery_verified,false);
  assert.equal(p.terms.owner,owner);assert.equal(p.terms.vault,vault);
  assert.equal(p.terms.budget.proposed_vault_funding_yocto,funding);
  assert.deepEqual(p.terms.create_actions,x.plan.review.stages[0].actions);
  assert.deepEqual(p.terms.deployment_actions,x.plan.review.stages[1].actions);
  assert.equal(Object.isFrozen(p.terms),true);assert.equal(Object.isFrozen(p.terms.create_actions[1]),true);
  assert.ok(p.terms.limitations.some(item=>item.includes('different transaction-signing key')));
  await assert.rejects(approve(p));assert.equal(x.calls(),0);
  assert.equal((await x.local.read()).revision,0);assert.deepEqual(await x.local.read(),await x.remote.read());
});

test('isolated adapter claims once, sends the exact reviewed wallet request, and retains the returned original',async()=>{
  const x=await fixture(),p=await x.prepare();
  await assert.rejects(p.invoke({approved:false,reviewedTermsSha256:p.terms_sha256}));
  await assert.rejects(p.invoke({approved:true,reviewedTermsSha256:'0'.repeat(64)}));
  const result=await approve(p);
  assert.equal(result.status,'CREATE_ORIGINAL_RETAINED');assert.equal(result.original_hash,x.txHash);
  assert.equal(result.wallet_request_attempted,true);assert.equal(result.wallet_may_have_broadcast,true);
  assert.equal(result.final_execution_verified,false);assert.equal(result.independent_recovery_verified,false);
  assert.deepEqual(x.request(),x.plan.walletRequest);assert.equal(x.calls(),1);
  assert.equal((await x.local.read()).revision,2);assert.deepEqual(await x.local.read(),await x.remote.read());
  await assert.rejects(approve(p));await assert.rejects(x.prepare());assert.equal(x.calls(),1);
});

test('lost, rejected and malformed wallet results remain claimed and never get retried',async()=>{
  for(const outcome of ['missing','throw','malformed']){
    const x=await fixture({outcome}),p=await x.prepare(),result=await approve(p);
    assert.equal(result.status,'WALLET_RESULT_UNKNOWN');assert.equal(result.original_hash,null);assert.equal(result.do_not_retry,true);
    assert.equal(x.calls(),1);assert.equal((await x.local.read()).revision,1);
    assert.deepEqual(await x.local.read(),await x.remote.read());
    await assert.rejects(approve(p));await assert.rejects(x.prepare());assert.equal(x.calls(),1);
  }
});

test('a returned original is retained even when the wallet session changes while it is open',async()=>{
  const x=await fixture({outcome:'change-session'}),p=await x.prepare(),result=await approve(p);
  assert.equal(result.status,'CREATE_ORIGINAL_RETAINED');assert.equal(result.original_hash,x.txHash);
  assert.equal((await x.local.read()).revision,2);assert.deepEqual(await x.local.read(),await x.remote.read());
});

test('an uncertain original append returns the known hash without retrying either write or wallet',async()=>{
  const x=await fixture({outcome:'retention-uncertain'}),p=await x.prepare(),result=await approve(p);
  assert.equal(result.status,'ORIGINAL_RETENTION_UNCERTAIN');assert.equal(result.original_hash,x.txHash);
  assert.equal(result.do_not_retry,true);assert.equal(x.calls(),1);
  assert.equal((await x.local.read()).revision,2);assert.equal((await x.remote.read()).revision,2);
  await assert.rejects(approve(p));assert.equal(x.calls(),1);
});

test('an expired review or disconnected session cannot reach the claim or the wallet',async()=>{
  const x=await fixture();let time=clock;
  const p=await x.prepare({now:()=>time});time+=120_001;
  await assert.rejects(approve(p));assert.equal((await x.local.read()).revision,0);assert.equal(x.calls(),0);
  const y=await fixture(),q=await y.prepare();y.stop();
  await assert.rejects(approve(q));assert.equal((await y.local.read()).revision,0);assert.equal(y.calls(),0);
});

test('changed costs or on-chain state stop before or after claim without a wallet call',async()=>{
  for(const at of [2,3]){
    const x=await fixture();x.state.onStatus=count=>{if(count===at)x.state.gas='2000000000'};
    const p=await x.prepare();await assert.rejects(approve(p));assert.equal(x.calls(),0);
    assert.equal((await x.local.read()).revision,at===2?0:1);assert.deepEqual(await x.local.read(),await x.remote.read());
    await assert.rejects(approve(p));
  }
  const x=await fixture();x.state.onStatus=count=>{if(count===3)x.state.present=true};
  const p=await x.prepare();await assert.rejects(approve(p));assert.equal(x.calls(),0);
  assert.equal((await x.local.read()).revision,1);
});

test('uncertain claim write stops before opening a wallet and is not retried',async()=>{
  const x=await fixture(),p=await x.prepare();x.remote.loseNext();await assert.rejects(approve(p));
  assert.equal(x.calls(),0);assert.equal((await x.local.read()).revision,1);assert.equal((await x.remote.read()).revision,1);
  await assert.rejects(approve(p));await assert.rejects(x.prepare());assert.equal(x.calls(),0);
});

test('concurrent isolated preparations cannot both claim and prompt',async()=>{
  const x=await fixture(),w2=x.buildWitness(),r2=await createBootstrapOriginalRetainer({review:x.plan.review,compressedV14:compressed,
    witness:w2,verifyCreateFinal:x.verifyCreateFinal,crypto:webcrypto});
  const [a,b]=await Promise.all([x.prepare(),x.prepare({witness:w2,retainer:r2})]);
  const results=await Promise.allSettled([approve(a),approve(b)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.calls(),1);
  assert.equal((await x.local.read()).revision,2);assert.deepEqual(await x.local.read(),await x.remote.read());
});

test('review, preflight and retainer must all be bound to the same witnessed plan',async()=>{
  const x=await fixture(),other=await fixture();
  assert.equal(isBootstrapOriginalRetainer(x.retainer,x.witness,x.plan.review.review_sha256),true);
  assert.equal(isBootstrapOriginalRetainer(x.retainer,other.witness,x.plan.review.review_sha256),false);
  await assert.rejects(x.prepare({retainer:other.retainer}));
  await assert.rejects(x.prepare({preflight:other.preflight}));
  await assert.rejects(x.prepare({review:{...x.plan.review,vault_funding_yocto:'1'}}));
  await assert.rejects(x.prepare({location:{origin:'https://evil.example',host:'evil.example'}}));
  await assert.rejects(x.prepare({isTopLevel:false}));
  x.stop();await assert.rejects(x.prepare());assert.equal(x.calls(),0);
});
