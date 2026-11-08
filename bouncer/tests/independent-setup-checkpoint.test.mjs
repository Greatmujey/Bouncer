import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIndependentSetupCheckpointClient,createIndependentSetupCheckpointServer } from '../agent/independent-setup-checkpoint.mjs';

const token=crypto.randomBytes(32).toString('base64url'),origin='https://checkpoint.example.test',base={head:'a'.repeat(40),revision:'0'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
test('checkpoint client requires a dedicated HTTPS origin and does not retry uncertain operations',async()=>{
  assert.throws(()=>createIndependentSetupCheckpointClient({origin:'http://checkpoint.example.test',token}));
  assert.throws(()=>createIndependentSetupCheckpointClient({origin:`${origin}/path`,token}));
  assert.throws(()=>createIndependentSetupCheckpointClient({origin,token:'short'}));
  let calls=0;const client=createIndependentSetupCheckpointClient({origin,token,fetch:async()=>{calls++;throw Error('connection lost')}});
  await assert.rejects(client.compareAndSet({expected:base,nextHead:'b'.repeat(40)}));assert.equal(calls,1);
  const dishonest=createIndependentSetupCheckpointClient({origin,token,fetch:async()=>json({confirmed:true,head:'b'.repeat(40),revision:'0'})});
  await assert.rejects(dishonest.compareAndSet({expected:base,nextHead:'b'.repeat(40)}));
  const reader=createIndependentSetupCheckpointClient({origin,token,fetch:async()=>json({...base,extra:'unsafe'})});
  await assert.rejects(reader.read());
});

test('checkpoint handler requires its bearer, exact body, latest remote and independent audit',async()=>{
  let advances=0,state={...base},remote='b'.repeat(40),permitted=false;
  const anchor={async read(){return {...state}},async compareAndSet({expected,nextHead}){advances++;assert.deepEqual(expected,state);
    state={head:nextHead,revision:'1'};return {confirmed:true,...state}}};
  const server=createIndependentSetupCheckpointServer({anchor,token,resolveRemoteHead:async()=>remote,audit:async()=>permitted});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const send=(body,bearer=token)=>fetch(`${url}/v1/compare-and-set`,{method:'POST',headers:{authorization:`Bearer ${bearer}`,
    'content-type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await send({expected:base,nextHead:remote},crypto.randomBytes(32).toString('base64url'))).status,401);
    assert.equal((await send({expected:base,nextHead:remote,extra:true})).status,400);
    assert.equal((await send({expected:base,nextHead:remote})).status,409);assert.equal(advances,0);
    permitted=true;remote='c'.repeat(40);assert.equal((await send({expected:base,nextHead:'b'.repeat(40)})).status,409);assert.equal(advances,0);
    const ok=await send({expected:base,nextHead:remote});assert.equal(ok.status,200);assert.equal((await ok.json()).confirmed,true);assert.equal(advances,1);
    assert.equal((await send({expected:base,nextHead:'d'.repeat(40)})).status,409);assert.equal(advances,1);
  }finally{await new Promise(resolve=>server.close(resolve))}
});


test('checkpoint monitor bootstrap refuses missing or unsafe config without exposing secrets or provisioning',()=>{
  const script=fileURLToPath(new URL('../scripts/start-independent-setup-checkpoint.mjs',import.meta.url)),
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-checkpoint-cli-')),secret=path.join(dir,'token');
  const run=(env={},...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',timeout:10_000,env:{PATH:process.env.PATH,...env}});
  try{
    const help=run({},'--help');assert.equal(help.status,0);assert.match(help.stdout,/No provisioning/);
    const missing=run();assert.equal(missing.status,1);assert.match(missing.stderr,/No checkpoint was provisioned/);
    fs.writeFileSync(secret,token,{mode:0o600});
    const vars={BOUNCER_CHECKPOINT_DATABASE_URL:'postgresql://synthetic:local-test-password@127.0.0.1:1/synthetic',
      BOUNCER_CHECKPOINT_TOKEN_FILE:secret,BOUNCER_CHECKPOINT_REPOSITORY:'Greatmujey/Bouncer',
      BOUNCER_CHECKPOINT_BRANCH:'arena/0e4386ea-near-hub',BOUNCER_CHECKPOINT_INITIAL_HEAD:'a'.repeat(40),
      BOUNCER_CHECKPOINT_GIT_REPO:dir,BOUNCER_CHECKPOINT_REMOTE_URL:'https://github.com/other/repo.git'};
    const mismatch=run(vars);assert.equal(mismatch.status,1);assert.doesNotMatch(mismatch.stderr,/local-test-password|Bearer|[A-Za-z0-9_-]{43}/);
    fs.chmodSync(secret,0o644);const unsafe=run(vars);assert.equal(unsafe.status,1);assert.doesNotMatch(unsafe.stderr,/local-test-password|Bearer|[A-Za-z0-9_-]{43}/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
