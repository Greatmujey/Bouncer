import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import nearApi from 'near-api-js';
import { provisionPostgresSetupHeadAnchor,createPostgresSetupHeadAnchor } from '../agent/postgres-setup-head-anchor.mjs';
import { createAnchoredSetupWitnessPair } from '../agent/anchored-setup-witness-pair.mjs';
import { createGitNativeOraclePromptWitnessStore } from '../agent/git-branch-witness-store.mjs';
import { createNativeOraclePromptWitness } from '../agent/git-native-oracle-prompt-witness.mjs';
import { createGitAuditedSetupCheckpointServer,createIndependentSetupCheckpointClient,createIndependentGitHeadResolver } from '../agent/independent-setup-checkpoint.mjs';

const url=process.env.BOUNCER_TEST_POSTGRES_URL;
if(process.env.BOUNCER_REQUIRE_POSTGRES_TESTS==='1' && !url)throw Error('disposable PostgreSQL required');
const dbtest=url?test:test.skip,branch='arena/0e4386ea-near-hub',repository='Greatmujey/Bouncer',initialHead='1'.repeat(40);
const code=(e,c)=>e.code===c;
async function database(run){
  const admin=new pg.Pool({connectionString:url,max:3}),name=`bouncer_anchor_${crypto.randomBytes(6).toString('hex')}`;
  let db,created=false;try{
    await admin.query(`CREATE DATABASE "${name}"`);created=true;const target=new URL(url);target.pathname=`/${name}`;
    const connectionString=target.href;db=new pg.Pool({connectionString,max:12});
    await run({db,connectionString});
  }finally{if(db)await db.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end()}
}
const options=db=>({pool:db,repository,branch,initialHead});

dbtest('checkpoint never auto-provisions; a complete baseline must be explicitly pinned exactly once',async()=>database(async({db})=>{
  const cfg=options(db),anchor=createPostgresSetupHeadAnchor(cfg);
  await assert.rejects(anchor.read(),e=>code(e,'ANCHOR_UNSAFE'));
  await assert.rejects(provisionPostgresSetupHeadAnchor(cfg),e=>code(e,'ANCHOR_INVALID'));
  assert.deepEqual(await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true}),{head:initialHead,revision:'0'});
  await assert.rejects(provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true}),e=>code(e,'ANCHOR_ALREADY_PROVISIONED'));
  await assert.rejects(createPostgresSetupHeadAnchor({...cfg,branch:'other'}).read(),e=>code(e,'ANCHOR_UNSAFE'));
  await assert.rejects(createPostgresSetupHeadAnchor({...cfg,initialHead:'f'.repeat(40)}).read(),e=>code(e,'ANCHOR_UNSAFE'));
}));

dbtest('concurrent independent checkpoint CAS has one winner; replay and old heads do not succeed',async()=>database(async({db})=>{
  const cfg=options(db);await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true});
  const anchor=createPostgresSetupHeadAnchor(cfg),expected=await anchor.read();
  const result=await Promise.allSettled(['2','3','4'].map(x=>anchor.compareAndSet({expected,nextHead:x.repeat(40)})));
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.filter(x=>x.status==='rejected' && x.reason.code==='ANCHOR_CONFLICT').length,2);
  const current=await anchor.read();assert.equal(current.revision,'1');
  await assert.rejects(anchor.compareAndSet({expected,nextHead:'5'.repeat(40)}),e=>code(e,'ANCHOR_CONFLICT'));
  await assert.rejects(anchor.compareAndSet({expected:current,nextHead:initialHead}));
  assert.deepEqual(await anchor.read(),current);
}));

