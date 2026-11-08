// Mobile-sized UI test with fabricated wallet, authenticated backend and RPC.
// No real phone, wallet, checkpoint, chain transaction or provider is used.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const web=fileURLToPath(new URL('../web/',import.meta.url));
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const owner='great_mujey.testnet',vault=`native.${owner}`;
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const allowed=new Set(PUBLIC_WEB_FILES),types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript',
  '.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
const labels={reserve_native_setup:id=>`Reserve native setup prompt: ${id}`,claim_native_setup_stage:id=>`Claim one native setup prompt: ${id}`,
  record_native_setup_original:id=>`Record native setup original: ${id}`,inspect_native_setup:()=> 'Inspect retained native setup',
  verify_native_setup_completion:()=> 'Verify native setup originals and state',claim_native_oracle_trial:()=> 'Retain original native trial hash'};
try {
  for(const {width,unknown,origin,walletId,blocked} of [
    {width:390,unknown:false,origin:'https://bouncer-near.vercel.app',walletId:'nightly-wallet',blocked:false},
    {width:320,unknown:true,origin:'https://4173-synthetic.e2b.app',walletId:'nightly-wallet',blocked:false},
    {width:390,unknown:false,origin:'https://bouncer-near.vercel.app',walletId:'meteor-wallet',blocked:true},
  ]) {
    const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator,'storage',{value:{persist:async()=>true,persisted:async()=>true},configurable:true}));
    const errors=[],requests=[],challenges=new Map();page.on('pageerror',e=>errors.push(e.message));
    const pair=generateKeyPairSync('ed25519'),privatePkcs8=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const hashes=[1,2,3,4].map(hash);
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
        return {accountId:signerId,publicKey:'${publicKey}',signature:btoa(String.fromCharCode(...sig))}},
      async signAndSendTransaction({network,signerId,actions}){if(network!=='testnet'||signerId!=='${owner}')throw Error();
        const first=actions?.[0],index=first?.type==='CreateAccount'?0:first?.params?.methodName==='set_policy'?1:
          first?.params?.methodName==='deposit_native'?2:first?.type==='AddKey'?3:-1;
        if(index<0)throw Error('unexpected synthetic action');if(${unknown}&&index===0)throw Error('synthetic unknown wallet result');
        return {transaction:{hash:${JSON.stringify(hashes)}[index]}}}
    });`;
    const bundle=fs.readFileSync(path.join(web,'wallet.bundle.js'),'utf8'),digest=createHash('sha256').update(mock).digest('hex'),
      pinned=WALLET_EXECUTOR_SHA256[walletId];assert.ok(bundle.includes(pinned));
    let review=null,identity=null,rows=[],records=[],sequence=0,reserved=false,dropAck=unknown,claims=0,trial=null,sends=0,blockTime=null;
    const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),headers:{'cache-control':'no-store'}});
    const common=purpose=>({purpose,owner,ownerPublicKey:publicKey,identity});
    function challenge(ctx){const action=nativeSetupAuthAction(ctx),actionDigest=createHash('sha256').update(JSON.stringify(action)).digest('hex');
      const issued=Date.now(),expires=issued+120_000,id=(++sequence).toString(16).padStart(32,'0'),nonce=Buffer.alloc(32,sequence);
      const result={challenge_id:id,nonce_base64:nonce.toString('base64'),recipient:new URL(origin).host,expires_at_ms:expires,
        message:`Bouncer testnet owner authentication\n${labels[ctx.purpose](action.stage_id)}\nAccount: ${owner}\nPublic key: ${publicKey}\n`+
          `Action SHA-256: ${actionDigest}\nSite: ${origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n`+
          'This message is not a transaction and does not itself approve spending.'};
      challenges.set(id,{action,result,used:false});return result;}
    function authenticate(evidence,ctx){const saved=challenges.get(evidence?.challenge_id);assert(saved&&!saved.used);
      assert.deepEqual(saved.action,nativeSetupAuthAction(ctx));assert.equal(evidence.accountId,owner);assert.equal(evidence.publicKey,publicKey);
      const payload=nep413Payload({message:saved.result.message,nonce:new Uint8Array(Buffer.from(saved.result.nonce_base64,'base64')),recipient:saved.result.recipient});
      assert.equal(verifySignature(null,createHash('sha256').update(payload).digest(),pair.publicKey,Buffer.from(evidence.signature,'base64')),true);saved.used=true;}
    function completion(){const now=Date.now();blockTime??=now;return {version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',
      stage_id:'verify_native_setup_completion',owner,vault,review_sha256:review.review_sha256,independently_witnessed:true,
      witness_head:(trial?'d':'c').repeat(40),
      execution_authorized:false,signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
      prior_original_hashes:rows.map(row=>row.original_hash),checks:{...checks},blockers:[],observed_at:new Date(now).toISOString(),
      block_hash:hash(9),block_height:100,block_timestamp_nanosec:String(BigInt(blockTime)*1_000_000n),agent_key_nonce:'77'};}
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());requests.push(`${req.method()} ${url.pathname}`);
      if(url.pathname.endsWith(walletId==='meteor-wallet'?'meteor-near-connect-latest.js':'/repository/nightly.js'))
        return route.fulfill({status:200,contentType:'text/javascript',body:mock});
      if(url.origin==='https://test.rpc.fastnear.com')return route.abort('failed');
      if(url.origin==='https://rpc.testnet.near.org'){
        const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS',
          'access-control-allow-headers':'content-type'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const request=req.postDataJSON();
        if(request.method==='status')return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{chain_id:'testnet'}})});
        sends++;assert.equal(request.method,'send_tx');assert.equal(request.params.wait_until,'FINAL');
        assert(trial);const decoded=nearApi.transactions.SignedTransaction.decode(Buffer.from(request.params.signed_tx_base64,'base64'));
        assert.equal(decoded.transaction.signerId,owner);assert.equal(decoded.transaction.receiverId,vault);
        return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{transaction:{hash:trial.original_hash},transaction_outcome:{id:trial.original_hash}}})});
      }
      if(url.origin!==origin)return route.abort();
      if(url.pathname==='/api/google-session')return json(route,{authenticated:false});
      if(url.pathname==='/api/wallet-setup/config')return json(route,{enabled:false,network:'testnet',owner});
      if(url.pathname==='/api/native-oracle-setup/config')return json(route,{enabled:true,network:'testnet',owner,ready_for_real_spending:false,trial_submission_enabled:true});
      if(url.pathname==='/api/read-only/config')return json(route,{relay_url:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read'});
      if(url.pathname==='/api/read-only/pending')return json(route,{jobs:[]});
      if(url.pathname==='/api/read-only/owner-key')return json(route,{full_access:true});
      if(url.pathname==='/api/native-oracle-setup/artifact')return route.fulfill({status:200,contentType:'application/wasm',body:wasm});
      if(url.pathname==='/api/native-oracle-setup/review'){
        const input=req.postDataJSON();review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner,vault,policy_id:'price',agent_public_key:input.agentPublicKey,
          per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',vault_deposit_yocto:'100000000000000000000000',
          agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
        identity={owner,owner_public_key:publicKey,operation_id:'1'.repeat(32),review_sha256:review.review_sha256,
          stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
        rows=identity.stages.map(s=>({...s,claimed:false,original_hash:null}));
        return json(route,{task_id:review.review_sha256,review,signing_authorized:false,transaction_sent:false});
      }
      const name=url.pathname.replace('/api/native-oracle-setup/',''),input=req.method()==='POST'?req.postDataJSON():{};
      if(name==='inspect-challenge')return json(route,challenge(common('inspect_native_setup')));
      if(name==='inspect') {authenticate(input.evidence,common('inspect_native_setup'));return json(route,reserved
        ? {status:'WITNESSED',identity,review,database_stages:rows,witnessed_records:records,execution_authorized:false}
        : {status:'NO_LOCAL_RECORD',execution_authorized:false});}
      if(name==='reserve-challenge')return json(route,challenge({...common('reserve_native_setup'),review}));
      if(name==='reserve') {authenticate(input.evidence,{...common('reserve_native_setup'),review});reserved=true;records.push({event:'reserve'});
        return json(route,{status:'RESERVED_NOT_CLAIMED',identity,witness_head:'c'.repeat(40),execution_authorized:false});}
      if(name==='claim-challenge')return json(route,challenge({...common('claim_native_setup_stage'),stageId:input.stageId}));
      if(name==='claim') {authenticate(input.evidence,{...common('claim_native_setup_stage'),stageId:input.stageId});
        const row=rows.find(r=>r.stage_id===input.stageId);assert(row&&!row.claimed);row.claimed=true;claims++;records.push({event:'claim',stage_id:row.stage_id});
        return json(route,{status:'PROMPT_CLAIMED_NO_HASH',independently_witnessed:true,do_not_retry:true,execution_authorized:false,owner,
          operation_id:identity.operation_id,review_sha256:review.review_sha256,stage_id:row.stage_id,action_commitment_sha256:row.action_commitment_sha256,
          witness_head:'c'.repeat(40),preflight_checked_at:new Date().toISOString(),preflight_block_hash:hash(9)});}
      if(name==='original-challenge')return json(route,challenge({...common('record_native_setup_original'),stageId:input.stageId,originalHash:input.originalHash}));
      if(name==='original') {authenticate(input.evidence,{...common('record_native_setup_original'),stageId:input.stageId,originalHash:input.originalHash});
        const row=rows.find(r=>r.stage_id===input.stageId);assert(row?.claimed&&!row.original_hash);row.original_hash=input.originalHash;
        records.push({event:'original',stage_id:row.stage_id,original_hash:row.original_hash});
        if(dropAck){dropAck=false;return route.abort('failed');}
        return json(route,{status:'ORIGINAL_RECORDED',owner,operation_id:identity.operation_id,stage_id:row.stage_id,original_hash:row.original_hash,
          do_not_retry:true,execution_authorized:false});}
      if(name==='preview-original') {authenticate(input.evidence,common('inspect_native_setup'));const index=rows.findIndex(r=>r.stage_id===input.stageId),row=rows[index];
        assert(row?.claimed);assert.equal(input.originalHash,hashes[index]);return json(route,{status:index===3?'FINAL_LOCAL_ADD_KEY_OUTCOME_MATCH':'FINAL_NATIVE_SETUP_RECEIPT_MATCH',
          stage_id:row.stage_id,tx_hash:input.originalHash,original_recorded:row.original_hash===input.originalHash,execution_authorized:false});}
      if(name==='completion-challenge')return json(route,challenge(common('verify_native_setup_completion')));
      if(name==='completion') {authenticate(input.evidence,common('verify_native_setup_completion'));return json(route,completion());}
      if(name==='trial-challenge')return json(route,challenge({...common('claim_native_oracle_trial'),trial:input.trial,expectedWitnessHead:input.expectedWitnessHead}));
      if(name==='trial') {
        authenticate(input.evidence,{...common('claim_native_oracle_trial'),trial:input.trial,expectedWitnessHead:input.expectedWitnessHead});
        authenticate(input.completionEvidence,common('verify_native_setup_completion'));
        assert.equal(input.expectedWitnessHead,'c'.repeat(40));assert.equal(trial,null);trial=structuredClone(input.trial);
        records.push({event:'trial_claim',...trial});
        return json(route,{status:'TRIAL_ORIGINAL_WITNESSED',owner,operation_id:identity.operation_id,review_sha256:review.review_sha256,
          ...trial,witness_head:'d'.repeat(40),independently_witnessed:true,do_not_retry:true,execution_authorized:false,transaction_sent:false});
      }
      if(name==='preview-trial') {
        authenticate(input.evidence,common('inspect_native_setup'));assert(trial);assert.equal(sends,1);
        return json(route,{status:'FINAL_NATIVE_ORACLE_DELIVERY_MATCH',owner,original_hash:trial.original_hash,do_not_retry:true,
          execution_authorized:false,provider_delivery_verified:true,delivery:{tx_hash:trial.original_hash,provider:review.payee,asset:'NEAR',
            maximum_yocto:review.per_tx_cap_yocto,charged_yocto:'10000000000000000000000',refunded_to_owner_yocto:'90000000000000000000000',
            result:{price_usd:2.75}}});
      }
      const file=url.pathname.slice(1)||'index.html';
      if(!allowed.has(file))return route.fulfill({status:404,body:'blocked synthetic route'});
      const content=file==='wallet.bundle.js'?bundle.replace(pinned,digest):fs.readFileSync(path.join(web,file));
      return route.fulfill({status:200,contentType:types[path.extname(file)],body:content});
    });
    await page.goto(`${origin}/`,{waitUntil:'networkidle'});
    const walletSelector=`[data-wallet-id="${walletId}"]`;
    await page.waitForFunction(id=>!document.querySelector(`[data-wallet-id="${id}"]`).disabled,walletId);
    await page.locator('.top-connect').click();await page.locator(walletSelector).click();
    await page.waitForFunction(()=>document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'));
    await page.locator('.top-connect').click();await page.locator('#wallet-owner-verify').click();
    try { await page.waitForFunction(()=>document.querySelector('#wallet-account-badge').textContent==='OWNER VERIFIED',null,{timeout:10_000}); }
    catch (error) { console.error('Synthetic owner verification:',await page.locator('#wallet-owner-status').textContent(),
      await page.locator('#wallet-status').textContent(),errors,requests.slice(-12)); throw error; }
    await page.locator('#wallet-native-setup-open').waitFor({state:'visible'});await page.locator('#wallet-native-setup-open').click();
    await page.locator('#wallet-native-setup-device').waitFor({state:'visible'});assert.equal(claims,0);
    await page.locator('#wallet-native-setup-device').click();await page.locator('#wallet-native-setup-reserve').waitFor({state:'visible'});
    assert.match(await page.locator('#wallet-native-setup-terms').innerText(),/5\.4 test NEAR.*can remain locked/s);
    assert.match(await page.locator('#wallet-native-setup-terms').innerText(),/0\.1 test NEAR per request/);assert.equal(claims,0);
    await page.locator('#wallet-native-setup-reserve').click();
    if(blocked){
      await page.waitForFunction(()=>document.querySelector('#wallet-native-setup-status').textContent.includes('too large for the Meteor mobile bridge'));
      assert.equal(reserved,false);assert.equal(claims,0);assert.equal(sends,0);
      assert.equal(requests.some(r=>r==='POST /api/native-oracle-setup/reserve-challenge'||r==='POST /api/native-oracle-setup/reserve'),false);
      assert.equal(await page.locator('#wallet-native-setup-approve').isVisible(),false);
      assert.deepEqual(errors,[]);await context.close();continue;
    }
    try { await page.locator('#wallet-native-setup-approve').waitFor({state:'visible',timeout:10_000}); }
    catch(error) { console.error('Synthetic reservation:',await page.locator('#wallet-native-setup-status').textContent(),errors,requests.slice(-15)); throw error; }
    for(let i=0;i<4;i++){
      assert.match(await page.locator('#wallet-native-setup-stage').innerText(),new RegExp(`${i+1} of 4`));
      assert.equal(claims,i);await page.locator('#wallet-native-setup-approve').click();
      if(unknown&&i===0){await page.locator('#wallet-native-setup-recover').waitFor({state:'visible'});
        assert.match(await page.locator('#wallet-native-setup-status').innerText(),/unknown.*do not repeat/i);
        await page.locator('#wallet-native-setup-original').fill(hashes[0]);await page.locator('#wallet-native-setup-recover-original').click();
        await page.locator('#wallet-native-setup-check').waitFor({state:'visible'});assert.equal(claims,1);
        await page.locator('#wallet-native-setup-check').click();}
      try { await page.locator('#wallet-native-setup-receipt').waitFor({state:'visible',timeout:10_000}); }
      catch(error) { console.error('Synthetic stage:',i,await page.locator('#wallet-native-setup-status').textContent(),errors,requests.slice(-18)); throw error; }
      assert.equal(claims,i+1);
      await page.locator('#wallet-native-setup-receipt').click();
      await page.locator(i===3?'#wallet-native-setup-verify':'#wallet-native-setup-approve').waitFor({state:'visible'});
    }
    await page.locator('#wallet-native-setup-verify').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-native-setup-status').textContent.includes('did not buy a resource'));
    assert.equal(claims,4);assert.equal(sends,0);assert.equal(trial,null);
    await page.locator('#wallet-native-trial-review').waitFor({state:'visible'});await page.locator('#wallet-native-trial-review').click();
    await page.locator('#wallet-native-trial-send').waitFor({state:'visible'});
    assert.match(await page.locator('#wallet-native-setup-stage').innerText(),/maximum 0\.1 test NEAR/);
    assert.equal(sends,0);assert.equal(trial,null);await page.locator('#wallet-native-trial-send').click();
    try { await page.locator('#wallet-native-trial-check').waitFor({state:'visible',timeout:15_000}); }
    catch(error) { console.error('Synthetic trial:',await page.locator('#wallet-native-setup-status').textContent(),
      {trialRetained:Boolean(trial),sends},errors,requests.slice(-18)); throw error; }
    assert.equal(sends,1);assert(trial?.original_hash);assert.match(await page.locator('#wallet-native-setup-hash').innerText(),new RegExp(trial.original_hash));
    await page.locator('#wallet-native-trial-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-native-setup-status').textContent.includes('OutLayer receipt verified'));
    assert.match(await page.locator('#wallet-native-setup-status').innerText(),/charged 0\.01 test NEAR, refunded 0\.09/);
    assert.equal(sends,1);assert.equal(await page.locator('#wallet-native-trial-send').isVisible(),false);
    assert.equal(await page.locator('#wallet-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);

    // Reopen without persistent device storage: only authenticated read-only
    // recovery of the witnessed original is available, never another send.
    await page.reload({waitUntil:'networkidle'});
    try { await page.waitForFunction(id=>!document.querySelector(`[data-wallet-id="${id}"]`).disabled ||
      document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'),walletId,{timeout:12_000}); }
    catch(error) { console.error('Synthetic reconnect:',await page.locator('#wallet-status').textContent(),errors,requests.slice(-12));throw error; }
    if(!(await page.locator('#wallet-status').textContent()).includes(owner)){
      await page.locator('.top-connect').click();await page.locator(walletSelector).click();
      await page.waitForFunction(()=>document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'));
    }
    await page.locator('.top-connect').click();await page.locator('#wallet-owner-verify').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-account-badge').textContent==='OWNER VERIFIED');
    await page.evaluate(()=>Object.defineProperty(navigator,'storage',{value:{persist:async()=>false,persisted:async()=>false},configurable:true}));
    await page.locator('#wallet-native-setup-open').waitFor({state:'visible'});await page.locator('#wallet-native-setup-open').click();
    await page.locator('#wallet-native-trial-check').waitFor({state:'visible'});
    assert.match(await page.locator('#wallet-native-setup-status').innerText(),/phone key is unavailable/i);
    assert.match(await page.locator('#wallet-native-setup-hash').innerText(),new RegExp(trial.original_hash));
    assert.equal(await page.locator('#wallet-native-trial-send').isVisible(),false);
    await page.locator('#wallet-native-trial-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-native-setup-status').textContent.includes('OutLayer receipt verified'));
    assert.equal(sends,1);assert.equal(claims,4);assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('Native owner UI: synthetic four-stage/trial/recovery and pre-reservation Meteor size block passed. No live transaction.');
} finally {await browser.close();}
