// Mobile-sized Chromium, a real non-extractable WebCrypto key and fabricated
// setup/owner/witness data. All requests are intercepted: no actual wallet,
// testnet RPC, independent checkpoint, transaction broadcast or provider call.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';
import { nativeSetupAuthAction } from '../web-src/native-oracle-setup-auth.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';

const bundle=(await build({stdin:{contents:
  "export {createNativeOracleSetupClient} from './web-src/native-oracle-setup-client.mjs';\n"+
  "export {openNativeOracleDeviceKey} from './web-src/native-oracle-device-key.mjs';\n"+
  "export {prepareWitnessedNativeOracleTrial} from './web-src/witnessed-native-oracle-trial.mjs';",
  resolveDir:process.cwd(),sourcefile:'synthetic-witnessed-native-phone.mjs'},bundle:true,format:'esm',platform:'browser',
  target:['es2020'],write:false})).outputFiles[0].text;
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const origin='https://4173-synthetic.e2b.app',owner='great_mujey.testnet',vault=`native.${owner}`;
const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n)),wasm=fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url));
const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
try {
  for(const {width,drop} of [{width:390,drop:false},{width:320,drop:true}]) {
    const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();
    const errors=[],requests=[],challenges=new Map();page.on('pageerror',e=>errors.push(e.message));
    const pair=generateKeyPairSync('ed25519'),privatePkcs8=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${nearApi.utils.serialize.base_encode(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    let review,identity,claimed=null,sequence=0;const initialHead='c'.repeat(40),trialHead='d'.repeat(40),blockTime=Date.now();
    const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value),headers:{'cache-control':'no-store'}});
    const common=purpose=>({purpose,owner,ownerPublicKey:publicKey,identity});
    function challenge(ctx) {
      const action=nativeSetupAuthAction(ctx),digest=createHash('sha256').update(JSON.stringify(action)).digest('hex');
      const issued=Date.now(),expires=issued+120_000,id=(++sequence).toString(16).padStart(32,'0'),nonce=Buffer.alloc(32,sequence);
      const labels={verify_native_setup_completion:'Verify native setup originals and state',claim_native_oracle_trial:'Retain original native trial hash'};
      const result={challenge_id:id,nonce_base64:nonce.toString('base64'),recipient:new URL(origin).host,expires_at_ms:expires,
        message:`Bouncer testnet owner authentication\n${labels[ctx.purpose]}\nAccount: ${owner}\nPublic key: ${publicKey}\n`+
          `Action SHA-256: ${digest}\nSite: ${origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n`+
          'This message is not a transaction and does not itself approve spending.'};
      challenges.set(id,{action,result,used:false});return result;
    }
    function authenticate(evidence,ctx) {
      const saved=challenges.get(evidence?.challenge_id);assert(saved && !saved.used);
      assert.deepEqual(saved.action,nativeSetupAuthAction(ctx));assert.equal(evidence.accountId,owner);assert.equal(evidence.publicKey,publicKey);
      const payload=nep413Payload({message:saved.result.message,nonce:new Uint8Array(Buffer.from(saved.result.nonce_base64,'base64')),
        recipient:saved.result.recipient});
      const digest=createHash('sha256').update(payload).digest();
      assert.equal(verifySignature(null,digest,pair.publicKey,Buffer.from(evidence.signature,'base64')),true);saved.used=true;
    }
    function completion() {
      return {version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',stage_id:'verify_native_setup_completion',
        owner,vault,review_sha256:review.review_sha256,independently_witnessed:true,witness_head:claimed?trialHead:initialHead,
        execution_authorized:false,signing_authorized:false,transaction_sent:false,owner_approval_obtained:false,wallet_prompt_authorized:false,
        prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],checks:{...checks},blockers:[],observed_at:new Date().toISOString(),
        block_hash:hash(9),block_height:100,block_timestamp_nanosec:(BigInt(blockTime)*1_000_000n).toString(),agent_key_nonce:'77'};
    }
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());requests.push(`${req.method()} ${url.origin}${url.pathname}`);
      if(url.origin==='https://test.rpc.fastnear.com')return route.fulfill({status:req.method()==='OPTIONS'?204:200,contentType:'application/json',
        headers:{'access-control-allow-origin':'*','access-control-allow-headers':'content-type','access-control-allow-methods':'POST,OPTIONS'},
        body:req.method()==='OPTIONS'?'':JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}})});
      if(url.origin!==origin)return route.abort();
      if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic witnessed native phone</title>'});
      if(url.pathname==='/synthetic-client.mjs')return route.fulfill({status:200,contentType:'text/javascript',body:bundle});
      if(url.pathname==='/api/native-oracle-setup/completion-challenge')return json(route,challenge(common('verify_native_setup_completion')));
      if(url.pathname==='/api/native-oracle-setup/completion'){
        authenticate(req.postDataJSON().evidence,common('verify_native_setup_completion'));return json(route,completion());
      }
      if(url.pathname==='/api/native-oracle-setup/trial-challenge'){
        const input=req.postDataJSON();if(claimed)return json(route,{error:'WITNESS_NOT_CLAIMABLE'},409);
        assert.deepEqual(input.identity,identity);assert.equal(input.expectedWitnessHead,initialHead);
        assert.equal(input.trial.goal_sha256,createHash('sha256').update(JSON.stringify(input.goal)).digest('hex'));
        const tx=nearApi.transactions.createTransaction(owner,nearApi.utils.PublicKey.from(review.agent_public_key),vault,78n,
          [nearApi.transactions.functionCall('execute_outlayer_native_project',{policy_id:review.policy_id,amount:review.per_tx_cap_yocto,
            expected_route:input.goal.route},300n*10n**12n,0n)],Buffer.alloc(32,9));
        assert.equal(input.trial.original_hash,nearApi.utils.serialize.base_encode(createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest()));
        return json(route,challenge({...common('claim_native_oracle_trial'),trial:input.trial,expectedWitnessHead:initialHead}));
      }
      if(url.pathname==='/api/native-oracle-setup/trial'){
        const input=req.postDataJSON();assert.equal(claimed,null);assert.equal(input.expectedWitnessHead,initialHead);
        authenticate(input.evidence,{...common('claim_native_oracle_trial'),trial:input.trial,expectedWitnessHead:initialHead});
        authenticate(input.completionEvidence,common('verify_native_setup_completion'));claimed=structuredClone(input.trial);
        if(drop)return route.abort('failed');
        return json(route,{status:'TRIAL_ORIGINAL_WITNESSED',owner,operation_id:identity.operation_id,review_sha256:review.review_sha256,
          ...claimed,witness_head:trialHead,independently_witnessed:true,do_not_retry:true,execution_authorized:false,transaction_sent:false});
      }
      return route.fulfill({status:404,body:'blocked synthetic route'});
    });
    await page.goto(`${origin}/`);
    const created=await page.evaluate(async({owner,vault})=>{window.__m=await import('/synthetic-client.mjs');
      window.__keys=await window.__m.openNativeOracleDeviceKey({indexedDB,storage:{persisted:async()=>true},crypto,origin:location.origin,isTopLevel:true});
      return window.__keys.create({owner,vault});},{owner,vault});
    review=buildNativeOracleWalletPlan({wasmBytes:wasm,terms:{owner,vault,policy_id:'price',agent_public_key:created.public_key,
      per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',vault_deposit_yocto:'100000000000000000000000',
      agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
    identity={owner,owner_public_key:publicKey,operation_id:'1'.repeat(32),review_sha256:review.review_sha256,
      stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
    const result=await page.evaluate(async({owner,publicKey,privatePkcs8,review,identity})=>{
      let ownerMessages=0,transactions=0;
      const wallet={manifest:{id:'near-mobile'},async signMessage(p){ownerMessages++;
        const e=new TextEncoder(),m=e.encode(p.message),r=e.encode(p.recipient),payload=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(payload.buffer);
        let i=0;v.setUint32(i,0x80000000+413,true);i+=4;v.setUint32(i,m.length,true);i+=4;payload.set(m,i);i+=m.length;
        payload.set(p.nonce,i);i+=32;v.setUint32(i,r.length,true);i+=4;payload.set(r,i);i+=r.length;payload[i]=0;
        const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(privatePkcs8),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',payload),signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:owner,publicKey,signature:btoa(String.fromCharCode(...signature))}},
        async signAndSendTransaction(){transactions++;throw Error('unexpected wallet transaction')}};
      const client=window.__m.createNativeOracleSetupClient({wallet,accountId:owner,ownerPublicKey:publicKey,deviceStore:window.__keys,
        location,crypto,isCurrent:()=>true,isTopLevel:true,relay:({work})=>work()});
      const prepared=await window.__m.prepareWitnessedNativeOracleTrial({client,deviceStore:window.__keys,identity,review,
        goalId:'native-oracle-trial-1',origin:location.origin,isTopLevel:true,crypto,isCurrent:()=>true});
      let refusal=false,error='',output=null,again=false;
      try{await prepared.sign({ownerConfirmed:false})}catch{refusal=true}
      try{const signed=await prepared.sign({ownerConfirmed:true});output={tx_hash:signed.tx_hash,status:signed.status,
        transaction_sent:signed.transaction_sent,bytes:Array.from(signed.signed_transaction)}}catch(e){error=e.code||e.message}
      try{await prepared.sign({ownerConfirmed:true})}catch{again=true}
      const local=await window.__keys.inspectNativeOracleOriginal({reviewSha256:review.review_sha256});window.__keys.close();
      return {terms:prepared.terms,refusal,error,output,again,ownerMessages,transactions,local};
    },{owner,publicKey,privatePkcs8,review,identity});
    assert.equal(result.refusal,true);assert.equal(result.again,true);assert.equal(result.transactions,0);
    assert.equal(result.terms.maximum_native_yocto,review.per_tx_cap_yocto);assert.equal(result.terms.transaction_sent,false);
    assert.deepEqual(result.terms.project,review.project);assert.equal(result.terms.rolling_day_cap_yocto,review.daily_cap_yocto);
    assert.equal(result.terms.gas_limit,'300000000000000');assert.equal(result.terms.refund_destination,owner);
    assert.ok(claimed);assert.deepEqual(errors,[]);
    if(drop){assert.equal(result.error,'NATIVE_SETUP_RESULT_UNKNOWN');assert.equal(result.output,null);
      assert.equal(result.local.status,'NO_LOCAL_ORIGINAL');assert.equal(result.ownerMessages,3)}
    else{assert.equal(result.error,'');assert.equal(result.output.status,'SIGNED_NOT_BROADCAST');assert.equal(result.output.transaction_sent,false);
      assert.equal(result.output.tx_hash,claimed.original_hash);assert.equal(result.local.record.tx_hash,claimed.original_hash);assert.equal(result.ownerMessages,4);
      const tx=nearApi.transactions.SignedTransaction.decode(Uint8Array.from(result.output.bytes));
      const digest=createHash('sha256').update(nearApi.transactions.encodeTransaction(tx.transaction)).digest();
      assert.equal(nearApi.utils.serialize.base_encode(digest),claimed.original_hash);
      assert.equal(nearApi.utils.PublicKey.from(review.agent_public_key).verify(digest,Uint8Array.from(tx.signature.ed25519Signature.data)),true)}
    assert.ok(requests.every(r=>r.includes(origin)||r.includes('https://test.rpc.fastnear.com')));await context.close();
  }
  console.log('Chromium phone flow: synthetic owner authentication, witness-before-signing and lost-response recovery passed; no broadcast.');
} finally {await browser.close()}
