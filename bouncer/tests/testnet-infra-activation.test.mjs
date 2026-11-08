import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForTestnetInfraActivation} from '../agent/testnet-infra-activation.mjs';

test('a missing or unreadable instruction waits without activating',async()=>{
  let reads=0,clock=0,activations=0;
  const result=await waitForTestnetInfraActivation({runId:'42',deadline:3,now:()=>clock,wait:async()=>clock++,
    readControl:async()=>{reads++;if(reads===1)throw Error('missing file');return null},activate:async()=>{activations++}});
  assert.equal(result,false);assert.equal(reads,3);assert.equal(activations,0);
});

test('only the exact run-specific instruction activates, once',async()=>{
  let clock=0,activations=0;
  const values=[{version:1,run_id:'41',mode:'serve-testnet'},{version:1,run_id:'42',mode:'serve-testnet',extra:true},
    {version:1,run_id:'42',mode:'serve-testnet'}];
  const result=await waitForTestnetInfraActivation({runId:'42',deadline:10,now:()=>clock,wait:async()=>clock++,
    readControl:async()=>values.shift(),activate:async()=>{activations++}});
  assert.equal(result,true);assert.equal(activations,1);assert.equal(clock,2);
});

test('an uncertain activation is propagated and never retried',async()=>{
  let calls=0;
  await assert.rejects(waitForTestnetInfraActivation({runId:'42',deadline:10,now:()=>0,wait:async()=>{},
    readControl:async()=>({version:1,run_id:'42',mode:'serve-testnet'}),activate:async()=>{calls++;throw Error('uncertain')}}),/uncertain/);
  assert.equal(calls,1);
});
