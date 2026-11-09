// Desktop and mobile browser tests, synthetic wallet/backend/RPC only. No live send.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { MARKET_SUMMARY_PROGRAM } from '../agent/market-summary.mjs';
import { validateNativeMission } from '../agent/native-mission.mjs';
import { nativeMissionAction, nativeMissionApprovalMessage } from '../web-src/native-mission-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';
import { PUBLIC_WEB_FILES, stagePublicWeb } from './stage-public-web.mjs';

const web=fileURLToPath(new URL('../web/',import.meta.url));
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const defaultOrigin='https://bouncer-near.vercel.app',owner='great_mujey.testnet',vault=`native.${owner}`;
const base58=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
const program={url:'https://example.test/random.wasm',sha256:'a'.repeat(64),build_target:'wasm32-wasip1',max_instructions:10_000_000,max_memory_mb:128,max_execution_seconds:60};
const route={project:{...ORACLE_TESTNET_PROJECT},route_revision:1,policy_revision:1,payee_revision:1,active:true};
const storageRoute={prefix:'mission-',max_value_bytes:4096,route_revision:1,policy_revision:1,payee_revision:1,active:true};
const randomMission=validateNativeMission({version:1,id:'ui-demo',contract_id:vault,owner_account_id:owner,max_native_amount:'3000000000000000000000',
  required_resources:['compute','storage','api'],goals:[
    {kind:'random',goal:{id:'compute',contract_id:vault,owner_account_id:owner,policy_id:'compute',amount:'1000000000000000000000',input:{min:1,max:10},program}},
    {kind:'oracle',goal:{id:'price',contract_id:vault,owner_account_id:owner,policy_id:'price',amount:'1000000000000000000000',route,max_age_seconds:300}},
    {kind:'storage',goal:{id:'store',contract_id:vault,contract_code_hash:base58(42),owner_account_id:owner,policy_id:'store',amount:'1000000000000000000000',
      object_id:'mission-demo',value:{from_goal_ids:['compute','price']},route:storageRoute}},
  ]});
const marketMission=validateNativeMission({version:1,id:'ui-market-demo',contract_id:vault,owner_account_id:owner,max_native_amount:'3000000000000000000000',
  required_resources:['compute','storage','api'],goals:[
    {kind:'oracle',goal:{id:'price',contract_id:vault,owner_account_id:owner,policy_id:'price',amount:'1000000000000000000000',route,max_age_seconds:300}},
    {kind:'market',goal:{id:'compute',contract_id:vault,owner_account_id:owner,policy_id:'compute',amount:'1000000000000000000000',
      input:{from_goal_id:'price',quantity:10},program:MARKET_SUMMARY_PROGRAM}},
    {kind:'storage',goal:{id:'store',contract_id:vault,contract_code_hash:base58(42),owner_account_id:owner,policy_id:'store',amount:'1000000000000000000000',
      object_id:'mission-demo',value:{from_goal_ids:['price','compute']},route:storageRoute}},
  ]});
const sha=x=>createHash('sha256').update(x).digest('hex');
const allowed=new Set(PUBLIC_WEB_FILES),types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript',
  '.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-mission-ui-'));
