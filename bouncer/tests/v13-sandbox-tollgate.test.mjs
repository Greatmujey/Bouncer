import test from 'node:test';
import assert from 'node:assert/strict';
import {exerciseV13TollgateSandbox} from '../integration/v13-sandbox-tollgate.mjs';

test('V13 channel harness rejects every non-loopback endpoint before signing',async()=>{
 for(const rpcUrl of ['https://rpc.testnet.near.org','http://localhost:3030','http://127.0.0.1:3030/elsewhere','http://127.0.0.1:3030/?x=1']){
  await assert.rejects(exerciseV13TollgateSandbox({rpcUrl}),/loopback/);
 }
});
test('V13 channel harness requires matching local root and exact fixtures',async()=>{
 const rpcUrl='http://127.0.0.1:34343',provider={connection:{url:rpcUrl}};
 for(const root of [null,{accountId:'some.testnet',provider},{accountId:'testnet',provider:{connection:{url:'http://127.0.0.1:12345'}}},
  {accountId:'testnet',provider:{connection:{url:'https://rpc.testnet.near.org'}}}]){
  await assert.rejects(exerciseV13TollgateSandbox({rpcUrl,root}),/sandbox/);
 }
 await assert.rejects(exerciseV13TollgateSandbox({rpcUrl,root:{accountId:'testnet',provider},v13Wasm:Buffer.from('fake'),
  v13Sha256:'0'.repeat(64),channelWasm:Buffer.from('fake')}),/fixture binaries/);
});
