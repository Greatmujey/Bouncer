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
import {inflateRawSync} from 'node:zlib';
import {buildV14PhoneResearchPlan} from '../agent/native-v14-phone-plan.mjs';
import {deriveV14OriginalBinding} from '../agent/v14-original-witness.mjs';
import {V14_TESTNET_ARTIFACT} from '../shared/v14-testnet-artifact.mjs';
import {V14_PHONE_RESEARCH_ARTIFACTS as pinnedArtifacts} from '../shared/v14-phone-research-artifacts.mjs';
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
  "export * from './web-src/v14-phone-wallet-plan.mjs';",
  "export * from './web-src/v14-phone-wallet-prompt.mjs';",
  "export * from './web-src/v14-setup-read-client.mjs';",
].join('\n'),resolveDir:process.cwd(),sourcefile:'synthetic-browser-original-entry.mjs'},bundle:true,format:'iife',
  globalName:'BouncerSyntheticOriginal',platform:'browser',target:'es2020',write:false});
const {inputs}=fixture();
inputs.loaderWasm=fs.readFileSync('web/artifacts/v14-research-loader.wasm');
inputs.compressed=fs.readFileSync('web/artifacts/v14-research.deflate');
inputs.vaultWasm=inflateRawSync(inputs.compressed,{maxOutputLength:V14_TESTNET_ARTIFACT.bytes});
inputs.trustedArtifacts={vault_sha256:pinnedArtifacts.vault_sha256,loader_sha256:pinnedArtifacts.loader_sha256};
inputs.mission.goals.find(item=>item.kind==='storage').goal.contract_code_hash=V14_TESTNET_ARTIFACT.near_code_hash;
const review=buildV14PhoneResearchPlan(inputs).review,
  binding=deriveV14OriginalBinding({...inputs,review,trustedReviewSha256:review.review_sha256,scopeId:scope}),
  key='a'.repeat(64),capability='b'.repeat(64),originalHash=nearApi.utils.serialize.base_encode(Buffer.alloc(32,33));
const digest=value=>createHash('sha256').update(value).digest('hex');
const input={review,scope,owner,vault,key,capability,originalHash,blockHash:nearApi.utils.serialize.base_encode(Buffer.alloc(32,90)),stageId:binding.stages[0].id,
  loaderBase64:Buffer.from(inputs.loaderWasm).toString('base64'),compressedBase64:Buffer.from(inputs.compressed).toString('base64'),
  trustedArtifacts:pinnedArtifacts};
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
    let remote={revision:0,head_sha256:'0'.repeat(64),events:[]},loseNext=false,preflights=0;
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
      if(url===`${origin}/api/native-mission/v14-preflight` && request.method()==='POST') {
        preflights++;const data=request.postDataJSON(),stage=review.stages.find(item=>item.id===data.stageId);
        assert.equal(data.scopeId,scope);assert.equal(request.headers()['x-bouncer-native-mission'],'v1');
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'V14_SETUP_PREFLIGHT_MATCH',network:'testnet',
          owner,vault,stage_id:data.stageId,review_sha256:review.review_sha256,action_commitment_sha256:stage.action_commitment_sha256,
          prior_original_hashes:data.prior.map(item=>item.tx_hash),final_block_hash:input.blockHash,checked_at_ms:Date.now(),
          wallet_transaction_authorized:false,transaction_sent:false})});
      }
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
    const plan=await page.evaluate(async input=>{
      const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
      const checked=await window.BouncerSyntheticOriginal.verifyV14BrowserPhonePlan({review:input.review,
        trustedReviewSha256:input.review.review_sha256,trustedArtifacts:input.trustedArtifacts,
        loaderBytes:bytes(input.loaderBase64),compressedBytes:bytes(input.compressedBase64)});
      return {commitments:checked.stages.map(stage=>stage.action_commitment_sha256),authorized:checked.wallet_prompt_authorized};
    },input);
    assert.deepEqual(plan,{commitments:review.stages.map(stage=>stage.action_commitment_sha256),authorized:false});
    assert.deepEqual(await initialize(page,true),{secure:true,indexedDB:true});
    const first=await page.evaluate(async input=>{
      await window.syntheticWitness.reserve();let walletCalls=0;
      const wallet={manifest:{features:{signAndSendTransaction:true}},async signAndSendTransaction(request){
        walletCalls++;const state=await window.syntheticWitness.inspect();
        if(state.pending?.stage_id!==input.stageId||request.network!=='testnet')throw Error('claim missing');
        throw Error('synthetic wallet closed without a result');
      }};
      const client=await window.BouncerSyntheticOriginal.createV14SetupReadClient({review:input.review,
        trustedReviewSha256:input.review.review_sha256,scopeId:input.scope,location:window.location,isCurrent:()=>true});
      const verifyPreflight=client.preflight;
      const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0));
      const prompt=await window.BouncerSyntheticOriginal.prepareV14PhoneWalletPrompt({review:input.review,
        trustedReviewSha256:input.review.review_sha256,trustedArtifacts:input.trustedArtifacts,
        loaderBytes:bytes(input.loaderBase64),compressedBytes:bytes(input.compressedBase64),scopeId:input.scope,stageId:input.stageId,
        witness:window.syntheticWitness,wallet,verifyPreflight,location:window.location,isTopLevel:true,isCurrent:()=>true});
      const result=await prompt.invoke();
      const record=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('bouncer-v14-browser-witness-v1',1);
        request.onsuccess=()=>{const db=request.result,tx=db.transaction('originals','readonly'),get=tx.objectStore('originals').get(input.scope);
          get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(Error('read failed'))};request.onerror=()=>reject(Error('open failed'));
      });
      const encoded=JSON.stringify(record);
      return {revision:record.revision,encrypted:!encoded.includes(input.review.review_sha256)&&!encoded.includes(input.key)&&!encoded.includes('wallet_claim'),
        walletCalls,walletResult:result.status};
    },input);
    assert.deepEqual(first,{revision:2,encrypted:true,walletCalls:1,walletResult:'WALLET_RESULT_UNKNOWN'});
    assert.equal(preflights,2);assert.equal(remote.revision,2);
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
