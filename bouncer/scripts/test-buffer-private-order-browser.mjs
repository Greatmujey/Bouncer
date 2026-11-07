/** Synthetic mobile-sized WebCrypto interoperability test. It contacts no
 * wallet, seller or chain and is not a real-device security audit. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const path=process.env.BOUNCER_PLAYWRIGHT_PATH, executablePath=process.env.CHROMIUM_PATH;
if (!path || !executablePath) throw Error('Playwright module and Chromium are required');
const {chromium}=await import(pathToFileURL(path).href);
const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-gpu'],headless:true});
try {
  for (const width of [320,390]) {
    const page=await browser.newPage({viewport:{width,height:844},isMobile:true,hasTouch:true});
    const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
    await page.route('https://capsule.example.test/**', async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if (pathname==='/') return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Private order crypto test</title>'});
      const file=pathname.slice(1);
      if (['buffer-private-order-capsule.mjs','cli-login.mjs','wallet-utils.mjs'].includes(file)) {
        return route.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(`web-src/${file}`,'utf8')});
      }
      return route.fulfill({status:404});
    });
    await page.goto('https://capsule.example.test/');
    const result=await page.evaluate(async ()=>{
      const {createPrivateOrderKey,sealPrivateOrder,openPrivateOrder,privateOrderCapsuleCommitment}=await import('/buffer-private-order-capsule.mjs');
      const {nep413Payload}=await import('/cli-login.mjs');
      const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
      const raw=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)), alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let n=0n; for (const b of raw) n=n*256n+BigInt(b);
      let b58=''; while(n>0n) { b58=alphabet[Number(n%58n)]+b58; n/=58n; }
      for (const b of raw) { if(b!==0) break; b58='1'+b58; }
      const owner='buyer.testnet', ownerPublicKey='ed25519:'+b58;
      let prompts=0;
      const wallet={manifest:{id:'meteor'},signMessage:async options=>{
        prompts++;
        const digest=await crypto.subtle.digest('SHA-256',nep413Payload(options));
        const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,digest));
        return {accountId:owner,publicKey:ownerPublicKey,signature:btoa(String.fromCharCode(...signature))};
      }};
      const fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'bouncer-cli-login',result:{permission:'FullAccess'}}));
      const keyRecord=await createPrivateOrderKey({wallet,owner,ownerPublicKey,location,crypto,fetch});
      const order={brief:'A confidential synthetic research request.',sku:'weekly-market-brief',
        orderId:'01234567-89ab-cdef-0123-456789abcdef',onchainOrderId:'o-123456abcdef',accessToken:'ab'.repeat(24)};
      const capsule=await sealPrivateOrder({keyRecord,attemptId:'12'.repeat(16),privateOrder:order,crypto});
      const trustedCapsuleSha256=await privateOrderCapsuleCommitment({capsule,crypto});
      const decoded=await openPrivateOrder({wallet,keyRecord,capsule,trustedCapsuleSha256,location,crypto,fetch});
      return {equal:JSON.stringify(decoded)===JSON.stringify(order),prompts,
        secretsInCiphertext:JSON.stringify({keyRecord,capsule}).includes(order.brief) || JSON.stringify({keyRecord,capsule}).includes(order.accessToken)};
    });
    assert.deepEqual(result,{equal:true,prompts:3,secretsInCiphertext:false}); assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('Private order capsule sealed and reopened in synthetic 320px and 390px Chromium. No real phone, wallet, order, or transaction.');
} finally { await browser.close(); }
