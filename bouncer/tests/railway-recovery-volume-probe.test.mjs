// Disposable local files and synthetic service IDs only. No Railway, wallet,
// checkpoint, recovery kit, RPC request or transaction is touched here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {isRailwayRecoveryProbeTarget,runRailwayRecoveryVolumeProbe} from '../agent/railway-recovery-volume-probe.mjs';
import {createStandbyReadiness} from '../agent/railway-standby-readiness.mjs';

const initial=root=>runRailwayRecoveryVolumeProbe({root,phase:'initial',mode:'create-once'});
const observe=root=>runRailwayRecoveryVolumeProbe({root,phase:'after-redeploy',mode:'observe-only'});
function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-volume-check-'));return {root,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})}}

const target={RAILWAY_PROJECT_ID:'3ec18e48-2aff-41d7-bcb6-cb43fb1815c7',
  RAILWAY_SERVICE_ID:'3de96476-d197-40fb-9c17-ee5ebdb3ad65',RAILWAY_ENVIRONMENT_ID:'b44a0026-ada6-483f-bfc1-9f05ca9c84a9',
  RAILWAY_VOLUME_MOUNT_PATH:'/data'};

test('only the exact existing Railway project, service, environment and mount are eligible',()=>{
  assert.equal(isRailwayRecoveryProbeTarget(target),true);
  for(const key of Object.keys(target)) {
    assert.equal(isRailwayRecoveryProbeTarget({...target,[key]:'different'}),false);
    const missing={...target};delete missing[key];assert.equal(isRailwayRecoveryProbeTarget(missing),false);
  }
  assert.equal(isRailwayRecoveryProbeTarget({}),false);
});

test('a non-secret marker survives another process and the second phase only observes',()=>{
  const x=temp();try {
    const first=initial(x.root);assert.equal(first.status,'CREATED');assert.match(first.fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(first.transaction_authorized,false);assert.equal(fs.readdirSync(x.root).length,1);
    const module=new URL('../agent/railway-recovery-volume-probe.mjs',import.meta.url).href;
    const code=`import {runRailwayRecoveryVolumeProbe} from ${JSON.stringify(module)};`+
      `console.log(JSON.stringify(runRailwayRecoveryVolumeProbe({root:process.argv[1],phase:'after-redeploy',mode:'observe-only'})))`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code,x.root],{encoding:'utf8',timeout:5000});
    assert.equal(child.status,0);const after=JSON.parse(child.stdout);
    assert.equal(after.status,'OBSERVED');assert.equal(after.fingerprint,first.fingerprint);assert.equal(after.transaction_authorized,false);
    assert.deepEqual(observe(x.root),after);assert.equal(fs.readdirSync(x.root).length,1);
    assert.throws(()=>runRailwayRecoveryVolumeProbe({root:x.root,phase:'after-redeploy',mode:'create-once'}));
  }finally{x.cleanup()}
});

test('missing, partial, altered or locked markers are never repaired by observation',()=>{
  for(const damage of ['missing','partial','corrupt','locked','symlink','hardlink']) {
    const x=temp();try {
      if(damage==='missing') {
        assert.equal(observe(x.root).status,'MISSING');assert.deepEqual(fs.readdirSync(x.root),[]);continue;
      }
      assert.equal(initial(x.root).status,'CREATED');const marker=path.join(x.root,fs.readdirSync(x.root)[0]);
      if(damage==='partial')fs.writeFileSync(marker,'abc');
      if(damage==='corrupt')fs.writeFileSync(marker,'z'.repeat(64));
      if(damage==='locked')fs.writeFileSync(`${marker}.lock`,'pending');
      if(damage==='symlink'){fs.unlinkSync(marker);fs.symlinkSync('/dev/null',marker)}
      if(damage==='hardlink')fs.linkSync(marker,path.join(x.root,'linked'));
      const before=fs.readdirSync(x.root).sort();
      assert.equal(observe(x.root).status,damage==='locked'?'LOCKED':'UNAVAILABLE');
      assert.deepEqual(fs.readdirSync(x.root).sort(),before,'no removal or repair');
      assert.equal(initial(x.root).status,damage==='locked'?'LOCKED':'UNAVAILABLE');
      assert.deepEqual(fs.readdirSync(x.root).sort(),before);
    }finally{x.cleanup()}
  }
});

test('diagnostic only adds public status and never enables transactions or exposes the marker contents',()=>{
  const x=temp();try {
    const probe=initial(x.root),readiness=createStandbyReadiness({env:{},recoveryVolumeProbe:probe,fetchImpl:async()=>{throw Error('not called')}});
    const response=readiness.snapshot(),raw=JSON.stringify(response),marker=fs.readFileSync(path.join(x.root,fs.readdirSync(x.root)[0]),'utf8');
    assert.deepEqual(response.recovery_volume_probe,probe);assert.equal(response.transactions_enabled,false);
    assert.equal(response.mission_enabled,false);assert.equal(raw.includes(marker),false);assert.equal(raw.includes(x.root),false);
    assert.match(response.scope,/does not read or alter recovery records/);
    const copy=response.recovery_volume_probe;copy.status='forged';assert.equal(readiness.snapshot().recovery_volume_probe.status,'CREATED');
    assert.throws(()=>createStandbyReadiness({recoveryVolumeProbe:{...probe,transaction_authorized:true}}));
  }finally{x.cleanup()}
});
