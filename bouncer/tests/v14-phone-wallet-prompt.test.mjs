// Synthetic wallet prompts only; no real signing, network or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import nearApi from 'near-api-js';
import {IDBFactory} from 'fake-indexeddb';
import {fixture,scope,owner,vault} from './v14-witness-fixture.mjs';
import {createV14BrowserWitnessStore} from '../web-src/v14-browser-witness-store.mjs';
import {createV14BrowserOriginalWitness} from '../web-src/v14-browser-original-witness.mjs';
import {prepareV14PhoneWalletPrompt} from '../web-src/v14-phone-wallet-prompt.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),zero='0'.repeat(64);
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
function memoryStore() {
  let state={revision:0,head_sha256:zero,events:[]},lose=false;
  return {read:async()=>structuredClone(state),append:async({expected_revision,expected_head_sha256,record})=>{
    if(state.revision!==expected_revision||state.head_sha256!==expected_head_sha256)throw Error('CAS conflict');
    state={revision:state.revision+1,head_sha256:sha(record),events:[...state.events,record]};
    if(lose){lose=false;throw Error('lost response')};return structuredClone(state);
  },loseNext:()=>{lose=true}};
}
async function setup() {
  const {review,inputs,binding}=fixture(),remote=memoryStore();
  const local=await createV14BrowserWitnessStore({indexedDB:new IDBFactory(),crypto:webcrypto,owner,vault,scopeId:scope,
    journalKeyHex:'a'.repeat(64),initializeBrandNew:true});
  const witness=await createV14BrowserOriginalWitness({review,trustedReviewSha256:review.review_sha256,scopeId:scope,
    localStore:local,independentStore:remote,crypto:webcrypto});
  await witness.reserve();let preflights=0,walletCalls=0;
  const wallet={manifest:{features:{signAndSendTransaction:true}},signAndSendTransaction:async request=>{
    walletCalls++;
    const state=await witness.inspect();assert.equal(state.pending.stage_id,binding.stages[0].id);assert.equal(state.pending.tx_hash,null);
    assert.equal(request.network,'testnet');assert.equal(request.signerId,owner);assert.equal(request.receiverId,vault);
    return {transaction:{hash:hash(50)},transaction_outcome:{id:hash(50)}};
  }};
  const verifyPreflight=async({stageId,prior})=>{preflights++;const stage=review.stages.find(item=>item.id===stageId);
    return {status:'V14_SETUP_PREFLIGHT_MATCH',network:'testnet',owner,vault,stage_id:stageId,review_sha256:review.review_sha256,
      action_commitment_sha256:stage.action_commitment_sha256,prior_original_hashes:prior.map(item=>item.tx_hash),
      final_block_hash:hash(200),checked_at_ms:10_000,wallet_transaction_authorized:false,transaction_sent:false};
  };
  const args={review,trustedReviewSha256:review.review_sha256,scopeId:scope,stageId:binding.stages[0].id,
    trustedArtifacts:{...inputs.trustedArtifacts,compressed_sha256:sha(inputs.compressed)},
    loaderBytes:new Uint8Array(inputs.loaderWasm),compressedBytes:new Uint8Array(inputs.compressed),witness,wallet,verifyPreflight,
    location:{origin:'https://bouncer-near.vercel.app'},isTopLevel:true,isCurrent:()=>true,now:()=>10_001,crypto:webcrypto};
  return {args,binding,local,remote,witness,preflights:()=>preflights,walletCalls:()=>walletCalls};
}

test('wallet receives one exact reviewed stage only after a two-copy claim and two fresh preflights',async()=>{
  const s=await setup(),prompt=await prepareV14PhoneWalletPrompt(s.args);
  assert.equal(s.walletCalls(),0);assert.equal(prompt.wallet_prompt_authorized,false);
  const result=await prompt.invoke();assert.equal(s.preflights(),2);assert.equal(s.walletCalls(),1);
  assert.deepEqual(result,{status:'ORIGINAL_HASH_RETAINED',original_hash:hash(50),do_not_retry:true,final_execution_verified:false});
  assert.equal((await s.witness.inspect()).pending.tx_hash,hash(50));
  await assert.rejects(prompt.invoke(),/do not repeat/);
  const reopened=await prepareV14PhoneWalletPrompt(s.args);await assert.rejects(reopened.invoke(),/do not repeat/);
  assert.equal(s.walletCalls(),1);s.local.close();
});

