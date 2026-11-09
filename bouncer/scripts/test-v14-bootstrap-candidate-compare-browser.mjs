// Desktop and phone-sized UI using ONLY synthetic keys, wallet, checkpoint and RPC.
// Every network route is intercepted. No enrollment, transaction or live read.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {baseEncode} from '@near-js/utils';
import {createV14BootstrapCandidate} from '../web-src/v14-bootstrap-candidate.mjs';
import {prepareBootstrapEnrollment} from '../web-src/v14-bootstrap-checkpoint.mjs';
import {V14_BOOTSTRAP_ENDPOINT} from '../web-src/v14-bootstrap-remote-store.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {nep413Payload} from '../web-src/cli-login.mjs';
import {WALLET_EXECUTOR_SHA256} from '../web-src/wallet-executor.mjs';
import {PUBLIC_WEB_FILES,stagePublicWeb} from './stage-public-web.mjs';

const web=fileURLToPath(new URL('../web/',import.meta.url));
const playwrightPath=process.env.BOUNCER_PLAYWRIGHT_PATH||path.join(process.env.RUNNER_TEMP||'','bouncer-browser/node_modules/playwright-core/index.mjs');
const {chromium}=await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath=process.env.CHROMIUM_PATH||['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].find(fs.existsSync);
if(!executablePath)throw Error('No Chromium executable found');
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
const origin='https://bouncer-production-6df1.up.railway.app',owner='great_mujey.testnet',vault=`native.${owner}`;
const passphrase='synthetic browser only recovery passphrase';
const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript',
  '.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-candidate-match-ui-'));
