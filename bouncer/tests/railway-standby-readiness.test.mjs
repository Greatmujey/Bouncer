// Synthetic read-only diagnostics. No live RPC, provider, wallet or payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { createStandbyReadiness, inspectStandbyMount } from '../agent/railway-standby-readiness.mjs';
import { createRailwayNativeStandby } from '../scripts/start-railway-native.mjs';
import { ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-testnet-registry.mjs';
import { MARKET_SUMMARY_PROGRAM } from '../shared/market-summary-constants.mjs';

const wasm=fs.readFileSync(new URL('../programs/market-summary/market-summary.wasm',import.meta.url));
function mockFilesystem({mount='/data',symlink=false,writable=true,real=mount,reported=mount}={}) {
  return {lstatSync(){return {isDirectory:()=>true,isSymbolicLink:()=>symlink}},realpathSync(){return real},
    readFileSync(){return `10 1 8:1 / ${reported.replaceAll(' ','\\040')} rw - ext4 /dev/synthetic rw\n`},
    accessSync(){if(!writable)throw Error('not writable')}};
}
function fakeFetch({chain='testnet',badRegistry=false,badWasm=false,unavailable=false}={}) {
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});if(unavailable)throw Error('private synthetic failure must not leak');
    assert.equal(options.redirect,'error');
    if(options.method==='GET') {assert.equal(url,MARKET_SUMMARY_PROGRAM.url);return new Response(badWasm?Buffer.from('wrong'):wasm)}
    assert.equal(url,'https://test.rpc.fastnear.com/');assert.equal(options.method,'POST');
    const q=JSON.parse(options.body);assert.equal(q.id,'bouncer-read-only');assert.ok(['status','query'].includes(q.method));
    if(q.method==='status')return Response.json({jsonrpc:'2.0',id:q.id,result:{chain_id:chain}});
    assert.equal(q.params.request_type,'call_function');assert.equal(q.params.account_id,'outlayer.testnet');
    assert.equal(q.params.finality,'final');assert.ok(['get_project','get_version','get_project_pricing'].includes(q.params.method_name));
    const p=ORACLE_TESTNET_PROGRAM;
    const views={get_project:{project_id:ORACLE_PROJECT_ID,uuid:badRegistry?'incorrect':ORACLE_PROJECT_UUID,owner:'zavodil2.testnet'},
      get_version:{wasm_hash:p.sha256,source:{WasmUrl:{url:p.url,hash:p.sha256,build_target:p.build_target}}},get_project_pricing:null};
    return Response.json({jsonrpc:'2.0',id:q.id,result:{result:[...Buffer.from(JSON.stringify(views[q.params.method_name]))],logs:[]}});
  };
  return {fetchImpl,calls};
}

test('mount inspection checks the declared actual mount without creating files or trusting symlinks',()=>{
  const env={RAILWAY_VOLUME_MOUNT_PATH:'/data'};
  assert.equal(inspectStandbyMount({env,filesystem:mockFilesystem()}),'DECLARED_MOUNT_PRESENT');
  assert.equal(inspectStandbyMount({env,filesystem:mockFilesystem({writable:false})}),'MOUNT_PRESENT_ACCESS_UNCONFIRMED');
  for(const filesystem of [mockFilesystem({symlink:true}),mockFilesystem({real:'/other'}),mockFilesystem({reported:'/different'})])
    assert.equal(inspectStandbyMount({env,filesystem}),'NOT_CONFIRMED');
  for(const value of [undefined,'/','data','/data/../other','/data\0'])
    assert.equal(inspectStandbyMount({env:{RAILWAY_VOLUME_MOUNT_PATH:value},filesystem:mockFilesystem()}),'NOT_CONFIRMED');
  assert.equal(inspectStandbyMount({env:{RAILWAY_VOLUME_MOUNT_PATH:'/my data'},filesystem:mockFilesystem({mount:'/my data'})}),'DECLARED_MOUNT_PRESENT');
});

test('one startup-only inspection uses fixed read-only methods and pins the actual artifact bytes',async()=>{
  const {fetchImpl,calls}=fakeFetch();
  const readiness=createStandbyReadiness({env:{RAILWAY_VOLUME_MOUNT_PATH:'/data'},filesystem:mockFilesystem(),fetchImpl});
  assert.equal(readiness.snapshot().checks.testnet_rpc,'PENDING');
  const [result,again]=await Promise.all([readiness.start(),readiness.start()]);assert.deepEqual(result,again);
  assert.deepEqual(result.checks,{volume:'DECLARED_MOUNT_PRESENT',testnet_rpc:'TESTNET_VIEW_OK',
    pinned_oracle_registry:'REGISTRY_MATCH',market_wasm:'SHA256_MATCH'});
  assert.equal(result.mission_enabled,false);assert.equal(result.transactions_enabled,false);assert.ok(result.checked_at);
  assert.equal(calls.length,5);assert.equal(calls.filter(c=>c.options.method==='GET').length,1);
  assert.doesNotMatch(JSON.stringify(result),/\/data|private synthetic failure|[A-Za-z0-9]{43,}/);
});

test('wrong network, changed pins, fetch errors and disabled TLS never become readiness success',async()=>{
  for(const [options,expected] of [
    [{chain:'mainnet'},{testnet_rpc:'WRONG_NETWORK',pinned_oracle_registry:'SKIPPED',market_wasm:'SHA256_MATCH'}],
    [{badRegistry:true,badWasm:true},{testnet_rpc:'TESTNET_VIEW_OK',pinned_oracle_registry:'UNAVAILABLE_OR_MISMATCH',market_wasm:'MISMATCH'}],
    [{unavailable:true},{testnet_rpc:'UNAVAILABLE',pinned_oracle_registry:'SKIPPED',market_wasm:'UNAVAILABLE'}],
  ]) {
    const {fetchImpl}=fakeFetch(options),result=await createStandbyReadiness({env:{},fetchImpl}).start();
    for(const [key,value] of Object.entries(expected))assert.equal(result.checks[key],value);
    assert.doesNotMatch(JSON.stringify(result),/private synthetic failure/);
  }
  const {fetchImpl,calls}=fakeFetch();
  const result=await createStandbyReadiness({env:{NODE_TLS_REJECT_UNAUTHORIZED:'0'},fetchImpl}).start();
  assert.equal(result.checks.testnet_rpc,'UNAVAILABLE');assert.equal(result.checks.market_wasm,'UNAVAILABLE');assert.equal(calls.length,0);
});

test('public diagnostic reads are cached and cannot invoke a mission or trigger another remote call',async()=>{
  const {fetchImpl,calls}=fakeFetch(),readiness=createStandbyReadiness({env:{},fetchImpl});
  await readiness.start();const count=calls.length,server=createRailwayNativeStandby({readiness});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    for(let i=0;i<3;i++) {
      const r=await fetch(`${base}/readiness`);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
      const data=await r.json();assert.equal(data.status,'STANDBY');assert.equal(data.transactions_enabled,false);
    }
    for(const query of ['?volume-probe=1','?volume-probe=2','?volume-probe=3']) {
      const r=await fetch(`${base}/readiness${query}`);assert.equal(r.status,200);assert.equal((await r.json()).transactions_enabled,false);
    }
    assert.equal((await fetch(`${base}/readiness`,{method:'POST'})).status,404);
    assert.equal((await fetch(`${base}/readiness?x=1`)).status,404);
    assert.equal((await fetch(`${base}/api/native-mission/execute`,{method:'POST'})).status,404);
    assert.equal(calls.length,count);
  } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
