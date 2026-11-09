import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {KeyPair} from '@near-js/crypto';
import {buildV14TemporaryBootstrapPlan,signV14TemporaryBootstrapDeployment} from '../web-src/v14-bootstrap-plan.mjs';
import {createBootstrapOriginalRetainer} from '../web-src/v14-bootstrap-original-retainer.mjs';
import {createV14BootstrapCreateVerifier} from '../web-src/v14-bootstrap-create-verifier.mjs';
import {createBootstrapTwoCopyWitness,isBootstrapTwoCopyWitness} from '../web-src/v14-bootstrap-originals.mjs';
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';

const webcrypto=crypto.webcrypto,scope='ab'.repeat(16),clock=1_800_000_000_000,now=()=>clock;
const compressed=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const owner=KeyPair.fromRandom('ed25519'),temporary=KeyPair.fromRandom('ed25519');
const randomHash=()=>encodeBase58(crypto.randomBytes(32));
const OWNER='buyer.testnet',VAULT='store.buyer.testnet',FUNDING=String(6n*10n**24n);
function memoryStore() {
  let data={revision:0,head_sha256:'0'.repeat(64),events:[]},lose=false;
  return {read:async()=>structuredClone(data),loseNext:()=>{lose=true},append:async({expected_revision,expected_head_sha256,record})=>{
    if(data.revision!==expected_revision||data.head_sha256!==expected_head_sha256)throw Error('CAS failed');
    data={revision:expected_revision+1,head_sha256:await bootstrapSha256(webcrypto,record),events:[...data.events,record]};
    if(lose){lose=false;throw Error('synthetic lost response after commit')}return structuredClone(data);
  }};
}
async function fixture({mode='valid',funding=FUNDING}={}) {
  const plan=await buildV14TemporaryBootstrapPlan({owner:OWNER,ownerPublicKey:String(owner.getPublicKey()),vault:VAULT,
    temporaryPublicKey:String(temporary.getPublicKey()),vaultFundingYocto:funding,compressedV14:compressed,crypto:webcrypto});
  const local=memoryStore(),remote=memoryStore(),createHash=randomHash(),root=randomHash(),block=randomHash();let verifies=0;
  const actions=['CreateAccount',{Transfer:{deposit:mode==='wrong-actions'?'1':funding}},{AddKey:{
    public_key:plan.review.temporary_vault_public_key,access_key:{nonce:0,permission:'FullAccess'}}}];
  const action={signer_id:OWNER,signer_public_key:plan.review.owner_public_key,gas_price:'100000000',
    input_data_ids:[],output_data_receivers:[],actions};
  const result={final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:createHash,signer_id:OWNER,
    public_key:plan.review.owner_public_key,receiver_id:VAULT,actions:structuredClone(actions)},
    transaction_outcome:{id:createHash,outcome:{executor_id:OWNER,status:{SuccessReceiptId:root},receipt_ids:[root]}},
    receipts:[{predecessor_id:OWNER,receiver_id:VAULT,receipt_id:root,receipt:{Action:action}}],
    receipts_outcome:[{id:root,outcome:{executor_id:VAULT,status:{SuccessValue:''},receipt_ids:[]}}]};
  const fetch=async(_url,options)=>{
    const req=JSON.parse(options.body);let value;
    if(req.method==='status'){verifies++;if(mode==='unavailable')throw Error('RPC unavailable');value={chain_id:'testnet'}}
    else if(req.method==='EXPERIMENTAL_tx_status')value=result;
    else if(req.method==='block')value={header:{hash:block,height:200,timestamp_nanosec:String(BigInt(clock-(mode==='stale'?121_000:0))*1_000_000n)}};
    else if(req.method==='query'){
      const ownerView=req.params.account_id===OWNER;
      if(req.params.request_type==='view_account')value={block_hash:block,code_hash:'11111111111111111111111111111111',
        ...(ownerView?{}:{amount:funding,locked:'0',storage_usage:200})};
      else if(req.params.request_type==='view_access_key_list')value={block_hash:block,keys:[{
        public_key:ownerView?plan.review.owner_public_key:plan.review.temporary_vault_public_key,access_key:{nonce:1,permission:'FullAccess'}}]};
      else throw Error('unexpected read');
    } else throw Error('unexpected method');
    return Response.json({jsonrpc:'2.0',id:req.id,result:value});
  };
  const verifyCreateFinal=await createV14BootstrapCreateVerifier({review:plan.review,compressedV14:compressed,fetch,crypto:webcrypto,now});
  const witness=createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:plan.review.review_sha256,localStore:local,remoteStore:remote,
    verifyCreateFinal,crypto:webcrypto,now});
  const retainer=await createBootstrapOriginalRetainer({review:plan.review,compressedV14:compressed,witness,verifyCreateFinal,crypto:webcrypto});
  const signed=()=>signV14TemporaryBootstrapDeployment({review:plan.review,expectedReviewSha256:plan.review.review_sha256,
    compressedV14:compressed,temporaryKey:temporary,nonce:'1',blockHash:randomHash(),crypto:webcrypto});
  return {plan,local,remote,witness,retainer,createHash,signed,verifyCreateFinal,verifies:()=>verifies};
}
async function readyForDeploy(f){
  await f.witness.claimCreate();await f.retainer.retainWalletResult({transaction:{hash:f.createHash}});
  await f.witness.claimDeployment();
}

