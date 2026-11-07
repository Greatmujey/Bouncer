// Phone-sized Chromium tests for the UNMOUNTED native setup client.
// All routes, owner keys, wallet responses, challenges and checkpoint claims
// are synthetic; no live phone, wallet, network RPC, payment or provider used.
import assert from 'node:assert/strict';
import { createHash,generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { baseEncode } from '@near-js/utils';
import { buildNativeOracleWalletPlan,NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';

const entry=await build({stdin:{contents:"export {createNativeOracleSetupClient} from './web-src/native-oracle-setup-client.mjs';\n"+
  "export {openNativeOracleDeviceKey} from './web-src/native-oracle-device-key.mjs';",resolveDir:process.cwd(),sourcefile:'synthetic-native-entry.mjs'},
  bundle:true,format:'esm',platform:'browser',target:['es2020'],write:false});
const bundle=entry.outputFiles[0].text,wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const origin='https://4173-synthetic.e2b.app',owner='great_mujey.testnet',vault=`native.${owner}`,
  taskId='a'.repeat(32),originalHash=baseEncode(Buffer.alloc(32,6)),blockHash=baseEncode(Buffer.alloc(32,9));
try{
  for(const {width,drop} of [{width:390,drop:false},{width:320,drop:true}]){
    const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();
    const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));let review,identity,claimed=false;
    const pair=generateKeyPairSync('ed25519'),privatePkcs8=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${baseEncode(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),headers:{'cache-control':'no-store'}});
    const challenge=ctx=>{
      const digest=createHash('sha256').update(JSON.stringify(nativeSetupAuthAction(ctx))).digest('hex'),issued=Date.now(),expires=issued+120_000;
      const label={reserve_native_setup:`Reserve native setup prompt: ${review.stages[0].id}`,
        claim_native_setup_stage:`Claim one native setup prompt: ${review.stages[0].id}`,
        inspect_native_setup:'Inspect retained native setup'}[ctx.purpose];
      return {challenge_id:'b'.repeat(32),nonce_base64:Buffer.alloc(32,8).toString('base64'),recipient:new URL(origin).host,expires_at_ms:expires,
        message:`Bouncer testnet owner authentication\n${label}\nAccount: ${owner}\nPublic key: ${publicKey}\nAction SHA-256: ${digest}\n`+
          `Site: ${origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n`+
          'This message is not a transaction and does not itself approve spending.'};
    };
    await page.route('**/*',async route=>{
      const req=route.request(),u=new URL(req.url());requests.push(`${req.method()} ${u.origin}${u.pathname}`);
      if(u.origin==='https://test.rpc.fastnear.com')return route.fulfill({status:req.method()==='OPTIONS'?204:200,contentType:'application/json',
        headers:{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'POST,OPTIONS'},
        body:req.method()==='OPTIONS'?'':JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})});
      if(u.origin!==origin)return route.abort();
      if(u.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic native setup client</title>'});
      if(u.pathname==='/synthetic-client.mjs')return route.fulfill({status:200,contentType:'text/javascript',body:bundle});
      if(u.pathname==='/api/native-oracle-setup/config')return json(route,{enabled:true,network:'testnet',owner,ready_for_real_spending:false});
      if(u.pathname==='/api/native-oracle-setup/artifact')return route.fulfill({status:200,contentType:'application/wasm',body:wasm});
      if(u.pathname==='/api/native-oracle-setup/review')return json(route,{task_id:taskId,review,signing_authorized:false,transaction_sent:false});
      if(u.pathname==='/api/native-oracle-setup/reserve-challenge')return json(route,challenge({purpose:'reserve_native_setup',owner,ownerPublicKey:publicKey,review}));
      if(u.pathname==='/api/native-oracle-setup/reserve')return json(route,{status:'RESERVED',identity,execution_authorized:false});
      if(u.pathname==='/api/native-oracle-setup/inspect-challenge')return json(route,challenge({purpose:'inspect_native_setup',owner,ownerPublicKey:publicKey}));
      if(u.pathname==='/api/native-oracle-setup/inspect')return json(route,{status:'WITNESSED',identity,database_stages:[{claimed,original_hash:null}],execution_authorized:false});
      if(u.pathname==='/api/native-oracle-setup/claim-challenge'){
        if(claimed)return json(route,{error:'WITNESS_NOT_CLAIMABLE',do_not_retry_wallet_prompt:true},409);
        return json(route,challenge({purpose:'claim_native_setup_stage',owner,ownerPublicKey:publicKey,identity,stageId:review.stages[0].id}));
      }
      if(u.pathname==='/api/native-oracle-setup/claim'){
        claimed=true;if(drop)return route.abort('failed');
        return json(route,{status:'PROMPT_CLAIMED_NO_HASH',independently_witnessed:true,do_not_retry:true,execution_authorized:false,
          owner,operation_id:identity.operation_id,review_sha256:review.review_sha256,stage_id:review.stages[0].id,
          action_commitment_sha256:review.stages[0].action_commitment_sha256,witness_head:'c'.repeat(40),
          preflight_block_hash:blockHash,preflight_checked_at:new Date().toISOString()});
      }
      return route.fulfill({status:404,body:'blocked synthetic route'});
    });
    await page.goto(`${origin}/`);
    const created=await page.evaluate(async({owner,vault})=>{
      window.__m=await import('/synthetic-client.mjs');
      window.__keys=await window.__m.openNativeOracleDeviceKey({indexedDB,storage:{persisted:async()=>true},crypto,origin:location.origin,isTopLevel:true});
      return window.__keys.create({owner,vault});
    },{owner,vault});
    assert.equal(created.private_key_exportable,false);assert.equal(created.independent_backup_verified,false);
    review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner,vault,policy_id:'price',agent_public_key:created.public_key,
      per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',vault_deposit_yocto:'100000000000000000000000',
      agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
    identity={owner,owner_public_key:publicKey,operation_id:'1'.repeat(32),review_sha256:review.review_sha256,
      stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
    const result=await page.evaluate(async({owner,publicKey,privatePkcs8,review,taskId,originalHash})=>{
      let prompts=0;
      const wallet={manifest:{id:'near-mobile',features:{signAndSendTransaction:true}},async signMessage(p){
        const e=new TextEncoder(),m=e.encode(p.message),r=e.encode(p.recipient),payload=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(payload.buffer);
        let i=0;v.setUint32(i,0x80000000+413,true);i+=4;v.setUint32(i,m.length,true);i+=4;payload.set(m,i);i+=m.length;
        payload.set(p.nonce,i);i+=32;v.setUint32(i,r.length,true);i+=4;payload.set(r,i);i+=r.length;payload[i]=0;
        const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(privatePkcs8),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',payload),signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:owner,publicKey,signature:btoa(String.fromCharCode(...signature))};},
        async signAndSendTransaction(p){prompts++;if(p.signerId!==owner || p.receiverId!==review.vault || p.actions[2].params.code.length!==452675)throw Error('unexpected synthetic action');
          return {transaction:{hash:originalHash}};}};
      const client=window.__m.createNativeOracleSetupClient({wallet,accountId:owner,ownerPublicKey:publicKey,deviceStore:window.__keys,
        location,crypto,isCurrent:()=>true,isTopLevel:true,relay:({work})=>work()});
      const enabled=await client.enabled(),prepared=await client.createReview({agentPublicKey:review.agent_public_key});
      if(prepared.task_id!==taskId)throw Error('unexpected retained synthetic review');
      const {identity}=await client.reserve({taskId:prepared.task_id,review:prepared.review});let result,error;
      try{result=await client.approveStage({identity,review,stageId:review.stages[0].id})}catch(e){error=e.code||e.message}
      const state=await client.inspect();let secondError=null;
      try{await client.approveStage({identity,review,stageId:review.stages[0].id})}catch(e){secondError=e.code||e.message}
      window.__keys.close();return {enabled,result,error,state,prompts,secondError};
    },{owner,publicKey,privatePkcs8,review,taskId,originalHash});
    assert.equal(result.enabled,true);assert.equal(result.state.database_stages[0].claimed,true);
    if(drop){assert.equal(result.error,'NATIVE_SETUP_RESULT_UNKNOWN');assert.equal(result.prompts,0)}
    else{assert.equal(result.result.status,'ORIGINAL_HASH_RETURNED');assert.equal(result.result.original_hash,originalHash);assert.equal(result.prompts,1)}
    assert.equal(result.secondError,'WITNESS_NOT_CLAIMABLE');assert.deepEqual(errors,[]);
    assert.ok(requests.every(r=>r.includes(origin)||r.includes('https://test.rpc.fastnear.com')));
    await context.close();
  }
  console.log('Synthetic mobile-sized Chromium native setup: real local WebCrypto/IndexedDB, fake wallet and backend; lost claim never opened a wallet.');
}finally{await browser.close()}
