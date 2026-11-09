// Synthetic model, signers, journal and runner only; no live model or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {FileJournal} from '../agent/procurement.mjs';
import {createPlannedNativeMissionService} from '../agent/planned-native-mission-service.mjs';

const example=name=>JSON.parse(fs.readFileSync(new URL(`../examples/${name}`,import.meta.url),'utf8'));
function fixture(){
  const catalog={version:1,market:{mission:example('native-market-mission.example.json'),max_quantity:100},
    random:{mission:example('native-mission.example.json'),min:0,max:1000,max_span:100}};
  const mission=catalog.market.mission,dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-planned-service-'));
  const journal=new FileJournal(path.join(dir,'journal.json'),mission.contract_id,mission.owner_account_id);
  const ids=new Set([...catalog.market.mission.goals,...catalog.random.mission.goals].map(({goal})=>goal.id));
  const signers=Object.fromEntries([...ids].map(id=>[id,{account:{id},publicKey:`synthetic-${id}`} ]));
  const calls={models:0,previews:[],actions:[],authenticated:0,executions:0};
  const auth={async issue(action){calls.actions.push(action);return {synthetic:true}},
    async authenticate(){calls.authenticated++;return false}};
  const run=async options=>{
    if(options.execute)calls.executions++;
    calls.previews.push(options);
    return {status:'READY',next_goal_id:options.mission.goals[0].goal.id};
  };
  const modelClient=async()=>{calls.models++;return {kind:'market',quantity:25}};
  const params={objective:'Estimate the USD value of 25 NEAR and store the result',catalog,modelClient,
    modelRequestApproved:true,provider:{},signers,journal,auth,run};
  return {catalog,signers,journal,calls,params,close(){journal.close();fs.rmSync(dir,{recursive:true,force:true})}};
}
const ownerPublicKey='ed25519:'+'1'.repeat(32);

test('one bounded model proposal becomes the immutable hash-bound owner review',async()=>{
  const f=fixture();try {
    const expectedProgram=f.catalog.market.mission.goals[1].goal.program.sha256;
    let modelInput;
    const service=await createPlannedNativeMissionService({...f.params,modelClient:async input=>{
      f.calls.models++;modelInput=input;
      // A remote model does not get these objects. This simulates concurrent
      // local changes while its response is pending.
      f.catalog.market.mission.goals[1].goal.program.sha256='a'.repeat(64);
      f.catalog.market.max_quantity=1000;f.signers.price.publicKey='changed';
      return {kind:'market',quantity:25};
    }});
    assert.deepEqual(modelInput,{objective:f.params.objective,choices:['market','random']});
    assert.equal(f.calls.models,1);assert.equal(f.calls.previews.length,0);assert.deepEqual(f.journal.list(),[]);
    const review=service.getReview(),mission=review.mission;
    assert.deepEqual(mission.goals.map(({kind})=>kind),['oracle','market','storage']);
    assert.equal(mission.goals[1].goal.input.quantity,25);
    assert.equal(mission.goals[1].goal.program.sha256,expectedProgram);
    assert.equal(review.mission_sha256,crypto.createHash('sha256').update(JSON.stringify(mission)).digest('hex'));
    review.mission.goals[1].goal.input.quantity=99; // caller only gets a copy
    assert.equal(service.getReview().mission.goals[1].goal.input.quantity,25);
    const hash=service.getReview().mission_sha256;
    await service.preview({missionSha256:hash});
    assert.equal(f.calls.previews[0].signers.price.publicKey,'synthetic-price');
    assert.equal(f.calls.previews[0].mission.goals[1].goal.input.quantity,25);
    await service.issue({missionSha256:hash,ownerPublicKey,goalId:'price'});
    assert.equal(f.calls.actions[0].mission_sha256,hash);assert.equal(f.calls.actions[0].goal_id,'price');
    assert.equal(f.calls.actions[0].max_native_yocto,mission.max_native_amount);
    await assert.rejects(service.execute({missionSha256:'0'.repeat(64),ownerPublicKey,goalId:'price',evidence:{}}));
    await assert.rejects(service.execute({missionSha256:hash,ownerPublicKey,goalId:'price',evidence:{}}));
    assert.equal(f.calls.authenticated,1);assert.equal(f.calls.executions,0);assert.deepEqual(f.journal.list(),[]);
  }finally{f.close()}
});

test('missing model consent or incomplete owner configuration never calls a model',async()=>{
  for(const changed of [
    f=>({modelRequestApproved:false}),
    f=>({signers:{}}),
    f=>({signers:{...f.signers,price:undefined}}),
    f=>({auth:undefined}),
    f=>({journal:undefined}),
    f=>({catalog:{...f.catalog,version:2}}),
    f=>({objective:''}),
  ]) {
    const f=fixture();try {
      await assert.rejects(createPlannedNativeMissionService({...f.params,...changed(f)}));
      assert.equal(f.calls.models,0);assert.equal(f.calls.executions,0);assert.deepEqual(f.journal.list(),[]);
    }finally{f.close()}
  }
});

test('unsupported or inflated proposals stop; a different allowed task gets a different review',async()=>{
  const f=fixture();try {
    for(const proposal of [{kind:'market',quantity:101},{kind:'market',quantity:1,receiver:'attacker.testnet'},
      {kind:'random',min:0,max:101},{kind:'storage'}]) {
      await assert.rejects(createPlannedNativeMissionService({...f.params,modelClient:async()=>proposal}));
    }
    const service=await createPlannedNativeMissionService({...f.params,objective:'Pick a number from 4 to 8',
      modelClient:async()=>({kind:'random',min:4,max:8})});
    const review=service.getReview();
    assert.deepEqual(review.mission.goals.map(({kind})=>kind),['random','oracle','storage']);
    assert.deepEqual(review.mission.goals[0].goal.input,{min:4,max:8});
    assert.equal(review.mission.max_native_amount,f.catalog.random.mission.max_native_amount);
    assert.equal(f.calls.executions,0);assert.deepEqual(f.journal.list(),[]);
  }finally{f.close()}
});
