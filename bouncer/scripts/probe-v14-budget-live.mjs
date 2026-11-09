// One live, public, view-only check of the deployed Railway vault-cost UI.
// No wallet, owner signature, key, checkpoint, journal or transaction is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!playwright)throw Error('Playwright path required');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('Chromium unavailable');
const site='https://bouncer-production-6df1.up.railway.app',owner='great_mujey.testnet',vault=`native.${owner}`;
const circle='3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const rpcOrigins=new Set(['https://rpc.testnet.near.org','https://test.rpc.fastnear.com']);
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const report={hosted_workspace:false,public_account_view:false,read_only_budget:false,no_wallet:true,no_transaction:true};
const diagnostics={methods:[],blocked:[],failed:[]};let error,stage='initialization',page;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,
    userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36'});
  page=await context.newPage();
  page.on('requestfailed',req=>{try{const u=new URL(req.url());if(rpcOrigins.has(u.origin))diagnostics.failed.push(`${req.method()} ${u.origin}: ${req.failure()?.errorText||'failed'}`)}catch{}});
  await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),method=req.method();
    if(['GET','HEAD','OPTIONS'].includes(method))return route.continue();
    if(method==='POST'&&rpcOrigins.has(u.origin)) {
      try {
        const body=req.postDataJSON(),params=body?.params,action=body?.method;
        let allowed=['status','block','gas_price','EXPERIMENTAL_protocol_config'].includes(action);
        if(action==='query')allowed=(params?.account_id===owner&&['view_account','view_access_key_list'].includes(params.request_type))||
          (params?.account_id===vault&&params.request_type==='view_account')||
          (params?.account_id===circle&&params.request_type==='call_function'&&params.method_name==='ft_balance_of');
        if(allowed){diagnostics.methods.push(action);return route.continue()}
      }catch{}
    }
    diagnostics.blocked.push(`${method} ${u.origin}${u.pathname}`);return route.abort();
  });
  stage='workspace';
  const response=await page.goto(`${site}/workspace?budget-probe=1`,{waitUntil:'domcontentloaded',timeout:60000});
  assert.equal(response?.status(),200);report.hosted_workspace=true;
  await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="near-cli"]').disabled,null,{timeout:30000});
  stage='public account view';
  await page.locator('.top-connect').click();await page.locator('[data-wallet-id="near-cli"]').click();
  await page.locator('#wallet-account-id').fill(owner);await page.locator('#wallet-account-submit').click();
  await page.waitForFunction(()=>document.querySelector('#wallet-status').textContent.includes('Viewing great_mujey.testnet'));
  report.public_account_view=true;
  await page.evaluate(()=>{location.hash='#guardrails';});
  await page.locator('#vault-tools-title').waitFor({state:'visible'});
  await page.locator('[data-route-view="guardrails"] .workspace-advanced > summary').click();
  await page.locator('#wallet-bootstrap-budget-open').click();
  stage='public budget read';
  await page.locator('#wallet-bootstrap-budget-refresh').click();
  await page.waitForFunction(()=>{
    const text=document.querySelector('#wallet-bootstrap-budget-status')?.textContent||'';
    return text.includes('No transaction was authorized or sent')||text.includes('Could not obtain a fresh testnet review');
  },null,{timeout:45000});
  const status=await page.locator('#wallet-bootstrap-budget-status').innerText();
  const review=await page.locator('#wallet-bootstrap-budget-result').textContent();
  report.read_only_budget=/No transaction was authorized or sent/i.test(status)&&/Example vault transfer: 6 test NEAR \(not approved\)/i.test(review||'');
  assert.ok(report.read_only_budget,`Budget review unavailable: ${status}`);
  assert.equal(diagnostics.blocked.length,0);
  report.no_transaction=true;report.no_wallet=true;
  await context.close();
}catch(e){
  error=`${stage}: ${String(e?.message||'probe failed').slice(0,250)}`;
  if(page)try{diagnostics.status=await page.locator('#wallet-bootstrap-budget-status').textContent()}catch{}
}finally{await browser.close()}
console.log(`::${error?'error':'notice'} title=Live read-only V14 budget UI::${JSON.stringify({...report,error,...(error?{diagnostics}:{})}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(error)process.exitCode=1;