dbtest('checkpoint guards reject UPDATE, DELETE and TRUNCATE; missing triggers and broken histories fail closed',async()=>database(async({db})=>{
  const cfg=options(db);await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true});
  const anchor=createPostgresSetupHeadAnchor(cfg),first=await anchor.read();await anchor.compareAndSet({expected:first,nextHead:'2'.repeat(40)});
  for(const sql of ['UPDATE bouncer_setup_head_anchor_v1.entries SET head=head','DELETE FROM bouncer_setup_head_anchor_v1.entries',
    'TRUNCATE bouncer_setup_head_anchor_v1.entries','UPDATE bouncer_setup_head_anchor_v1.meta SET branch=branch',
    'TRUNCATE bouncer_setup_head_anchor_v1.meta'])await assert.rejects(db.query(sql));
  await db.query('ALTER TABLE bouncer_setup_head_anchor_v1.entries DISABLE TRIGGER no_truncate');
  await assert.rejects(anchor.read(),e=>code(e,'ANCHOR_UNSAFE'));
  await db.query('ALTER TABLE bouncer_setup_head_anchor_v1.entries ENABLE TRIGGER no_truncate');
  await db.query("INSERT INTO bouncer_setup_head_anchor_v1.entries(revision,previous_head,head) VALUES(4,$1,$2)",['2'.repeat(40),'4'.repeat(40)]);
  await assert.rejects(anchor.read(),e=>code(e,'ANCHOR_UNSAFE'));
}));

dbtest('a committed but lost PostgreSQL acknowledgement stops and is inspectable without repeating CAS',async()=>database(async({db,connectionString})=>{
  const cfg=options(db);await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true});
  let drop=true;const uncertain={async connect(){const client=await db.connect(),query=client.query.bind(client);
    client.query=async(...args)=>{const value=await query(...args);if(args[0]==='COMMIT' && drop){drop=false;throw Error('lost synthetic acknowledgement')}return value};
    const release=client.release.bind(client);client.release=()=>{client.query=query;release()};return client;}};
  const anchor=createPostgresSetupHeadAnchor({...cfg,pool:uncertain});
  await assert.rejects(anchor.compareAndSet({expected:{head:initialHead,revision:'0'},nextHead:'a'.repeat(40)}),e=>code(e,'ANCHOR_COMMIT_UNKNOWN'));
  const reopened=new pg.Pool({connectionString,max:2});try{
    const reader=createPostgresSetupHeadAnchor({...cfg,pool:reopened}),actual=await reader.read();
    assert.deepEqual(actual,{head:'a'.repeat(40),revision:'1'});
    await assert.rejects(reader.compareAndSet({expected:{head:initialHead,revision:'0'},nextHead:'b'.repeat(40)}),e=>code(e,'ANCHOR_CONFLICT'));
  }finally{await reopened.end()}
}));

dbtest('synthetic local Git witness commits advance a separately provisioned PostgreSQL head and rollback is blocked',async()=>database(async({db})=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-pg-anchor-')),
    git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{
    const bare=path.join(root,'remote.git'),work=path.join(root,'work');fs.mkdirSync(work);
    git(root,['init','--bare','--initial-branch',branch,bare]);git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']);git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]);fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']);git(work,['commit','-m','Initial']);git(work,['push','origin',branch]);
    const base=git(work,['rev-parse','HEAD']),cfg={pool:db,repository,branch,initialHead:base};
    await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true});
    const anchor=createPostgresSetupHeadAnchor(cfg),pair=createAnchoredSetupWitnessPair({repo:work,branch,initialHead:base,anchor});
    const owner='anchor-phone.testnet',identity={owner,owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),
      operation_id:crypto.randomBytes(16).toString('hex'),review_sha256:'b'.repeat(64),
      stages:['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent']
        .map((stage_id,i)=>({stage_id,action_commitment_sha256:String(i+1).repeat(64)}))};
    const saved=await pair.native.reserve(identity);assert.equal((await anchor.read()).head,saved.head);
    git(work,['push','--force','origin',`${base}:refs/heads/${branch}`]);
    await assert.rejects(pair.native.inspect(owner),e=>code(e,'WITNESS_UNAVAILABLE'));
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}));

