// Offline only: disposable keys, loopback HTTP and fabricated RPC views.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import pg from 'pg';
import { ORACLE_PROJECT_ID, ORACLE_PROJECT_UUID, ORACLE_TESTNET_PROGRAM } from '../agent/oracle-outlayer.mjs';
import { initializePostgresWalletPromptAuth } from '../agent/postgres-wallet-prompt-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { createNativeMissionSite } from '../agent/native-mission-site.mjs';
import { configureNativeMissionSite, readConfiguredMission, readConfiguredNativeSigners, inspectConfiguredNativeSigners, trackNativeMissionWork, assertRailwayNativeVolume } from '../agent/configured-native-mission-site.mjs';
import { initializeNativeMissionJournal } from '../scripts/init-native-mission-journal.mjs';
import { initializeNativeAgentKeys } from '../scripts/init-native-mission-agent-keys.mjs';
import { FileJournal } from '../agent/procurement.mjs';
import { readFileJournalKeyFile } from '../agent/file-journal-crypto.mjs';
import { acquireRailwayNativeJournalFence } from '../agent/railway-native-journal-fence.mjs';

const linuxFlockTest=process.platform==='linux'&&fs.existsSync('/usr/bin/flock') ? test : test.skip;
const origin='https://bouncer.example',host='bouncer.example';
const clone=x=>structuredClone(x);
const listen=server=>new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
const close=server=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
function request(server,{url='/',method='GET',headers={},body}={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:{host,...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(body);
  });
}
function mockService() {
  const calls=[];
  const service={getReview:()=>({format:'fixture'}),...Object.fromEntries(['preview','issue','execute','originals','recover'].map(name=>[name,async input=>{calls.push([name,input]);return {status:name}}]))};
  return {calls,service};
}
function files() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-native-site-'));fs.chmodSync(dir,0o700);
  const missionFile=path.join(dir,'mission.json'),journalFile=path.join(dir,'originals.json'),keyFile=path.join(dir,'journal.key'),agentFile=path.join(dir,'agent-keys.json');
  const input=JSON.parse(fs.readFileSync(new URL('../examples/native-mission.example.json',import.meta.url),'utf8'));
  input.owner_account_id='runtime-owner.testnet';input.contract_id='native.runtime-owner.testnet';
  for(const {goal} of input.goals){goal.owner_account_id=input.owner_account_id;goal.contract_id=input.contract_id}
  fs.writeFileSync(missionFile,JSON.stringify(input),{mode:0o600});
  fs.writeFileSync(keyFile,crypto.randomBytes(32),{mode:0o600});
  const mission=readConfiguredMission(missionFile);
  const pairs=Object.fromEntries(mission.goals.map(({goal})=>[goal.id,nearApi.KeyPair.fromRandom('ed25519')]));
  const saved={format:'bouncer-restricted-agent-keys-v1',owner_account_id:mission.owner_account_id,keys:Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,pair.toString()]))};
  fs.writeFileSync(agentFile,JSON.stringify(saved),{mode:0o600});
  return {dir,missionFile,journalFile,keyFile,agentFile,mission,pairs,saved,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
function rpcFixture(f) {
  const methods={random:'execute_outlayer',oracle:'execute_outlayer_native_project',storage:'execute_native_storage'};
  const scopes=Object.fromEntries(f.mission.goals.map(({kind,goal})=>[String(f.pairs[goal.id].getPublicKey()),{receiver_id:f.mission.contract_id,method_names:[methods[kind]],allowance:'1000000000000000000000000'}]));
  const state={chain:'testnet',code:f.mission.goals.find(x=>x.kind==='storage').goal.contract_code_hash,keys:[],owner:f.mission.owner_account_id,version:'bouncer-agent-v14-native-storage-testnet',scopes};
  const provider={async viewNodeStatus(){return {chain_id:state.chain}},async viewAccount(){return {code_hash:state.code}},
    async viewAccessKeyList(){return {keys:state.keys}},async callFunction(_id,method){return method==='get_owner'?state.owner:state.version},
    async viewAccessKey(_id,publicKey){return {permission:{FunctionCall:state.scopes[String(publicKey)]}}}};
  return {state,provider};
}

test('one fixed-origin site serves the reviewed assets and exact mission APIs',async()=>{
  const {service,calls}=mockService(),server=createNativeMissionSite({siteOrigin:origin,service,walletConnectProjectId:'a'.repeat(32)});await listen(server);
  try {
    const index=await request(server);assert.equal(index.status,200);assert.match(index.body,/content="https:\/\/bouncer\.example"/);
    assert.match(index.headers['content-security-policy'],/object-src 'none'/);assert.equal(index.headers['x-content-type-options'],'nosniff');
    const config=await request(server,{url:'/walletconnect-config.json'});assert.deepEqual(JSON.parse(config.body),{projectId:'a'.repeat(32)});
    assert.equal((await request(server,{url:'/wallet.bundle.js?v=1',method:'HEAD'})).status,200);
    assert.equal((await request(server,{url:'/agent/procurement.mjs'})).status,404);
    assert.equal((await request(server,{url:'/%2e%2e/agent/procurement.mjs'})).status,404);
    assert.equal((await request(server,{headers:{host:'attacker.example'}})).status,421);
    assert.equal((await request(server,{headers:{'x-forwarded-proto':'http'}})).status,421);
    const hdr={'x-bouncer-native-mission':'v1'};
    assert.equal((await request(server,{url:'/api/native-mission/config',headers:hdr})).status,200);
    assert.equal((await request(server,{url:'/api/native-mission/config?x=1',headers:hdr})).status,404);
    assert.equal((await request(server,{url:'/api/native-mission/config',headers:{...hdr,origin:'https://evil.example'}})).status,403);
    const data=JSON.stringify({missionSha256:'a'.repeat(64)}),post={'x-bouncer-native-mission':'v1',origin,'content-type':'application/json'};
    assert.equal((await request(server,{url:'/api/native-mission/preview',method:'POST',headers:post,body:data})).status,200);
    assert.deepEqual(calls,[['preview',{missionSha256:'a'.repeat(64)}]]);
    assert.equal((await request(server,{url:'/api/native-mission/execute',method:'POST',headers:{...post,origin:'https://evil.example'},body:data})).status,403);
    assert.equal(calls.length,1);
    assert.equal((await request(server,{url:'/api/google-session'})).status,503);
  } finally {await close(server)}
});

test('WalletConnect upgrade is origin checked even on the same server',async()=>{
  const {service}=mockService(),server=createNativeMissionSite({siteOrigin:origin,service,walletConnectProjectId:'a'.repeat(32)});await listen(server);
  try {
    const status=await new Promise((resolve,reject)=>{
      const socket=net.createConnection(server.address().port,'127.0.0.1');let text='';socket.on('error',reject);
      socket.on('connect',()=>socket.write(`GET /api/wc-relay HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n`));
      socket.on('data',data=>text+=data);socket.on('end',()=>resolve(text.split('\r\n')[0]));
    });
    assert.match(status,/^HTTP\/1\.1 403/);
    // A valid same-origin upgrade reaches the bridge, but sends no JWT or
    // frame and therefore never opens an upstream connection.
    const accepted=await new Promise((resolve,reject)=>{
      const socket=net.createConnection(server.address().port,'127.0.0.1');socket.on('error',reject);
      socket.on('connect',()=>socket.write(`GET /api/wc-relay HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n`));
      socket.once('data',data=>{const first=data.toString().split('\r\n')[0];socket.destroy();resolve(first)});
    });
    assert.match(accepted,/^HTTP\/1\.1 101/);
  } finally {await close(server)}
});

test('new encrypted journal is exclusive, scoped to the mission, and never recreated over an original',()=>{
  const f=files();try {
    assert.throws(()=>initializeNativeMissionJournal({...f}),/confirmation/);
    assert.deepEqual(initializeNativeMissionJournal({...f,confirmBrandNewVault:true}),{status:'NEW_JOURNAL_INITIALIZED',transactions_sent:0});
    assert.throws(()=>initializeNativeMissionJournal({...f,confirmBrandNewVault:true}),/already exists/);
    assert.doesNotMatch(fs.readFileSync(f.journalFile,'utf8'),/runtime-owner|compute/);
    const key=readFileJournalKeyFile(f.keyFile),journal=new FileJournal(f.journalFile,f.mission.contract_id,f.mission.owner_account_id,{encryptionKey:key,keyFile:f.keyFile,requireExisting:true});key.fill(0);
    try {
      const intent=journal.get(`native-mission:${f.mission.id}`);
      assert.equal(intent.kind,'native-mission-intent-v1');assert.deepEqual(intent.mission,f.mission);
      assert.equal(journal.encryptionEnabled,true);assert.equal(journal.list().length,1);
    } finally {journal.close()}
    fs.chmodSync(f.agentFile,0o644);
    assert.throws(()=>readConfiguredNativeSigners(f.agentFile,f.mission,{}),/not private/);
  } finally {f.clean()}
});

test('generates distinct agent keys once, exposes only public keys and installs nothing',()=>{
  const f=files();try {
    fs.unlinkSync(f.agentFile);
    const result=initializeNativeAgentKeys(f);
    assert.equal(result.status,'AGENT_KEYS_CREATED_NOT_INSTALLED');assert.equal(result.transactions_sent,0);
    assert.equal(Object.keys(result.public_keys).length,f.mission.goals.length);
    assert.equal(new Set(Object.values(result.public_keys).map(x=>x.public_key)).size,f.mission.goals.length);
    assert.ok(Object.values(result.public_keys).every(x=>x.receiver_id===f.mission.contract_id && x.max_gas_allowance_yocto==='1000000000000000000000000'));
    assert.equal(fs.statSync(f.agentFile).mode&0o777,0o600);
    const signers=readConfiguredNativeSigners(f.agentFile,f.mission,{}),stored=JSON.parse(fs.readFileSync(f.agentFile));
    for(const {goal} of f.mission.goals) {
      assert.equal(String(signers[goal.id].publicKey),result.public_keys[goal.id].public_key);
      assert.equal(JSON.stringify(result).includes(stored.keys[goal.id]),false);
    }
    assert.throws(()=>initializeNativeAgentKeys(f),/already exists/);
  } finally {f.clean()}
});

test('startup checks independent, bounded, single-method agent keys and pinned keyless vault',async()=>{
  const f=files();try {
    const {state,provider}=rpcFixture(f),signers=readConfiguredNativeSigners(f.agentFile,f.mission,provider);
    assert.deepEqual(await inspectConfiguredNativeSigners({mission:f.mission,provider,signers}),{status:'RESTRICTED_SIGNERS_CHECKED',transactions_sent:0});
    const first=String(signers[f.mission.goals[0].goal.id].publicKey),original=clone(state.scopes[first]);
    for(const bad of [
      {...original,receiver_id:'other.testnet'}, {...original,method_names:[]}, {...original,method_names:['execute_outlayer','set_policy']},
      {...original,allowance:null}, {...original,allowance:'0'}, {...original,allowance:'1000000000000000000000001'},
    ]) {state.scopes[first]=bad;await assert.rejects(inspectConfiguredNativeSigners({mission:f.mission,provider,signers}),/restricted/)}
    state.scopes[first]=original;state.keys=[{public_key:'unexpected'}];
    await assert.rejects(inspectConfiguredNativeSigners({mission:f.mission,provider,signers}),/keyless/);state.keys=[];
    state.chain='mainnet';await assert.rejects(inspectConfiguredNativeSigners({mission:f.mission,provider,signers}),/testnet/);state.chain='testnet';
    state.owner='other.testnet';await assert.rejects(inspectConfiguredNativeSigners({mission:f.mission,provider,signers}),/owner/);
    const duplicate=clone(f.saved);const ids=Object.keys(duplicate.keys);duplicate.keys[ids[1]]=duplicate.keys[ids[0]];
    fs.writeFileSync(f.agentFile,JSON.stringify(duplicate),{mode:0o600});
    assert.throws(()=>readConfiguredNativeSigners(f.agentFile,f.mission,provider),/invalid or reused/);
  } finally {f.clean()}
});

test('shutdown stops new operations and waits for disconnected in-flight work before draining',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let started=false;
  const {service}=mockService();service.execute=async()=>{started=true;await gate;return {status:'done'}};
  const tracked=trackNativeMissionWork(service),work=tracked.service.execute({});
  await Promise.resolve();assert.equal(started,true);tracked.stop();
  await assert.rejects(tracked.service.preview({}),/stopping/);
  let drained=false;const waiting=tracked.drain().then(()=>{drained=true});
  await Promise.resolve();assert.equal(drained,false);release();await work;await waiting;assert.equal(drained,true);
});

