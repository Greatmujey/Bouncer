// Disposable PostgreSQL only. No real wallet, account, provider or transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const url=process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS==='1' && !url) throw Error('disposable PostgreSQL required');
const dbtest=url?test:test.skip;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const zero='0'.repeat(64),scope='1'.repeat(32),capHash=sha('synthetic capability'),owner='fixture.testnet',vault='native.fixture.testnet';
const sql=fs.readFileSync(new URL('../infrastructure/v14-original-checkpoint.sql',import.meta.url),'utf8');

async function database(run) {
  const admin=new pg.Pool({connectionString:url,max:2}),name=`bouncer_v14_ckpt_${crypto.randomBytes(6).toString('hex')}`;
  let db,created=false;
  try {
    // Supabase already has these NOLOGIN roles. The isolated CI cluster does not.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    const target=new URL(url);target.pathname=`/${name}`;db=new pg.Pool({connectionString:target.href,max:8});
    await db.query(sql);await run(db);
  } finally { if(db)await db.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end(); }
}
const event=(seq,previous,type,data)=>JSON.stringify({format:'bouncer-v14-original-event-v1',seq,previous_sha256:previous,type,data});
async function call(db,operation,revision=null,head=null,record=null,cap=capHash) {
  return (await db.query('SELECT public.bouncer_v14_original_checkpoint_v1($1,$2,$3,$4,$5,$6) AS value',
    [scope,cap,operation,revision,head,record])).rows[0].value;
}

dbtest('separate PostgreSQL checkpoint has scoped access, one-winner CAS and append-only originals',async()=>database(async db=>{
  // This is a database fixture, not a NEAR wallet or account. Real provisioning
  // is deliberately unavailable to the public/Edge service role.
  await db.query('INSERT INTO bouncer_v14_originals_v1.streams(scope_id,owner_id,vault_id,capability_hash) VALUES($1,$2,$3,$4)',[scope,owner,vault,capHash]);
  await assert.rejects(db.query('INSERT INTO bouncer_v14_originals_v1.streams(scope_id,owner_id,vault_id,capability_hash) VALUES($1,$2,$3,$4)',
    ['2'.repeat(32),owner,vault,capHash]));
  assert.deepEqual(await call(db,'read'),{revision:0,head_sha256:zero,events:[]});
  assert.deepEqual(await call(db,'read',null,null,null,'f'.repeat(64)),{error:'unavailable'});
  const bad=event(1,zero,'reserve',{scope_id:scope,owner:'other.testnet',vault});
  assert.deepEqual(await call(db,'append',0,zero,bad),{error:'unavailable'});
  const missing=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:1,previous_sha256:zero,data:{scope_id:scope,owner,vault},unknown:true});
  assert.deepEqual(await call(db,'append',0,zero,missing),{error:'unavailable'});
  const first=event(1,zero,'reserve',{scope_id:scope,owner,vault});
  assert.deepEqual(await call(db,'append',0,zero,first),{revision:1,head_sha256:sha(first),events:[first]});
  const second=['left','right'].map(value=>event(2,sha(first),'wallet_claim',{synthetic:value}));
  const results=await Promise.all(second.map(record=>call(db,'append',1,sha(first),record)));
  assert.equal(results.filter(x=>x.revision===2).length,1);assert.equal(results.filter(x=>x.error==='unavailable').length,1);
  const current=await call(db,'read');assert.equal(current.revision,2);assert.equal(current.events[0],first);
  assert.ok(second.includes(current.events[1]));assert.equal(current.head_sha256,sha(current.events[1]));
  assert.deepEqual(await call(db,'append',1,sha(first),second[0]),{error:'unavailable'});
  for (const query of [
    'UPDATE bouncer_v14_originals_v1.events SET record=record',
    'DELETE FROM bouncer_v14_originals_v1.events',
    'DELETE FROM bouncer_v14_originals_v1.streams',
    'TRUNCATE bouncer_v14_originals_v1.events',
    'TRUNCATE bouncer_v14_originals_v1.streams CASCADE',
    `UPDATE bouncer_v14_originals_v1.streams SET revision=0,head_sha256='${zero}'`,
  ]) await assert.rejects(db.query(query));
  const client=await db.connect();
  try {
    await client.query('SET ROLE anon');
    await assert.rejects(client.query('SELECT public.bouncer_v14_original_checkpoint_v1($1,$2,$3)',[scope,capHash,'read']),e=>e.code==='42501');
    await client.query('RESET ROLE');await client.query('SET ROLE service_role');
    const viaRole=await client.query('SELECT public.bouncer_v14_original_checkpoint_v1($1,$2,$3) AS value',[scope,capHash,'read']);
    assert.deepEqual(viaRole.rows[0].value,current);
    await assert.rejects(client.query('SELECT * FROM bouncer_v14_originals_v1.streams'),e=>e.code==='42501');
    await client.query('RESET ROLE');
  } finally {client.release();}
}));
