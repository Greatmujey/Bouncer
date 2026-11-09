// One public probe of the actual Railway site using a dummy, probe-only
// journal row. Never connects a wallet, signs, or sends a NEAR transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {RAILWAY_WEB_ORIGIN} from '../agent/railway-standby-web.mjs';

const playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!playwright)throw Error('Playwright path required');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('Chromium unavailable');
const endpoint='https://itzqbvbpmbnimvpyaige.supabase.co/functions/v1/bouncer-direct-one-shot';
const rpc='https://rpc.testnet.near.org';
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const report={top_level:false,workspace:false,standby_notice:false,journal_read:false,
  dummy_original_retained:false,rpc_cors:false,meteor_adapter:false,meteor_handoff:false,no_wallet:true,no_transaction:true};
const diagnostics={meteor_requests:0,meteor_status:0,meteor_failure:'',browser_errors:[]};
let error,stage='initialization',page;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36'});
  await context.addInitScript(()=>{
    window.__bouncerOpenCalls=[];
    window.open=url=>{window.__bouncerOpenCalls.push(String(url));return {closed:false,focus(){},close(){this.closed=true},postMessage(){},addEventListener(){},removeEventListener(){}}};
  });
  page=await context.newPage();
  page.on('request',req=>{if(req.url().includes('/storage/meteor-near-connect-latest.js'))diagnostics.meteor_requests++});
  page.on('response',response=>{if(response.url().includes('/storage/meteor-near-connect-latest.js'))diagnostics.meteor_status=response.status()});
  page.on('requestfailed',req=>{if(req.url().includes('/storage/meteor-near-connect-latest.js'))diagnostics.meteor_failure=req.failure()?.errorText||'failed'});
  page.on('pageerror',e=>diagnostics.browser_errors.push(String(e.message).slice(0,150)));
  page.on('console',m=>{if(m.type()==='error')diagnostics.browser_errors.push(m.text().slice(0,150))});
  // Only the dummy journal and read-only status RPC may receive POST requests.
  // No app code can broadcast a transaction or reach a wallet via this probe.
  await page.route('**/*',async route=>{
    const req=route.request(),url=req.url(),method=req.method();
    if(['GET','HEAD','OPTIONS'].includes(method))return route.continue();
    if(method==='POST'&&url===endpoint) {
      try {const body=req.postDataJSON();if(body.capability==='s'.repeat(43)&&['read','claim','retain'].includes(body.operation))return route.continue()}catch{}
    }
    // Chromium canonicalizes the origin-only RPC URL to a trailing slash.
    if(method==='POST'&&url===`${rpc}/`) {
      try {if(req.postDataJSON()?.method==='status')return route.continue()}catch{}
    }
    return route.abort();
  });
  stage='workspace';
  const loaded=await page.goto(`${RAILWAY_WEB_ORIGIN}/workspace?probe=live`,{waitUntil:'domcontentloaded',timeout:60000});
  assert.equal(loaded?.status(),200);
  report.top_level=await page.evaluate(()=>window===window.top);
  report.workspace=await page.getByRole('heading',{name:'Welcome to Bouncer.'}).count()===1;
  report.standby_notice=await page.getByText('Temporary Railway testnet site.',{exact:false}).count()===1;
  assert.ok(report.top_level&&report.workspace&&report.standby_notice);

  stage='retained dummy journal';
  const result=await page.evaluate(async endpoint=>{
    const response=await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',headers:{'content-type':'application/json'},
      body:JSON.stringify({operation:'read',capability:'s'.repeat(43)}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,body:await response.json()};
  },endpoint);
  report.journal_read=result.status===200&&result.body.scope==='probe'&&result.body.state==='retained';
  report.dummy_original_retained=result.body.original_hash==='1'.repeat(32);
  assert.ok(report.journal_read&&report.dummy_original_retained);

  stage='testnet RPC';
  const rpcResult=await page.evaluate(async rpc=>{
    const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'railway-cors',method:'status',params:[]}),signal:AbortSignal.timeout(20000)});
    return {status:response.status,body:await response.json()};
  },rpc);
  report.rpc_cors=rpcResult.status===200&&rpcResult.body.id==='railway-cors'&&rpcResult.body.result?.chain_id==='testnet';
  assert.ok(report.rpc_cors);

  stage='Meteor adapter';
  await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled,null,{timeout:30000});
  await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
  const frame=page.frameLocator('iframe').first();
  const mobile=frame.getByRole('button',{name:/^Meteor Mobile/});
  await mobile.waitFor({state:'visible',timeout:30000});
  await mobile.evaluate(el=>new Promise((resolve,reject)=>{
    if(!el.disabled)return resolve();const o=new MutationObserver(()=>{if(!el.disabled){o.disconnect();resolve()}});
    o.observe(el,{attributes:true,attributeFilter:['disabled','aria-busy']});setTimeout(()=>{o.disconnect();reject(Error('mobile option unavailable'))},15000);
  }));
  report.meteor_adapter=diagnostics.meteor_status===200;
  await mobile.click();await page.waitForFunction(()=>window.__bouncerOpenCalls?.length>0,null,{timeout:20000});
  report.meteor_handoff=await page.evaluate(()=>window.__bouncerOpenCalls.some(s=>{
    try {const u=new URL(s);return u.origin==='https://wallet.meteorwallet.app'||['meteorwallet:','meteorwalletdev:'].includes(u.protocol)}catch{return false}
  }));
  assert.ok(report.meteor_adapter&&report.meteor_handoff);
  await context.close();
} catch(e){
  error=`${stage}: ${String(e?.message||'probe failed').slice(0,300)}`;
  if(page) try {
    diagnostics.page=await page.evaluate(()=>({
      wallet_status:document.querySelector('#wallet-status')?.textContent?.slice(0,300),
      dialog_status:document.querySelector('#wallet-dialog-status')?.textContent?.slice(0,300),
      popup:document.querySelector('.hot-connector-popup')?.innerText?.slice(0,300),
      frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,src:f.getAttribute('src')?.split('?')[0],sandbox:f.getAttribute('sandbox')})),
    }));
    diagnostics.frame_text=await Promise.all(page.frames().slice(1,5).map(f=>f.evaluate(()=>document.body?.innerText?.slice(0,400)).catch(()=>'')));
  } catch { /* Diagnostics are best-effort and contain no wallet data. */ }
}
finally{await browser.close()}
console.log(`::${error?'error':'notice'} title=Live Railway dummy browser probe::${JSON.stringify({...report,error,...(error?{diagnostics}:{} )}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(error)process.exitCode=1;