test('configured recovery site needs the original journal and does not load keys, open challenges or send',async()=>{
  const f=files(),methods=[];
  const rpc=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const message=JSON.parse(Buffer.concat(chunks));methods.push(message.method);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{chain_id:'testnet'}}));
  });await listen(rpc);
  const env={BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_MODE:'recover',BOUNCER_WALLET_ORIGIN:origin,
    BOUNCER_TESTNET_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,BOUNCER_NATIVE_MISSION_FILE:f.missionFile,
    BOUNCER_NATIVE_MISSION_JOURNAL_FILE:f.journalFile,BOUNCER_FILE_JOURNAL_KEY_FILE:f.keyFile};
  let runtime;
  try {
    await assert.rejects(configureNativeMissionSite({env:{...env,BOUNCER_NATIVE_MISSION_ENABLED:'0'}}),/enablement/);
    await assert.rejects(configureNativeMissionSite({env}),/original journal not found/);assert.equal(fs.existsSync(f.journalFile),false);
    initializeNativeMissionJournal({...f,confirmBrandNewVault:true});
    runtime=await configureNativeMissionSite({env});await listen(runtime.server);
    const headers={'x-bouncer-native-mission':'v1'};
    const config=JSON.parse((await request(runtime.server,{url:'/api/native-mission/config',headers})).body);
    const body=JSON.stringify({missionSha256:config.review.mission_sha256}),post={...headers,origin,'content-type':'application/json'};
    const original=JSON.parse((await request(runtime.server,{url:'/api/native-mission/originals',method:'POST',headers:post,body})).body);
    assert.deepEqual(original.originals,[]);assert.equal(original.status,'NO_LOCAL_ORIGINALS');
    const preview=JSON.parse((await request(runtime.server,{url:'/api/native-mission/preview',method:'POST',headers:post,body})).body);
    assert.equal(preview.preview.stage,'recovery-only');assert.equal(preview.preview.new_payments,0);
    assert.ok(methods.every(m=>m==='status'));
  } finally {if(runtime)await runtime.close();await close(rpc);f.clean()}
});