const allowed=new Set(PUBLIC_WEB_FILES),sha=x=>createHash('sha256').update(x).digest('hex');
try {
  for(const width of [1280,320,390]) {
    const siteDir=path.join(staging,`site-${width}`);stagePublicWeb(siteDir,web,{walletOrigin:origin,walletConnectProjectId:''});
    const pair=generateKeyPairSync('ed25519'),privatePkcs8=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${baseEncode(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const input={owner,ownerPublicKey:publicKey,vault,vaultFundingYocto:String(6n*10n**24n),compressedV14,passphrase,crypto:webcrypto};
    const candidate=await createV14BootstrapCandidate(input),different=await createV14BootstrapCandidate(input);
    const makeOnline=async saved=>{
      const {review,sealed_kit:kit}=JSON.parse(saved.text);
      const draft=await prepareBootstrapEnrollment({review,kit,passphrase,compressedV14,site:origin,crypto:webcrypto});
      const digest=createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
      const owner_attestation=JSON.stringify({terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
        signature_base64:sign(null,digest,pair.privateKey).toString('base64')});
      return {status:'EXISTING_RECOVERY_ONLY',scope_id:kit.scope_id,review_text:draft.review_text,sealed_kit:draft.sealed_kit,
        owner_attestation,revision:0,head_sha256:'0'.repeat(64),events:[],transaction_authorized:false,
        latest_head_independently_verified:false};
    };
    const expectedOnline=await makeOnline(candidate),otherOnline=await makeOnline(different);
    const file=JSON.parse(candidate.text),opened=await openV14BootstrapRecoveryKit({kit:file.sealed_kit,passphrase,crypto:webcrypto,
      expected:{owner,vault,ownerPublicKey:publicKey,temporaryPublicKey:candidate.temporary_public_key,
        reviewSha256:candidate.review_sha256,scopeId:file.sealed_kit.scope_id}});
    let tempSecret,capability;
    await opened.useSecrets(({temporaryKey,checkpointCapability})=>{tempSecret=String(temporaryKey);capability=checkpointCapability});opened.dispose();
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,reducedMotion:'reduce'}),page=await context.newPage();
    let signatures=0,transactions=0,online=expectedOnline;const operations=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.text()==='BOUNCER_SYNTHETIC_SIGNATURE')signatures++;
      if(message.text()==='BOUNCER_UNEXPECTED_TRANSACTION')transactions++});
    const mock=`window.selector.ready({
      async signIn(p){if(p.network!=='testnet'||p.addFunctionCallKey)throw Error();return [{accountId:'${owner}'}]},
      async signOut(){},async getAccounts(){return [{accountId:'${owner}'}]},
      async signMessage({network,signerId,message,nonce,recipient}){
        if(network!=='testnet'||signerId!=='${owner}')throw Error();console.log('BOUNCER_SYNTHETIC_SIGNATURE');
        const e=new TextEncoder(),m=e.encode(message),r=e.encode(recipient),p=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(p.buffer);
        let i=0;v.setUint32(i,0x80000000+413,true);i+=4;v.setUint32(i,m.length,true);i+=4;p.set(m,i);i+=m.length;
        p.set(nonce,i);i+=32;v.setUint32(i,r.length,true);i+=4;p.set(r,i);i+=r.length;p[i]=0;
        const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob('${privatePkcs8}'),c=>c.charCodeAt(0)),{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',p),sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:signerId,publicKey:'${publicKey}',signature:btoa(String.fromCharCode(...sig))}},
      async signAndSendTransaction(){console.log('BOUNCER_UNEXPECTED_TRANSACTION');throw Error('unexpected transaction')}
    });`;
    const bundle=fs.readFileSync(path.join(siteDir,'wallet.bundle.js'),'utf8'),pinned=WALLET_EXECUTOR_SHA256['meteor-wallet'];
    assert(bundle.includes(pinned));const mockDigest=sha(mock);
    const cors={'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'};
    await page.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.endsWith('meteor-near-connect-latest.js'))return route.fulfill({status:200,contentType:'text/javascript',body:mock});
      if(url.origin==='https://test.rpc.fastnear.com') {
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const request=req.postDataJSON();
        return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{permission:'FullAccess'}})});
      }
      if(url.href===V14_BOOTSTRAP_ENDPOINT) {
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        assert.equal(req.method(),'POST');const raw=req.postData(),body=JSON.parse(raw);operations.push(body.operation);
        assert.equal(body.operation,'recover','no enrollment, append or broadcast');
        for(const secret of [candidate.text,candidate.fingerprint,passphrase,tempSecret,capability])assert(!raw.includes(secret));
        return route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify(online)});
      }
      if(url.origin!==origin)return route.abort('failed');
      if(url.pathname.startsWith('/api/'))return route.fulfill({status:404,contentType:'application/json',body:'{}'});
      const filename=url.pathname==='/workspace'?'index.html':(url.pathname.slice(1)||'index.html');
      if(!allowed.has(filename))return route.fulfill({status:404,body:'blocked'});
      const content=filename==='wallet.bundle.js'?bundle.replace(pinned,mockDigest):fs.readFileSync(path.join(siteDir,filename));
      return route.fulfill({status:200,contentType:types[path.extname(filename)],body:content});
    });
    await page.goto(`${origin}/workspace`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>!document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click();await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-account-badge').textContent==='OWNER VERIFIED',null,{timeout:15_000});
    await page.evaluate(()=>{location.hash='#guardrails'});await page.locator('#vault-tools-title').waitFor({state:'visible'});
    await page.locator('#wallet-bootstrap-recovery-open').click();
    await page.waitForFunction(()=>!document.querySelector('#wallet-bootstrap-match-check').disabled);
    assert.equal(signatures,1);assert.deepEqual(operations,[]);
    const choose=()=>page.locator('#wallet-bootstrap-match-file').setInputFiles({name:'synthetic-setup.json',mimeType:'application/json',buffer:Buffer.from(candidate.text)});
    await choose();await page.locator('#wallet-bootstrap-match-id').fill('0'.repeat(64));
    await page.locator('#wallet-bootstrap-match-passphrase').fill(passphrase);await page.locator('#wallet-bootstrap-match-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-match-status').textContent.includes('Could not verify'));
    assert.equal(await page.locator('#wallet-bootstrap-match-passphrase').inputValue(),'');assert.equal(signatures,1);assert.deepEqual(operations,[]);
    await page.locator('#wallet-bootstrap-match-id').fill(candidate.fingerprint.toUpperCase());
    await page.locator('#wallet-bootstrap-match-passphrase').fill('wrong synthetic recovery passphrase');await page.locator('#wallet-bootstrap-match-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-match-status').textContent.includes('Could not verify'));
    assert.equal(await page.locator('#wallet-bootstrap-match-passphrase').inputValue(),'');assert.equal(signatures,1);assert.deepEqual(operations,[]);
    await page.locator('#wallet-bootstrap-match-passphrase').fill(passphrase);await page.locator('#wallet-bootstrap-match-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-match-status').textContent.startsWith('Matched:'),null,{timeout:20_000});
    assert.match(await page.locator('#wallet-bootstrap-match-status').textContent(),/does not prove a separate backup, latest history, vault state or final receipts/i);
    assert.equal(await page.locator('#wallet-bootstrap-match-passphrase').inputValue(),'');assert.equal(signatures,2);assert.deepEqual(operations,['recover']);
    assert.equal(await page.locator('#wallet-bootstrap-recovery-panel').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#wallet-bootstrap-match-id').fill(candidate.fingerprint);
    assert.equal(await page.locator('#wallet-bootstrap-match-status').textContent(),'','edited input clears the old match');
    online=otherOnline;
    await page.locator('#wallet-bootstrap-match-passphrase').fill(passphrase);await page.locator('#wallet-bootstrap-match-check').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-match-status').textContent.includes('different setups'),null,{timeout:20_000});
    assert.equal(signatures,3);assert.deepEqual(operations,['recover','recover']);assert.equal(transactions,0);
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('Synthetic desktop and phone candidate comparison: local failures, signed read, exact match, mismatch and no transactions passed. No real wallet or device was used.');
} finally {await browser.close();fs.rmSync(staging,{recursive:true,force:true})}