test('a returned wallet hash is retained in both copies without another prompt or transaction',async()=>{
  const f=await fixture();assert.equal(isBootstrapTwoCopyWitness(f.witness),true);
  await f.witness.claimCreate();
  const result=await f.retainer.retainWalletResult({transaction:{hash:f.createHash},transaction_outcome:{id:f.createHash}});
  assert.equal(result.status,'CREATE_ORIGINAL_RETAINED');assert.equal(result.original_hash,f.createHash);
  assert.equal(result.do_not_retry,true);assert.equal(result.final_execution_verified,false);
  assert.equal(result.independent_recovery_verified,false);assert.equal(result.transaction_sent_by_this_operation,false);
  assert.equal((await f.local.read()).revision,2);assert.deepEqual(await f.local.read(),await f.remote.read());
  assert.equal(f.verifies(),0); // retained first; this is not a receipt
  await assert.rejects(f.retainer.retainWalletResult({transaction:{hash:f.createHash}}));
  assert.throws(()=>createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:f.plan.review.review_sha256,
    localStore:f.local,remoteStore:f.local,crypto:webcrypto}));
});

test('a missing or inconsistent wallet result stays claimed; manual hash requires verification and never prompts',async()=>{
  for(const outcome of [undefined,{}, {transaction:{hash:'not-a-hash'}},
    {transaction:{hash:randomHash()},transaction_outcome:{id:randomHash()}}]) {
    const f=await fixture();await f.witness.claimCreate();
    const result=await f.retainer.retainWalletResult(outcome);
    assert.equal(result.status,'WALLET_RESULT_UNKNOWN');assert.equal(result.original_hash,null);assert.equal(result.do_not_retry,true);
    assert.equal((await f.local.read()).revision,1);assert.deepEqual(await f.local.read(),await f.remote.read());
    await assert.rejects(f.witness.claimCreate()); // durable claim cannot be repeated
    // The failed attempted claim stops that witness instance. Reopen the exact
    // existing two copies; never initialize an empty replacement.
    const reopened=createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:f.plan.review.review_sha256,localStore:f.local,
      remoteStore:f.remote,crypto:webcrypto,now,verifyCreateFinal:f.verifyCreateFinal});
    const recovery=await createBootstrapOriginalRetainer({review:f.plan.review,compressedV14:compressed,witness:reopened,
      verifyCreateFinal:f.verifyCreateFinal,crypto:webcrypto});
    const recovered=await recovery.recoverCreateFromWalletHistory(f.createHash);
    assert.equal(recovered.status,'RECOVERED_CREATE_ORIGINAL_RETAINED');assert.equal(recovered.final_execution_verified,true);
    assert.equal(recovered.independent_recovery_verified,false);assert.equal(recovered.transaction_authorized,false);
    assert.equal((await f.local.read()).revision,2);assert.deepEqual(await f.local.read(),await f.remote.read());
    await assert.rejects(recovery.recoverCreateFromWalletHistory(f.createHash));
  }
});

test('manual recovery fails closed when the receipt is wrong, stale, or unavailable',async()=>{
  for(const mode of ['unavailable','stale','wrong-actions']) {
    const f=await fixture({mode});await f.witness.claimCreate();
    await assert.rejects(f.retainer.recoverCreateFromWalletHistory(f.createHash));
    assert.equal((await f.local.read()).revision,1);assert.deepEqual(await f.local.read(),await f.remote.read());
    await assert.rejects(f.witness.claimCreate());
  }
});