test('Railway volume guard refuses missing mounts, outside paths and symlink escapes',()=>{
  const f=files(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-outside-'));
  try {
    fs.chmodSync(outside,0o700);
    assert.doesNotThrow(()=>assertRailwayNativeVolume({mountPath:f.dir,files:[f.missionFile,f.journalFile,f.keyFile]}));
    assert.throws(()=>assertRailwayNativeVolume({mountPath:'/',files:[f.missionFile,f.journalFile,f.keyFile]}),/volume/);
    assert.throws(()=>assertRailwayNativeVolume({mountPath:f.dir,files:[f.missionFile,f.journalFile,path.join(outside,'key')]}),/declared Railway volume/);
    const link=path.join(f.dir,'escape');fs.symlinkSync(outside,link,'dir');
    assert.throws(()=>assertRailwayNativeVolume({mountPath:f.dir,files:[f.missionFile,f.journalFile,path.join(link,'key')]}),/declared Railway volume/);
    assert.throws(()=>assertRailwayNativeVolume({mountPath:path.join(f.dir,'missing'),files:[f.missionFile,f.journalFile,f.keyFile]}),/declared Railway volume/);
  } finally {fs.rmSync(outside,{recursive:true,force:true});f.clean()}
});

linuxFlockTest('Railway recovery-only startup needs its original volume and cannot authorize or send',async()=>{
  const f=files(), methods=[], rpc=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const msg=JSON.parse(Buffer.concat(chunks));methods.push(msg.method);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{chain_id:'testnet'}}));
  });await listen(rpc);let runtime;
  const secret='ab'.repeat(32),railwayOrigin='https://bouncer-synthetic.up.railway.app',railwayHost='bouncer-synthetic.up.railway.app';
  try {
    initializeNativeMissionJournal({...f,confirmBrandNewVault:true});
    const env={BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_MODE:'recover',BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
      BOUNCER_WALLET_ORIGIN:origin,BOUNCER_TESTNET_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,
      BOUNCER_NATIVE_MISSION_FILE:f.missionFile,BOUNCER_NATIVE_MISSION_JOURNAL_FILE:f.journalFile,BOUNCER_FILE_JOURNAL_KEY_FILE:f.keyFile,
      BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:railwayOrigin,BOUNCER_NATIVE_MISSION_PROXY_SECRET:secret,RAILWAY_VOLUME_MOUNT_PATH:f.dir,
      BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE:f.agentFile};
    await assert.rejects(configureNativeMissionSite({env:{...env,BOUNCER_NATIVE_MISSION_MODE:'execute'}}),/start in recovery-only mode/);
    await assert.rejects(configureNativeMissionSite({env:{...env,RAILWAY_VOLUME_MOUNT_PATH:'/wrong'}}),/volume/);
    await assert.rejects(configureNativeMissionSite({env:{...env,BOUNCER_NATIVE_MISSION_PROXY_SECRET:'bad'}}),/secret/);
    runtime=await configureNativeMissionSite({env});assert.equal(runtime.mode,'recover');assert.equal(runtime.ingress,'railway-proxy');
    await listen(runtime.server);
    const auth={host:railwayHost,'x-forwarded-proto':'https','x-bouncer-proxy-secret':secret,'x-bouncer-native-mission':'v1'};
    assert.equal((await request(runtime.server,{url:'/api/native-mission/config',headers:{...auth,'x-bouncer-proxy-secret':'cd'.repeat(32)}})).status,403);
    const conf=await request(runtime.server,{url:'/api/native-mission/config',headers:auth});assert.equal(conf.status,200);
    const review=JSON.parse(conf.body).review,post={...auth,origin,'content-type':'application/json'};
    const preview=await request(runtime.server,{url:'/api/native-mission/preview',method:'POST',headers:post,body:JSON.stringify({missionSha256:review.mission_sha256})});
    assert.equal(JSON.parse(preview.body).preview.stage,'recovery-only');
    assert.equal(fs.existsSync(`${f.journalFile}.recovery-started`),false);
    const originals=await request(runtime.server,{url:'/api/native-mission/originals',method:'POST',headers:post,
      body:JSON.stringify({missionSha256:review.mission_sha256})});
    assert.equal(JSON.parse(originals.body).status,'NO_LOCAL_ORIGINALS');
    assert.equal(fs.existsSync(`${f.journalFile}.recovery-started`),true);
    const challenge=await request(runtime.server,{url:'/api/native-mission/challenge',method:'POST',headers:post,
      body:JSON.stringify({missionSha256:review.mission_sha256,ownerPublicKey:'synthetic'})});
    assert.equal(challenge.status,409);assert.ok(!methods.includes('send_tx'));
    await runtime.close();runtime=null;
    const fence=acquireRailwayNativeJournalFence({journalFile:f.journalFile,mode:'execute'});fence.close();
  } finally {if(runtime)await runtime.close();await close(rpc);f.clean()}
});

