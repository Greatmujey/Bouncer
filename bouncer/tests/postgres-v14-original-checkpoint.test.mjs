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

const enrollmentSql=fs.readFileSync(new URL('../infrastructure/v14-checkpoint-enrollment.sql',import.meta.url),'utf8');
const pub='ed25519:11111111111111111111111111111111',review='b'.repeat(64);
async function enroll(db,s=scope,o=owner,v=vault,c=capHash,k=pub,r=review) {
  return (await db.query('SELECT public.bouncer_v14_enroll_v1($1,$2,$3,$4,$5,$6) AS value',[s,c,o,v,k,r])).rows[0].value;
}

dbtest('owner enrollment binds one immutable scope and exact public review without exposing a reset',async()=>database(async db=>{
  await db.query(enrollmentSql);
  assert.deepEqual(await enroll(db),{status:'ENROLLED',scope_id:scope,revision:0,head_sha256:zero});
  assert.deepEqual(await enroll(db),{status:'ALREADY_ENROLLED',scope_id:scope,revision:0,head_sha256:zero});
  assert.deepEqual(await enroll(db,scope,owner,vault,'f'.repeat(64)),{error:'unavailable'});
  assert.deepEqual(await enroll(db,'2'.repeat(32)),{error:'unavailable'}); // same owner/vault cannot get a replacement scope
  const otherOwnerKey='ed25519:11111111111111111111111111111112';
  assert.deepEqual(await enroll(db,'3'.repeat(32),owner,vault,capHash,otherOwnerKey),{error:'unavailable'});
  assert.deepEqual(await enroll(db,scope,owner,vault,capHash,otherOwnerKey),{error:'unavailable'});
  assert.deepEqual(await enroll(db,scope,owner,vault,capHash,pub,'f'.repeat(64)),{error:'unavailable'});
  const bad=event(1,zero,'reserve',{scope_id:scope,owner,vault,review_sha256:'f'.repeat(64),
    public_review:{owner_public_key:pub,review_sha256:'f'.repeat(64)}});
  await assert.rejects(call(db,'append',0,zero,bad),/initial review differs/);
  assert.deepEqual(await call(db,'read'),{revision:0,head_sha256:zero,events:[]});
  const first=event(1,zero,'reserve',{scope_id:scope,owner,vault,review_sha256:review,public_review:{owner_public_key:pub,review_sha256:review}});
  const retained=await call(db,'append',0,zero,first);assert.equal(retained.revision,1);assert.equal(retained.head_sha256,sha(first));
  const inspected=(await db.query('SELECT public.bouncer_v14_owner_inspect_v1($1,$2) AS value',[owner,vault])).rows[0].value;
  assert.deepEqual(inspected,{status:'EXISTING_CHECKPOINT',scope_id:scope,revision:1,head_sha256:sha(first),events:[first]});
  assert.ok(!JSON.stringify(inspected).includes(capHash));
  assert.deepEqual((await db.query('SELECT public.bouncer_v14_owner_inspect_v1($1,$2) AS value',['wrong.testnet',vault])).rows[0].value,{error:'unavailable'});
  assert.deepEqual(await enroll(db),{status:'ALREADY_ENROLLED',scope_id:scope,revision:1,head_sha256:sha(first)});
  await assert.rejects(db.query("UPDATE bouncer_v14_originals_v1.streams SET review_sha256=$1,revision=revision+1,head_sha256=$2",['f'.repeat(64),'e'.repeat(64)]));
  const other='other.testnet',otherVault='native.other.testnet';
  const races=await Promise.all(['4','5'].map((x,i)=>enroll(db,x.repeat(32),other,otherVault,capHash,i?otherOwnerKey:pub)));
  assert.equal(races.filter(x=>x.status==='ENROLLED').length,1);assert.equal(races.filter(x=>x.error==='unavailable').length,1);
  const client=await db.connect();try {
    await client.query('SET ROLE anon');
    await assert.rejects(client.query('SELECT public.bouncer_v14_enroll_v1($1,$2,$3,$4,$5,$6)',[scope,capHash,owner,vault,pub,review]),e=>e.code==='42501');
    await assert.rejects(client.query('SELECT public.bouncer_v14_owner_inspect_v1($1,$2)',[owner,vault]),e=>e.code==='42501');
    await client.query('RESET ROLE');await client.query('SET ROLE service_role');
    assert.equal((await client.query('SELECT public.bouncer_v14_enroll_v1($1,$2,$3,$4,$5,$6) AS value',[scope,capHash,owner,vault,pub,review])).rows[0].value.status,'ALREADY_ENROLLED');
    assert.deepEqual((await client.query('SELECT public.bouncer_v14_owner_inspect_v1($1,$2) AS value',[owner,vault])).rows[0].value,inspected);
    await client.query('RESET ROLE');
  } finally {client.release();}
}));

