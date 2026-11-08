// Isolated PostgreSQL test. Never contacts Supabase, a wallet, or NEAR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';

const connectionString=process.env.BOUNCER_TEST_POSTGRES_URL;
if(!connectionString)throw Error('isolated BOUNCER_TEST_POSTGRES_URL required');
const pool=new pg.Pool({connectionString,max:24});
const cap='a'.repeat(64),expiredCap='b'.repeat(64),origin='https://8svrp7.csb.app',original='1'.repeat(32),other='2'.repeat(32);
try{
  await pool.query('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;');
  await pool.query(fs.readFileSync(new URL('../infrastructure/direct-test-one-shot.sql',import.meta.url),'utf8'));
  await pool.query(`INSERT INTO bouncer_direct_test.claims (capability_hash,origin,scope,expires_at)
    VALUES ($1,$2,'probe',clock_timestamp()+interval '1 hour'),($3,$2,'probe',clock_timestamp()-interval '1 hour')`,[cap,origin,expiredCap]);
  const fn='SELECT public.bouncer_direct_test_v1($1,$2,$3,$4) AS result';
  const call=async(c,o,h=null)=>(await pool.query(fn,[c,origin,o,h])).rows[0].result;
  assert.deepEqual(await call(cap,'read'),{scope:'probe',state:'ready',original_hash:null,claim_acquired:false,expired:false});
  const wins=await Promise.all(Array.from({length:20},()=>call(cap,'claim')));
  assert.equal(wins.filter(x=>x.claim_acquired).length,1);assert.ok(wins.every(x=>x.state==='claimed'));
  assert.equal((await call(cap,'read')).state,'claimed');
  assert.equal((await call(cap,'retain',original)).original_hash,original);
  assert.equal((await call(cap,'retain',original)).state,'retained');
  assert.deepEqual(await call(cap,'retain',other),{error:'unavailable'});
  assert.equal((await call(cap,'read')).original_hash,original);
  const overdue=await call(expiredCap,'claim');assert.equal(overdue.state,'ready');assert.equal(overdue.expired,true);assert.equal(overdue.claim_acquired,false);
  assert.deepEqual(await call('c'.repeat(64),'claim'),{error:'unavailable'});
  const client=await pool.connect();
  try{
    await client.query('SET ROLE anon');await assert.rejects(client.query(fn,[cap,origin,'read',null]),e=>e.code==='42501');
    await client.query('RESET ROLE');await client.query('SET ROLE service_role');
    assert.equal((await client.query(fn,[cap,origin,'read',null])).rows[0].result.state,'retained');
    await assert.rejects(client.query('SELECT * FROM bouncer_direct_test.claims'),e=>e.code==='42501');
    await client.query('RESET ROLE');
  }finally{client.release();}
  console.log('Isolated one-shot PostgreSQL checks passed: one of 20 concurrent claims, expiry, hash immutability, and least privilege. No wallet.');
}finally{await pool.end();}
