import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { createTestnetResourceAgentKeyring, readTestnetResourceAgentKeyring, validateTestnetResourceAgentPlan }
  from '../agent/testnet-resource-agent-keyring.mjs';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-test-agent-')); fs.chmodSync(root,0o700);
  const owner = { version: 1, purpose: 'new-bouncer-testnet-owner', network: 'testnet',
    account_id: 'bouncer-owner-0123456789abcdef01234567.testnet', public_key: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) };
  return { root, dir: path.join(root,'agent'), owner, cleanup: () => fs.rmSync(root,{recursive:true,force:true}) };
}
test('creates distinct testnet agent with two authenticated ciphertexts, never overwriting an existing keyring', () => {
  const f=fixture(); try {
    const r=createTestnetResourceAgentKeyring({dir:f.dir,ownerPlan:f.owner}), p=r.plan;
    assert.notEqual(p.public_key,f.owner.public_key); assert.equal(p.owner,f.owner.account_id);
    assert.deepEqual(p.methods,['execute','execute_ft_call']); assert.equal(r.off_device_backup_verified,false);
    assert.equal(String(readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}).getPublicKey()),p.public_key);
    assert.equal((fs.statSync(path.join(f.dir,'master.key')).mode & 0o777),0o600);
    assert.throws(()=>createTestnetResourceAgentKeyring({dir:f.dir,ownerPlan:f.owner}));
    for(const change of [{methods:['set_policy']},{policy_id:'unsafe'},{public_key:f.owner.public_key},{network:'mainnet'}]) {
      assert.throws(()=>validateTestnetResourceAgentPlan({...p,...change},f.owner));
    }
    const file=path.join(f.dir,'backup.enc.json'), e=JSON.parse(fs.readFileSync(file));
    e.tag=Buffer.alloc(16,1).toString('base64'); fs.writeFileSync(file,JSON.stringify(e));
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}),/authenticated/);
  } finally {f.cleanup()}
});

test('rejects exposed master, exposed directory, ciphertext substitution and stale public plans',()=>{
  const f=fixture(); try {
    const p=createTestnetResourceAgentKeyring({dir:f.dir,ownerPlan:f.owner}).plan, master=path.join(f.dir,'master.key');
    fs.chmodSync(master,0o644);
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}),/exposed/);
    fs.chmodSync(master,0o600); fs.chmodSync(f.dir,0o755);
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}),/not private/);
    fs.chmodSync(f.dir,0o700);
    const backup=path.join(f.dir,'backup.enc.json'), obj=JSON.parse(fs.readFileSync(backup,'utf8'));
    obj.owner='different.testnet'; fs.writeFileSync(backup,JSON.stringify(obj));
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}),/invalid encrypted/);
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:{...p,public_key:f.owner.public_key},ownerPlan:f.owner}),/invalid/);
    for(const file of ['primary.enc.json','backup.enc.json']) assert.ok(!fs.readFileSync(path.join(f.dir,file),'utf8').includes('private_key'));
  } finally {f.cleanup()}
});

test('does not follow a symlink in place of the wrapping key',()=>{
  const f=fixture(); try {
    const p=createTestnetResourceAgentKeyring({dir:f.dir,ownerPlan:f.owner}).plan, master=path.join(f.dir,'master.key');
    fs.renameSync(master,path.join(f.root,'other.key'));fs.symlinkSync(path.join(f.root,'other.key'),master);
    assert.throws(()=>readTestnetResourceAgentKeyring({dir:f.dir,plan:p,ownerPlan:f.owner}),/missing or exposed/);
  } finally {f.cleanup()}
});