const kitSql=fs.readFileSync(new URL('../infrastructure/v14-secret-kit.sql',import.meta.url),'utf8');
function sealedFixture(s=scope,o=owner,v=vault) {
  const envelope={format:'bouncer-v14-secret-kit-v1',kdf:'PBKDF2-SHA256',iterations:600000,cipher:'AES-256-GCM',owner:o,vault:v,
    scope_id:s,review_sha256:review,capability_sha256:capHash,salt_base64:Buffer.alloc(16).toString('base64'),
    iv_base64:Buffer.alloc(12).toString('base64'),ciphertext_base64:Buffer.alloc(40).toString('base64')};
  const sealed=JSON.stringify(envelope),terms={format:'bouncer-v14-checkpoint-kit-enrollment-v2',network:'testnet',owner:o,
    owner_public_key:pub,vault:v,scope_id:s,review_sha256:review,capability_sha256:capHash,
    issued_ms:1800000000000,expires_ms:1800000180000,kit_sha256:sha(sealed)};
  const attestation=JSON.stringify({terms,nonce_base64:Buffer.alloc(32).toString('base64'),signature_base64:Buffer.alloc(64).toString('base64')});
  return {s,o,v,sealed,kitHash:sha(sealed),attestation,attestationHash:sha(attestation)};
}
async function enrollKit(db,f,overrides={}) {
  const x={...f,...overrides};
  return (await db.query('SELECT public.bouncer_v14_enroll_kit_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value',
    [x.s,capHash,x.o,x.v,pub,review,x.kitHash,x.sealed,x.attestationHash,x.attestation])).rows[0].value;
}

dbtest('encrypted kit and owner attestation enroll atomically and cannot overwrite or retrofit a stream',async()=>database(async db=>{
  await db.query(enrollmentSql);await db.query(kitSql);
  const f=sealedFixture(),expected={status:'ENROLLED_WITH_KIT',scope_id:scope,revision:0,head_sha256:zero,
    kit_sha256:f.kitHash,attestation_sha256:f.attestationHash};
  assert.deepEqual(await enrollKit(db,f),expected);
  assert.deepEqual(await enrollKit(db,f),{...expected,status:'EXISTING_KIT'});
  const other=sealedFixture('2'.repeat(32));
  assert.deepEqual(await enrollKit(db,other),{error:'unavailable'}); // unique owner/vault
  assert.deepEqual(await enrollKit(db,f,{kitHash:'f'.repeat(64)}),{error:'unavailable'});
  const malformed=JSON.parse(f.sealed);delete malformed.salt_base64;malformed.extra='x';
  const malformedText=JSON.stringify(malformed),malformedAtt=JSON.parse(f.attestation);malformedAtt.terms.kit_sha256=sha(malformedText);
  const malformedAttText=JSON.stringify(malformedAtt);
  assert.deepEqual(await enrollKit(db,f,{sealed:malformedText,kitHash:sha(malformedText),attestation:malformedAttText,
    attestationHash:sha(malformedAttText)}),{error:'unavailable'});
  const conflict=JSON.parse(f.sealed);conflict.ciphertext_base64=Buffer.alloc(40,1).toString('base64');
  const conflictText=JSON.stringify(conflict),conflictAtt=JSON.parse(f.attestation);conflictAtt.terms.kit_sha256=sha(conflictText);
  const conflictAttText=JSON.stringify(conflictAtt);
  assert.deepEqual(await enrollKit(db,f,{sealed:conflictText,kitHash:sha(conflictText),attestation:conflictAttText,
    attestationHash:sha(conflictAttText)}),{error:'unavailable'});
  const original=(await db.query('SELECT public.bouncer_v14_owner_kit_inspect_v2($1,$2) AS value',[owner,vault])).rows[0].value;
  assert.deepEqual(original,{status:'EXISTING_ENCRYPTED_KIT',scope_id:scope,review_sha256:review,capability_sha256:capHash,
    kit_sha256:f.kitHash,sealed_kit:f.sealed,attestation_sha256:f.attestationHash,owner_attestation:f.attestation});
  const first=event(1,zero,'reserve',{scope_id:scope,owner,vault,review_sha256:review,public_review:{owner_public_key:pub,review_sha256:review}});
  await call(db,'append',0,zero,first);
  assert.deepEqual(await enrollKit(db,f),{...expected,status:'EXISTING_KIT',revision:1,head_sha256:sha(first)});
  for(const query of ['UPDATE bouncer_v14_originals_v1.secret_kits SET sealed_kit=sealed_kit',
    'DELETE FROM bouncer_v14_originals_v1.secret_kits','TRUNCATE bouncer_v14_originals_v1.secret_kits']) await assert.rejects(db.query(query));
  // A pre-existing v1 scope may reflect an unrecorded prompt even when empty.
  const old=sealedFixture('3'.repeat(32),'old.testnet','native.old.testnet');
  assert.equal((await enroll(db,old.s,old.o,old.v)).status,'ENROLLED');
  assert.deepEqual(await enrollKit(db,old),{error:'unavailable'});
  const racers=['4','5'].map(ch=>sealedFixture(ch.repeat(32),'race.testnet','native.race.testnet'));
  const outcomes=await Promise.all(racers.map(item=>enrollKit(db,item)));
  assert.equal(outcomes.filter(item=>item.status==='ENROLLED_WITH_KIT').length,1);
  assert.equal(outcomes.filter(item=>item.error==='unavailable').length,1);
  const client=await db.connect();try {
    await client.query('SET ROLE anon');
    await assert.rejects(client.query('SELECT public.bouncer_v14_owner_kit_inspect_v2($1,$2)',[owner,vault]),e=>e.code==='42501');
    await assert.rejects(client.query('SELECT * FROM bouncer_v14_originals_v1.secret_kits'),e=>e.code==='42501');
    await client.query('RESET ROLE');await client.query('SET ROLE service_role');
    assert.deepEqual((await client.query('SELECT public.bouncer_v14_owner_kit_inspect_v2($1,$2) AS value',[owner,vault])).rows[0].value,original);
    await assert.rejects(client.query('SELECT * FROM bouncer_v14_originals_v1.secret_kits'),e=>e.code==='42501');
    await client.query('RESET ROLE');
  } finally {client.release()}
}));
