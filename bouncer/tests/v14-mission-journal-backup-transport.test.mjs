// Synthetic fixed-origin transport only: no external service or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {encryptFileJournal} from '../agent/file-journal-crypto.mjs';
import {createSupabaseV14MissionJournalStore,V14_MISSION_BACKUP_ENDPOINT} from '../agent/supabase-v14-mission-journal-store.mjs';
import {createV14MissionJournalBackupHandler} from '../infrastructure/v14-mission-journal-backup-handler.mjs';

const scope='1'.repeat(32),cap='2'.repeat(64),owner='owner.testnet',vault='native.owner.testnet',head='3'.repeat(64);
const sha=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const txHash='1'.repeat(32);
const ciphertext=encryptFileJournal({version:1,contract_id:vault,owner_account_id:owner,entries:[]},Buffer.alloc(32,5),vault,owner);
const record={format:'bouncer-v14-mission-journal-backup-v1',scope_id:scope,owner,vault,review_sha256:'4'.repeat(64),
  mission_sha256:'5'.repeat(64),witness_revision:19,witness_head_sha256:head,goal_id:'compute',kind:'random',tx_hash:txHash,
  fingerprint:'6'.repeat(64),phase:'pending',ciphertext_sha256:sha(ciphertext),ciphertext};
function fixture() {
  const env={BOUNCER_V14_MISSION_BACKUP_ENABLE:'1',SUPABASE_URL:'https://jiouaqwxkvlkmvyumzwc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-secret'};
  const saved=new Map(),calls=[];let failAfterWrite=false,mutateReply=false;
  const upstream=async(url,options)=>{
    calls.push({url,options});assert.equal(url,`${env.SUPABASE_URL}/rest/v1/rpc/bouncer_v14_mission_journal_backup_v1`);
    assert.equal(options.redirect,'error');assert.equal(options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);
    const body=JSON.parse(options.body);assert.equal(body.p_capability_hash,sha(cap));assert.ok(!options.body.includes(cap));
    const key=`${body.p_goal_id}:${body.p_phase}`;
    if(body.p_operation==='append') {
      if(saved.has(key))return Response.json({error:'unavailable'});
      saved.set(key,JSON.parse(body.p_record));
      if(failAfterWrite){failAfterWrite=false;throw Error('synthetic lost acknowledgement')}
    }
    const row=saved.get(key);let result=row?{status:'EXISTING_BACKUP',record:structuredClone(row)}:{status:'MISSING'};
    if(mutateReply&&row)result.record.tx_hash='2'.repeat(32);
    return Response.json(result);
  };
  const handler=createV14MissionJournalBackupHandler({getEnv:key=>env[key],fetch:upstream,crypto:crypto.webcrypto});
  let clientCalls=0;
  const client=createSupabaseV14MissionJournalStore({scopeId:scope,capability:cap,fetch:async(url,options)=>{
    clientCalls++;assert.equal(url,V14_MISSION_BACKUP_ENDPOINT);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    return handler(new Request(url,options));
  }});
  return {env,calls,handler,client,get clientCalls(){return clientCalls},loseNext:()=>{failAfterWrite=true},
    mutate:value=>{mutateReply=value}};
}
const request=(body,options={})=>new Request(V14_MISSION_BACKUP_ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(body),...options});

test('fixed server transport retains and rereads ciphertext; lost acknowledgement is not retried',async()=>{
  const f=fixture();assert.equal(await f.client.read({goal_id:'compute',phase:'pending'}),null);
  f.loseNext();await assert.rejects(f.client.append(record),/unavailable or uncertain/);
  assert.equal(f.clientCalls,2);assert.equal(f.calls.length,2); // exactly one append
  assert.deepEqual(await f.client.read({goal_id:'compute',phase:'pending'}),record);
  f.mutate(true);await assert.rejects(f.client.append(record),/unavailable or uncertain/);
  assert.equal(f.calls.length,4); // duplicate is refused; no implicit resend
  assert.ok(f.calls.every(call=>!call.options.body.includes('synthetic-service-secret')));
});

test('handler and client fail shut on default-off, origins, wrong scope, head or response',async()=>{
  const f=fixture(),body={scope_id:scope,capability:cap,operation:'read',goal_id:'compute',phase:'pending'};
  f.env.BOUNCER_V14_MISSION_BACKUP_ENABLE='0';assert.equal((await f.handler(request(body))).status,503);assert.equal(f.calls.length,0);
  f.env.BOUNCER_V14_MISSION_BACKUP_ENABLE='1';
  assert.equal((await f.handler(request(body,{headers:{'content-type':'application/json',origin:'https://bouncer-near.vercel.app'}}))).status,403);
  assert.equal((await f.handler(new Request(V14_MISSION_BACKUP_ENDPOINT,{method:'GET'}))).status,405);
  assert.equal((await f.handler(request({...body,extra:true}))).status,503);
  assert.equal((await f.handler(request({...body,capability:'bad'}))).status,503);
  assert.equal((await f.handler(request({...body,operation:'append',expected_revision:19,expected_head_sha256:head,
    record:{...record,witness_head_sha256:'f'.repeat(64)}}))).status,503);
  assert.equal(f.calls.length,0);
  f.env.SUPABASE_URL='https://wrong.example';assert.equal((await f.handler(request(body))).status,503);assert.equal(f.calls.length,0);
  assert.throws(()=>createSupabaseV14MissionJournalStore({scopeId:'bad',capability:cap}),/unavailable/);
  assert.throws(()=>f.client.read({goal_id:'bad/id',phase:'pending'}),/unavailable/);
});

test('client rejects a substituted acknowledgement and never loops',async()=>{
  let calls=0;
  const client=createSupabaseV14MissionJournalStore({scopeId:scope,capability:cap,fetch:async()=>{
    calls++;return Response.json({status:'EXISTING_BACKUP',record:{...record,tx_hash:'2'.repeat(32)}});
  }});
  await assert.rejects(client.append(record),/unavailable or uncertain/);assert.equal(calls,1);
});