dbtest('separate synthetic HTTP checkpoint independently audits Git before CAS and never retries a lost acknowledgement',async()=>database(async({db})=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-independent-monitor-')),
    git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  let server;
  try{
    const bare=path.join(root,'remote.git'),work=path.join(root,'work'),monitor=path.join(root,'monitor');fs.mkdirSync(work);
    git(root,['init','--bare','--initial-branch',branch,bare]);git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']);git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]);fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']);git(work,['commit','-m','Initial']);git(work,['push','origin',branch]);
    const base=git(work,['rev-parse','HEAD']);git(root,['clone','--quiet','--branch',branch,bare,monitor]);
    const cfg={pool:db,repository,branch,initialHead:base};await provisionPostgresSetupHeadAnchor({...cfg,operatorVerifiedCompleteBaseline:true});
    const anchor=createPostgresSetupHeadAnchor(cfg),token=crypto.randomBytes(32).toString('base64url');
    assert.throws(()=>createIndependentGitHeadResolver({repo:monitor,branch,remoteUrl:bare})); // local Git is tests only
    server=createGitAuditedSetupCheckpointServer({anchor,repo:monitor,branch,remoteUrl:bare,token,allowLocalForTests:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local=`http://127.0.0.1:${server.address().port}`,origin='https://checkpoint.example.test';
    const fetchImpl=(address,init)=>fetch(address.replace(origin,local),init);
    const client=createIndependentSetupCheckpointClient({origin,token,fetch:fetchImpl});
    assert.equal((await fetch(`${local}/v1/head`)).status,401);
    assert.throws(()=>createIndependentSetupCheckpointClient({origin:'http://checkpoint.example.test',token}));
    const before=await client.read(),owner='monitor-alice.testnet',identity={owner,
      owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),operation_id:crypto.randomBytes(16).toString('hex'),
      review_sha256:'b'.repeat(64),stages:['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent']
        .map((stage_id,i)=>({stage_id,action_commitment_sha256:String(i+1).repeat(64)}))};
    const raw=createNativeOraclePromptWitness({store:createGitNativeOraclePromptWitnessStore({repo:work,branch,initialHead:base})});
    const reserved=await raw.reserve(identity),after=await client.compareAndSet({expected:before,nextHead:reserved.head});
    assert.equal(after.confirmed,true);assert.equal(after.head,reserved.head);assert.equal(after.revision,'1');
    // First lose the acknowledgement of a genuinely append-only update.
    fs.appendFileSync(path.join(work,'README.md'),'Safe synthetic change\n');git(work,['add','README.md']);
    git(work,['commit','-m','Safe synthetic change']);git(work,['push','origin',branch]);
    const safe=git(work,['rev-parse','HEAD']);let lost=true;
    const uncertain=createIndependentSetupCheckpointClient({origin,token,fetch:async(address,init)=>{
      const response=await fetchImpl(address,init);if(address.endsWith('/compare-and-set')&&lost){lost=false;await response.body?.cancel();throw Error('synthetic lost response')}return response;
    }});
    await assert.rejects(uncertain.compareAndSet({expected:{head:after.head,revision:after.revision},nextHead:safe}));
    const trusted={head:safe,revision:'2'};assert.deepEqual(await client.read(),trusted);
    await assert.rejects(client.compareAndSet({expected:{head:after.head,revision:after.revision},nextHead:safe}));

    const file=`bouncer/evidence/native-oracle-prompt-witness-v1/${crypto.createHash('sha256').update(owner).digest('hex')}.jsonl`;
    const old=fs.readFileSync(path.join(work,file));fs.unlinkSync(path.join(work,file));git(work,['add','-A']);git(work,['commit','-m','Malicious synthetic deletion']);
    git(work,['push','origin',branch]);const unsafe=git(work,['rev-parse','HEAD']);
    await assert.rejects(client.compareAndSet({expected:trusted,nextHead:unsafe}));
    assert.deepEqual(await client.read(),trusted);
    fs.writeFileSync(path.join(work,file),old);git(work,['add','-A']);git(work,['commit','-m','Restore synthetic witness']);git(work,['push','origin',branch]);
    const restored=git(work,['rev-parse','HEAD']);
    await assert.rejects(client.compareAndSet({expected:trusted,nextHead:restored}));
    assert.deepEqual(await client.read(),trusted,'restoring an unsafe intermediate deletion cannot make the range safe');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
}));
