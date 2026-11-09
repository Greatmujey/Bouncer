// Desktop/phone read-only checkpoint UI, synthetic wallet, RPC and database.
// No network transaction, key installation, scope creation or paid call.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { createV14RecoveryHandler } from '../infrastructure/v14-recovery-edge.mjs';
import { V14_CHECKPOINT_RECOVERY_ENDPOINT } from '../web-src/v14-checkpoint-recovery-client.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';
import { PUBLIC_WEB_FILES, stagePublicWeb } from './stage-public-web.mjs';
import { fixture, scope, owner, vault } from '../tests/v14-witness-fixture.mjs';

const web=fileURLToPath(new URL('../web/',import.meta.url));
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const origin='https://bouncer-near.vercel.app',project='https://jiouaqwxkvlkmvyumzwc.supabase.co';
const base58=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),sha=x=>createHash('sha256').update(x).digest('hex');
const allowed=new Set(PUBLIC_WEB_FILES),types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript',
  '.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v14-history-ui-'));
const {binding}=fixture(),lines=[];
function append(type,data) {
  const previous_sha256=lines.length?sha(lines.at(-1)):'0'.repeat(64);
  lines.push(JSON.stringify({format:'bouncer-v14-original-event-v1',seq:lines.length+1,previous_sha256,type,data}));
}
append('reserve',binding);
append('wallet_claim',{stage_id:binding.stages[0].id,action_commitment_sha256:binding.stages[0].action_commitment_sha256});
append('wallet_original',{stage_id:binding.stages[0].id,tx_hash:base58(40)});
append('wallet_verified',{stage_id:binding.stages[0].id,tx_hash:base58(40),final_block_hash:base58(41)});
append('wallet_claim',{stage_id:binding.stages[1].id,action_commitment_sha256:binding.stages[1].action_commitment_sha256});
const snapshot={status:'EXISTING_CHECKPOINT',scope_id:scope,revision:lines.length,head_sha256:sha(lines.at(-1)),events:lines};
try {
  for(const {width,mode} of [{width:1280,mode:'ready'},{width:320,mode:'ready'},{width:390,mode:'corrupt'},{width:390,mode:'off'}]) {
    const siteDir=path.join(staging,`site-${fs.readdirSync(staging).length}`);
    stagePublicWeb(siteDir,web,{walletOrigin:origin,walletConnectProjectId:''});
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,reducedMotion:'reduce'}),page=await context.newPage();
    const errors=[];let signCount=0,edgeReads=0,dbReads=0,resolveReady;
    const readyRequest=new Promise(resolve=>{resolveReady=resolve;});
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.text()==='BOUNCER_SYNTHETIC_READ_ONLY_SIGNATURE')signCount++;});
    const keys=generateKeyPairSync('ed25519'),privatePkcs8=keys.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(keys.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const mock=`window.selector.ready({
      async signIn(p){if(p.network!=='testnet'||p.addFunctionCallKey)throw Error();return [{accountId:'${owner}'}]},
      async signOut(){},async getAccounts(){return [{accountId:'${owner}'}]},
      async signMessage({network,signerId,message,nonce,recipient}){
        if(network!=='testnet'||signerId!=='${owner}')throw Error();console.log('BOUNCER_SYNTHETIC_READ_ONLY_SIGNATURE');
        const e=new TextEncoder(),m=e.encode(message),r=e.encode(recipient),p=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(p.buffer);
        let i=0;v.setUint32(i,0x80000000+413,true);i+=4;v.setUint32(i,m.length,true);i+=4;p.set(m,i);i+=m.length;
        p.set(nonce,i);i+=32;v.setUint32(i,r.length,true);i+=4;p.set(r,i);i+=r.length;p[i]=0;
        const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob('${privatePkcs8}'),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',p),sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:signerId,publicKey:'${publicKey}',signature:btoa(String.fromCharCode(...sig))}},
      async signAndSendTransaction(){throw Error('This test must never request a transaction')}
    });`;
    const bundle=fs.readFileSync(path.join(siteDir,'wallet.bundle.js'),'utf8'),pinned=WALLET_EXECUTOR_SHA256['meteor-wallet'];
    assert(bundle.includes(pinned));const mockDigest=sha(mock);
    const getEnv=key=>({BOUNCER_V14_RECOVERY_ENABLE:mode==='off'?'0':'1',SUPABASE_URL:project,SUPABASE_SERVICE_ROLE_KEY:'synthetic'})[key];
    const upstream=async(url,options)=>{
      const data=JSON.parse(options.body);
      if(url==='https://test.rpc.fastnear.com') {
        const result=data.method==='status'?{chain_id:'testnet'}:data.method==='block'?{header:{hash:base58(7),timestamp_nanosec:String(BigInt(Date.now())*1_000_000n)}}:
          {block_hash:base58(7),permission:'FullAccess'};
        if(data.method==='query')assert.equal(data.params.public_key,publicKey);
        return new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-v14-enrollment',result}));
      }
      if(url===`${project}/rest/v1/rpc/bouncer_v14_owner_inspect_v1`) {
        dbReads++;assert.deepEqual(data,{p_owner_id:owner,p_vault_id:vault});
        return new Response(JSON.stringify(mode==='corrupt'?{...snapshot,head_sha256:'f'.repeat(64)}:snapshot));
      }
      throw Error('unexpected synthetic host');
    };
    const handler=createV14RecoveryHandler({getEnv,fetch:upstream,crypto:webcrypto});
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.endsWith('meteor-near-connect-latest.js'))return route.fulfill({status:200,contentType:'text/javascript',body:mock});
      if(url.origin==='https://test.rpc.fastnear.com') {
        const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const data=req.postDataJSON();assert.equal(data.id,'bouncer-cli-login');
        return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})});
      }
      if(url.href===V14_CHECKPOINT_RECOVERY_ENDPOINT) {
        if(req.method()==='POST')edgeReads++;
        const result=await handler(new Request(url.href,{method:req.method(),headers:{origin,'content-type':'application/json'},
          ...(req.method()==='POST'?{body:req.postData()}: {})}));
        const response={status:result.status,headers:Object.fromEntries(result.headers),body:await result.text()};
        if(req.method()==='GET')resolveReady();
        return route.fulfill(response);
      }
      if(url.origin!==origin)return route.abort('failed');
      if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,contentType:'application/json',body:'{}'});
      const file=url.pathname.slice(1)||'index.html';if(!allowed.has(file))return route.fulfill({status:404,body:'blocked synthetic route'});
      const content=file==='wallet.bundle.js'?bundle.replace(pinned,mockDigest):fs.readFileSync(path.join(siteDir,file));
      return route.fulfill({status:200,contentType:types[path.extname(file)],body:content});
    });
    await page.goto(`${origin}/`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-account-badge').textContent==='OWNER VERIFIED',null,{timeout:10_000});
    assert.equal(await page.locator('#wallet-dialog').evaluate(el=>el.open),false);
    await page.evaluate(()=>{location.hash='#guardrails';});
    await page.locator('#vault-tools-title').waitFor({state:'visible'});
    let readyTimer;
    try { await Promise.race([readyRequest,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(Error('read-only readiness not requested')),10_000);})]); }
    finally { clearTimeout(readyTimer); }
    assert.equal(signCount,1);assert.equal(edgeReads,0);assert.equal(dbReads,0);
    if(mode==='off') {
      assert.equal(await page.locator('#wallet-v14-recovery-open').isVisible(),false);
    } else {
      await page.locator('#wallet-v14-recovery-open').waitFor({state:'visible'});
      await page.locator('#wallet-v14-recovery-open').click();
      assert.equal(await page.locator('#wallet-v14-recovery-vault').inputValue(),vault);
      await page.locator('#wallet-v14-recovery-vault').fill('other.testnet');await page.locator('#wallet-v14-recovery-read').click();
      assert.match(await page.locator('#wallet-v14-recovery-status').textContent(),/No wallet request was made/);
      assert.equal(signCount,1);assert.equal(edgeReads,0);
      await page.locator('#wallet-v14-recovery-vault').fill(vault);await page.locator('#wallet-v14-recovery-read').click();
      if(mode==='corrupt') {
        await page.waitForFunction(()=>document.querySelector('#wallet-v14-recovery-status').textContent.includes('History is unavailable'),null,{timeout:15_000});
        assert.equal(await page.locator('#wallet-v14-recovery-originals a').count(),0);
      } else {
        await page.waitForFunction(()=>document.querySelector('#wallet-v14-recovery-status').textContent.includes('Read 5 retained events'),null,{timeout:15_000});
        const message=await page.locator('#wallet-v14-recovery-status').textContent();
        assert.match(message,/wallet prompt is recorded without an original hash/i);assert.match(message,/never resend an uncertain original/i);
        assert.match(message,/not been independently re-verified/i);
        await page.locator('#wallet-v14-recovery-review summary').click();
        assert.match(await page.locator('#wallet-v14-recovery-review-text').textContent(),/owner\.testnet/);
        assert.equal(await page.locator('#wallet-v14-recovery-originals a').count(),1);
        assert.equal(await page.locator('#wallet-v14-recovery-originals a').getAttribute('href'),`https://testnet.nearblocks.io/txns/${base58(40)}`);
      }
      assert.equal(signCount,2);assert.equal(edgeReads,1);assert.equal(dbReads,1);
    }
    assert.equal(await page.locator('#wallet-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Synthetic V14 desktop/phone read-only recovery: default off, current owner, original link, pending warning and corrupt history passed.');
} finally { await browser.close(); fs.rmSync(staging,{recursive:true,force:true}); }
