// Offline status-only deployment. No credentials, wallets, RPC or payments.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRailwayNativeStandby, railwayNativePort, railwayNativeStartMode, STANDBY_STATUS } from '../scripts/start-railway-native.mjs';

const listen=server=>new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
function request(server,{path='/',method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}

test('Railway standby is the default and cannot accidentally enable a mission',()=>{
  for(const value of [undefined,'','0'])assert.equal(railwayNativeStartMode({BOUNCER_NATIVE_MISSION_ENABLED:value}),'standby');
  for(const value of ['yes','true','2'])assert.throws(()=>railwayNativeStartMode({BOUNCER_NATIVE_MISSION_ENABLED:value}));
  assert.throws(()=>railwayNativeStartMode({BOUNCER_NATIVE_MISSION_ENABLED:'1'}));
  assert.throws(()=>railwayNativeStartMode({BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_INGRESS:'same-origin',BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0'}));
  assert.equal(railwayNativeStartMode({BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
    BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0'}),'configured');
});

test('Railway port is bounded and cannot differ from the platform port',()=>{
  assert.equal(railwayNativePort({}),8080);assert.equal(railwayNativePort({PORT:'4321'}),4321);
  assert.equal(railwayNativePort({PORT:'4321',BOUNCER_NATIVE_MISSION_PORT:'4321'}),4321);
  for(const env of [{PORT:'0'},{PORT:'65536'},{PORT:'8080',BOUNCER_NATIVE_MISSION_PORT:'9999'},{PORT:'x'}])assert.throws(()=>railwayNativePort(env));
});

test('real Railway entry starts in standby and exits cleanly without creating state',async()=>{
  const available=http.createServer();await listen(available);const port=available.address().port;await close(available);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-standby-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/start-railway-native.mjs',import.meta.url))],{
    env:{PATH:process.env.PATH,HOME:dir,PORT:String(port),BOUNCER_NATIVE_MISSION_FILE:path.join(dir,'mission.json'),
      BOUNCER_FILE_JOURNAL_KEY_FILE:path.join(dir,'key')},stdio:['ignore','pipe','pipe']});
  try {
    const timeout=new Promise((_,reject)=>setTimeout(()=>reject(Error('standby startup timed out')),5000).unref());
    const [line]=await Promise.race([once(child.stdout,'data'),timeout]);assert.match(line.toString(),/STANDBY/);
    const health=await fetch(`http://127.0.0.1:${port}/healthz`);assert.deepEqual(await health.json(),STANDBY_STATUS);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/native-mission/config`)).status,404);
    assert.deepEqual(fs.readdirSync(dir),[]);
    child.kill('SIGTERM');const [code,signal]=await once(child,'exit');assert.equal(signal,null);assert.equal(code,0);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true})}
  const failed=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/start-railway-native.mjs',import.meta.url))],{
    env:{PATH:process.env.PATH,BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
      BOUNCER_NATIVE_MISSION_BIND:'0.0.0.0'},encoding:'utf8',timeout:5000});
  assert.notEqual(failed.status,0);assert.match(failed.stderr,/did not start/);
});

test('standby exposes only an honest non-spending status, no mission APIs or reflected input',async()=>{
  const server=createRailwayNativeStandby();await listen(server);
  try {
    for(const path of ['/','/healthz']) {
      const res=await request(server,{path,headers:{'x-bouncer-proxy-secret':'synthetic-never-reflect'}});
      assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body),STANDBY_STATUS);
      assert.equal(res.headers['cache-control'],'no-store');assert.ok(!res.body.includes('synthetic-never-reflect'));
    }
    assert.equal((await request(server,{path:'/healthz',method:'HEAD'})).body,'');
    for(const [method,path] of [['POST','/healthz'],['GET','/healthz?x=1'],['GET','/api/native-mission/config'],
      ['POST','/api/native-mission/execute'],['GET','/journal']]) {
      const res=await request(server,{method,path,headers:{origin:'https://attacker.example'},body:method==='POST'?'{}':undefined});
      assert.equal(res.status,404);assert.deepEqual(JSON.parse(res.body),{error:'unavailable'});
      assert.equal(res.headers['access-control-allow-origin'],undefined);
    }
  } finally {await close(server)}
});
