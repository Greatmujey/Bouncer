// Phone-sized Chromium recovery UI test with a synthetic wallet and backend.
// No real wallet, RPC, seller, private key, order or transaction is used.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { baseEncode } from '@near-js/utils';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupAuthAction } from '../web-src/witnessed-setup-auth.mjs';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw Error('No Chromium executable found');
const browser = await chromium.launch({ executablePath, args:['--no-sandbox','--disable-gpu'], headless:true });
const origin = 'https://4173-synthetic.e2b.app', owner = 'great_mujey.testnet', stage = 'create_keyless_vault';
const hash = baseEncode(Buffer.alloc(32,7)), allowed = new Set(PUBLIC_WEB_FILES);
const types = {'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.json':'application/json',
  '.zip':'application/zip','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2','.txt':'text/plain'};
try {
  for (const width of [320,390]) {
    const page = await browser.newPage({ viewport:{width,height:844}, isMobile:true, hasTouch:true, reducedMotion:'reduce' });
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    const synthetic = generateKeyPairSync('ed25519'), privatePkcs8 = synthetic.privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
    const publicKey = `ed25519:${baseEncode(Buffer.from(synthetic.publicKey.export({format:'jwk'}).x,'base64url'))}`;
    const identity = {owner,owner_public_key:publicKey,operation_id:'1'.repeat(32),review_sha256:'2'.repeat(64),
      stages:['create_keyless_vault','register_vault_circle','fund_vault_circle'].map((stage_id,i)=>({stage_id,action_commitment_sha256:String(i+3).repeat(64)}))};
    // Display-only synthetic review for the recovery flow. No transactions
    // are prepared, approved or broadcast in this browser test.
    const review = { owner, vault:`vault.${owner}`, vault_wasm_sha256:'a'.repeat(64), fixed_product_price_atoms:'20000000',
      stages:[{id:stage,actions:[{type:'transfer',deposit_yocto:'1000000000000000000000000'}]},
        {id:'register_vault_circle',actions:[{deposit_yocto:'1250000000000000000000'}]},
        {id:'fund_vault_circle',actions:[{args:{amount:'20000000'}}]}] };
    const mock = `window.selector.ready({
      async signIn(p) { if(p.network !== 'testnet' || p.addFunctionCallKey) throw Error(); return [{accountId:'${owner}'}]; },
      async signOut() {}, async getAccounts() { return [{accountId:'${owner}'}]; },
      async signMessage({network,signerId,message,nonce,recipient}) {
        if(network !== 'testnet' || signerId !== '${owner}') throw Error();
        const e=new TextEncoder(),m=e.encode(message),r=e.encode(recipient),p=new Uint8Array(4+4+m.length+32+4+r.length+1),v=new DataView(p.buffer);
        let i=0; v.setUint32(i,0x80000000+413,true); i+=4; v.setUint32(i,m.length,true); i+=4; p.set(m,i); i+=m.length;
        p.set(nonce,i); i+=32; v.setUint32(i,r.length,true); i+=4; p.set(r,i); i+=r.length; p[i]=0;
        const bytes=Uint8Array.from(atob('${privatePkcs8}'),c=>c.charCodeAt(0)), key=await crypto.subtle.importKey('pkcs8',bytes,{name:'Ed25519'},false,['sign']);
        const digest=await crypto.subtle.digest('SHA-256',p), sig=new Uint8Array(await crypto.subtle.sign('Ed25519',key,digest));
        return {accountId:signerId,publicKey:'${publicKey}',signature:btoa(String.fromCharCode(...sig))};
      }
    });`;
    const bundle = fs.readFileSync(path.join(web,'wallet.bundle.js'),'utf8');
    const digest = createHash('sha256').update(mock).digest('hex'), pinned = WALLET_EXECUTOR_SHA256['meteor-wallet'];
    assert.ok(bundle.includes(pinned));
    const reply = (route, data, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    await page.route('**/*', async route => {
      const request = route.request(), u = new URL(request.url()); calls.push(`${request.method()} ${u.pathname}`);
      if (u.pathname.endsWith('meteor-near-connect-latest.js')) return route.fulfill({status:200,contentType:'text/javascript',body:mock});
      if (u.origin === 'https://test.rpc.fastnear.com') return route.abort('failed'); // exercise the read-only fallback

      if (u.origin !== origin) return route.abort();
      if (u.pathname === '/api/google-session') return reply(route,{authenticated:false});
      if (u.pathname === '/api/wallet-setup/config') return reply(route,{enabled:true,network:'testnet',owner});
      if (u.pathname === '/api/read-only/config') return reply(route,{relay_url:'https://bouncer-testnet-readonly-relay-tau.vercel.app/api/read'});
      if (u.pathname === '/api/read-only/pending') return reply(route,{jobs:[]});
      if (u.pathname === '/api/read-only/owner-key') return reply(route,{full_access:true});
      if (['/api/wallet-setup/inspect-challenge','/api/wallet-setup/original-challenge',
        '/api/wallet-setup/reconcile-challenge'].includes(u.pathname)) {
        const recording = u.pathname.endsWith('/original-challenge'), reconciling = u.pathname.endsWith('/reconcile-challenge');
        const ctx = recording || reconciling
          ? {purpose:recording?'record_original_hash':'reconcile_setup_original',owner,ownerPublicKey:publicKey,identity,stageId:stage,originalHash:hash}
          : {purpose:'inspect',owner,ownerPublicKey:publicKey};
        const action = setupAuthAction(ctx), actionDigest = createHash('sha256').update(JSON.stringify(action)).digest('hex');
        const issued=Date.now(), expires=issued+120_000, label=recording?'Record the original transaction hash'
          : reconciling?`Reconcile original: ${stage}`:'Inspect the retained prompt';
        return reply(route,{challenge_id:'a'.repeat(32),nonce_base64:Buffer.alloc(32,8).toString('base64'),recipient:new URL(origin).host,
          expires_at_ms:expires,message:`Bouncer testnet owner authentication\n${label}\nAccount: ${owner}\nPublic key: ${publicKey}\n` +
            `Action SHA-256: ${actionDigest}\nSite: ${origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
            'This message is not a transaction and does not itself approve spending.'});
      }
      if (u.pathname === '/api/wallet-setup/inspect') return reply(route,{status:'WITNESSED',identity,review,witnessed_records:[{event:'claim',stage_id:stage}]});
      if (u.pathname === '/api/wallet-setup/preview-original') return reply(route,{status:'FINAL_SETUP_RECEIPT_MATCH',tx_hash:hash,stage_id:stage,original_recorded:false});
      if (u.pathname === '/api/wallet-setup/original') return reply(route,{status:'ORIGINAL_RECORDED',original_hash:hash,stage_id:stage});
      if (u.pathname === '/api/wallet-setup/reconcile') return reply(route,{status:'FINAL_SETUP_RECEIPT_MATCH',tx_hash:hash,stage_id:stage});
      const file = u.pathname.slice(1) || 'index.html';
      if (!allowed.has(file)) return route.fulfill({status:404,body:'blocked'});
      const content = file === 'wallet.bundle.js' ? bundle.replace(pinned,digest) : fs.readFileSync(path.join(web,file));
      return route.fulfill({status:200,contentType:types[path.extname(file)],body:content});
    });
    await page.goto(`${origin}/`,{waitUntil:'networkidle'});
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click(); await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('great_mujey.testnet'));
    await page.locator('.top-connect').click(); await page.locator('#wallet-owner-verify').click();
    await page.waitForFunction(() => document.querySelector('#wallet-account-badge').textContent === 'OWNER VERIFIED');
    await page.locator('#wallet-setup-recovery').click();
    await page.waitForFunction(() => /claimed.*Do not repeat.*wallet history/i.test(document.querySelector('#wallet-setup-recovery-status').textContent));
    await page.locator('#wallet-setup-original').fill(hash);
    await page.locator('#wallet-setup-check-original').click();
    await page.waitForFunction(() => /matches the reviewed testnet receipt.*No payment or delivery/i.test(document.querySelector('#wallet-setup-recovery-status').textContent));
    assert.equal(await page.locator('#wallet-setup-recovery-form').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await page.locator('#wallet-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await page.locator('#wallet-setup-record-original').click();
    await page.waitForFunction(() => /reconciled at FINAL.*Review the next setup stage/i.test(document.querySelector('#wallet-setup-recovery-status').textContent));
    assert.equal(await page.locator('#wallet-setup-recovery-form').isVisible(),false);
    assert.match(await page.locator('#wallet-buffer-setup-approve').innerText(), /register vault circle/i);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.ok(calls.some(x=>x.endsWith('/api/read-only/owner-key')));
    assert.ok(calls.some(x=>x.endsWith('/api/wallet-setup/reconcile')));
    assert.ok(!calls.some(x=>/wallet-setup\/(claim|reserve|broadcast)/.test(x)), 'recovery never automatically claims another stage');
    assert.deepEqual(errors,[]); await page.close();
  }
  console.log('Phone-sized setup recovery inspected and recorded a synthetic original without a transaction. No live wallet or real phone was used.');
} finally { await browser.close(); }
