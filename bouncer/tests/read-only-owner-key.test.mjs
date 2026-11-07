import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from '@near-js/crypto';
import { inspectReadOnlyOwnerKey } from '../agent/read-only-owner-key.mjs';
import { createOwnerKeyFallbackFetch } from '../web-src/read-only-owner-key-fallback.mjs';
import { firstSetupPreflightFixture } from './fixtures/wallet-setup-preflight-provider.mjs';

const owner='buyer.testnet', publicKey=String(KeyPair.fromRandom('ed25519').getPublicKey());
test('public owner key fallback requires testnet, current FINAL, canonical key and matching pinned block', async () => {
  const {provider,state,blockHash}=firstSetupPreflightFixture({owner,ownerKey:publicKey});
  const result=await inspectReadOnlyOwnerKey({owner,publicKey,provider});
  assert.equal(result.full_access,true); assert.equal(result.block_hash,blockHash);
  assert.deepEqual(state.calls.filter(x=>x[0]==='ownerKey')[0].slice(1),[owner,publicKey,{blockId:blockHash}]);
  state.ownerKey.permission={FunctionCall:{}};
  assert.equal((await inspectReadOnlyOwnerKey({owner,publicKey,provider})).full_access,false);
  state.network='mainnet'; await assert.rejects(inspectReadOnlyOwnerKey({owner,publicKey,provider})); state.network='testnet';
  state.blockAgeMs=121_000; await assert.rejects(inspectReadOnlyOwnerKey({owner,publicKey,provider})); state.blockAgeMs=0;
  state.ownerKey.block_hash='wrong'; await assert.rejects(inspectReadOnlyOwnerKey({owner,publicKey,provider}));
  await assert.rejects(inspectReadOnlyOwnerKey({owner:'buyer.near',publicKey,provider}));
  await assert.rejects(inspectReadOnlyOwnerKey({owner,publicKey:'ed25519:bad',provider}));
});

test('browser falls back only for exact read-only owner checks, not transaction requests', async () => {
  const calls=[], relay='https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read';
  const json=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
  const fetch=async (url,options={})=>{
    calls.push([url,options.method||'GET']);
    if(url==='https://test.rpc.fastnear.com') throw Error('offline');
    if(url==='/api/read-only/config') return json({relay_url:relay});
    if(url==='/api/read-only/pending') return json({jobs:[]});
    if(url==='/api/read-only/owner-key') { assert.deepEqual(JSON.parse(options.body),{owner,publicKey}); return json({full_access:true}); }
    throw Error('unexpected URL');
  };
  const wrapped=createOwnerKeyFallbackFetch({fetch,enabled:true});
  const body={jsonrpc:'2.0',id:'bouncer-cli-login',method:'query',params:{request_type:'view_access_key',finality:'final',account_id:owner,public_key:publicKey}};
  const result=await (await wrapped('https://test.rpc.fastnear.com',{method:'POST',body:JSON.stringify(body)})).json();
  assert.equal(result.result.permission,'FullAccess');
  const before=calls.length;
  await assert.rejects(wrapped('https://test.rpc.fastnear.com',{method:'POST',body:JSON.stringify({...body,method:'broadcast_tx_async'})}));
  assert.equal(calls.length,before+1); assert.equal(calls.at(-1)[0],'https://test.rpc.fastnear.com');
  const disabled=createOwnerKeyFallbackFetch({fetch,enabled:false});
  await assert.rejects(disabled('https://test.rpc.fastnear.com',{method:'POST',body:JSON.stringify(body)}));
});

test('owner check uses the actual bounded RPC provider and only pinned view calls', async () => {
  const { ReadOnlyNearReceiptProvider } = await import('../agent/read-only-near-receipts.mjs');
  const now = Date.now(), blockHash = (await import('near-api-js')).default.utils.serialize.base_encode(Buffer.alloc(32,11)), requests=[];
  const fetchImpl = async (url,options) => {
    assert.equal(url,'https://test.rpc.fastnear.com/'); const req=JSON.parse(options.body); requests.push(req);
    const result = req.method === 'status' ? {chain_id:'testnet'} : req.method === 'block'
      ? {header:{hash:blockHash,timestamp_nanosec:String(BigInt(now)*1_000_000n)}}
      : {block_hash:blockHash,nonce:12,permission:'FullAccess'};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-read-only',result}),{headers:{'content-type':'application/json'}});
  };
  const provider=new ReadOnlyNearReceiptProvider('https://test.rpc.fastnear.com',{fetchImpl});
  assert.equal((await inspectReadOnlyOwnerKey({owner,publicKey,provider,now:()=>now})).full_access,true);
  assert.deepEqual(requests.map(x=>x.method),['status','block','query']);
  assert.deepEqual(requests.at(-1).params,{request_type:'view_access_key',account_id:owner,public_key:publicKey,block_id:blockHash});
});
