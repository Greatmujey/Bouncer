// Synthetic browser storage and wallet hashes only; no live account or send.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { createV14BrowserWitnessStore } from '../web-src/v14-browser-witness-store.mjs';
import { createV14BrowserOriginalWitness } from '../web-src/v14-browser-original-witness.mjs';
import { createV14OriginalWitness } from '../agent/v14-original-witness.mjs';
import { fixture,scope,owner,vault } from './v14-witness-fixture.mjs';

const webcrypto=crypto.webcrypto,key='a'.repeat(64),zero='0'.repeat(64);
const sha=text=>crypto.createHash('sha256').update(text,'utf8').digest('hex');
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
function memoryStore() {
  let current={revision:0,head_sha256:zero,events:[]},lose=false;
  return {
    // Deliberately reorder properties like a JSONB response can.
    read:async()=>({events:[...current.events],head_sha256:current.head_sha256,revision:current.revision}),
    append:async({expected_revision,expected_head_sha256,record})=>{
      if(current.revision!==expected_revision||current.head_sha256!==expected_head_sha256)throw Error('CAS conflict');
      current={revision:current.revision+1,head_sha256:sha(record),events:[...current.events,record]};
      if(lose){lose=false;throw Error('synthetic response lost after commit')}
      return structuredClone(current);
    },
    loseNext:()=>{lose=true},
  };
}
const newLocal=opts=>createV14BrowserWitnessStore({indexedDB:opts.db,crypto:webcrypto,owner,vault,scopeId:scope,
  journalKeyHex:key,initializeBrandNew:opts.initializeBrandNew??false});
async function coordinator({local,remote,review,verifySetupReceipt}={}) {
  return createV14BrowserOriginalWitness({review,trustedReviewSha256:review.review_sha256,scopeId:scope,
    localStore:local,independentStore:remote,verifySetupReceipt,crypto:webcrypto});
}
function openRaw(factory) {
  return new Promise((resolve,reject)=>{
    const request=factory.open('bouncer-v14-browser-witness-v1',1);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function rawGet(factory) {
  const db=await openRaw(factory);
  try {return await new Promise((resolve,reject)=>{
    const tx=db.transaction('originals','readonly'),request=tx.objectStore('originals').get(scope);
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  })} finally {db.close()}
}
async function rawPut(factory,value) {
  const db=await openRaw(factory);
  try {await new Promise((resolve,reject)=>{
    const tx=db.transaction('originals','readwrite');tx.objectStore('originals').put(value,scope);
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
  })} finally {db.close()}
}

test('encrypted local original survives reopening; wrong key and implicit replacement fail',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore();
  await assert.rejects(newLocal({db}),/missing or uncertain/);
  let local=await newLocal({db,initializeBrandNew:true});
  const witness=await coordinator({local,remote,review});await witness.reserve();
  await witness.claimWalletStage(binding.stages[0].id);
  const disk=await rawGet(db),encoded=JSON.stringify(disk);
  assert.equal(disk.revision,2);assert.ok(!encoded.includes(review.review_sha256));
  assert.ok(!encoded.includes(key));assert.ok(!encoded.includes('wallet_claim'));
  await assert.rejects(newLocal({db,initializeBrandNew:true}),/missing or uncertain/);
  local.close();
  await assert.rejects(createV14BrowserWitnessStore({indexedDB:db,crypto:webcrypto,owner,vault,scopeId:scope,
    journalKeyHex:'b'.repeat(64)}),/missing or uncertain/);
  local=await newLocal({db});
  const restarted=await coordinator({local,remote,review});
  assert.deepEqual((await restarted.inspect()).pending,{type:'wallet',stage_id:binding.stages[0].id,tx_hash:null});
  await assert.rejects(restarted.claimWalletStage(binding.stages[0].id),/never repeat/);
  assert.deepEqual(await local.read(),{revision:2,head_sha256:disk.head_sha256,events:(await remote.read()).events});
  local.close();
});

test('browser witness interoperates with Node witness and retains only the original hash',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),local=await newLocal({db,initializeBrandNew:true});
  const browser=await coordinator({local,remote,review,verifySetupReceipt:async({txHash})=>({tx_hash:txHash,final_block_hash:hash(250)})});
  await browser.reserve();await browser.claimWalletStage(binding.stages[0].id);
  await browser.retainWalletOriginal({stageId:binding.stages[0].id,txHash:hash(1)});
  await assert.rejects(browser.retainWalletOriginal({stageId:binding.stages[0].id,txHash:hash(2)}),/never repeat/);
  await browser.verifyWalletOriginal({stageId:binding.stages[0].id,proof:{synthetic:true}});
  const node=createV14OriginalWitness({binding,localStore:local,independentStore:remote});
  const nodeState=await node.inspect(),browserState=await browser.inspect();
  assert.equal(nodeState.setup[0].tx_hash,hash(1));assert.equal(browserState.setup[0].tx_hash,hash(1));
  assert.equal(nodeState.next_setup_stage,binding.stages[1].id);assert.equal(browserState.receipts_verified,false);
  assert.equal(browserState.wallet_transaction_authorized,false);local.close();
});