linuxFlockTest('Railway refuses to serve a journal containing another original',async()=>{
  const f=files(),rpc=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const msg=JSON.parse(Buffer.concat(chunks));
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{chain_id:'testnet'}}));
  });await listen(rpc);
  try {
    initializeNativeMissionJournal({...f,confirmBrandNewVault:true});
    const key=readFileJournalKeyFile(f.keyFile),journal=new FileJournal(f.journalFile,f.mission.contract_id,f.mission.owner_account_id,
      {encryptionKey:key,keyFile:f.keyFile,requireExisting:true});key.fill(0);
    journal.put('unrelated',{status:'pending',fingerprint:'synthetic',tx_hash:'synthetic-other-original'});journal.close();
    const before=fs.readFileSync(f.journalFile);
    const env={BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_MODE:'recover',BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
      BOUNCER_WALLET_ORIGIN:origin,BOUNCER_TESTNET_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,
      BOUNCER_NATIVE_MISSION_FILE:f.missionFile,BOUNCER_NATIVE_MISSION_JOURNAL_FILE:f.journalFile,BOUNCER_FILE_JOURNAL_KEY_FILE:f.keyFile,
      BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:'https://bouncer-synthetic.up.railway.app',BOUNCER_NATIVE_MISSION_PROXY_SECRET:'ab'.repeat(32),
      RAILWAY_VOLUME_MOUNT_PATH:f.dir};
    await assert.rejects(configureNativeMissionSite({env}),/dedicated original mission journal/);
    assert.deepEqual(fs.readFileSync(f.journalFile),before);
  } finally {await close(rpc);f.clean()}
});

