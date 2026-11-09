// Desktop and phone browser integration. Synthetic keys, wallets and providers
// only; all requests are intercepted. No live enrollment or transaction.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,webcrypto} from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {baseEncode} from '@near-js/utils';
import {createV14BootstrapCandidate} from '../web-src/v14-bootstrap-candidate.mjs';
import {prepareBootstrapEnrollment} from '../web-src/v14-bootstrap-checkpoint.mjs';
import {openV14BootstrapRecoveryKit} from '../web-src/v14-bootstrap-recovery-kit.mjs';
import {deriveBootstrapAnchorCredentials} from '../shared/v14-bootstrap-anchor-auth.mjs';
import {V14_BOOTSTRAP_ENDPOINT} from '../web-src/v14-bootstrap-remote-store.mjs';
import {V14_RAILWAY_ANCHOR_ENDPOINT} from '../web-src/v14-bootstrap-railway-store.mjs';
import {createV14BootstrapRailwayAnchor} from '../agent/v14-bootstrap-railway-anchor.mjs';
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
const passphrase='synthetic browser only recovery passphrase',zero='0'.repeat(64);
const compressedV14=new Uint8Array(fs.readFileSync(new URL('../web/artifacts/v14-research.deflate',import.meta.url)));
const types={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript',
  '.json':'application/json','.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-anchor-ui-'));
