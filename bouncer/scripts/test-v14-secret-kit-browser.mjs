// Local-only synthetic crypto round-trip at desktop and phone viewport sizes.
// No real account, wallet, journal, secret, chain or remote service is used.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { build } from 'esbuild';
import { buildV14PhoneResearchPlan } from '../agent/native-v14-phone-plan.mjs';
import { fixture,scope } from '../tests/v14-witness-fixture.mjs';

const browserPath=process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(browserPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/chromium'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const compiled=await build({stdin:{contents:[
  "export * from './web-src/v14-secret-recovery-kit.mjs';",
  "export * from './web-src/v14-checkpoint-enrollment.mjs';",
  "export * from './web-src/v14-checkpoint-enrollment-kit.mjs';",
  "export * from './web-src/v14-checkpoint-kit-recovery.mjs';",
  "export * from './web-src/v14-checkpoint-kit-client.mjs';",
  "export { nep413Payload } from './web-src/cli-login.mjs';",
].join('\n'),resolveDir:process.cwd(),sourcefile:'synthetic-kit-browser-entry.mjs'},bundle:true,format:'iife',globalName:'BouncerSyntheticKit',
  platform:'browser',target:'es2020',write:false});
const {inputs}=fixture(),ownerKey=nearApi.KeyPair.fromRandom('ed25519'),pairs=Object.fromEntries(['compute','price','store'].map(id=>[id,nearApi.KeyPair.fromRandom('ed25519')]));
inputs.ownerPublicKey=String(ownerKey.getPublicKey());
inputs.agentPublicKeys=Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,String(pair.getPublicKey())]));
const review=buildV14PhoneResearchPlan(inputs).review,capability=randomBytes(32).toString('hex');
const rawOwner=nearApi.utils.serialize.base_decode(ownerKey.toString().replace(/^ed25519:/,''));
const ownerPkcs8=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(rawOwner.slice(0,32))]).toString('base64');
const synthetic={review,ownerPkcs8,trustedReviewSha256:review.review_sha256,scopeId:scope,
  capabilitySha256:createHash('sha256').update(capability).digest('hex'),capability,witnessJournalKey:randomBytes(32).toString('hex'),
  missionJournalKey:randomBytes(32).toString('hex'),restrictedAgentKeys:Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,pair.toString()])),
  passphrase:'synthetic-unicode-🔒-passphrase'};
const origin='https://bouncer-near.vercel.app';
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
try {
  for(const width of [1280,390]) {
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600}),page=await context.newPage();
    const errors=[],unexpected=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      if(route.request().url()===`${origin}/`)return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic recovery test</title>'});
      unexpected.push(route.request().url());return route.abort('failed');
    });
    await page.goto(`${origin}/`);await page.addScriptTag({content:compiled.outputFiles[0].text});
    const result=await page.evaluate(async input=>{
      const api=window.BouncerSyntheticKit;
      const envelope=await api.sealV14SecretKit(input);
      const opened=await api.openV14SecretKit({...input,envelope});
      let rejected=false;
      try {await api.openV14SecretKit({...input,envelope,passphrase:'wrong-but-long-test-passphrase'});}catch {rejected=true;}
      return {secure:window.isSecureContext,capability:opened.capability===input.capability,
        witness:opened.witness_journal_key===input.witnessJournalKey,mission:opened.mission_journal_key===input.missionJournalKey,
        agents:JSON.stringify(opened.restricted_agent_keys)===JSON.stringify(input.restrictedAgentKeys),
        encrypted:!JSON.stringify(envelope).includes(input.capability),wrong_password_rejected:rejected};
    },synthetic);
    assert.deepEqual(result,{secure:true,capability:true,witness:true,mission:true,agents:true,encrypted:true,wrong_password_rejected:true});
    const enrollment=await page.evaluate(async input=>{
      const api=window.BouncerSyntheticKit,owner=input.review.owner,ownerPublicKey=input.review.owner_public_key,vault=input.review.vault;
      const original=await api.prepareV14Enrollment({owner,ownerPublicKey,vault,reviewSha256:input.review.review_sha256});
      const sealed=await api.sealV14SecretKit({...input,scopeId:original.terms.scope_id,capability:original.capability,
        capabilitySha256:original.terms.capability_sha256});
      const draft=await api.prepareV14KitEnrollment({draft:original,envelope:sealed,review:input.review,
        trustedReviewSha256:input.review.review_sha256,passphrase:input.passphrase});
      const pkcs8=Uint8Array.from(atob(input.ownerPkcs8),c=>c.charCodeAt(0));
      const privateKey=await crypto.subtle.importKey('pkcs8',pkcs8,{name:'Ed25519'},false,['sign']);
      let signatures=0,saved;
      const wallet={async signMessage({signerId,message,nonce,recipient}){
        signatures++;const digest=await crypto.subtle.digest('SHA-256',api.nep413Payload({message,nonce,recipient}));
        const sig=new Uint8Array(await crypto.subtle.sign('Ed25519',privateKey,digest));
        return {accountId:signerId,publicKey:ownerPublicKey,signature:btoa(String.fromCharCode(...sig))};
      }};
      const fetch=async(url,options)=>{
        const body=JSON.parse(options.body);
        if(url==='https://test.rpc.fastnear.com')return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{permission:'FullAccess'}}));
        if(url===api.V14_KIT_ENROLLMENT_ENDPOINT) {
          const att=JSON.stringify({terms:body.terms,nonce_base64:body.nonce_base64,signature_base64:body.signature_base64});
          saved={status:'EXISTING_ENCRYPTED_KIT',scope_id:body.terms.scope_id,review_sha256:body.terms.review_sha256,
            capability_sha256:body.terms.capability_sha256,kit_sha256:body.terms.kit_sha256,sealed_kit:body.sealed_kit,
            attestation_sha256:await api.v14KitSha256(crypto,att),owner_attestation:att};
          return new Response(JSON.stringify({status:'ENROLLED_WITH_KIT',scope_id:saved.scope_id,revision:0,head_sha256:'0'.repeat(64),
            kit_sha256:saved.kit_sha256,attestation_sha256:saved.attestation_sha256}));
        }
        if(url===api.V14_KIT_RECOVERY_ENDPOINT)return new Response(JSON.stringify({...saved,wallet_transaction_authorized:false,journal_restored:false}));
        throw Error('unexpected synthetic request');
      };
      const signed=await api.signV14KitEnrollment({draft,wallet,location,fetch});
      const client=api.createV14KitClient({location,fetch});
      const created=await client.enroll(signed);
      const recovery=api.prepareV14KitRecovery({owner,ownerPublicKey,vault});
      const signedRead=await api.signV14KitRecovery({draft:recovery,wallet,location,fetch});
      const read=await client.read(signedRead,{review:input.review,scopeId:original.terms.scope_id,
        trustedReviewSha256:input.review.review_sha256});
      const opened=await api.openV14SecretKit({envelope:read.envelope,review:input.review,trustedReviewSha256:input.review.review_sha256,
        scopeId:read.scope_id,capabilitySha256:read.capability_sha256,passphrase:input.passphrase});
      return {created:created.status==='ENROLLED_WITH_KIT',sameCapability:opened.capability===original.capability,
        signatures,notRestored:read.journal_restored===false,noSpend:read.wallet_transaction_authorized===false};
    },synthetic);
    assert.deepEqual(enrollment,{created:true,sameCapability:true,signatures:2,notRestored:true,noSpend:true});
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await context.close();
  }
  console.log('Synthetic V14 encrypted key kit passed on desktop and phone-sized Chromium; no external network or wallet.');
} finally {await browser.close()}
