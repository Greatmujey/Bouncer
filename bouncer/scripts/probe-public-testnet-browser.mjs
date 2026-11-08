// Read-only inspection of a third-party testnet contract form. This script has
// no wallet credentials and deliberately never clicks Write or selects a wallet.
// It blocks every non-GET/HEAD/OPTIONS request, including all broadcasts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {directOutlayerArgs} from '../web-src/direct-outlayer-testnet.mjs';

const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH;
if(!playwrightPath)throw Error('BOUNCER_PLAYWRIGHT_PATH is required');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const report={url:'https://testnet.nearblocks.io/address/outlayer.testnet/contract/methods',
  loaded:false,method_visible:false,change_form:false,terms_filled:false,meteor_option_visible:false,
  wallet_connected:false,write_clicked:false,signed:false,transaction_sent:false,blocked_non_read_requests:0};
let error;
try {
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  await context.route('**/*',route=>{
    const method=route.request().method();
    if(!['GET','HEAD','OPTIONS'].includes(method)){
      report.blocked_non_read_requests++;
      return route.abort();
    }
    return route.continue();
  });
  const page=await context.newPage();
  const response=await page.goto(report.url,{waitUntil:'domcontentloaded',timeout:60000});
  assert.equal(response?.status(),200,'contract page HTTP status');
  report.loaded=true;
  const button=page.getByRole('button',{name:/request_execution/i}).first();
  await button.waitFor({state:'visible',timeout:30000});
  report.method_visible=true;
  await button.click();
  const change=page.getByRole('radio',{name:/change/i}).first();
  if(await change.count())await change.check();
  const gas=page.locator('input[name="gas"]'),deposit=page.locator('input[name="deposit"]');
  await gas.waitFor({state:'visible',timeout:10000});
  report.change_form=true;
  await page.locator('textarea[name="args"]').fill(JSON.stringify(directOutlayerArgs(),null,2));
  await gas.fill('300');await deposit.fill('0.1');
  assert.deepEqual(JSON.parse(await page.locator('textarea[name="args"]').inputValue()),directOutlayerArgs());
  assert.equal(await gas.inputValue(),'300');assert.equal(await deposit.inputValue(),'0.1');
  report.terms_filled=true;
  // Just open the wallet picker, if exposed; do not select a wallet or sign in.
  const signIn=page.getByRole('button',{name:'Sign In',exact:true});
  if(await signIn.count() && await signIn.first().isVisible()) {
    await signIn.first().click();
    try { await page.getByText(/meteor wallet/i).first().waitFor({state:'visible',timeout:15000});report.meteor_option_visible=true; }
    catch { /* no evidence that Meteor is available */ }
  }
  await context.close();
} catch(e) {error=e?.message || 'browser probe failed';}
finally {await browser.close();}
const result=JSON.stringify({...report,error:error?.slice(0,300) || undefined});
console.log(`::notice title=Read-only public testnet browser probe::${result.replaceAll('%','%25').replaceAll('\n','%0A').replaceAll('\r','%0D')}`);
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n## Public testnet browser probe\n\nNo wallet connected, no Write clicked, no transaction sent.\n\n\`\`\`json\n${JSON.stringify({...report,error},null,2)}\n\`\`\`\n`);
if(error)process.exitCode=1;