const allowed=new Set(PUBLIC_WEB_FILES),sha=x=>createHash('sha256').update(x).digest('hex');
try {
  for(const width of [1280,390,320]) {
    const siteDir=path.join(staging,`site-${width}`),volume=path.join(staging,`volume-${width}`);
    fs.mkdirSync(volume,{mode:0o700});stagePublicWeb(siteDir,web,{walletOrigin:origin,walletConnectProjectId:''});
    const pair=generateKeyPairSync('ed25519'),privatePkcs8=pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),
      publicKey=`ed25519:${baseEncode(Buffer.from(pair.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const candidate=await createV14BootstrapCandidate({owner,ownerPublicKey:publicKey,vault,
      vaultFundingYocto:String(6n*10n**24n),compressedV14,passphrase,crypto:webcrypto});
    const file=JSON.parse(candidate.text),{review,sealed_kit:kit}=file;
    const draft=await prepareBootstrapEnrollment({review,kit,passphrase,compressedV14,site:origin,crypto:webcrypto});
    const digest=createHash('sha256').update(nep413Payload({message:draft.message,nonce:draft.nonce,recipient:draft.recipient})).digest();
    const owner_attestation=JSON.stringify({terms:draft.terms,nonce_base64:Buffer.from(draft.nonce).toString('base64'),
      signature_base64:sign(null,digest,pair.privateKey).toString('base64')});
    const online={status:'EXISTING_RECOVERY_ONLY',scope_id:kit.scope_id,review_text:draft.review_text,sealed_kit:draft.sealed_kit,
      owner_attestation,revision:0,head_sha256:zero,events:[],transaction_authorized:false,latest_head_independently_verified:false};
    const opened=await openV14BootstrapRecoveryKit({kit,passphrase,crypto:webcrypto,
      expected:{owner,vault,ownerPublicKey:publicKey,temporaryPublicKey:candidate.temporary_public_key,
        reviewSha256:candidate.review_sha256,scopeId:kit.scope_id}});
    let tempSecret,primaryCapability,anchorCredentials;
    await opened.useSecrets(async({temporaryKey,checkpointCapability})=>{
      tempSecret=String(temporaryKey);primaryCapability=checkpointCapability;
      anchorCredentials=await deriveBootstrapAnchorCredentials({temporaryKey,scopeId:kit.scope_id,reviewSha256:candidate.review_sha256,crypto:webcrypto});
    });opened.dispose();
    // Preload a disposable fixture directly. The hosted HTTP route and UI do
    // not allow initialization while the real prior attempt is uncertain.
    const anchor=createV14BootstrapRailwayAnchor({volumePath:volume,compressedV14,crypto:webcrypto,
      currentMountVerified:()=>true}); // synthetic directory only
    await anchor.initialize({scope_id:kit.scope_id,review_sha256:candidate.review_sha256,
      capability:anchorCredentials.capability,initialization_signature:anchorCredentials.initialization_signature,
      review_text:draft.review_text,sealed_kit:draft.sealed_kit,owner_attestation});
    const markerFile=path.join(volume,'v14-bootstrap-anchor-v1','metadata.json'),beforeMetadata=fs.readFileSync(markerFile);
    const block=baseEncode(Buffer.alloc(32,17)),rpc=async(url,options)=>{
      const req=JSON.parse(options.body);let result;
      if(req.method==='status')result={chain_id:'testnet'};
      else if(req.method==='block')result={header:{hash:block,height:10,timestamp_nanosec:String(BigInt(Date.now())*1_000_000n)}};
      else if(req.method==='query')result={block_hash:block,permission:'FullAccess'};
      else throw Error('no transaction RPC');
      return Response.json({jsonrpc:'2.0',id:req.id,result});
    };
    const context=await browser.newContext({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600,reducedMotion:'reduce'}),page=await context.newPage();
    let signatures=0,transactions=0,primaryOnline=true;const operations=[],errors=[];
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
        const request=req.postDataJSON();return route.fulfill({status:200,contentType:'application/json',headers:cors,
          body:JSON.stringify({jsonrpc:'2.0',id:request.id,result:{permission:'FullAccess'}})});
      }
      if(url.href===V14_BOOTSTRAP_ENDPOINT) {
        if(req.method()==='OPTIONS')return route.fulfill({status:primaryOnline?204:503,headers:cors});
        assert(primaryOnline,'restore must not contact the primary provider');
        const raw=req.postData(),body=JSON.parse(raw);operations.push(`primary:${body.operation}`);
        for(const secret of [candidate.text,candidate.fingerprint,passphrase,tempSecret])assert(!raw.includes(secret));
        if(body.operation==='recover')return route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify(online)});
        if(body.operation==='read')return route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify({revision:0,head_sha256:zero,events:[]})});
        throw Error('unexpected primary mutation');
      }
      if(url.href===V14_RAILWAY_ANCHOR_ENDPOINT) {
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const raw=req.postData(),data=JSON.parse(raw),{operation,...input}=data;operations.push(`anchor:${operation}`);
        for(const secret of [candidate.text,candidate.fingerprint,passphrase,tempSecret,primaryCapability])assert(!raw.includes(secret));
        let result;
        if(operation==='read')result=await anchor.read({scope_id:data.scope_id,capability:data.capability});
        else if(operation==='recover_owner')result=await anchor.recoverByOwner({signed:input,origin,fetch:rpc,now:Date.now});
        else if(operation==='inspect_owner')result=await anchor.inspectByOwner({signed:input,origin,fetch:rpc,now:Date.now});
        else throw Error('unexpected anchor operation; writes are paused');
        return route.fulfill({status:200,headers:cors,contentType:'application/json',body:JSON.stringify(result)});
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
    await page.evaluate(()=>{location.hash='#guardrails'});await page.locator('#wallet-bootstrap-recovery-open').click();
    await page.locator('#wallet-bootstrap-anchor-panel').waitFor({state:'visible'});
    assert.equal(await page.locator('#wallet-bootstrap-anchor-save').count(),0,'no live initialization button');
    await page.waitForFunction(()=>!document.querySelector('#wallet-bootstrap-recovery-read').disabled);
    await page.locator('#wallet-bootstrap-recovery-read').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-recovery-status').textContent.includes('Online recovery'));
    await page.locator('#wallet-bootstrap-recovery-passphrase').fill(passphrase);
    await page.locator('#wallet-bootstrap-recovery-unlock').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-recovery-status').textContent.includes('unlocked locally'));
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#wallet-bootstrap-recovery-export').click()]);
    assert.equal(download.suggestedFilename(),'bouncer-testnet-encrypted-setup-recovery.json');
    const recoveryBytes=fs.readFileSync(await download.path());
    primaryOnline=false;
    // The saved recovery export can be re-imported and MAC-verified without
    // contacting the original provider. It is not proof of a latest head.
    await page.locator('#wallet-bootstrap-recovery-file').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:recoveryBytes});
    await page.locator('#wallet-bootstrap-recovery-import').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-recovery-status').textContent.includes('Local encrypted file'));
    await page.locator('#wallet-bootstrap-recovery-passphrase').fill(passphrase);
    await page.locator('#wallet-bootstrap-recovery-unlock').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-recovery-status').textContent.includes('file integrity matched'));
    assert.equal(await page.locator('#wallet-bootstrap-recovery-export').isDisabled(),false);
    await page.locator('#wallet-bootstrap-anchor-inspect').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-anchor-status').textContent.includes('signed, structurally valid encrypted record'),null,{timeout:15_000});
    assert.equal(await page.locator('#wallet-bootstrap-recovery-export').isDisabled(),false,'inspection preserves the unlocked file');
    assert.equal(await page.locator('#wallet-bootstrap-anchor-passphrase').inputValue(),'','inspection does not ask for a passphrase');
    await page.locator('#wallet-bootstrap-anchor-passphrase').fill(passphrase);
    await page.locator('#wallet-bootstrap-anchor-restore').click();
    await page.waitForFunction(()=>document.querySelector('#wallet-bootstrap-anchor-status').textContent.includes('unlocked on this device'),null,{timeout:15_000});
    assert.equal(await page.locator('#wallet-bootstrap-recovery-export').isDisabled(),false);
    assert.deepEqual(operations,['primary:recover','anchor:inspect_owner','anchor:recover_owner','anchor:read']);
    assert.deepEqual(fs.readFileSync(markerFile),beforeMetadata,'read-only checks and restores do not alter the anchor');
    assert.equal(signatures,4);assert.equal(transactions,0);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
    console.log(`Synthetic independent recovery: ${width}px passed (no transaction, no primary restore request)`);
    await context.close();
  }
} finally {await browser.close();fs.rmSync(staging,{recursive:true,force:true})}
