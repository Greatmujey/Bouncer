// Optional offline browser probes of the exact pinned third-party executors.
// Provide reviewed bytes via the BOUNCER_*_EXECUTOR paths. Signatures, RPC,
// signer backends and accounts are synthetic; no real wallet or NEAR transfer
// is used. These probes are separate from the routine mocked browser suite.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { KeyPair } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
if (!['BOUNCER_METEOR_EXECUTOR', 'BOUNCER_CLI_EXECUTOR', 'BOUNCER_MOBILE_EXECUTOR', 'BOUNCER_NIGHTLY_EXECUTOR', 'BOUNCER_LEDGER_EXECUTOR'].some(key => process.env[key])) throw new Error('Provide at least one pinned executor path');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const allowed = new Set(PUBLIC_WEB_FILES);
const server = http.createServer((req, res) => {
  const filename = new URL(req.url, 'http://test.invalid').pathname.slice(1) || 'index.html';
  if (!allowed.has(filename)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(filename)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(web, filename)).pipe(res);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browserArgs = ['--no-sandbox', '--disable-gpu'];
try {
  if (process.env.BOUNCER_METEOR_EXECUTOR) {
    // Run the pinned, unmodified Meteor executor through the actual NEAR
    // Connect bridge. Network backend is blocked; no wallet is signed in.
    const executor = fs.readFileSync(process.env.BOUNCER_METEOR_EXECUTOR);
    assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), 'b55347ec700b9d55b71aa6450aac24548045cb4cf0005700dab08e5326c7cfab');
    const browserReal = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await browserReal.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/meteor-near-connect-latest.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }));
      await page.route('https://mc.meteorwallet.app/**', route => route.fulfill({ status: 503, body: 'blocked in browser test' }));
      await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="meteor-wallet"]').click();
      const walletFrame = page.frameLocator('.hot-connector-popup iframe').first();
      await walletFrame.getByRole('button', { name: 'Meteor Web' }).waitFor({ timeout: 20_000 });
      await walletFrame.getByRole('button', { name: 'Close Meteor Connect' }).click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cancelled or unavailable'));
      assert.deepEqual(errors, []);
      console.log('Pinned real Meteor wallet UI opened and cancelled; no account sign-in or upstream service was tested.');
    } finally { await browserReal.close(); }
  }

  // Exercise the exact vendored Ethereum executor in a real near-connect
  // sandbox. The approval page is synthetic; no real wallet or chain is used.
  {
    const ethBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const context = await ethBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage(), errors = [], requests = [], rpc = [];
      page.on('pageerror', error => errors.push(error.message));
      const fakeApprovalPage = `<!doctype html><button id="approve">Approve synthetic request</button><p id="kind"></p><script>
        const params = new URLSearchParams(location.hash.slice(1)), origin = params.get('origin'), requestId = params.get('requestId');
        const channel = 'ethereum-near-connect/v1'; let payload;
        const ready = () => opener.postMessage({ channel, requestId, type: 'READY' }, origin);
        addEventListener('message', event => {
          if (event.origin !== origin || event.source !== opener || event.data?.channel !== channel || event.data?.requestId !== requestId || event.data?.type !== 'REQUEST') return;
          payload = event.data.payload; document.querySelector('#kind').textContent = payload.kind + ':' + payload.network;
        });
        document.querySelector('#approve').onclick = () => {
          if (!payload) return;
          opener.postMessage({ channel, requestId, type: 'RESULT', result: payload.kind === 'signIn' ? [{accountId:'0x${'a'.repeat(40)}'}] : null }, origin);
        };
        setInterval(ready, 250); ready();
      <\/script>`;
      await context.route('https://evm-on-near.dev/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fakeApprovalPage }));
      await context.route('https://test.rpc.fastnear.com/**', route => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = route.request().postDataJSON(); rpc.push(body);
        const block = 'B'.repeat(44), height = 276000123;
        const result = body.method === 'block' ? { header: { hash: block, height } }
          : body.params.request_type === 'view_account'
            ? { amount: '16000000000000000000000000', block_hash: block, block_height: height }
            : { result: [...Buffer.from('"20000000"')], block_hash: block, block_height: height };
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
      });
      await context.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) requests.push(request.url()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="ethereum-wallets"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="ethereum-wallets"]').click();
      assert.equal(await page.locator('#wallet-ethereum-info').isVisible(), true);
      assert.match(await page.locator('#wallet-ethereum-info').innerText(), /setup transaction/);
      const popupPromise = page.waitForEvent('popup');
      await page.locator('#wallet-ethereum-continue').click();
      const popup = await popupPromise;
      await popup.locator('#kind').waitFor();
      await popup.waitForFunction(() => document.querySelector('#kind').textContent === 'signIn:testnet');
      await popup.locator('#approve').click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('0x' + 'a'.repeat(40)));
      assert.match(await page.locator('#wallet-status').textContent(), /wallet-reported.*No vault or spending access/);
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
      await page.locator('.top-connect').click();
      assert.equal(await page.locator('#wallet-account-badge').textContent(), 'CONNECTED');
      assert.match(await page.locator('#wallet-account-warning').textContent(), /does not grant Bouncer spending access/);
      assert.equal(await page.locator('#wallet-account-use-wallet').isVisible(), false);
      await page.locator('#wallet-account-refresh').click();
      await page.waitForFunction(() => document.querySelector('#wallet-account-usdc').textContent === '20');
      assert.equal(await page.locator('#wallet-account-near').textContent(), '16');
      assert.deepEqual(rpc.map(call => call.method === 'block' ? 'block' : call.params.request_type), ['block', 'view_account', 'call_function']);
      assert.equal(rpc[1].params.account_id, `0x${'a'.repeat(40)}`);
      assert.equal(JSON.parse(Buffer.from(rpc[2].params.args_base64, 'base64')).account_id, `0x${'a'.repeat(40)}`);
      const signOutPopup = page.waitForEvent('popup');
      await page.locator('#wallet-disconnect').click({ noWaitAfter: true });
      const disconnectPopup = await signOutPopup;
      await disconnectPopup.waitForFunction(() => document.querySelector('#kind').textContent === 'signOut:testnet');
      await disconnectPopup.locator('#approve').click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('disconnected'));
      assert.equal(requests.length, 3);
      assert.ok(requests.every(url => url === 'https://test.rpc.fastnear.com/'), 'only read-only RPC requests were sent');
      assert.deepEqual(errors, []);
      console.log('Vendored Ethereum executor completed a synthetic testnet connect, public balance view and disconnect through a mock popup. No real wallet, relayer or transaction was tested.');
      await context.close();
    } finally { await ethBrowser.close(); }
  }

  if (process.env.BOUNCER_CLI_EXECUTOR) {
    const executor = fs.readFileSync(process.env.BOUNCER_CLI_EXECUTOR);
    assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), WALLET_EXECUTOR_SHA256['near-cli']);
    const cliBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await cliBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const errors = [], writes = [], rpc = [];
      let cliLoads = 0;
      const pair = KeyPair.fromRandom('ed25519'); // synthetic key, never submitted to a real network
      const publicKey = pair.getPublicKey().toString();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url()); });
      await page.route('**/near-cli-connect/*/dist/near-cli.js*', route => { cliLoads++; return route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }); });
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      await page.route('https://test.rpc.fastnear.com/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = route.request().postDataJSON(); rpc.push(body);
        const block = 'B'.repeat(44), height = 276000123;
        const result = body.method === 'block' ? { header: { hash: block, height } }
          : body.params.request_type === 'view_account'
            ? { amount: '16019958035075000000000000', block_hash: block, block_height: height }
            : body.params.request_type === 'call_function'
              ? { result: [...Buffer.from('"20000000"')], block_hash: block, block_height: height }
              : { permission: 'FullAccess' };
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
      });
      await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-cli"]').disabled);
      // The phone-friendly account view never loads the CLI executor or asks
      // for a key/signature. Real-looking values here are synthetic RPC data.
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="near-cli"]').click();
      await page.locator('#wallet-account-id').fill('cli-synthetic.testnet');
      await page.locator('#wallet-account-id').press('Enter');
      await page.waitForFunction(() => document.querySelector('#wallet-account-usdc').textContent === '20');
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'view-only');
      assert.match(await page.locator('#wallet-status').textContent(), /unverified.*No wallet is connected/);
      assert.equal(cliLoads, 0, 'typed account does not execute the CLI adapter');
      assert.deepEqual(rpc.map(request => request.method === 'block' ? 'block' : request.params.request_type), ['block', 'view_account', 'call_function']);
      await page.locator('.top-connect').click();
      assert.equal(await page.locator('#wallet-account-view').isVisible(), true);
      await page.locator('#wallet-disconnect').click();
      await page.locator('#wallet-close').click();
      rpc.length = 0; writes.length = 0;
      async function submitCliSignature(corrupt = false) {
        await page.locator('.top-connect').click();
        await page.locator('[data-wallet-id="near-cli"]').click();
        if (await page.locator('.account-entry-cli').getAttribute('open') === null) await page.locator('.account-entry-cli summary').click();
        await page.locator('#wallet-cli-verify').click();
        const frame = page.frameLocator('.hot-connector-popup iframe').first();
        await frame.locator('#account-id').fill('cli-synthetic.testnet', { timeout: 20_000 });
        await frame.locator('#account-id').press('Enter');
        const keychain = frame.locator('[data-method="sign-with-keychain"]');
        const choice = frame.locator(corrupt ? '[data-method="sign-with-keychain"]' : '[data-method="sign-with-legacy-keychain"]');
        if (!corrupt) {
          await choice.tap();
          if (!(await choice.getAttribute('class')).includes('selected')) {
            // Some hosted headless Chromium builds silently lose nested-frame
            // taps. Exercise the adapter's real keyboard selection instead.
            console.warn('CLI credentials-file touch was not delivered; using keyboard selection. Touch input was not verified in this run.');
            await keychain.press('ArrowRight');
          }
        }
        assert.match(await choice.getAttribute('class'), /\bselected\b/);
        await choice.press('Enter');
        const command = await frame.locator('.command-block code').textContent();
        assert.match(command, /^near message sign-nep413/);
        assert.match(command, /network-config testnet/);
        assert.match(command, corrupt ? /sign-with-keychain/ : /sign-with-legacy-keychain/);
        assert.doesNotMatch(command, /near (?:transaction|tokens)|near account add-key/i);
        const message = /utf8 '([\s\S]*?)'/.exec(command)?.[1];
        const nonce = /nonce '([^']+)'/.exec(command)?.[1];
        const recipient = /recipient '([^']+)'/.exec(command)?.[1];
        assert.ok(message && nonce && recipient, 'CLI exposes the exact login challenge');
        const text = value => { const b = Buffer.from(value), len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); };
        const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
        const payload = Buffer.concat([tag, text(message), Buffer.from(nonce, 'base64'), text(recipient), Buffer.from([0])]);
        const signature = Buffer.from(pair.sign(crypto.createHash('sha256').update(payload).digest()).signature);
        if (corrupt) signature[0] ^= 1;
        let output = { accountId: 'cli-synthetic.testnet', publicKey, signature: `ed25519:${baseEncode(signature)}` };
        await frame.locator('#sign-output').fill(JSON.stringify(output));
        // Keyboard activation also avoids hosted Chromium's intermittent loss
        // of synthetic pointer events in a nested sandbox iframe.
        await frame.locator('#submit-sign-btn').press('Enter');
      }
      await submitCliSignature();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cli-synthetic.testnet'));
      assert.match(await page.locator('#wallet-status').textContent(), /CLI login verified against testnet/);
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
      assert.equal(await page.locator('.top-connect [data-wallet-label]').innerText(), 'Connected');
      assert.equal(rpc.length, 1);
      assert.equal(rpc[0].method, 'query');
      assert.deepEqual(rpc[0].params, { request_type: 'view_access_key', finality: 'final', account_id: 'cli-synthetic.testnet', public_key: publicKey });
      assert.deepEqual(writes, ['https://test.rpc.fastnear.com/'], 'the only POST must be a read-only access-key query');
      await page.locator('.top-connect').click();
      await page.locator('#wallet-disconnect').click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected'));
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
      await page.locator('#wallet-close').click();
      await submitCliSignature(true);
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Could not verify the CLI login message'));
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
      assert.equal(rpc.length, 1, 'bad signature fails before RPC');
      assert.deepEqual(errors, []);
      console.log('Pinned NEAR CLI executor + synthetic signer and RPC: valid off-chain login accepted, forgery rejected; no real wallet or transaction tested.');
    } finally { await cliBrowser.close(); }
  }

  if (process.env.BOUNCER_MOBILE_EXECUTOR) {
    // Run the exact Fastnear NEAR Mobile executor with a *synthetic* signer and
    // testnet RPC. Verify the real NEP-413 path: no AddKey/DeleteKey request is
    // made, the login signature and returned access key are actually checked.
    // Nothing here contacts a real wallet or submits a NEAR transaction.
    const executor = fs.readFileSync(process.env.BOUNCER_MOBILE_EXECUTOR);
    assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), WALLET_EXECUTOR_SHA256['near-mobile']);
    const mobileBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await mobileBrowser.newPage({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/133.0.0.0 Mobile Safari/537.36',
      });
      const errors = [], calls = [], rpc = [], consoleMessages = [], failures = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
      page.on('requestfailed', request => failures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
      const pair = KeyPair.fromRandom('ed25519'); // ephemeral synthetic test key only
      const publicKey = pair.getPublicKey().toString();
      let messageRequest, approved = false, corruptSignature = false;
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      const respond = (route, data) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) });
      await page.route('**/fastnear/near-connect/*/repository/near-mobile.js*', route => route.fulfill({ status: 200, headers: cors, contentType: 'text/javascript', body: executor }));
      await page.context().route('https://near-mobile-signer-backend_production.peersyst.tech/**', async route => {
        const req = route.request(), pathname = new URL(req.url()).pathname;
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        calls.push({ method: req.method(), pathname });
        if (pathname.startsWith('/assets/')) return route.fulfill({ status: 200, headers: cors, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
        if (pathname === '/api/deep-link') return route.fulfill({ status: 200, headers: cors, contentType: 'text/html', body: 'Synthetic deep link' });
        if (pathname === '/api/signer-request/message' && req.method() === 'POST') {
          messageRequest = req.postDataJSON();
          return respond(route, { id: 'bouncer-synthetic-login', network: 'testnet', status: 'pending' });
        }
        if (pathname === '/api/signer-request/message/bouncer-synthetic-login' && req.method() === 'GET') {
          if (!approved) return respond(route, { id: 'bouncer-synthetic-login', network: 'testnet', status: 'pending' });
          const string = value => { const text = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(text.length); return Buffer.concat([length, text]); };
          const tag = Buffer.alloc(4); tag.writeUInt32LE(2 ** 31 + 413);
          const payload = Buffer.concat([tag, string(messageRequest.message), Buffer.from(messageRequest.nonce), string(messageRequest.receiver), Buffer.from([0])]);
          const hash = crypto.createHash('sha256').update(payload).digest();
          const signatureBytes = Buffer.from(pair.sign(hash).signature);
          if (corruptSignature) signatureBytes[0] ^= 1;
          return respond(route, { id: 'bouncer-synthetic-login', network: 'testnet', status: 'approved', response: { accountId: 'synthetic.testnet', publicKey, signature: signatureBytes.toString('base64') } });
        }
        throw new Error(`Unexpected Mobile signer call: ${req.method()} ${pathname}`);
      });
      await page.route('https://test.rpc.fastnear.com/**', async route => {
        const req = route.request();
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = req.postDataJSON(); rpc.push(body);
        return respond(route, { jsonrpc: '2.0', id: body.id, result: { permission: 'FullAccess' } });
      });
      await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-mobile"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="near-mobile"]').click();
      const mobileFrame = page.frameLocator('.hot-connector-popup iframe').first();
      await mobileFrame.locator('#qr-code svg').waitFor({ timeout: 20_000 }).catch(async error => {
        console.error('Mobile browser diagnostic:', { calls, errors, consoleMessages, failures, status: await page.locator('#wallet-status').textContent(), frames: page.frames().map(frame => frame.url()) });
        throw error;
      });
      assert.equal(messageRequest.network, 'testnet');
      assert.equal(messageRequest.receiver, new URL(url).host);
      assert.equal(messageRequest.nonce.length, 32);
      assert.match(messageRequest.message, /login message does not approve a transaction, transfer funds, or add an access key/i);
      assert.match(await mobileFrame.locator('.bouncer-mobile-hint').innerText(), /testnet account.*return to this tab/i);
      assert.equal(await page.locator('.bouncer-mobile-close').getAttribute('aria-label'), 'Cancel NEAR Mobile connection');
      assert.equal(await mobileFrame.locator('#approve-button').innerText(), 'Open NEAR Mobile');
      approved = true;
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('synthetic.testnet'), null, { timeout: 20_000 });
      assert.match(await page.locator('#wallet-status').textContent(), /NEAR Mobile login verified against testnet/);
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
      assert.equal(await page.locator('.top-connect [data-wallet-label]').innerText(), 'Connected');
      assert.match(await page.locator('#wallet-banner').textContent(), /Connected: synthetic\.testnet/);
      assert.deepEqual(rpc.map(request => [request.method, request.params.request_type]), [['query', 'view_access_key']]);
      assert.equal(rpc[0].params.account_id, 'synthetic.testnet');
      assert.equal(rpc[0].params.public_key, publicKey);
      await page.locator('.top-connect').click();
      await page.locator('#wallet-disconnect').click();
      assert.equal(calls.filter(call => call.method === 'POST').length, 1);
      assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.pathname), ['/api/signer-request/message']);
      // A forged signature must be rejected before any access-key RPC lookup.
      approved = false; corruptSignature = true;
      await page.locator('[data-wallet-id="near-mobile"]').click();
      await page.frameLocator('.hot-connector-popup iframe').first().locator('#qr-code svg').waitFor({ timeout: 20_000 });
      approved = true;
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Could not verify the NEAR Mobile login message'), null, { timeout: 20_000 });
      assert.equal(await page.locator('#wallet-disconnect').isVisible(), false);
      assert.equal(rpc.length, 1, 'invalid signature must not reach RPC verification');
      assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.pathname), ['/api/signer-request/message', '/api/signer-request/message']);
      approved = false; corruptSignature = false;
      await page.locator('[data-wallet-id="near-mobile"]').click();
      await page.frameLocator('.hot-connector-popup iframe').first().locator('#qr-code svg').waitFor({ timeout: 20_000 });
      await page.locator('.bouncer-mobile-close').click();
      await page.waitForFunction(() => document.querySelector('#wallet-dialog').open, null, { timeout: 10_000 });
      assert.match(await page.locator('#wallet-status').textContent(), /cancelled or unavailable/i);
      assert.equal(calls.filter(call => call.method === 'POST').length, 3, 'only message requests were made');
      assert.deepEqual(errors, []);
      console.log('Pinned NEAR Mobile executor verified a synthetic signed login and rejected a forgery; message flow, visible connected state, cancel and local disconnect passed. No real wallet or transaction tested.');
    } finally { await mobileBrowser.close(); }
  }

  // With no extension or hardware attached, check that the real Nightly and
  // Ledger adapters surface their install/device prompts and cancel safely.
  for (const [id, envKey, pattern, title] of [
    ['nightly-wallet', 'BOUNCER_NIGHTLY_EXECUTOR', '**/repository/nightly.js*', 'Nightly Wallet'],
    ['ledger', 'BOUNCER_LEDGER_EXECUTOR', '**/ledger-executor.js*', 'Connect Ledger'],
  ]) {
    if (!process.env[envKey]) continue;
    const executor = fs.readFileSync(process.env[envKey]);
    assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), WALLET_EXECUTOR_SHA256[id]);
    const promptBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await promptBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url()); });
      await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await page.route('https://storage.herewallet.app/**', route => route.fulfill({ status: 404, body: 'Blocked in synthetic test' }));
      await page.route(pattern, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="nightly-wallet"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator(`[data-wallet-id="${id}"]`).click();
      const frame = page.frameLocator('.hot-connector-popup iframe').first();
      await frame.getByText(title, { exact: true }).waitFor({ timeout: 20000 });
      if (id === 'nightly-wallet') {
        assert.match(await frame.locator('body').innerText(), /Download Nightly/);
        await page.getByRole('button', { name: 'Cancel Nightly Wallet connection' }).click();
      } else {
        assert.match(await frame.locator('body').innerText(), /Ledger device/i);
        // Some browsers wait for WebHID permission; cancellation must work
        // even while the upstream adapter is still showing its spinner.
        await page.getByRole('button', { name: 'Cancel Ledger connection' }).click();
      }
      await page.waitForFunction(() => document.querySelector('#wallet-dialog').open && /cancelled or unavailable/i.test(document.querySelector('#wallet-status').textContent));
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(`Pinned ${title} adapter opened and cancelled without an extension, device, account or transaction.`);
    } finally { await promptBrowser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