test('an uncertain append returns the known original and never retries the write',async()=>{
  const f=await fixture();await f.witness.claimCreate();f.remote.loseNext();
  const result=await f.retainer.retainWalletResult({transaction:{hash:f.createHash}});
  assert.equal(result.status,'ORIGINAL_RETENTION_UNCERTAIN');assert.equal(result.original_hash,f.createHash);assert.equal(result.do_not_retry,true);
  assert.equal((await f.local.read()).revision,2);assert.equal((await f.remote.read()).revision,2);
  await assert.rejects(f.retainer.retainWalletResult({transaction:{hash:f.createHash}}));
  await assert.rejects(f.witness.claimDeployment());
});

test('signed deployment hash is verified against pinned bytes and signature before two-copy retention',async()=>{
  const f=await fixture();await readyForDeploy(f);const original=await f.signed();
  const result=await f.retainer.retainSignedDeployment(original);
  assert.equal(result.status,'DEPLOYMENT_ORIGINAL_RETAINED');assert.equal(result.original_hash,original.transaction_hash);
  assert.equal(result.transaction_authorized,false);assert.equal(result.transaction_sent_by_this_operation,false);
  assert.deepEqual(await f.local.read(),await f.remote.read());const retained=await f.local.read();assert.equal(retained.revision,4);
  assert.equal(JSON.stringify(retained).includes(Buffer.from(original.signed_bytes).toString('base64')),false);
  assert.equal(JSON.stringify(retained).includes(String(temporary)),false);
  await assert.rejects(f.retainer.retainSignedDeployment(original));
});

test('deployment retention refuses a changed witness head before any append',async()=>{
  const f=await fixture();await readyForDeploy(f);
  await assert.rejects(f.witness.retainDeploymentOriginal(randomHash(),'0'.repeat(64)));
  assert.equal((await f.local.read()).revision,3);assert.deepEqual(await f.local.read(),await f.remote.read());
});

test('mutated or unrelated signed deployment is rejected before any append',async()=>{
  const f=await fixture();await readyForDeploy(f);const original=await f.signed();
  const badBytes=new Uint8Array(original.signed_bytes);badBytes[badBytes.length-1]^=1;
  const changed=[{signed_bytes:badBytes},{transaction_hash:randomHash()},{nonce:'2'},{block_hash:randomHash()},
    {transaction_sent:true},{status:'FINAL'},{signed_bytes:new Uint8Array(110)},{extra:true}];
  for(const patch of changed){await assert.rejects(f.retainer.retainSignedDeployment({...original,...patch}));
    assert.equal((await f.local.read()).revision,3);assert.deepEqual(await f.local.read(),await f.remote.read());}
});

test('signed bytes are snapshotted before awaiting crypto or stores',async()=>{
  const f=await fixture();await readyForDeploy(f);const original=await f.signed(),expected=original.transaction_hash;
  const pending=f.retainer.retainSignedDeployment(original);original.signed_bytes[original.signed_bytes.length-1]^=1;
  const result=await pending;assert.equal(result.status,'DEPLOYMENT_ORIGINAL_RETAINED');assert.equal(result.original_hash,expected);
});

test('a different review or unbranded witness is rejected before touching either store',async()=>{
  const f=await fixture();await assert.rejects(createBootstrapOriginalRetainer({review:{...f.plan.review,vault_funding_yocto:'1'},
    compressedV14:compressed,witness:f.witness,verifyCreateFinal:f.verifyCreateFinal,crypto:webcrypto}));
  await assert.rejects(createBootstrapOriginalRetainer({review:f.plan.review,compressedV14:compressed,
    witness:{binding:()=>({})},verifyCreateFinal:f.verifyCreateFinal,crypto:webcrypto}));
  await assert.rejects(createBootstrapOriginalRetainer({review:f.plan.review,compressedV14:compressed,
    witness:f.witness,verifyCreateFinal:async()=>({}),crypto:webcrypto}));
  const other=await fixture({funding:String(5n*10n**24n)});
  await assert.rejects(createBootstrapOriginalRetainer({review:f.plan.review,compressedV14:compressed,
    witness:f.witness,verifyCreateFinal:other.verifyCreateFinal,crypto:webcrypto}));
  const wrongPlanWitness=createBootstrapTwoCopyWitness({scopeId:scope,reviewSha256:f.plan.review.review_sha256,
    localStore:f.local,remoteStore:f.remote,crypto:webcrypto,now,verifyCreateFinal:other.verifyCreateFinal});
  await assert.rejects(createBootstrapOriginalRetainer({review:f.plan.review,compressedV14:compressed,
    witness:wrongPlanWitness,verifyCreateFinal:other.verifyCreateFinal,crypto:webcrypto}));
  assert.equal((await f.local.read()).revision,0);assert.equal((await f.remote.read()).revision,0);
});
