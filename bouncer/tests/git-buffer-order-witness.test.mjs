import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import nearApi from 'near-api-js';
import {createBufferOrderWitness,parseBufferOrderWitness} from '../agent/git-buffer-order-witness.mjs';
import {createGitBufferOrderWitnessStore,createGitBranchWitnessStore} from '../agent/git-branch-witness-store.mjs';
const identity=()=>({owner:'buyer.testnet',owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),
  attempt_id:'a'.repeat(32),site:'https://site.example.test',key_sha256:'b'.repeat(64),review_sha256:'c'.repeat(64),
  request_commitment_sha256:'d'.repeat(64),draft_sha256:'e'.repeat(64)});
function memoryStore() {
  let text='',head='0',lost=false;
  return {async read(){return {text,head}},async append(input){
    if(input.expectedHead!==head || input.expectedText!==text) throw Error('conflict');
    text=input.text; head=String(+head+1); if(lost) throw Error('lost'); return {head,confirmed:true};
  },loseAck(x){lost=x},snapshot(){return {text,head}}};
}
test('order witness has exactly one immutable reserve, claim and sealed commitment',async()=>{
  const store=memoryStore(),witness=createBufferOrderWitness({store}),id=identity();
  await witness.reserve(id); await assert.rejects(witness.reserve(id));
  await assert.rejects(witness.seal(id,'f'.repeat(64)));
  await witness.claim(id); await assert.rejects(witness.claim(id));
  await witness.seal(id,'f'.repeat(64)); await witness.seal(id,'f'.repeat(64));
  await assert.rejects(witness.seal(id,'0'.repeat(64)));
  const state=(await witness.inspect(id.owner)).state;
  assert.equal(state.phase,'sealed'); assert.equal(state.records.length,3);
  const text=store.snapshot().text;
  assert.ok(!/brief|accessToken|signature|private_key/.test(text));
  assert.throws(()=>parseBufferOrderWitness(text.replace(id.site,'https://evil.test'),id.owner));
  assert.throws(()=>parseBufferOrderWitness(text.slice(0,-1),id.owner));
  assert.throws(()=>parseBufferOrderWitness(text,'other.testnet'));
});
test('an uncertain independent claim never returns a second claim',async()=>{
  const store=memoryStore(),witness=createBufferOrderWitness({store}),id=identity();
  const results=await Promise.allSettled([witness.reserve(id),witness.reserve(id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  store.loseAck(true); await assert.rejects(witness.claim(id)); store.loseAck(false);
  assert.equal((await witness.inspect(id.owner)).state.phase,'claimed'); await assert.rejects(witness.claim(id));
});
test('Buffer and wallet witnesses use separate paths and one branch in a real local Git CAS store',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'buffer-order-witness-')),bare=path.join(root,'remote.git'),work=path.join(root,'work'),branch='arena/0ee9ab70-near-hub';
  const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    fs.mkdirSync(work); git(root,['init','--bare','--initial-branch',branch,bare]); git(work,['init','--initial-branch',branch]);
    git(work,['config','user.email','synthetic@example.test']); git(work,['config','user.name','Synthetic test']);
    git(work,['remote','add','origin',bare]); fs.writeFileSync(path.join(work,'README.md'),'Synthetic only\n');
    git(work,['add','README.md']); git(work,['commit','-m','Initial']); git(work,['push','origin',branch]);
    const initialHead=git(work,['rev-parse','HEAD']),id=identity();
    const store=createGitBufferOrderWitnessStore({repo:work,branch,initialHead});
    const walletStore=createGitBranchWitnessStore({repo:work,branch,initialHead});
    const witness=createBufferOrderWitness({store});
    await witness.reserve(id); await witness.claim(id); await witness.seal(id,'f'.repeat(64));
    assert.equal((await witness.inspect(id.owner)).state.phase,'sealed');
    assert.equal((await walletStore.read(id.owner)).text,'');
    const pathname=`bouncer/evidence/buffer-order-witness-v1/${crypto.createHash('sha256').update(id.owner).digest('hex')}.jsonl`;
    assert.ok(git(bare,['show',`${branch}:${pathname}`]).includes('sealed'));
    fs.writeFileSync(path.join(work,'dirty.txt'),'dirty'); await assert.rejects(witness.inspect(id.owner));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