try {
  for(const {width,mode,origin} of [{width:1280,mode:'market',origin:defaultOrigin}, {width:390,mode:'market',origin:defaultOrigin},
    {width:1280,mode:'success',origin:defaultOrigin},
    {width:390,mode:'success',origin:defaultOrigin},{width:320,mode:'unknown',origin:defaultOrigin},
    {width:390,mode:'blocked',origin:defaultOrigin},{width:390,mode:'recovery-empty',origin:defaultOrigin},
    {width:390,mode:'success',origin:'https://synthetic-bouncer.netlify.app'}]) {
    const mission=mode==='market'?marketMission:randomMission;
    const review={format:'bouncer-native-mission-review-v1',network:'testnet',mission,mission_sha256:sha(JSON.stringify(mission))};
    const siteDir=path.join(staging,`site-${fs.readdirSync(staging).length}`);
    stagePublicWeb(siteDir,web,{walletOrigin:origin,walletConnectProjectId:''});
    const mobile=width<600;
    const context=await browser.newContext({viewport:{width,height:844},isMobile:mobile,hasTouch:mobile,reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
    const keys=generateKeyPairSync('ed25519'),privatePkcs8=keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(keys.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const mock=`window.selector.ready({
      async signIn(p){if(p.network!=='testnet'||p.addFunctionCallKey)throw Error();return [{accountId:'${owner}'}]},
      async signOut(){},async getAccounts(){return [{accountId:'${owner}'}]},
      async signMessage({network,signerId,message,nonce,recipient}){
        if(network!=='testnet'||signerId!=='${owner}')throw Error();
        const e=new TextEncoder(),m=e.encode(message),r=e.encode(recipient),p=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(p.buffer);
        let i=0;v.setUint32(i,0x80000000+413,true);i+=4;v.setUint32(i,m.length,true);i+=4;p.set(m,i);i+=m.length;
        p.set(nonce,i);i+=32;v.setUint32(i,r.length,true);i+=4;p.set(r,i);i+=r.length;p[i]=0;
        const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob('${privatePkcs8}'),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',p),sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:signerId,publicKey:'${publicKey}',signature:btoa(String.fromCharCode(...sig))}}
    });`;
    const bundle=fs.readFileSync(path.join(siteDir,'wallet.bundle.js'),'utf8'),pinned=WALLET_EXECUTOR_SHA256['meteor-wallet'];
    assert(bundle.includes(pinned));const mockDigest=sha(mock);
    let saved, executes=0, recovers=0, challengeCount=0;
    const deliveries = count => mission.goals.slice(0,count).map((item,index)=>({kind:item.kind,goal_id:item.goal.id,
      delivery:{tx_hash:base58(40+index),result:item.kind==='oracle'?{price_usd:2.75}:item.kind==='market'?
        {value_usd_micros:27500000}:{value:'synthetic public object'}}}));
    const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),headers:{'cache-control':'no-store'}});
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());requests.push(`${req.method()} ${url.pathname}`);
      if(url.pathname.endsWith('meteor-near-connect-latest.js'))return route.fulfill({status:200,contentType:'text/javascript',body:mock});
      if(url.origin==='https://test.rpc.fastnear.com') {
        const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const input=req.postDataJSON();
        if(input.id==='bouncer-cli-login')return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})});
        return route.abort('failed');
      }
      if(url.origin==='https://rpc.testnet.near.org' && width===390 && mode==='recovery-empty') {
        const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const input=req.postDataJSON(),base={jsonrpc:'2.0',id:input.id},at=base58(19);
        const fee={send_sir:100000000,send_not_sir:100000000,execution:100000000};
        const actions={create_account_cost:fee,transfer_cost:fee,add_key_cost:{full_access_cost:fee},deploy_contract_cost:fee,
          deploy_contract_cost_per_byte:fee,function_call_cost:fee,function_call_cost_per_byte:fee,delete_key_cost:fee};
        let result,error;
        if(input.method==='status')result={chain_id:'testnet'};
        else if(input.method==='block')result={header:{hash:at,height:123,timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};
        else if(input.method==='EXPERIMENTAL_protocol_config')result={chain_id:'testnet',protocol_version:90,runtime_config:{
          storage_amount_per_byte:'10000000000000000000',min_gas_purchase_price:'1000000000',account_creation_charge:'7000000000000000000000',
          transaction_costs:{action_receipt_creation_config:fee,action_creation_config:actions}}};
        else if(input.method==='gas_price')result={gas_price:'100000000'};
        else if(input.method==='query' && input.params.account_id===vault)error={cause:{name:'UNKNOWN_ACCOUNT',
          info:{requested_account_id:vault,block_hash:at}}};
        else if(input.method==='query' && input.params.request_type==='view_account')result={block_hash:at,code_hash:'11111111111111111111111111111111',
          amount:'26000000000000000000000000',storage_usage:264};
        else if(input.method==='query' && input.params.request_type==='view_access_key_list')result={block_hash:at,keys:[{public_key:'synthetic',access_key:{permission:'FullAccess'}}]};
        else return route.abort('failed');
        return route.fulfill({status:200,contentType:'application/json',headers:cors,body:JSON.stringify({...base,...(error?{error}:{result})})});
      }
      if(url.origin!==origin)return route.abort('failed');
      if(url.pathname==='/api/google-session')return json(route,{error:'not configured'},503);
      if(url.pathname==='/api/native-mission/config')return json(route,{enabled:true,network:'testnet',review});
      if(url.pathname.startsWith('/api/native-mission/')) {
        const name=url.pathname.split('/').pop(),input=req.postDataJSON();assert.equal(input.missionSha256,review.mission_sha256);
        if(name==='preview')return json(route,{review,preview:{status:['blocked','recovery-empty'].includes(mode)?'BLOCKED':'READY',stage:'synthetic',
          ...(mode==='market'?{next_goal_id:mission.goals[executes]?.goal.id??null,verified_prior_deliveries:deliveries(executes)}:{})}});
        if(name==='challenge') {
          assert.equal(input.ownerPublicKey,publicKey);challengeCount++;
          if(mode==='market')assert.equal(input.goalId,mission.goals[executes].goal.id);
          const action=nativeMissionAction({owner,ownerPublicKey:publicKey,vault,missionId:mission.id,missionSha256:review.mission_sha256,
            maxNativeYocto:mission.max_native_amount,...(mode==='market'?{goalId:input.goalId,goalMaxNativeYocto:mission.goals[executes].goal.amount}:{})});
          const issued=Date.now(),expires=issued+120_000,id=String(challengeCount).padStart(32,'0'),nonce=Buffer.alloc(32,challengeCount);
          const challenge={challenge_id:id,nonce_base64:nonce.toString('base64'),recipient:new URL(origin).host,expires_at_ms:expires,
            message:nativeMissionApprovalMessage(action,sha(JSON.stringify(action)),origin,issued,expires)};
          saved={challenge,nonce,used:false};return json(route,challenge);
        }
        if(name==='execute') {
          assert(saved&&!saved.used);assert.equal(input.ownerPublicKey,publicKey);assert.equal(input.evidence.challenge_id,saved.challenge.challenge_id);
          assert.equal(input.evidence.accountId,owner);assert.equal(input.evidence.publicKey,publicKey);
          const payload=nep413Payload({message:saved.challenge.message,nonce:new Uint8Array(saved.nonce),recipient:saved.challenge.recipient});
          assert.equal(verify(null,createHash('sha256').update(payload).digest(),keys.publicKey,Buffer.from(input.evidence.signature,'base64')),true);
          if(mode==='market')assert.equal(input.goalId,mission.goals[executes].goal.id);
          saved.used=true;executes++;if(mode==='unknown')return route.abort('failed');
          if(mode==='market')return json(route,{status:executes<3?'CHECKPOINT':'FULFILLED',new_payments:1,
            ...(executes<3?{remaining_goal_ids:mission.goals.slice(executes).map(x=>x.goal.id)}:{}),deliveries:deliveries(executes),note:'Synthetic test only.'});
          return json(route,{status:'FULFILLED',new_payments:3,deliveries:[],note:'Synthetic test only.'});
        }
        if(name==='originals')return json(route,mode==='recovery-empty'?{status:'NO_LOCAL_ORIGINALS',originals:[]}:
          {status:'LOCAL_ORIGINALS',originals:[{goal_id:'compute',kind:'random',status:'pending',original_hash:base58(43)}]});
        if(name==='recover'){recovers++;if(mode==='unknown')return json(route,{error:'synthetic receipt unavailable'},409);
          return json(route,{status:'RECOVERED',new_payments:0,deliveries:[]});}
        return json(route,{error:'unavailable'},404);
      }
      const file=url.pathname.slice(1)||'index.html';if(!allowed.has(file))return route.fulfill({status:404,body:'blocked test route'});
      const content=file==='wallet.bundle.js'?bundle.replace(pinned,mockDigest):fs.readFileSync(path.join(siteDir,file));
      return route.fulfill({status:200,contentType:types[path.extname(file)],body:content});
    });
    await page.goto(`${origin}/`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'));
    await page.locator('.top-connect').click();await page.locator('#wallet-owner-verify').click();
    try { await page.waitForFunction(()=>document.querySelector('#wallet-account-badge').textContent==='OWNER VERIFIED',null,{timeout:10_000}); }
    catch(error){console.error('Synthetic owner verification:',await page.locator('#wallet-owner-status').textContent(),errors,requests.slice(-12));throw error;}
    if(width===390 && mode==='recovery-empty') {
      await page.locator('#wallet-bootstrap-budget-open').click();
      await page.locator('#wallet-bootstrap-budget-refresh').click();
      await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-budget-result').textContent.includes('Example vault transfer: 6 test NEAR'));
      assert.match(await page.locator('#wallet-bootstrap-budget-status').innerText(),/no transaction was authorized or sent/i);
      // The checkpoint endpoint is deliberately unreachable in this browser
      // rehearsal. Offline recovery can still be opened and a malformed file
      // is rejected without another wallet signature or any transaction.
      await page.locator('#wallet-bootstrap-recovery-open').click();
      assert.equal(await page.locator('#wallet-bootstrap-recovery-read').isDisabled(),true);
      assert.match(await page.locator('#wallet-bootstrap-recovery-status').innerText(),/online recovery is not enabled/i);
      await page.locator('#wallet-bootstrap-recovery-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{}')});
      await page.locator('#wallet-bootstrap-recovery-import').click();
      await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-recovery-status').textContent.includes('file is invalid'));
      assert.equal(await page.locator('#wallet-bootstrap-recovery-backup').isVisible(),false);
      assert.equal(executes,0);assert.equal(challengeCount,0);
    }
    await page.locator('#wallet-native-mission-open').waitFor({state:'visible'});await page.locator('#wallet-native-mission-open').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-native-mission-details') && !document.querySelector('#wallet-native-mission-details').hidden);
    assert.match(await page.locator('#wallet-native-mission-panel').innerText(),/public NEAR contract state/i);
    assert.match(await page.locator('#wallet-native-mission-summary').innerText(),/maximum.*test NEAR plus gas/i);
    await page.locator('#wallet-native-mission-details summary').click();
    assert.match(await page.locator('#wallet-native-mission-manifest').innerText(),/"from_goal_ids"/);
    assert.equal(executes,0);assert.equal(challengeCount,0);
    if(['blocked','recovery-empty'].includes(mode)) {
      await page.waitForFunction(()=>document.querySelector('#wallet-native-mission-status').textContent.includes('Mission blocked'));
      assert.equal(await page.locator('#wallet-native-mission-approve').isVisible(),false);
      if(mode==='recovery-empty') {
        await page.locator('#wallet-native-mission-recover').click();
        await page.waitForFunction(()=>document.querySelector('#wallet-native-mission-status').textContent.includes('No local original was found'));
        assert.match(await page.locator('#wallet-native-mission-status').innerText(),/does not prove a transaction was never sent/i);
        assert.equal(recovers,0);assert.equal(executes,0);assert.equal(challengeCount,0);
      }
    } else {
      await page.locator('#wallet-native-mission-approve').waitFor({state:'visible'});
      assert.equal(await page.locator('#wallet-native-mission-approve').isDisabled(),true);
      await page.locator('#wallet-native-mission-consent').check();await page.locator('#wallet-native-mission-approve').click();
      if(mode==='market') {
        for(const [index,next] of ['compute','store'].entries()) {
          await page.waitForFunction(goal=>document.querySelector('#wallet-native-mission-status').textContent.includes(`Next step: ${goal}`),next,{timeout:15_000});
          assert.equal(executes,index+1);assert.equal(challengeCount,index+1);
          assert.equal(await page.locator('#wallet-native-mission-receipts a').count(),index+1);
          assert.match(await page.locator('#wallet-native-mission-receipts a').first().getAttribute('href'),/^https:\/\/testnet\.nearblocks\.io\/txns\//);
          await page.locator('#wallet-native-mission-consent').check();await page.locator('#wallet-native-mission-approve').click();
        }
      }
      await page.waitForFunction(()=>/FULFILLED|uncertain/.test(document.querySelector('#wallet-native-mission-status').textContent),null,{timeout:15_000});
      assert.equal(executes,mode==='market'?3:1);assert.equal(challengeCount,mode==='market'?3:1);
      assert.equal(await page.locator('#wallet-native-mission-approve').isVisible(),false);
      await page.locator('#wallet-native-mission-recover').click();
      if(mode==='unknown') {
        await page.waitForFunction(()=>document.querySelector('#wallet-native-mission-status').textContent.includes('Original receipts are unavailable'));
        assert.match(await page.locator('#wallet-native-mission-status').innerText(),new RegExp(base58(43)));
      } else await page.waitForFunction(()=>document.querySelector('#wallet-native-mission-status').textContent.includes('RECOVERED'));
      assert.equal(executes,mode==='market'?3:1);assert.equal(challengeCount,mode==='market'?3:1);assert.equal(recovers,1);
    }
    assert.equal(await page.locator('#wallet-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Synthetic desktop and mobile mission UI: per-step checkpoints, blocked preflight, unknown response, no-key recovery and empty-original warning passed.');
} finally { await browser.close(); fs.rmSync(staging,{recursive:true,force:true}); }
