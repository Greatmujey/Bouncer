import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import nearApi from 'near-api-js';
import { createExperimentalPhoneSetupRuntime } from '../agent/experimental-phone-setup-runtime.mjs';
import { createReadOnlyPreviewService } from '../agent/read-only-preview-service.mjs';
import { initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { initializePostgresWalletPromptFence } from '../agent/postgres-wallet-prompt-fence.mjs';
import { initializePostgresNativeOraclePromptFence } from '../agent/postgres-native-oracle-prompt-fence.mjs';

// Temporary databases, synthetic Git, public random keys and fabricated RPC.
// This test does not use a real wallet, network, provider, checkpoint or phone.
const url = process.env.BOUNCER_TEST_POSTGRES_URL;
if (process.env.BOUNCER_REQUIRE_POSTGRES_TESTS === '1' && !url) throw Error('disposable PostgreSQL test URL required');
const dbtest = url ? test : test.skip;
const branch = 'arena/0e4386ea-near-hub', origin = 'https://phone.example.test';
const nativeWasmBytes = fs.readFileSync(new URL('../../bouncer.wasm', import.meta.url));
const noRpc = async () => { throw Error('synthetic test must not call RPC'); };
const provider = Object.fromEntries(['viewNodeStatus','viewBlock','viewAccessKey','viewAccount','viewAccessKeyList','txStatusReceipts','query',
  'viewTestnetAccountPresenceAt','callFunctionRaw','experimental_protocolConfig','gasPrice'].map(name => [name,noRpc]));
const bridge = { pending:()=>[], take:()=>null, submit:()=>false, takeForBrowser:()=>null, submitEncrypted:()=>false };
const git = (cwd,args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-phone-runtime-'));
  const name = `bouncer_phone_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({connectionString:url,max:3,connectionTimeoutMillis:5000}); let db,created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    const parsed = new URL(url); parsed.pathname = `/${name}`;
    db = new pg.Pool({connectionString:parsed.href,max:6,connectionTimeoutMillis:5000});
    const work=path.join(root,'work'),bare=path.join(root,'remote.git');fs.mkdirSync(work);
    git(root,['init','--bare','--initial-branch',branch,bare]);git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']);git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]);fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']);git(work,['commit','-m','Synthetic baseline']);git(work,['push','origin',branch]);
    const initialHead=git(work,['rev-parse','HEAD']);let state={head:initialHead,revision:'0'},writes=0;
    const anchor={async read(){return {...state}},async compareAndSet(){writes++;throw Error('must not advance during startup')},
      set(value){state={...value}},snapshot(){return {...state}},writes(){return writes}};
    const config={pool:db,siteOrigin:origin,provider,anchor,repo:work,branch,initialHead,nativeWasmBytes,enableNative:true};
    await run({db,work,anchor,config,initialHead});
  } finally {
    await db?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();
    fs.rmSync(root,{recursive:true,force:true});
  }
}

async function counts(db) {
  const result = await db.query(`SELECT
    (SELECT count(*)::integer FROM bouncer_wallet_auth_v1.challenges) AS challenges,
    (SELECT count(*)::integer FROM bouncer_wallet_owner_fence_v1.holders) AS holders,
    (SELECT count(*)::integer FROM bouncer_wallet_prompt_v1.prompts) AS ft,
    (SELECT count(*)::integer FROM bouncer_native_wallet_prompt_v1.plans) AS native`);
  return result.rows[0];
}

dbtest('phone runtime never creates missing schemas and requires both durable fences and the exact checkpointed head', async () => fixture(async ({db,work,anchor,config,initialHead}) => {
  await assert.rejects(createExperimentalPhoneSetupRuntime(config));
  const absent = await db.query(`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname IN
    ('bouncer_wallet_auth_v1','bouncer_wallet_owner_fence_v1','bouncer_wallet_prompt_v1','bouncer_native_wallet_prompt_v1')`);
  assert.equal(absent.rows.length,0,'startup did not silently initialize any state');

  // Explicit privileged provisioning is confined to this disposable test DB.
  await initializePostgresWalletPromptAuth({pool:db});await initializePostgresWalletPromptFence({pool:db});
  await assert.rejects(createExperimentalPhoneSetupRuntime(config));
  assert.equal((await db.query("SELECT pg_catalog.to_regnamespace('bouncer_native_wallet_prompt_v1') IS NULL AS absent")).rows[0].absent,true);
  await initializePostgresNativeOraclePromptFence({pool:db});
  const initialCounts=await counts(db);

  await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts ENABLE ROW LEVEL SECURITY');
  try { await assert.rejects(createExperimentalPhoneSetupRuntime(config)); }
  finally { await db.query('ALTER TABLE bouncer_wallet_prompt_v1.prompts DISABLE ROW LEVEL SECURITY'); }
  fs.appendFileSync(path.join(work,'README.md'),'Uncheckpointed change\n');git(work,['add','README.md']);
  git(work,['commit','-m','Synthetic uncheckpointed change']);git(work,['push','origin',branch]);
  const latest=git(work,['rev-parse','HEAD']);assert.notEqual(latest,initialHead);
  await assert.rejects(createExperimentalPhoneSetupRuntime(config));
  assert.deepEqual(anchor.snapshot(),{head:initialHead,revision:'0'});assert.equal(anchor.writes(),0);
  assert.deepEqual(await counts(db),initialCounts);

  // Simulate an independently advanced checkpoint; an in-memory anchor is
  // strictly a fixture and is not independent or durable infrastructure.
  anchor.set({head:latest,revision:'1'});
  const runtime=await createExperimentalPhoneSetupRuntime(config);
  assert.equal(runtime.setupFactory,undefined);assert.equal(typeof runtime.nativeSetupFactory,'function');
  assert.equal(runtime.ready_for_real_spending,false);assert.deepEqual(await counts(db),initialCounts);
  const server=createReadOnlyPreviewService({bridge,siteOrigin:origin,inspectReadiness:async()=>({}),makeReview:async()=>({}),
    nativeSetupFactory:runtime.nativeSetupFactory});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,headers={'x-bouncer-preview':'native-oracle-setup-v1'};
  let prepared;
  try {
    const response=await fetch(`${base}/api/native-oracle-setup/config`,{headers});const status=await response.json();
    assert.equal(status.enabled,true);assert.equal(status.ready_for_real_spending,false);
    assert.equal((await fetch(`${base}/api/wallet-setup/config`,{headers})).status,404);
    const agentPublicKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
    const review=await fetch(`${base}/api/native-oracle-setup/review`,{method:'POST',
      headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify({agentPublicKey})});
    const body=await review.json();assert.equal(review.status,200);assert.equal(body.signing_authorized,false);
    assert.equal(body.transaction_sent,false);assert.equal(body.review.owner,'great_mujey.testnet');
    prepared={taskId:body.task_id,agentPublicKey};assert.equal(prepared.taskId,body.review.review_sha256);
    assert.equal((await fetch(`${base}/api/native-oracle-setup/broadcast`,{method:'POST',headers,body:'{}'})).status,404);
    assert.deepEqual(await counts(db),initialCounts,'read-only setup and synthetic review did not reserve or prompt');
    assert.equal(anchor.writes(),0);
  } finally { await new Promise(resolve=>server.close(resolve)); }

  // Exercise the actual paired FT+native composition when the pinned public
  // V12 fixture is supplied; this does not make FT a native prerequisite.
  if (process.env.BOUNCER_V12_WASM_PATH) {
    const bufferWasmBytes=fs.readFileSync(process.env.BOUNCER_V12_WASM_PATH);
    const both=await createExperimentalPhoneSetupRuntime({...config,enableBuffer:true,bufferWasmBytes});
    const dual=createReadOnlyPreviewService({bridge,siteOrigin:origin,inspectReadiness:async()=>({}),makeReview:async()=>({}),
      setupFactory:both.setupFactory,nativeSetupFactory:both.nativeSetupFactory});
    await new Promise(resolve=>dual.listen(0,'127.0.0.1',resolve));
    try {
      const url=`http://127.0.0.1:${dual.address().port}`;
      const ft=await fetch(`${url}/api/wallet-setup/config`,{headers:{'x-bouncer-preview':'witnessed-setup-v1'}});
      const native=await fetch(`${url}/api/native-oracle-setup/config`,{headers:{'x-bouncer-preview':'native-oracle-setup-v1'}});
      assert.equal(ft.status,200);assert.equal((await ft.json()).enabled,true);
      assert.equal(native.status,200);assert.equal((await native.json()).ready_for_real_spending,false);
      assert.deepEqual(await counts(db),initialCounts);
    } finally { await new Promise(resolve=>dual.close(resolve)); }
  }

  // A new runtime has no pre-reservation process cache. It reconstructs the
  // exact review using only its pinned artifact and the public key, and still
  // requires an owner challenge plus both fences before any reservation.
  const restarted=await createExperimentalPhoneSetupRuntime(config);
  const next=createReadOnlyPreviewService({bridge,siteOrigin:origin,inspectReadiness:async()=>({}),makeReview:async()=>({}),
    nativeSetupFactory:restarted.nativeSetupFactory});
  await new Promise(resolve=>next.listen(0,'127.0.0.1',resolve));
  try {
    const url=`http://127.0.0.1:${next.address().port}/api/native-oracle-setup/reserve-challenge`;
    const post=body=>fetch(url,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
    const ownerPublicKey=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
    const wrong=await post({...prepared,ownerPublicKey,agentPublicKey:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey())});
    assert.equal(wrong.status,409);assert.deepEqual(await counts(db),initialCounts);
    const response=await post({...prepared,ownerPublicKey});assert.equal(response.status,200);
    const challenge=await response.json();assert.match(challenge.challenge_id,/^[a-f0-9]{32}$/);
    assert.deepEqual(await counts(db),{...initialCounts,challenges:initialCounts.challenges+1});
    assert.equal(anchor.writes(),0);
  } finally { await new Promise(resolve=>next.close(resolve)); }
}));
