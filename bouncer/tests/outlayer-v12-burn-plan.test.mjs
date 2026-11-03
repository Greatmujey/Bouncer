import test from 'node:test';
import assert from 'node:assert/strict';
import nearApi from 'near-api-js';
import { buildOutlayerBurnStage,createOutlayerBurnPlan,OUTLAYER_BURN_REVIEW } from '../agent/outlayer-v12-burn-plan.mjs';
import { OUTLAYER_FAKE_USD,OUTLAYER_TESTNET } from '../agent/outlayer-v12-readiness.mjs';
const owner={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:'bouncer-owner-aaaaaaaaaaaaaaaaaaaaaaaa.testnet',
 public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey())};
const funding=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()), project=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
const plan=createOutlayerBurnPlan({ownerPlan:owner,fundingPublicKey:funding,projectPublicKey:project});
const build=stage=>buildOutlayerBurnStage({plan,ownerPlan:owner,stage});
const unpack=a=>{const f=a.functionCall;return {name:f.methodName,args:JSON.parse(Buffer.from(f.args).toString()),gas:f.gas,deposit:f.deposit}};

test('diagnostic stages never use Circle, arbitrary recipients or signing keys',()=>{
 const reg=build('register-fake');assert.equal(reg.receiver_id,OUTLAYER_FAKE_USD);
 assert.deepEqual(reg.actions.map(unpack).map(x=>x.args.account_id),[plan.owner,plan.vault]);
 assert.equal(reg.actions.reduce((s,x)=>s+unpack(x).deposit,0n),2500000000000000000000n);
 const wrap=unpack(build('wrap').actions[0]);assert.equal(wrap.name,'near_deposit');assert.equal(wrap.deposit,100000000000000n);
 const swap=unpack(build('swap-fake').actions[0]);assert.equal(swap.args.receiver_id,'ref-finance-101.testnet');
 const terms=JSON.parse(swap.args.msg);assert.equal(terms.actions[0].pool_id,54);assert.equal(terms.actions[0].token_out,OUTLAYER_FAKE_USD);
 assert.equal(terms.actions[0].min_amount_out,'15000');
 const fund=unpack(build('fund-vault').actions[0]);assert.deepEqual(fund.args,{receiver_id:plan.vault,amount:'10000',msg:''});
 assert.equal(fund.deposit,1n);assert.match(OUTLAYER_BURN_REVIEW.asset,/not Circle/);
});

test('one-yocto owner configuration pins policies, routes and bounded testnet NEAR',()=>{
 const stage=build('configure'), calls=stage.actions.map(unpack);
 assert.equal(stage.receiver_id,plan.vault);assert.equal(calls[0].name,'deposit_native');
 assert.equal(calls[0].deposit,20000000000000000000000n);
 for(const call of calls.slice(1))assert.equal(call.deposit,1n,`${call.name} must retain the owner escalation guard`);
 assert.equal(calls.filter(x=>x.name==='allow_payee').length,3);
 assert.ok(calls.filter(x=>x.name==='allow_payee').every(x=>x.args.payee===OUTLAYER_TESTNET));
 assert.equal(calls.find(x=>x.name==='set_ft_call_message').args.msg,'{"action":"deposit_balance"}');
 const route=calls.find(x=>x.name==='set_outlayer_project').args.project;
 assert.equal(route.token,OUTLAYER_FAKE_USD);assert.equal(route.attached_usd,'10000');
 assert.equal(route.input_data,'{"operation":"burn","rounds":50}');
 assert.ok(calls.reduce((n,x)=>n+x.gas,0n)<=300000000000000n);
});

test('provider agents use separate single-method access keys and zero-deposit actions',()=>{
 const keys=build('install-keys');assert.equal(keys.receiver_id,plan.owner);assert.equal(keys.actions.length,2);
 const permissions=keys.actions.map(a=>a.addKey.accessKey.permission.functionCall);
 assert.deepEqual(permissions.map(x=>x.methodNames),[['execute_ft_call'],['execute_outlayer_project']]);
 for(const x of permissions){assert.equal(x.receiverId,plan.vault);assert.equal(x.allowance,500000000000000000000000n)}
 assert.equal(OUTLAYER_BURN_REVIEW.agent_gas_allowance_yocto,'500000000000000000000000');
 const fundingCall=build('fund-provider'),run=build('run-project');
 assert.equal(fundingCall.signer_public_key,funding);assert.equal(run.signer_public_key,project);
 assert.equal(unpack(fundingCall.actions[0]).deposit,0n);assert.equal(unpack(run.actions[0]).deposit,0n);
 assert.equal(unpack(fundingCall.actions[0]).args.payee,OUTLAYER_TESTNET);
 assert.equal(unpack(run.actions[0]).args.expected_route.project.attached_usd,'10000');
});

test('plan rejects added terms, key reuse, altered identity and unsupported stages',()=>{
 for(const invalid of [{...plan,extra:true},{...plan,network:'mainnet'},{...plan,vault:'attacker.testnet'},
  {...plan,vault_code_hash:'other'},{...plan,funding_public_key:project},{...plan,funding_public_key:owner.public_key},
  {...plan,project_public_key:'ed25519:bad'}])assert.throws(()=>buildOutlayerBurnStage({plan:invalid,ownerPlan:owner,stage:'configure'}));
 assert.throws(()=>build('withdraw'));assert.throws(()=>createOutlayerBurnPlan({ownerPlan:owner,fundingPublicKey:funding,projectPublicKey:funding}));
});
