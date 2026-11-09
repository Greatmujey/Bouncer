// Disposable PostgreSQL only: no network wallet, provider or testnet action.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import {exerciseV14MissionBackupDatabase} from './v14-mission-backup-db-exercise.mjs';

const url=process.env.BOUNCER_TEST_POSTGRES_URL;
if(process.env.BOUNCER_REQUIRE_POSTGRES_TESTS==='1'&&!url)throw Error('disposable PostgreSQL required');
const dbtest=url?test:test.skip;

dbtest('encrypted mission backups bind the current witness head and are immutable in disposable PostgreSQL',async()=>{
  const admin=new pg.Pool({connectionString:url,max:2}),name=`bouncer_v14_backup_${crypto.randomBytes(6).toString('hex')}`;
  let db,created=false;
  try {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$`);
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    const target=new URL(url);target.pathname=`/${name}`;db=new pg.Pool({connectionString:target.href,max:8});
    for(const file of ['v14-original-checkpoint.sql','v14-checkpoint-enrollment.sql','v14-mission-journal-backup.sql']) {
      await db.query(fs.readFileSync(new URL(`../infrastructure/${file}`,import.meta.url),'utf8'));
    }
    await exerciseV14MissionBackupDatabase(db);
    const client=await db.connect();try {
      const args=['1'.repeat(32),'f'.repeat(64),'read','compute','pending'];
      await client.query('SET ROLE anon');
      await assert.rejects(client.query('SELECT public.bouncer_v14_mission_journal_backup_v1($1,$2,$3,$4,$5)',args),e=>e.code==='42501');
      await client.query('RESET ROLE');await client.query('SET ROLE service_role');
      assert.deepEqual((await client.query('SELECT public.bouncer_v14_mission_journal_backup_v1($1,$2,$3,$4,$5) AS value',args)).rows[0].value,
        {error:'unavailable'});
      await assert.rejects(client.query('SELECT * FROM bouncer_v14_originals_v1.mission_journal_backups'),e=>e.code==='42501');
      await client.query('RESET ROLE');
    } finally {client.release();}
  } finally {if(db)await db.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();}
});
