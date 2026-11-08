import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runNativeResource } from '../agent/mixed-mission.mjs';
import { ORACLE_TESTNET_PROJECT,validateOracleGoal } from '../agent/oracle-outlayer.mjs';

const goal={id:'synthetic-native',contract_id:'bouncer.testnet',owner_account_id:'owner.testnet',policy_id:'price',amount:'100',
  route:{project:{...ORACLE_TESTNET_PROJECT},route_revision:1,policy_revision:1,payee_revision:1,active:true},max_age_seconds:300};
function fixture({stale=false}={}){
  const records=new Map(),calls=[],journal={get:id=>records.get(id),put:(id,record)=>records.set(id,record)};
  const delivery={tx_hash:'synthetic-original',result:{timestamp:Math.floor(Date.now()/1000)-(stale?1000:0),price_usd:2.5},max_age_seconds:300};
  const runners={async outlayer({execute,goal:seen}){calls.push(execute?'send':'preview');assert.equal(seen.amount,'100');
    if(!execute)return {status:'READY'};journal.put(seen.id,{status:'completed',delivery});return {status:'FULFILLED',delivery}},
    async recover({update,publicKey}){calls.push(`recover:${update}`);assert.equal(publicKey,undefined);return {status:'REUSED',delivery}}};
  return {records,calls,journal,runners,delivery,options:{outlayer:{kind:'oracle',goal},provider:{},journal,runners,log:()=>{}}};
}

test('a native-only resource no longer requires any FT goals and never claims a full multi-resource mission',async()=>{
  const f=fixture(),preview=await runNativeResource(f.options);assert.equal(preview.status,'READY');assert.equal(preview.resources,null);
  assert.match(preview.scope,/not a full compute, storage and API/);assert.deepEqual(f.calls,['preview']);
  const result=await runNativeResource({...f.options,execute:true});
  assert.equal(result.status,'NATIVE_RESOURCE_FULFILLED');assert.equal(result.oracle_fresh_for_use,true);
  assert.deepEqual(f.calls,['preview','preview','send']);assert.equal(f.records.size,1);
});

test('pending original and stale historical oracle result are recovered without signing, spending, or pretending current freshness',async()=>{
  const f=fixture({stale:true});f.records.set(goal.id,{status:'pending',tx_hash:'synthetic-original'});
  const result=await runNativeResource({...f.options,outlayer:{kind:'oracle',goal},execute:false});
  assert.equal(result.status,'NATIVE_RESOURCE_REUSED');assert.equal(result.oracle_fresh_for_use,false);
  assert.deepEqual(f.calls,['recover:false']);assert.equal(f.records.get(goal.id).status,'pending');
});

test('blocked preview or an original appearing during preview prevents a new payment',async()=>{
  let f=fixture();f.runners.outlayer=async()=>{f.calls.push('blocked');return {status:'BLOCKED'}};
  assert.equal((await runNativeResource({...f.options,execute:true})).stage,'native-preflight');assert.deepEqual(f.calls,['blocked']);
  f=fixture();f.runners.outlayer=async()=>{f.calls.push('preview');f.records.set(goal.id,{status:'pending'});return {status:'READY'}};
  await assert.rejects(runNativeResource({...f.options,execute:true}),/original appeared/);assert.deepEqual(f.calls,['preview']);
});

test('unknown original remains reconciliation-only; missing journal and shared FT journals are rejected',async()=>{
  const f=fixture();f.records.set(goal.id,{status:'pending',tx_hash:'synthetic-original'});
  f.runners.recover=async()=>{f.calls.push('recover');throw Error('unknown original')};
  await assert.rejects(runNativeResource({...f.options,execute:true}),/unknown original/);assert.deepEqual(f.calls,['recover']);
  await assert.rejects(runNativeResource({...f.options,journal:null,execute:true}),/original-hash journal/);
  await assert.rejects(runNativeResource({...f.options,journal:{...f.journal,sharedDirectV3:true}}),/does not coordinate/);
});

test('checked-in native-only example is an unsigned, constrained goal rather than a paid receipt',()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../examples/native-oracle-resource.example.json',import.meta.url),'utf8'));
  assert.equal(config.outlayer_kind,'oracle');assert.equal(config.resources,undefined);
  assert.deepEqual(validateOracleGoal(config.outlayer_goal),config.outlayer_goal);
  assert.equal(config.outlayer_goal.owner_account_id,'great_mujey.testnet');
  assert.equal(config.outlayer_goal.contract_id,'native.great_mujey.testnet');
});

test('native-only CLI recovery refuses signing keys, execution, absent journals and absent originals',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-native-cli-')),cli=fileURLToPath(new URL('../agent/mixed-mission.mjs',import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10_000});
  try{
    const config=path.join(dir,'mission.json'),journal=path.join(dir,'journal.json');
    fs.writeFileSync(config,JSON.stringify({outlayer_kind:'oracle',outlayer_goal:goal}));
    const help=run('--help');assert.equal(help.status,0);assert.match(help.stdout,/not a full mission/);assert.match(help.stdout,/without signing keys/);
    const invalid=run('--mission',config,'--recover-only','--outlayer-key','never-read.json');
    assert.equal(invalid.status,1);assert.match(invalid.stderr,/without signing keys/);
    const noJournal=run('--mission',config,'--recover-only','--journal',journal);
    assert.equal(noJournal.status,1);assert.match(noJournal.stderr,/original journal not found/);assert.equal(fs.existsSync(journal),false);
    fs.writeFileSync(journal,JSON.stringify({version:1,contract_id:goal.contract_id,owner_account_id:goal.owner_account_id,entries:[]}));
    const empty=run('--mission',config,'--recover-only','--journal',journal);
    assert.equal(empty.status,1);assert.match(empty.stderr,/original not found/);assert.equal(fs.existsSync(`${journal}.lock`),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