test('stale preflight before claim causes no prompt; a second preflight failure preserves the claim',async()=>{
  let s=await setup();s.args.verifyPreflight=async()=>({});
  const before=await prepareV14PhoneWalletPrompt(s.args);await assert.rejects(before.invoke(),/do not repeat/);
  assert.equal((await s.witness.inspect()).pending,null);assert.equal(s.walletCalls(),0);s.local.close();
  s=await setup();const valid=s.args.verifyPreflight;let calls=0;
  s.args.verifyPreflight=async input=>{const value=await valid(input);if(++calls===2)value.checked_at_ms=1;return value};
  const after=await prepareV14PhoneWalletPrompt(s.args);await assert.rejects(after.invoke(),/do not repeat/);
  assert.equal((await s.witness.inspect()).pending.stage_id,s.binding.stages[0].id);assert.equal(s.walletCalls(),0);
  await assert.rejects((await prepareV14PhoneWalletPrompt(s.args)).invoke(),/do not repeat/);s.local.close();
});

test('a preflight that becomes stale while rereading both copies blocks the claimed prompt',async()=>{
  const s=await setup();let checks=0;s.args.now=()=>++checks<3?10_001:20_001;
  const prompt=await prepareV14PhoneWalletPrompt(s.args);await assert.rejects(prompt.invoke(),/do not repeat/);
  assert.equal(s.walletCalls(),0);assert.equal((await s.witness.inspect()).pending.stage_id,s.binding.stages[0].id);
  s.local.close();
});

test('an unknown wallet response never triggers a second prompt',async()=>{
  const s=await setup();let calls=0;s.args.wallet.signAndSendTransaction=async()=>{calls++;throw Error('wallet closed')};
  const prompt=await prepareV14PhoneWalletPrompt(s.args);
  assert.deepEqual(await prompt.invoke(),{status:'WALLET_RESULT_UNKNOWN',original_hash:null,do_not_retry:true,final_execution_verified:false});
  assert.equal((await s.witness.inspect()).pending.tx_hash,null);await assert.rejects(prompt.invoke(),/do not repeat/);
  assert.equal(calls,1);s.local.close();
});

test('retention uncertainty returns the original hash and never resends',async()=>{
  const s=await setup();let calls=0;s.args.wallet.signAndSendTransaction=async()=>{calls++;s.remote.loseNext();return {transaction:{hash:hash(70)}}};
  const prompt=await prepareV14PhoneWalletPrompt(s.args);
  assert.deepEqual(await prompt.invoke(),{status:'ORIGINAL_RETENTION_UNCERTAIN',original_hash:hash(70),do_not_retry:true,final_execution_verified:false});
  assert.equal(calls,1);assert.equal((await s.remote.read()).revision,3);assert.equal((await s.local.read()).revision,2);
  await assert.rejects(prompt.invoke(),/do not repeat/);s.local.close();
});

test('wrong artifact, untrusted scope, stale session, iframe and fake witness are blocked before wallet access',async()=>{
  for(const change of [
    s=>{s.args.trustedArtifacts.loader_sha256='f'.repeat(64)},
    s=>{s.args.scopeId='4'.repeat(32)},
    s=>{s.args.isCurrent=()=>false},
    s=>{s.args.isTopLevel=false},
    s=>{s.args.witness={inspect:async()=>({})}},
  ]) {
    const s=await setup();change(s);
    try {const prompt=await prepareV14PhoneWalletPrompt(s.args);await assert.rejects(prompt.invoke(),/do not repeat/)}
    catch(error){assert.match(error.message,/do not repeat|no wallet prompt/)}
    assert.equal(s.walletCalls(),0);s.local.close();
  }
});
