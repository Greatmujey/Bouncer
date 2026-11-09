// Real Chromium IndexedDB/WebCrypto with synthetic data and a mock remote CAS.
// Desktop and phone-sized viewports only: not a physical phone or wallet test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import {createV14BrowserOriginalCheckpointHandler} from '../infrastructure/v14-browser-original-checkpoint-edge.mjs';
import {V14_BROWSER_CHECKPOINT_ENDPOINT} from '../web-src/v14-browser-independent-store.mjs';
import {fixture,scope,owner,vault} from '../tests/v14-witness-fixture.mjs';

const browserPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(browserPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/chromium'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const compiled=await build({stdin:{contents:[
  "export * from './web-src/v14-browser-witness-store.mjs';",
  "export * from './web-src/v14-browser-original-witness.mjs';",
  "export * from './web-src/v14-browser-independent-store.mjs';",
].join('\n'),resolveDir:process.cwd(),sourcefile:'synthetic-browser-original-entry.mjs'},bundle:true,format:'iife',
  globalName:'BouncerSyntheticOriginal',platform:'browser',target:'es2020',write:false});
const {review,binding}=fixture(),key='a'.repeat(64),capability='b'.repeat(64),originalHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,33));
const input={review,scope,owner,vault,key,capability,originalHash,stageId:binding.stages[0].id};
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const origin='https://bouncer-near.vercel.app';
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
async function initialize(page,brandNew) {
  return page.evaluate(async ({input,brandNew})=>{
    const api=window.BouncerSyntheticOriginal;
    const remote=api.createV14BrowserIndependentStore({location:window.location,scopeId:input.scope,capability:input.capability});
    const local=await api.createV14BrowserWitnessStore({owner:input.owner,vault:input.vault,scopeId:input.scope,
      journalKeyHex:input.key,initializeBrandNew:brandNew});
    const witness=await api.createV14BrowserOriginalWitness({review:input.review,trustedReviewSha256:input.review.review_sha256,
      scopeId:input.scope,localStore:local,independentStore:remote});
    window.syntheticLocal=local;window.syntheticWitness=witness;
    return {secure:window.isSecureContext,indexedDB:!!window.indexedDB};
  },{input,brandNew});
}
try {
  for(const width of [1280,390]) {
    let remote={revision:0,head_sha256:'0'.repeat(64),events:[]},loseNext=false;
    const project='https://jiouaqwxkvlkmvyumzwc.supabase.co';
    const getEnv=name=>({BOUNCER_V14_BROWSER_CHECKPOINT_ENABLE:'1',SUPABASE_URL:project,
      SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role'})[name];
    const handler=createV14BrowserOriginalCheckpointHandler({getEnv,crypto:webcrypto,fetch:async(url,options)=>{
      assert.equal(url,`${project}/rest/v1/rpc/bouncer_v14_original_checkpoint_v1`);
      const body=JSON.parse(options.body);assert.equal(body.p_capability_hash,digest(capability));
      if(body.p_operation==='append') {
        if(body.p_expected_revision!==remote.revision||body.p_expected_head_sha256!==remote.head_sha256)
          return new Response(JSON.stringify({error:'unavailable'}));
        remote={revision:remote.revision+1,head_sha256:digest(body.p_record),events:[...remote.events,body.p_record]};
      }
      return new Response(JSON.stringify({events:remote.events,head_sha256:remote.head_sha256,revision:remote.revision}));
    }});
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600}),page=await context.newPage();
    const errors=[],unexpected=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const request=route.request(),url=request.url();
      if(url===`${origin}/` && request.method()==='GET')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic original checkpoint</title>'});
      if(url===V14_BROWSER_CHECKPOINT_ENDPOINT && ['POST','OPTIONS'].includes(request.method())) {
        const method=request.method(),body=method==='POST'?request.postData():undefined;
        const forwarded=new Request(url,{method,headers:{...request.headers(),origin},...(body?{body}:{})});
        const response=await handler(forwarded);
        if(loseNext && method==='POST' && JSON.parse(body).operation==='append' && response.ok) {loseNext=false;return route.abort('failed')}
        return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
      }
      unexpected.push(url);return route.abort('failed');
    });
    await page.goto(`${origin}/`);await page.addScriptTag({content:compiled.outputFiles[0].text});
    assert.deepEqual(await initialize(page,true),{secure:true,indexedDB:true});
    const first=await page.evaluate(async input=>{
      await window.syntheticWitness.reserve();await window.syntheticWitness.claimWalletStage(input.stageId);
      const record=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('bouncer-v14-browser-witness-v1',1);
        request.onsuccess=()=>{const db=request.result,tx=db.transaction('originals','readonly'),get=tx.objectStore('originals').get(input.scope);
          get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(Error('read failed'))};request.onerror=()=>reject(Error('open failed'));
      });
      const encoded=JSON.stringify(record);
      return {revision:record.revision,encrypted:!encoded.includes(input.review.review_sha256)&&!encoded.includes(input.key)&&!encoded.includes('wallet_claim')};
    },input);
    assert.deepEqual(first,{revision:2,encrypted:true});assert.equal(remote.revision,2);
    // Navigation/reload preserves the encrypted local record, not a new scope.
    await page.reload();await page.addScriptTag({content:compiled.outputFiles[0].text});await initialize(page,false);
    const restored=await page.evaluate(async input=>{
      const state=await window.syntheticWitness.inspect();let repeated=false;
      try{await window.syntheticWitness.claimWalletStage(input.stageId)}catch{repeated=true}
      return {pending:state.pending,repeated_rejected:repeated,authorized:state.wallet_transaction_authorized};
    },input);
    assert.deepEqual(restored,{pending:{type:'wallet',stage_id:input.stageId,tx_hash:null},repeated_rejected:true,authorized:false});
    // A response lost after an independent commit must not update the local
    // copy or open another prompt; recovery remains blocked on mismatch.
    loseNext=true;
    const stopped=await page.evaluate(async input=>{
      try{await window.syntheticWitness.retainWalletOriginal({stageId:input.stageId,txHash:input.originalHash});return false}catch{return true}
    },input);
    assert.equal(stopped,true);assert.equal(remote.revision,3);
    await page.reload();await page.addScriptTag({content:compiled.outputFiles[0].text});await initialize(page,false);
    assert.equal(await page.evaluate(async()=>{try{await window.syntheticWitness.inspect();return false}catch{return true}}),true);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await context.close();
    console.log(`Encrypted original witness: Chromium ${width}px, restart and lost acknowledgement passed (synthetic only).`);
  }
} finally {await browser.close();}