linuxFlockTest('unclean Railway restart stays recovery-only across wrong keys and an empty recovery',async()=>{
  const f=files(),methods=[],rpc=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const msg=JSON.parse(Buffer.concat(chunks));methods.push(msg.method);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{chain_id:'testnet'}}));
  });await listen(rpc);let runtime;
  const secret='ab'.repeat(32),backend='https://bouncer-synthetic.up.railway.app';
  const env={BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_MODE:'recover',BOUNCER_NATIVE_MISSION_INGRESS:'railway-proxy',
    BOUNCER_WALLET_ORIGIN:origin,BOUNCER_TESTNET_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,
    BOUNCER_NATIVE_MISSION_FILE:f.missionFile,BOUNCER_NATIVE_MISSION_JOURNAL_FILE:f.journalFile,BOUNCER_FILE_JOURNAL_KEY_FILE:f.keyFile,
    BOUNCER_NATIVE_MISSION_BACKEND_ORIGIN:backend,BOUNCER_NATIVE_MISSION_PROXY_SECRET:secret,RAILWAY_VOLUME_MOUNT_PATH:f.dir,
    BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE:f.agentFile};
  try {
    initializeNativeMissionJournal({...f,confirmBrandNewVault:true});
    const fence=acquireRailwayNativeJournalFence({journalFile:f.journalFile,mode:'recover'}),key=readFileJournalKeyFile(f.keyFile);
    const journal=new FileJournal(f.journalFile,f.mission.contract_id,f.mission.owner_account_id,{encryptionKey:key,keyFile:f.keyFile,requireExisting:true});
    fence.mark(journal);key.fill(0);
    // Simulate an unclean process exit: close descriptors but leave its marker.
    fs.closeSync(journal.lockFd);journal.lockFd=null;journal.close();fence.close();
    const saved=fs.readFileSync(f.keyFile);fs.writeFileSync(f.keyFile,crypto.randomBytes(32));
    await assert.rejects(configureNativeMissionSite({env}));fs.writeFileSync(f.keyFile,saved);saved.fill(0);
    assert.equal(fs.existsSync(`${f.journalFile}.recovery-required`),true);
    await assert.rejects(configureNativeMissionSite({env:{...env,BOUNCER_NATIVE_MISSION_MODE:'execute'}}),/unclean shutdown/);
    runtime=await configureNativeMissionSite({env});await listen(runtime.server);
    const headers={host:new URL(backend).host,'x-forwarded-proto':'https','x-bouncer-proxy-secret':secret,
      'x-bouncer-native-mission':'v1',origin,'content-type':'application/json'};
    const config=JSON.parse((await request(runtime.server,{url:'/api/native-mission/config',headers})).body);
    const response=await request(runtime.server,{url:'/api/native-mission/recover',method:'POST',headers,
      body:JSON.stringify({missionSha256:config.review.mission_sha256})});
    assert.equal(response.status,409); // no original receipt exists to verify
    await runtime.close();runtime=null;
    assert.equal(fs.existsSync(`${f.journalFile}.recovery-required`),true);
    await assert.rejects(configureNativeMissionSite({env:{...env,BOUNCER_NATIVE_MISSION_MODE:'execute'}}),/unclean shutdown/);
    assert.ok(!methods.includes('send_tx'));
  } finally {if(runtime)await runtime.close();await close(rpc);f.clean()}
});

