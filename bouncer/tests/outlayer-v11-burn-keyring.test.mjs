import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import {createOutlayerBurnKeyring,readOutlayerBurnKeyring} from '../agent/outlayer-v11-burn-keyring.mjs';
const owner=JSON.parse(fs.readFileSync(new URL('../config/testnet-owner-v2-plan.json',import.meta.url),'utf8'));
const existing=JSON.parse(fs.readFileSync(new URL('../config/testnet-resource-agent-v2-plan.json',import.meta.url),'utf8')).public_key;
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'outlayer-keyring-')),dir=path.join(root,'keys');
 const result=createOutlayerBurnKeyring({dir,ownerPlan:owner,existingResourcePublicKey:existing});
 return {root,dir,...result};
}
test('distinct single-purpose testnet agent keys stay in authenticated local encrypted copies',()=>{
 const f=fixture();try{
  assert.equal(f.encrypted_copies_checked,2);assert.equal(f.off_device_backup_verified,false);assert.equal(f.installed_on_chain,false);
  assert.equal(new Set([owner.public_key,existing,f.plan.funding_public_key,f.plan.project_public_key]).size,4);
  const {funding,project}=readOutlayerBurnKeyring({dir:f.dir,plan:f.plan,ownerPlan:owner});
  assert.equal(String(funding.getPublicKey()),f.plan.funding_public_key);assert.equal(String(project.getPublicKey()),f.plan.project_public_key);
  for(const name of ['master.key','primary.enc.json','backup.enc.json','public-plan.json'])assert.equal(fs.statSync(path.join(f.dir,name)).mode&0o077,0);
  const primary=fs.readFileSync(path.join(f.dir,'primary.enc.json'),'utf8'),backup=fs.readFileSync(path.join(f.dir,'backup.enc.json'),'utf8');
  assert.notEqual(primary,backup);assert.ok(!primary.includes(funding.toString()));assert.ok(!backup.includes(project.toString()));
  assert.throws(()=>createOutlayerBurnKeyring({dir:f.dir,ownerPlan:owner,existingResourcePublicKey:existing}));
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('changed backup, public plan, exposed key and symlink are rejected',()=>{
 for(const tamper of [
  f=>{const p=path.join(f.dir,'backup.enc.json'),x=JSON.parse(fs.readFileSync(p));x.tag=Buffer.alloc(16).toString('base64');fs.writeFileSync(p,JSON.stringify(x),{mode:0o600})},
  f=>{const p=path.join(f.dir,'public-plan.json'),x=JSON.parse(fs.readFileSync(p));x.project_public_key=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());fs.writeFileSync(p,JSON.stringify(x),{mode:0o600})},
  f=>fs.chmodSync(path.join(f.dir,'master.key'),0o644),
  f=>{const p=path.join(f.dir,'primary.enc.json');fs.renameSync(p,p+'.old');fs.symlinkSync(p+'.old',p)},
 ]){const f=fixture();try{tamper(f);assert.throws(()=>readOutlayerBurnKeyring({dir:f.dir,plan:f.plan,ownerPlan:owner}))}finally{fs.rmSync(f.root,{recursive:true,force:true})}}
});
