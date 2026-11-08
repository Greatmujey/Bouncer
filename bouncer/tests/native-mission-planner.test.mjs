// Fake model responses only. No real model, wallet, provider or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateNativePlanningCatalog, nativeMissionFromProposal, planNativeObjective,
  createNativeModelClient } from '../agent/native-mission-planner.mjs';

const read = name => JSON.parse(fs.readFileSync(new URL(`../examples/${name}`,import.meta.url),'utf8'));
function catalog() {
  return {version:1,market:{mission:read('native-market-mission.example.json'),max_quantity:100},
    random:{mission:read('native-mission.example.json'),min:0,max:1000,max_span:100}};
}

test('untrusted planner makes a real bounded choice and preserves all owner-controlled authority', async () => {
  const c=catalog(), seen=[];
  const market=await planNativeObjective({objective:'Estimate the USD value of 25 NEAR and record it',catalog:c,
    modelClient:async input=>{seen.push(input);return {kind:'market',quantity:25}}});
  assert.deepEqual(seen,[{objective:'Estimate the USD value of 25 NEAR and record it',choices:['market','random']}]);
  assert.deepEqual(market.goals.map(x=>x.kind),['oracle','market','storage']);
  assert.equal(market.goals[1].goal.input.quantity,25);
  const expected=structuredClone(c.market.mission);expected.goals[1].goal.input.quantity=25;
  assert.deepEqual(market,expected);assert.ok(Object.isFrozen(market.goals[1].goal.input));
  const random=await planNativeObjective({objective:'Pick a random integer between 4 and 8 and record the result',catalog:c,
    modelClient:async()=>({kind:'random',min:4,max:8})});
  assert.deepEqual(random.goals.map(x=>x.kind),['random','oracle','storage']);
  assert.deepEqual(random.goals[0].goal.input,{min:4,max:8});
  const randomExpected=structuredClone(c.random.mission);randomExpected.goals[0].goal.input={min:4,max:8};
  assert.deepEqual(random,randomExpected);
});

test('unknown fields, changed routes, out-of-catalog work and limits fail closed', () => {
  const c=catalog();
  for (const proposal of [{kind:'market',quantity:101},{kind:'market',quantity:0},{kind:'market',quantity:2,amount:'999'},
    {kind:'market',quantity:2,owner:'attacker.testnet'},{kind:'random',min:0,max:101},{kind:'random',min:-1,max:1},
    {kind:'random',min:10,max:9},{kind:'random',min:1,max:2,program:'evil'},{kind:'storage'},[],null]) {
    assert.throws(()=>nativeMissionFromProposal(proposal,c));
  }
  for (const alter of [x=>{x.market.mission.contract_id='other.testnet'},x=>{x.random.mission.goals.reverse()},
    x=>{x.market.max_quantity=0},x=>{x.random.max_span=1000001},x=>{x.market.mission.goals[2].goal.value.from_goal_ids=['price']},
    x=>{x.random.mission.id=x.market.mission.id},x=>{x.extra=true}]) {
    const bad=catalog();alter(bad);assert.throws(()=>validateNativePlanningCatalog(bad));
  }
});

test('catalog is snapshotted before model callbacks, with no silent fallback', async () => {
  const c=catalog(),expected=c.market.mission.goals[1].goal.program.sha256;
  const plan=await planNativeObjective({objective:'Value 5 NEAR',catalog:c,modelClient:async()=>{
    c.market.mission.goals[1].goal.program.sha256='a'.repeat(64);c.market.max_quantity=1000;
    return {kind:'market',quantity:5};
  }});
  assert.equal(plan.goals[1].goal.program.sha256,expected);assert.equal(plan.goals[1].goal.input.quantity,5);
  await assert.rejects(planNativeObjective({objective:'Value 5 NEAR',catalog:catalog(),modelClient:async()=>({kind:'unsupported'})}));
  await assert.rejects(planNativeObjective({objective:'',catalog:catalog(),modelClient:async()=>({kind:'market',quantity:1})}));
});

const response = (content,finish='stop') => new Response(JSON.stringify({choices:[{finish_reason:finish,message:{role:'assistant',content}}]}),
  {status:200,headers:{'content-type':'application/json'}});
test('model adapter sends only the objective and task shapes and accepts one complete JSON proposal', async () => {
  let request;
  const model=createNativeModelClient({endpoint:'https://model.example/v1/chat/completions',model:'test-model',apiKey:'secret-for-test',
    fetchImpl:async(url,options)=>{request={url:String(url),...options};return response(JSON.stringify({task:{kind:'market',quantity:7}}));}});
  const result=await model({objective:'Estimate 7 NEAR',choices:['market','random']});
  assert.deepEqual(result,{kind:'market',quantity:7});assert.equal(request.redirect,'error');
  assert.equal(request.headers.authorization,'Bearer secret-for-test');
  const body=JSON.parse(request.body);
  assert.equal(body.messages[1].content,'Estimate 7 NEAR');assert.equal(body.stream,false);
  assert.equal(body.response_format.json_schema.schema.type,'object');
  assert.ok(!request.body.includes('great_mujey.testnet'));assert.ok(!request.body.includes('private_key'));
  for (const options of [
    {endpoint:'http://remote.example/v1/chat/completions',model:'x'},
    {endpoint:'https://user:pass@model.example/v1/chat/completions',model:'x'},
    {endpoint:'https://model.example/v1/chat/completions?secret=1',model:'x'},
    {endpoint:'https://model.example/v1/chat/completions',model:'x',apiKey:'bad\nvalue'},
  ]) assert.throws(()=>createNativeModelClient(options));
});

test('model refusal, truncation, ambiguous choices, bad JSON and unauthorized fields do not fall back', async () => {
  const envelopes=[
    response(JSON.stringify({task:{kind:'market',quantity:1}}),'length'),
    response('not-json'), response(JSON.stringify({task:{kind:'market',quantity:1},extra:true})),
    new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',refusal:'no'}}]})),
    new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{}'}},
      {finish_reason:'stop',message:{role:'assistant',content:'{}'}}]})),
  ];
  for(const fake of envelopes) {
    const model=createNativeModelClient({endpoint:'http://127.0.0.1:18000/v1/chat/completions',model:'test',fetchImpl:async()=>fake});
    await assert.rejects(model({objective:'Value 1 NEAR',choices:['market','random']}));
  }
});
