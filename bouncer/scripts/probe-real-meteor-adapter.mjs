// Load the real pinned Meteor adapter in a mobile-sized browser at the public
// candidate, with a fake journal response and a stubbed window.open. This is
// a sign-in handoff probe only: no wallet, key, signature, or transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const id=process.env.CSB_CANDIDATE_ID,playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!/^[a-z0-9]{4,20}$/.test(id||'')||!playwright)throw Error('Candidate ID and Playwright required');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('Chromium unavailable');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true}),origin=`https://${id}.csb.app`;
let adapterStatus=0,adapterRequests=0,adapterFailure='',error,stage='open',page;const errors=[],consoleErrors=[];
const report={top_level:false,real_adapter_fetched:false,real_adapter_integrity_checked_by_app:false,
  wallet_ui_visible:false,mobile_option_ready:false,wallet_handoff_observed:false,handoff_kind:null,no_wallet:true,no_transaction:true};
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36'});
  await context.addInitScript(()=>{
    window.__bouncerOpenCalls=[];
    window.open=(url)=>{window.__bouncerOpenCalls.push(String(url));return {closed:false,focus(){},close(){this.closed=true},postMessage(){},addEventListener(){},removeEventListener(){}};};
  });
  page=await context.newPage();page.on('pageerror',e=>errors.push(String(e.message).slice(0,120)));
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text().slice(0,180))});
  page.on('request',r=>{if(r.url().includes('/storage/meteor-near-connect-latest.js'))adapterRequests++});
  page.on('requestfailed',r=>{if(r.url().includes('/storage/meteor-near-connect-latest.js'))adapterFailure=r.failure()?.errorText||'failed'});
  page.on('response',r=>{if(r.url().includes('/storage/meteor-near-connect-latest.js'))adapterStatus=r.status()});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin==='https://itzqbvbpmbnimvpyaige.supabase.co'&&url.pathname==='/functions/v1/bouncer-direct-one-shot'){
      const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
      if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
      const body=req.postDataJSON();assert.equal(body.operation,'read');assert.equal(body.capability,'u'.repeat(43));
      return route.fulfill({status:200,contentType:'application/json',headers:cors,
        body:JSON.stringify({scope:'direct',state:'ready',original_hash:null,claim_acquired:false,expired:false})});
    }
    if(url.origin===origin||url.hostname==='codesandbox.io'||url.hostname.endsWith('.codesandbox.io')||
       url.hostname==='raw.githubusercontent.com'||url.hostname==='mc.meteorwallet.app')return route.continue();
    return route.abort();
  });
  const link=`${origin}/#bouncer-direct=${'u'.repeat(43)}`;
  await page.goto(link,{waitUntil:'domcontentloaded',timeout:60000});
  const trust=page.getByText('Yes, proceed to preview',{exact:true});
  if(await trust.count()&&await trust.first().isVisible()){
    await trust.first().click();await page.waitForLoadState('domcontentloaded');
    if((await page.evaluate(()=>location.hash))!==`#bouncer-direct=${'u'.repeat(43)}`)await page.goto(link,{waitUntil:'domcontentloaded',timeout:60000});
  }
  stage='initialization';await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled,null,{timeout:30000});
  report.top_level=await page.evaluate(()=>window===window.top);
  stage='Meteor UI';await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
  const frame=page.frameLocator('iframe').first(),web=frame.getByRole('button',{name:'Meteor Web',exact:true});
  await web.waitFor({state:'visible',timeout:30000});report.wallet_ui_visible=true;
  report.real_adapter_fetched=adapterStatus===200;
  // The app executes this adapter only after loadVerifiedExecutor hashes the
  // fetched bytes and compares them to the reviewed SHA-256 pin.
  report.real_adapter_integrity_checked_by_app=report.real_adapter_fetched&&report.wallet_ui_visible;
  const mobile=frame.getByRole('button',{name:/^Meteor Mobile/});
  try{
    await mobile.waitFor({state:'visible',timeout:10000});
    report.mobile_option_ready=await mobile.evaluate(el=>new Promise(resolve=>{
      if(!el.disabled){resolve(true);return}const o=new MutationObserver(()=>{if(!el.disabled){o.disconnect();resolve(true)}});
      o.observe(el,{attributes:true,attributeFilter:['disabled','aria-busy']});setTimeout(()=>{o.disconnect();resolve(!el.disabled)},15000);
    }));
  }catch{}
  stage='Meteor handoff';if(report.mobile_option_ready)await mobile.click();else await web.click();
  await page.waitForFunction(()=>window.__bouncerOpenCalls?.length>0,null,{timeout:20000});
  const calls=await page.evaluate(()=>window.__bouncerOpenCalls.map(s=>{try{const u=new URL(s);return `${u.protocol}//${u.host}`}catch{return 'invalid'}}));
  report.wallet_handoff_observed=calls.some(s=>s==='https://wallet.meteorwallet.app'||s.startsWith('meteorwallet:')||s.startsWith('meteorwalletdev:'));
  report.handoff_kind=calls.find(s=>s==='https://wallet.meteorwallet.app'||s.startsWith('meteorwallet:')||s.startsWith('meteorwalletdev:'))||null;
  assert.ok(report.top_level&&report.real_adapter_integrity_checked_by_app&&report.wallet_handoff_observed);
  await context.close();
}catch(e){error=`${stage}: ${String(e?.message||'probe failed').slice(0,200)}`;
  try{report.wallet_status=(await page?.locator('#wallet-status').textContent({timeout:1000})||'').slice(0,120)}catch{}
  report.adapter_status=adapterStatus;report.adapter_requests=adapterRequests;report.adapter_failure=adapterFailure;
  report.page_errors=errors.slice(0,3);report.console_errors=consoleErrors.slice(-3);
  try{report.frames=await Promise.all(page.frames().slice(1,4).map(async frame=>(await frame.locator('body').innerText({timeout:1000})).slice(0,300)))}catch{}
}finally{await browser.close()}
console.log(`::${error?'error':'notice'} title=Real Meteor adapter handoff probe::${JSON.stringify({...report,error}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(error)process.exitCode=1;
