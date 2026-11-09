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
const compiled=await build({entryPoints:['web-src/v14-secret-recovery-kit.mjs'],bundle:true,format:'iife',globalName:'BouncerSyntheticKit',
  platform:'browser',target:'es2020',write:false});
const {inputs}=fixture(),pairs=Object.fromEntries(['compute','price','store'].map(id=>[id,nearApi.KeyPair.fromRandom('ed25519')]));
inputs.agentPublicKeys=Object.fromEntries(Object.entries(pairs).map(([id,pair])=>[id,String(pair.getPublicKey())]));
const review=buildV14PhoneResearchPlan(inputs).review,capability=randomBytes(32).toString('hex');
const synthetic={review,trustedReviewSha256:review.review_sha256,scopeId:scope,
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
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await context.close();
  }
  console.log('Synthetic V14 encrypted key kit passed on desktop and phone-sized Chromium; no external network or wallet.');
} finally {await browser.close()}
