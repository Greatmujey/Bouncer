// Exercise only a dummy probe row from the actual candidate's top-level
// browser origin. This does not connect a wallet, sign, or send anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const id=process.env.CSB_CANDIDATE_ID,playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!/^[a-z0-9]{4,20}$/.test(id||'')||!playwright)throw Error('Candidate ID and Playwright required');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('Chromium unavailable');
const origin=`https://${id}.csb.app`,browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const report={top_level:false,read:false,claim_once:false,retained:false,no_wallet:true,no_transaction:true};let error;
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();await page.goto(`${origin}/`,{waitUntil:'domcontentloaded',timeout:60000});
  const trust=page.getByText('Yes, proceed to preview',{exact:true});
  if(await trust.count()&&await trust.first().isVisible()){await trust.first().click();await page.waitForLoadState('domcontentloaded');}
  await page.waitForSelector('#wallet-dialog',{state:'attached',timeout:30000});
  report.top_level=await page.evaluate(()=>window===window.top);
  const result=await page.evaluate(async()=>{
    const endpoint='https://itzqbvbpmbnimvpyaige.supabase.co/functions/v1/bouncer-direct-one-shot',capability='q'.repeat(43);
    const call=async(operation,extra={})=>{
      const response=await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',headers:{'content-type':'application/json'},
        body:JSON.stringify({operation,capability,...extra}),signal:AbortSignal.timeout(20000)});
      return {status:response.status,body:await response.json()};
    };
    const read=await call('read'),claim=await call('claim'),again=await call('claim'),retain=await call('retain',{original_hash:'1'.repeat(32)});
    return {read,claim,again,retain};
  });
  report.read=result.read.status===200&&result.read.body.scope==='probe'&&result.read.body.state==='ready';
  report.claim_once=result.claim.status===200&&result.claim.body.claim_acquired===true&&
    result.again.status===200&&result.again.body.claim_acquired===false;
  report.retained=result.retain.status===200&&result.retain.body.state==='retained'&&result.retain.body.original_hash==='1'.repeat(32);
  assert.ok(report.top_level&&report.read&&report.claim_once&&report.retained);
  await context.close();
}catch(e){error=String(e?.message||'browser check failed').slice(0,250)}
finally{await browser.close()}
console.log(`::${error?'error':'notice'} title=Live browser dummy journal::${JSON.stringify({...report,error}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(error)process.exitCode=1;
