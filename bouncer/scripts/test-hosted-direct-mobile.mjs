// Mobile-sized browser exercise of the hosted public candidate. The Meteor
// executor, journal and RPC are synthetic; no real wallet or transaction is
// used. The separately checked hosted bundle is patched only to accept the
// synthetic executor digest during this test.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encodeBase58} from '../web-src/native-oracle-transaction.mjs';
import {WALLET_EXECUTOR_SHA256} from '../web-src/wallet-executor.mjs';
import {DIRECT_VERSION,DIRECT_PROJECT,DIRECT_UUID,DIRECT_DEPOSIT} from '../web-src/direct-outlayer-testnet.mjs';
const id=process.env.CSB_CANDIDATE_ID,playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!/^[a-z0-9]{4,20}$/.test(id||'')||!playwright)throw Error('Candidate ID and Playwright are required');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('Chromium unavailable');
const origin=`https://${id}.csb.app`,dummy='t'.repeat(43),original=encodeBase58(new Uint8Array(32).fill(7)),block=encodeBase58(new Uint8Array(32).fill(9));
const source={WasmUrl:{url:`https://wasmhub.testnet.fastfs.io/fastfs.testnet/${DIRECT_VERSION}.wasm`,hash:DIRECT_VERSION,build_target:'wasm32-wasip2'}};
const mock=`window.selector.ready({
 async signIn(p){if(p.network!=='testnet'||p.addFunctionCallKey)throw Error('wrong login');return [{accountId:'great_mujey.testnet'}]},
 async signOut(){},async getAccounts(){return [{accountId:'great_mujey.testnet'}]},
 async signAndSendTransaction(p){
  if(p.network!=='testnet'||p.signerId!=='great_mujey.testnet'||p.receiverId!=='outlayer.testnet'||
   p.actions?.length!==1||p.actions[0]?.type!=='FunctionCall'||p.actions[0]?.params?.methodName!=='request_execution'||
   p.actions[0]?.params?.deposit!=='${DIRECT_DEPOSIT}'||p.actions[0]?.params?.gas!=='300000000000000')throw Error('wrong synthetic action');
  console.log('BOUNCER_SYNTHETIC_WALLET_CALLED');return {transaction:{hash:'${original}'},transaction_outcome:{id:'${original}'}}
 }
});`;
const bundle=fs.readFileSync(fileURLToPath(new URL('../web/wallet.bundle.js',import.meta.url)),'utf8'),
  pinned=WALLET_EXECUTOR_SHA256['meteor-wallet'],digest=createHash('sha256').update(mock).digest('hex');
