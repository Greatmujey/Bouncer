#!/usr/bin/env node
/** A short-lived, explicitly enabled testnet preview. No private owner key,
 * wallet signature or transaction broadcaster is present on this server. The
 * checkpoint and coordinator run in separate jobs and databases but share an
 * account/operator; this is NOT an independently operated production service.
 * Any unknown activation, Git acknowledgement or checkpoint result stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import nearApi from 'near-api-js';
import {validateTestnetInfraConfig,testnetPoolerHosts,testnetPoolerSsl} from '../agent/testnet-infra-session-config.mjs';
import {findQuickTunnelOrigin,validatePreviewEndpoints,emptyReadOnlyBridge} from '../agent/testnet-preview-session.mjs';
import {createPostgresSetupHeadAnchor} from '../agent/postgres-setup-head-anchor.mjs';
import {createGitAuditedSetupCheckpointServer,createIndependentSetupCheckpointClient} from '../agent/independent-setup-checkpoint.mjs';
import {createGitWitnessRangeAudit} from '../agent/git-witness-range-audit.mjs';
import {createExperimentalPhoneSetupRuntime} from '../agent/experimental-phone-setup-runtime.mjs';
import {ReadOnlyNearReceiptProvider} from '../agent/read-only-near-receipts.mjs';
import {inspectNativeOracleReadiness} from '../agent/native-oracle-readiness.mjs';
import {inspectReadOnlyOwnerKey} from '../agent/read-only-owner-key.mjs';
import {createReadOnlyPreviewService} from '../agent/read-only-preview-service.mjs';

const ROLE=process.env.BOUNCER_INFRA_ROLE,RUN=process.env.GITHUB_RUN_ID,BRANCH=process.env.GITHUB_REF_NAME;
const REPO=process.env.GITHUB_WORKSPACE,TEMP=process.env.RUNNER_TEMP;
const BASELINE=process.env.BOUNCER_INFRA_BASELINE,INITIAL=process.env.BOUNCER_INFRA_INITIAL_HEAD;
const FAIL=()=>new Error('testnet preview unavailable; stop and reconcile any existing original');
const BINARY_URL='https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64';
const BINARY_SHA='1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872';
const OWNER='great_mujey.testnet',VAULT='native.great_mujey.testnet';
let phase='configuration',pool,tunnel,web,service,placeholder;
function git(args){try{return execFileSync('git',args,{cwd:REPO,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000,
  env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}}).trim()}catch{throw FAIL()}}
function protectedText(file){const s=fs.lstatSync(file);if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || (s.mode&0o077)!==0 || s.size>2048)throw FAIL();return fs.readFileSync(file,'utf8')}
async function connect(config,password){
  const project=config.projects[ROLE];
  for(const host of testnetPoolerHosts(ROLE,config)){
    const candidate=new pg.Pool({host,port:5432,database:'postgres',user:`bouncer_${ROLE}.${project.ref}`,password,ssl:testnetPoolerSsl(),
      max:6,connectionTimeoutMillis:8_000,idleTimeoutMillis:20_000});
    try{const r=await candidate.query('SELECT current_user AS role, current_database() AS database');
      if(r.rows.length!==1 || r.rows[0].role!==`bouncer_${ROLE}` || r.rows[0].database!=='postgres')throw FAIL();return candidate}
    catch{await candidate.end().catch(()=>{})}
  }
  throw FAIL();
}
async function listen(server,port){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});return server}
async function close(server){if(server?.listening)await new Promise(resolve=>server.close(resolve))}
async function downloadBinary(){
  const target=path.join(TEMP,`bouncer-cloudflared-${ROLE}`),response=await fetch(BINARY_URL,{redirect:'follow',signal:AbortSignal.timeout(120_000)});
  if(!response.ok || !response.body)throw FAIL();
  const file=await fs.promises.open(target,'wx',0o700),hash=crypto.createHash('sha256');let size=0;
  try{for await(const part of response.body){size+=part.length;if(size>80_000_000)throw FAIL();hash.update(part);await file.writeFile(part)}
    if(size<1_000_000 || hash.digest('hex')!==BINARY_SHA)throw FAIL();await file.chmod(0o700)}finally{await file.close()}
  return target;
}
async function openTunnel(port){
  const binary=await downloadBinary(),child=spawn(binary,['--no-autoupdate','tunnel','--protocol','http2','--url',`http://127.0.0.1:${port}`],
    {cwd:TEMP,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:TEMP}});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const origin=await new Promise((resolve,reject)=>{
    let log='',settled=false;const timer=setTimeout(()=>finish(null),120_000);
    function finish(value){if(settled)return;settled=true;clearTimeout(timer);value?resolve(value):reject(FAIL())}
    function onData(chunk){try{log=(log+String(chunk)).slice(-100_000);const found=findQuickTunnelOrigin(log);if(found)finish(found)}catch{finish(null)}}
    child.stdout.on('data',onData);child.stderr.on('data',onData);child.once('error',()=>finish(null));child.once('exit',()=>finish(null));
  }).catch(error=>{child.kill('SIGTERM');throw error});
  return {origin,child,exit};
}
async function publishEndpoint(origin,state){
  await pool.query(`CREATE TABLE IF NOT EXISTS bouncer_testnet_infra_v1.endpoints (
    run_id text NOT NULL, role text NOT NULL, baseline text NOT NULL, origin text NOT NULL, state text NOT NULL,
    PRIMARY KEY(run_id,role)); GRANT SELECT ON bouncer_testnet_infra_v1.endpoints TO postgres`);
  const result=await pool.query(`INSERT INTO bouncer_testnet_infra_v1.endpoints(run_id,role,baseline,origin,state)
    VALUES($1,$2,$3,$4,$5)`,[RUN,ROLE,BASELINE,origin,state]);
  if(result.rowCount!==1)throw FAIL();
}
async function mark(state){const r=await pool.query(`UPDATE bouncer_testnet_infra_v1.endpoints SET state=$1 WHERE run_id=$2 AND role=$3 AND baseline=$4`,[state,RUN,ROLE,BASELINE]);if(r.rowCount!==1)throw FAIL()}
async function waitForEndpoints(siteOrigin){
  const name=`bouncer/infrastructure/session-${RUN}-endpoints.json`,end=Date.now()+10*60_000;
  while(Date.now()<end){
    let raw;
    try{git(['fetch','--quiet','--no-tags','origin',BRANCH]);raw=git(['show',`refs/remotes/origin/${BRANCH}:${name}`])}catch{await delay(5_000);continue}
    const endpoints=validatePreviewEndpoints(JSON.parse(raw),RUN,siteOrigin);
    git(['pull','--ff-only','--quiet','origin',BRANCH]);
    if(git(['status','--porcelain','--untracked-files=normal']))throw FAIL();return endpoints;
  }
  throw FAIL();
}
async function readOnlyProvider(){
  for(const endpoint of ['https://test.rpc.fastnear.com','https://rpc.testnet.near.org']){
    try{const provider=new ReadOnlyNearReceiptProvider(endpoint,{timeoutMs:20_000});
      const readiness=await inspectNativeOracleReadiness({owner:OWNER,vault:VAULT,provider});
      if(readiness.blockers.length)throw FAIL();return {provider,readiness}}
    catch{/* choose only a freshly verified testnet endpoint */}
  }
  throw FAIL();
}
async function verifyBrowserRpcCors(site){
  const url='https://rpc.testnet.near.org',originOk=r=>['*',site].includes(r.headers.get('access-control-allow-origin'));
  const options=await fetch(url,{method:'OPTIONS',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{origin:site,
    'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
  if(!options.ok || !originOk(options) || !/\bPOST\b/i.test(options.headers.get('access-control-allow-methods')??'') ||
     !/(?:^|[,\s])(?:content-type|\*)(?:$|[,\s])/i.test(options.headers.get('access-control-allow-headers')??''))throw FAIL();
  const status=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{origin:site,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-preview-cors',method:'status',params:[]})});
  const data=await status.json();
  if(!status.ok || !originOk(status) || data?.id!=='bouncer-preview-cors' || data?.result?.chain_id!=='testnet' || data.error)throw FAIL();
}
async function main(){
  if(!['coordinator','checkpoint'].includes(ROLE) || !/^[1-9][0-9]{0,19}$/.test(RUN??'') || BRANCH!=='arena/0e4386ea-near-hub' ||
     !path.isAbsolute(REPO??'') || !path.isAbsolute(TEMP??'') || !/^[a-f0-9]{40}$/.test(BASELINE??'') || !/^[a-f0-9]{40}$/.test(INITIAL??'') ||
     process.argv.length!==3 || process.argv[2]!==`bouncer/infrastructure/session-${RUN}-serve.json`)throw FAIL();
  const control=JSON.parse(fs.readFileSync(path.join(REPO,process.argv[2]),'utf8'));
  if(Object.keys(control).sort().join(',')!=='mode,run_id,version' || control.version!==1 || control.run_id!==RUN || control.mode!=='serve-testnet')throw FAIL();
  const config=validateTestnetInfraConfig(JSON.parse(fs.readFileSync(path.join(REPO,`bouncer/infrastructure/session-${RUN}.json`),'utf8')),RUN);
  const dir=path.join(TEMP,`bouncer-testnet-infra-${ROLE}`),password=protectedText(path.join(dir,'postgres-password')),
    token=protectedText(path.join(dir,'checkpoint-token'));
  if(!/^[A-Za-z0-9_-]{43}$/.test(password) || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
     protectedText(path.join(dir,'baseline'))!==BASELINE || protectedText(path.join(dir,'initial-head'))!==INITIAL)throw FAIL();
  phase='database';pool=await connect(config,password);
  const status=await pool.query('SELECT role,run_id,baseline,phase FROM bouncer_testnet_infra_v1.status');
  if(status.rows.length!==1 || status.rows[0].role!==ROLE || status.rows[0].run_id!==RUN || status.rows[0].baseline!==BASELINE ||
     status.rows[0].phase!=='PROVISIONED_NO_WALLET')throw FAIL();
  if(ROLE==='checkpoint'){
    phase='checkpoint';
    const anchor=createPostgresSetupHeadAnchor({pool,repository:'Greatmujey/Bouncer',branch:BRANCH,initialHead:INITIAL});
    const current=await anchor.read();if(current.head!==BASELINE)throw FAIL();
    const remoteUrl='https://github.com/Greatmujey/Bouncer.git';
    git(['remote','set-url','origin',remoteUrl]);
    const monitor=createGitAuditedSetupCheckpointServer({token,anchor,repo:REPO,branch:BRANCH,remoteUrl});
    service=await listen(monitor,8788);phase='checkpoint-tunnel';tunnel=await openTunnel(8788);
    const throughTunnel=createIndependentSetupCheckpointClient({origin:tunnel.origin,token,timeoutMs:10_000});
    let verified;
    for(let i=0;i<12;i++){try{verified=await throughTunnel.read();break}catch{await delay(2_000)}}
    if(verified?.head!==BASELINE || verified.revision!==current.revision)throw FAIL();
    await publishEndpoint(tunnel.origin,'CHECKPOINT_READY');
    console.log('The separate checkpoint is reachable with its protected session token.');
  }else{
    phase='site-tunnel';
    placeholder=await listen(http.createServer((req,res)=>{res.writeHead(503,{'cache-control':'no-store','content-type':'text/plain'});res.end('Testnet preview is being prepared.')}),4173);
    tunnel=await openTunnel(4173);await publishEndpoint(tunnel.origin,'WAITING_FOR_CHECKPOINT');
    phase='endpoint-instruction';const endpoints=await waitForEndpoints(tunnel.origin);
    phase='checkpoint-advance';const anchor=createIndependentSetupCheckpointClient({origin:endpoints.checkpoint_origin,token});
    const before=await anchor.read(),head=git(['rev-parse','HEAD']);
    if(before.head!==BASELINE || !/^[a-f0-9]{40}$/.test(head) || head===BASELINE ||
       git(['ls-remote','--heads','origin',`refs/heads/${BRANCH}`])!==`${head}\trefs/heads/${BRANCH}` ||
       await createGitWitnessRangeAudit({repo:REPO})(BASELINE,head)!==true)throw FAIL();
    const advanced=await anchor.compareAndSet({expected:before,nextHead:head}); // never retry an uncertain CAS
    const after=await anchor.read();if(advanced.confirmed!==true || advanced.head!==head || after.head!==head || after.revision!==advanced.revision)throw FAIL();
    phase='read-only-preflight';const {provider,readiness}=await readOnlyProvider();
    phase='browser-rpc-cors';await verifyBrowserRpcCors(tunnel.origin);
    git(['config','--local','user.name','Bouncer testnet witness']);
    git(['config','--local','user.email','41898282+github-actions[bot]@users.noreply.github.com']);
    phase='runtime';
    const bytes=file=>fs.readFileSync(path.join(REPO,file));
    const runtime=await createExperimentalPhoneSetupRuntime({pool,siteOrigin:tunnel.origin,provider,anchor,repo:REPO,branch:BRANCH,initialHead:BASELINE,
      nativeWasmBytes:bytes('bouncer.wasm'),nativeLoaderBytes:bytes('bouncer/contracts/native-phone-loader/fixtures/native-phone-loader-research.wasm'),
      nativeCompressedBytes:bytes('bouncer/contracts/native-phone-loader/fixtures/native-v9.deflate'),
      enableNative:true,enableNativeTrial:true,enableNativeCompressed:true});
    service=await listen(createReadOnlyPreviewService({bridge:emptyReadOnlyBridge(),siteOrigin:tunnel.origin,
      relayUrl:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read',nativeSetupFactory:runtime.nativeSetupFactory,
      inspectOwnerKey:input=>inspectReadOnlyOwnerKey({...input,provider}),
      inspectReadiness:()=>{throw FAIL()},makeReview:()=>{throw FAIL()}}),8787);
    await close(placeholder);placeholder=null;
    web=spawn(process.execPath,['bouncer/scripts/dev-web.mjs'],{cwd:REPO,stdio:['ignore','ignore','ignore'],
      env:{...process.env,PORT:'4173',BOUNCER_READONLY_PREVIEW:'1',BOUNCER_READONLY_PREVIEW_PORT:'8787'}});
    const webExit=new Promise(resolve=>{web.once('exit',(code,signal)=>resolve({code,signal}));web.once('error',()=>resolve({code:null,signal:null}))});
    phase='public-smoke';
    // Wait for the fresh local listener, then verify the public HTTPS path and
    // a review built from throwaway public keys. No signatures or transactions.
    let localReady=false;for(let i=0;i<20;i++){try{const r=await fetch('http://127.0.0.1:4173/',{signal:AbortSignal.timeout(1000)});if(r.ok){localReady=true;break}}catch{}await delay(250)}
    if(!localReady)throw FAIL();
    const headers={'x-bouncer-preview':'native-oracle-setup-v1',origin:tunnel.origin};
    const response=await fetch(`${tunnel.origin}/api/native-oracle-setup/config`,{headers,signal:AbortSignal.timeout(25_000)});
    const settings=await response.json();
    if(!response.ok || settings.enabled!==true || settings.network!=='testnet' || settings.owner!==OWNER ||
       settings.review_available!==true || settings.compressed_review_enabled!==true || settings.trial_submission_enabled!==true || settings.ready_for_real_spending!==false)throw FAIL();
    const agent=nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString(),ownerKey=nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const reviewResponse=await fetch(`${tunnel.origin}/api/native-oracle-setup/review`,{method:'POST',headers:{...headers,'content-type':'application/json'},
      body:JSON.stringify({agentPublicKey:agent,ownerPublicKey:ownerKey}),signal:AbortSignal.timeout(25_000)});
    const review=await reviewResponse.json();
    if(!reviewResponse.ok || review.signing_authorized!==false || review.transaction_sent!==false || review.review?.owner!==OWNER ||
       review.review?.vault!==VAULT || review.review?.per_tx_cap_yocto!=='100000000000000000000000')throw FAIL();
    await mark('SERVING_TESTNET_ONLY');
    console.log(`Read-only FINAL-block preflight passed at height ${readiness.block_height}; the testnet preview is reachable. No wallet prompt or transaction was initiated by the server.`);
    const ended=await Promise.race([delay(45*60_000,null,{ref:false}).then(()=>null),tunnel.exit,webExit]);
    if(ended!==null)throw FAIL();
    await mark('EXPIRED');return;
  }
  const ended=await Promise.race([delay(45*60_000,null,{ref:false}).then(()=>null),tunnel.exit]);
  if(ended!==null)throw FAIL();await mark('EXPIRED');
}
async function cleanup(){if(web)web.kill('SIGTERM');if(tunnel?.child)tunnel.child.kill('SIGTERM');await close(placeholder);await close(service);await pool?.end().catch(()=>{})}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void cleanup().finally(()=>process.exit(1))});
main().then(()=>cleanup()).catch(()=>{console.error(`::error title=Testnet preview stopped::${ROLE??'unknown'} phase=${phase}; stop and reconcile any existing wallet original.`);void cleanup().finally(()=>{process.exitCode=1})});