const postgresUrl=process.env.BOUNCER_TEST_POSTGRES_URL;
if(process.env.BOUNCER_REQUIRE_POSTGRES_TESTS==='1'&&!postgresUrl)throw new Error('PostgreSQL integration test URL is required');
(postgresUrl?test:test.skip)('configured execute site binds real one-use PostgreSQL consent to real preflights without sending',async()=>{
  const f=files(),db=new pg.Pool({connectionString:postgresUrl,max:4,connectionTimeoutMillis:5000}),ownerKey=nearApi.KeyPair.fromRandom('ed25519');
  const methodByKind={random:'execute_outlayer',oracle:'execute_outlayer_native_project',storage:'execute_native_storage'};
  const scopes=Object.fromEntries(f.mission.goals.map(({kind,goal})=>[String(f.pairs[goal.id].getPublicKey()),
    {receiver_id:f.mission.contract_id,method_names:[methodByKind[kind]],allowance:'100000000000000000000000'}]));
  const methods=[],blockHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,42));let blocked=false,runtime;
  const rpc=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const msg=JSON.parse(Buffer.concat(chunks));methods.push(msg.method);
    const p=msg.params;let value;
    if(msg.method==='status')value={chain_id:'testnet'};
    else if(msg.method==='block')value={header:{hash:blockHash,timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};
    else if(msg.method==='query'&&p.request_type==='view_account')value={amount:'100000000000000000000000000',locked:'0',code_hash:f.mission.goals[2].goal.contract_code_hash,block_hash:blockHash};
    else if(msg.method==='query'&&p.request_type==='view_access_key_list')value={keys:[],block_hash:blockHash};
    else if(msg.method==='query'&&p.request_type==='view_access_key')value={nonce:'1',block_hash:blockHash,
      permission:p.public_key===String(ownerKey.getPublicKey())?'FullAccess':{FunctionCall:scopes[p.public_key]}};
    else if(msg.method==='query'&&p.request_type==='call_function') {
      const views={contract_version:'bouncer-agent-v14-native-storage-testnet',get_owner:f.mission.owner_account_id,
        get_policy:{token:'native',per_tx_cap:'10000000000000000000000000',daily_cap:'10000000000000000000000000'},
        get_outlayer_program:f.mission.goals[0].goal.program,get_outlayer_native_project:f.mission.goals[1].goal.route,
        get_native_storage_route:f.mission.goals[2].goal.route,is_agent_key_allowed:true,
        check:blocked?[false,'synthetic block']:[true,'ok'],native_storage_id_reserved:false,
        get_project:{project_id:ORACLE_PROJECT_ID,uuid:ORACLE_PROJECT_UUID,owner:'zavodil2.testnet'},
        get_version:{wasm_hash:ORACLE_TESTNET_PROGRAM.sha256,source:{WasmUrl:{url:ORACLE_TESTNET_PROGRAM.url,
          hash:ORACLE_TESTNET_PROGRAM.sha256,build_target:ORACLE_TESTNET_PROGRAM.build_target}}},
        get_project_pricing:null,daily_spent:'0',vault_balance:'10000000000000000000000000'};
      if(!Object.hasOwn(views,p.method_name)){res.writeHead(500);return res.end()}
      value={result:[...Buffer.from(JSON.stringify(views[p.method_name]))],logs:[],block_hash:blockHash};
    } else {res.writeHead(500);return res.end()}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:value}));
  });
  await listen(rpc);
  try {
    await initializePostgresWalletPromptAuth({pool:db});initializeNativeMissionJournal({...f,confirmBrandNewVault:true});
    runtime=await configureNativeMissionSite({env:{BOUNCER_NATIVE_MISSION_ENABLED:'1',BOUNCER_NATIVE_MISSION_MODE:'execute',
      BOUNCER_WALLET_ORIGIN:origin,BOUNCER_TESTNET_RPC_URL:`http://127.0.0.1:${rpc.address().port}`,
      BOUNCER_NATIVE_MISSION_FILE:f.missionFile,BOUNCER_NATIVE_MISSION_JOURNAL_FILE:f.journalFile,
      BOUNCER_FILE_JOURNAL_KEY_FILE:f.keyFile,BOUNCER_NATIVE_MISSION_AGENT_KEYS_FILE:f.agentFile,
      BOUNCER_NATIVE_MISSION_AUTH_DATABASE_URL:postgresUrl}});
    await listen(runtime.server);
    const hdr={'x-bouncer-native-mission':'v1'},post={...hdr,origin,'content-type':'application/json'};
    const config=JSON.parse((await request(runtime.server,{url:'/api/native-mission/config',headers:hdr})).body),digest=config.review.mission_sha256;
    const previewRes=await request(runtime.server,{url:'/api/native-mission/preview',method:'POST',headers:post,body:JSON.stringify({missionSha256:digest})});
    assert.equal(previewRes.status,200,previewRes.body);assert.equal(JSON.parse(previewRes.body).preview.status,'READY');
    const ownerPublicKey=String(ownerKey.getPublicKey());
    const challengeRes=await request(runtime.server,{url:'/api/native-mission/challenge',method:'POST',headers:post,
      body:JSON.stringify({missionSha256:digest,ownerPublicKey})});
    assert.equal(challengeRes.status,200,challengeRes.body);const challenge=JSON.parse(challengeRes.body);
    const payload=nep413Payload({message:challenge.message,nonce:new Uint8Array(Buffer.from(challenge.nonce_base64,'base64')),recipient:challenge.recipient});
    const signed=crypto.createHash('sha256').update(payload).digest();
    const evidence={challenge_id:challenge.challenge_id,accountId:f.mission.owner_account_id,publicKey:ownerPublicKey,
      signature:Buffer.from(ownerKey.sign(signed).signature).toString('base64')};
    blocked=true; // change the synthetic on-chain policy after consent, before any signature or broadcast
    const input=JSON.stringify({missionSha256:digest,ownerPublicKey,evidence});
    const execution=await request(runtime.server,{url:'/api/native-mission/execute',method:'POST',headers:post,body:input});
    assert.equal(execution.status,200,execution.body);assert.equal(JSON.parse(execution.body).status,'BLOCKED');
    assert.equal((await request(runtime.server,{url:'/api/native-mission/execute',method:'POST',headers:post,body:input})).status,409);
    const row=await db.query('SELECT * FROM bouncer_wallet_auth_v1.challenges WHERE challenge_id=$1',[challenge.challenge_id]);
    assert.equal(row.rows[0].consumed,true);assert.equal(JSON.stringify(row.rows[0]).includes(evidence.signature),false);
    assert.equal(methods.includes('send_tx'),false);
  } finally {if(runtime)await runtime.close();await close(rpc);await db.end();f.clean()}
});