test('all six synthetic wallet stages keep their exact originals in both stores',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),local=await newLocal({db,initializeBrandNew:true});
  const witness=await coordinator({local,remote,review,verifySetupReceipt:async({txHash})=>({tx_hash:txHash,final_block_hash:hash(250)})});
  await witness.reserve();
  for(let index=0;index<binding.stages.length;index++) {
    const stageId=binding.stages[index].id;
    await witness.claimWalletStage(stageId);
    await witness.retainWalletOriginal({stageId,txHash:hash(index+1)});
    await witness.verifyWalletOriginal({stageId,proof:{synthetic:true}});
  }
  const state=await witness.inspect();
  assert.equal(state.revision,19);assert.equal(state.pending,null);assert.equal(state.next_setup_stage,null);
  assert.deepEqual(state.setup.map(item=>item.tx_hash),[1,2,3,4,5,6].map(hash));
  assert.deepEqual((await local.read()).events,(await remote.read()).events);
  await assert.rejects(witness.claimWalletStage(binding.stages[0].id),/never repeat/);local.close();
});

test('a lost independent acknowledgement blocks restart when copies differ',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),local=await newLocal({db,initializeBrandNew:true});
  const witness=await coordinator({local,remote,review});await witness.reserve();remote.loseNext();
  await assert.rejects(witness.claimWalletStage(binding.stages[0].id),/never repeat/);
  assert.equal((await local.read()).revision,1);assert.equal((await remote.read()).revision,2);
  const restarted=await coordinator({local,remote,review});
  await assert.rejects(restarted.inspect(),/copies differ/);
  await assert.rejects(restarted.claimWalletStage(binding.stages[0].id),/never repeat/);
  local.close();
});

test('two tabs cannot both claim the same stage; no retry after the first claim',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),a=await newLocal({db,initializeBrandNew:true});
  const b=await newLocal({db}),first=await coordinator({local:a,remote,review}),second=await coordinator({local:b,remote,review});
  await first.reserve();
  const results=await Promise.allSettled([first.claimWalletStage(binding.stages[0].id),second.claimWalletStage(binding.stages[0].id)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  const restarted=await coordinator({local:a,remote,review});
  assert.equal((await restarted.inspect()).pending.stage_id,binding.stages[0].id);
  await assert.rejects(restarted.claimWalletStage(binding.stages[0].id),/never repeat/);a.close();b.close();
});

test('authenticated encryption catches tampering and local rollback is detected by the independent copy',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),local=await newLocal({db,initializeBrandNew:true});
  const witness=await coordinator({local,remote,review});await witness.reserve();const old=await rawGet(db);
  await witness.claimWalletStage(binding.stages[0].id);const latest=await rawGet(db);local.close();
  await rawPut(db,{...latest,head_sha256:'f'.repeat(64)});
  await assert.rejects(newLocal({db}),/missing or uncertain/);
  await rawPut(db,old); // valid old ciphertext is still not the current copy
  const rolled=await newLocal({db}),restarted=await coordinator({local:rolled,remote,review});
  await assert.rejects(restarted.inspect(),/copies differ/);rolled.close();
});

test('changed review, invalid receipt proof and missing storage never authorize a prompt',async()=>{
  const db=new IDBFactory(),{review,binding}=fixture(),remote=memoryStore(),local=await newLocal({db,initializeBrandNew:true});
  const changed=structuredClone(review);changed.native_deposit_yocto='999';
  await assert.rejects(createV14BrowserOriginalWitness({review:changed,trustedReviewSha256:review.review_sha256,scopeId:scope,
    localStore:local,independentStore:remote,crypto:webcrypto}),/invalid or uncertain/);
  const witness=await coordinator({local,remote,review,verifySetupReceipt:async()=>({tx_hash:hash(99),final_block_hash:hash(250)})});
  await witness.reserve();await witness.claimWalletStage(binding.stages[0].id);
  await witness.retainWalletOriginal({stageId:binding.stages[0].id,txHash:hash(1)});
  await assert.rejects(witness.verifyWalletOriginal({stageId:binding.stages[0].id}),/never repeat/);
  assert.equal((await witness.inspect()).pending.tx_hash,hash(1));local.close();
  await new Promise((resolve,reject)=>{const request=db.deleteDatabase('bouncer-v14-browser-witness-v1');
    request.onsuccess=resolve;request.onerror=()=>reject(request.error)});
  await assert.rejects(newLocal({db}),/missing or uncertain/);
});