assert.equal(bundle.split(pinned).length,2);
let phase='ready',retained=null,claims=0,walletCalls=0,externalScripts=0;
const report={trust_prompt:false,fragment_lost:false,reopened_same_link:false,csp_blocked:false,top_level:false,
  mocked_meteor_connected:false,read_only_review:false,mock_attempt_once:false,original_retained:false,no_real_transaction:true};
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
let error,stage='open',page;
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  await context.addInitScript(()=>Object.defineProperty(navigator,'storage',{value:{persist:async()=>false,persisted:async()=>false},configurable:true}));
  page=await context.newPage();
  page.on('console',msg=>{if(msg.text()==='BOUNCER_SYNTHETIC_WALLET_CALLED')walletCalls++});
  const json=(route,value,extra={})=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value),
    headers:{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type',...extra}});
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin==='https://codesandbox.io' && /(?:sse-hooks|banner\.|watermark-button\.)/.test(url.pathname)){
      externalScripts++;return route.fulfill({status:200,contentType:'text/javascript',body:'window.__thirdPartyInjectedScriptRan=true;'});
    }
    if(url.origin===origin && url.pathname==='/wallet.bundle.js')return route.fulfill({status:200,contentType:'text/javascript',body:bundle.replace(pinned,digest)});
    if(url.hostname==='raw.githubusercontent.com'&&url.pathname.endsWith('/meteor-near-connect-latest.js'))
      return route.fulfill({status:200,contentType:'text/javascript',body:mock,headers:{'access-control-allow-origin':'*'}});
    if(url.origin==='https://itzqbvbpmbnimvpyaige.supabase.co'&&url.pathname==='/functions/v1/bouncer-direct-one-shot'){
      if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}});
      const request=req.postDataJSON();assert.equal(request.capability,dummy);let won=false;
      if(request.operation==='claim'&&phase==='ready'){phase='claimed';claims++;won=true;}
      if(request.operation==='retain'){assert.equal(request.original_hash,original);phase='retained';retained=original;}
      return json(route,{scope:'direct',state:phase,original_hash:retained,claim_acquired:won,expired:false});
    }
    if(url.origin==='https://rpc.testnet.near.org'){
      if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':origin,
        'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}});
      const q=req.postDataJSON();let result;
      if(q.method==='status')result={chain_id:'testnet'};
      else if(q.method==='block')result={header:{hash:block,height:123,timestamp_nanosec:String(BigInt(Date.now())*1000000n)}};
      else if(q.method==='EXPERIMENTAL_protocol_config')result={chain_id:'testnet',runtime_config:{storage_amount_per_byte:'10000000000000000000'}};
      else if(q.method==='query'){
        if(q.params.request_type==='view_account')result={block_hash:block,amount:'22000000000000000000000000',storage_usage:1024};
        else if(q.params.request_type==='view_access_key_list')result={block_hash:block,keys:[{access_key:{permission:'FullAccess'}}]};
        else {const value=q.params.method_name==='get_project'?{project_id:DIRECT_PROJECT,uuid:DIRECT_UUID,owner:'zavodil2.testnet'}:
          q.params.method_name==='get_version'?{wasm_hash:DIRECT_VERSION,source}:null;
          result={block_hash:block,result:[...Buffer.from(JSON.stringify(value))]};}
      }else throw Error(`Unexpected RPC method: ${q.method}`);
      return json(route,{jsonrpc:'2.0',id:q.id,result});
    }
    // The synthetic test never calls a live wallet, wallet endpoint, or chain.
    if(url.hostname==='test.rpc.fastnear.com'||url.hostname==='archival-rpc.testnet.near.org')return route.abort();
    if(url.origin===origin||url.hostname==='codesandbox.io'||url.hostname.endsWith('.codesandbox.io'))return route.continue();
    return route.abort();
  });
  const link=`${origin}/#bouncer-direct=${dummy}`;
  await page.goto(link,{waitUntil:'domcontentloaded',timeout:60000});
  const trust=page.getByText('Yes, proceed to preview',{exact:true});
  if(await trust.count()&&await trust.first().isVisible()){
    report.trust_prompt=true;await trust.first().click();await page.waitForLoadState('domcontentloaded');
    report.fragment_lost=(await page.evaluate(()=>location.hash))!==`#bouncer-direct=${dummy}`;
    if(report.fragment_lost){await page.goto(link,{waitUntil:'domcontentloaded',timeout:60000});report.reopened_same_link=true;}
  }
  await page.waitForSelector('#wallet-dialog',{state:'attached',timeout:30000});
  report.top_level=await page.evaluate(()=>window===window.top);
  const probe=await page.evaluate(async()=>{
    window.__inlineCspProbe=false;const script=document.createElement('script');script.textContent='window.__inlineCspProbe=true';document.head.append(script);
    await new Promise(resolve=>setTimeout(resolve,100));
    return {inlineRan:window.__inlineCspProbe,thirdPartyRan:window.__thirdPartyInjectedScriptRan===true,
      policy:document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content||''};
  });
  report.csp_blocked=!probe.inlineRan&&!probe.thirdPartyRan&&probe.policy.includes("script-src 'self'")&&externalScripts===0;
  assert.equal(report.top_level,true);assert.equal(report.csp_blocked,true);
  stage='wallet initialization';
  await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled,null,{timeout:30000});
  stage='synthetic Meteor connect';await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
  await page.waitForFunction(()=>document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'),null,{timeout:30000});
  report.mocked_meteor_connected=true;assert.equal(claims,0);assert.equal(walletCalls,0);
  stage='direct review';await page.locator('.top-connect').click();await page.locator('#wallet-direct-outlayer-open').waitFor({state:'visible',timeout:15000});
  await page.locator('#wallet-direct-outlayer-open').click();
  await page.locator('#wallet-direct-outlayer-send').waitFor({state:'visible',timeout:20000});
  const terms=await page.locator('#wallet-direct-outlayer-panel').innerText();
  assert.match(terms,/0\.1 test NEAR/);assert.match(terms,/bypasses Bouncer’s firewall/);
  report.read_only_review=claims===0&&walletCalls===0;assert.equal(report.read_only_review,true);
  stage='synthetic one-shot';await page.locator('#wallet-direct-outlayer-send').click();
  await page.waitForFunction(()=>!document.querySelector('#wallet-direct-outlayer-hash').hidden,null,{timeout:20000});
  report.mock_attempt_once=claims===1&&walletCalls===1;report.original_retained=retained===original;
  assert.equal(report.mock_attempt_once,true);assert.equal(report.original_retained,true);
  assert.equal(await page.locator('#wallet-direct-outlayer-send').isVisible(),false);
  assert.match(await page.locator('#wallet-direct-outlayer-hash').innerText(),new RegExp(original));
  await context.close();
}catch(e){
  error=`${stage}: ${String(e?.message||'browser check failed').slice(0,250)}`;
  try{report.wallet_status=(await page?.locator('#wallet-status').textContent({timeout:1000})||'').slice(0,180)}catch{}
  try{report.direct_status=(await page?.locator('#wallet-direct-outlayer-status').textContent({timeout:1000})||'').slice(0,180)}catch{}
}
finally{await browser.close();}
const encoded=JSON.stringify({...report,error}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D');
console.log(`::${error?'error':'notice'} title=Hosted synthetic mobile wallet::${encoded}`);
if(error)process.exitCode=1;
