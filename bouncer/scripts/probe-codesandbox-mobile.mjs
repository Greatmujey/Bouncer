// Mobile-sized browser probe of an existing harmless, public hosting test page.
// Never connects a wallet, signs, or submits any request to NEAR.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const id=process.env.CSB_PROBE_ID || '';
if(!/^[a-z0-9]{4,20}$/i.test(id))throw Error('Invalid public probe ID');
const playwright=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!playwright)throw Error('Missing Playwright path');
const {chromium}=await import(pathToFileURL(path.resolve(playwright)));
const executablePath=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const report={interstitial:false,proceeded:false,top_level:false,script_executed:false,origin_correct:false,
  persistent_requested:false,persistent_granted:false,indexeddb_strict:false,reload_retained:false,fragment_retained:false,
  signed:false,transaction_sent:false};
let error;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();
  const dummyFragment=`#bouncer-direct=${'p'.repeat(43)}`;
  await page.goto(`https://${id}.csb.app/${dummyFragment}`,{waitUntil:'domcontentloaded',timeout:60000});
  const trust=page.getByText('Yes, proceed to preview',{exact:true});
  if(await trust.count() && await trust.first().isVisible()){
    report.interstitial=true;
    await trust.first().click();
    await page.waitForLoadState('domcontentloaded');
    report.proceeded=true;
  }
  await page.waitForFunction(()=>document.documentElement.dataset.hostingProbe==='ok',null,{timeout:30000});
  report.script_executed=true;
  report.fragment_retained=(await page.evaluate(()=>location.hash))===dummyFragment;
  const result=await page.evaluate(async(id)=>{
    const out={top_level:window===window.top,origin_correct:location.origin===`https://${id}.csb.app`,persistent_requested:false,
      persistent_granted:false,indexeddb_strict:false};
    if(navigator.storage?.persist){out.persistent_requested=true;out.persistent_granted=await navigator.storage.persist() && await navigator.storage.persisted();}
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('bouncer-harmless-probe',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('test');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});
    const tx=db.transaction('test','readwrite',{durability:'strict'});out.indexeddb_strict=tx.durability==='strict';
    await new Promise((resolve,reject)=>{tx.objectStore('test').put('retained','key');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();return out;
  },id);
  Object.assign(report,result);
  await page.reload({waitUntil:'domcontentloaded'});
  report.reload_retained=await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('bouncer-harmless-probe',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});
    const value=await new Promise((resolve,reject)=>{const r=db.transaction('test','readonly').objectStore('test').get('key');r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);});
    db.close();return value==='retained';
  });
  await context.close();
} catch(e) {error=(e?.message||'browser check failed').slice(0,300);}
finally {await browser.close();}
console.log(`::notice title=Public host mobile-browser probe::${JSON.stringify({...report,error}).replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n## Mobile browser hosting probe\n\nHarmless page, no wallet or transaction.\n\n\`\`\`json\n${JSON.stringify({...report,error},null,2)}\n\`\`\`\n`);
if(error || !report.top_level || !report.script_executed || !report.origin_correct || !report.indexeddb_strict || !report.reload_retained || !report.fragment_retained)process.exitCode=1;
