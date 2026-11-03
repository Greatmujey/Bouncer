// Browser smoke test for a locally served static build. Wallet executor is
// deliberately mocked: this does NOT claim a real wallet sign-in was tested.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';

const require = createRequire(import.meta.url);
const { KeyPair } = require('@near-js/crypto');
const { baseEncode } = require('@near-js/utils');

const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.zip': 'application/zip' };
const allowed = new Set(PUBLIC_WEB_FILES);
const httpServer = http.createServer((req, res) => {
  const filename = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (filename === 'embed.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<iframe src="/" style="width:100%;height:900px"></iframe>'); return; }
  if (!allowed.has(filename)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(filename)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(web, filename)).pipe(res);
});
httpServer.listen(0, '127.0.0.1');
await once(httpServer, 'listening');
const url = `http://127.0.0.1:${httpServer.address().port}/`;
const browserArgs = ['--no-sandbox', '--disable-gpu'];
if (process.env.BOUNCER_SINGLE_PROCESS === '1') browserArgs.push('--single-process', '--no-zygote');
const mockMeteor = accountId => `window.selector.ready({
  async signIn(params) { if (params.network !== 'testnet' || params.addFunctionCallKey) throw new Error('unsafe request'); return [{ accountId: '${accountId}' }]; },
  async signOut(params) { if (params.network !== 'testnet') throw new Error('wrong network'); },
  async getAccounts() { return [{ accountId: '${accountId}' }]; }
});`;
// Mocks are deliberately not the pinned upstream bytes. Replace only the
// expected digest in a test-only copy of the bundle; production is untouched.
async function allowMockMeteor(page, body) {
  const bundle = fs.readFileSync(path.join(web, 'wallet.bundle.js'), 'utf8');
  const upstream = WALLET_EXECUTOR_SHA256['meteor-wallet'];
  assert.ok(bundle.includes(upstream));
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  await page.route('**/wallet.bundle.js?*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.replace(upstream, digest) }));
}

try {
  for (const width of [320, 390, 1440]) {
    const browser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 650, hasTouch: width < 650 });
      const pageErrors = [], writes = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
      await page.goto(url, { waitUntil: 'networkidle' });
      const brand = page.locator(width < 650 ? '.mobile-brand .brand-mark svg' : '.brand .brand-mark svg');
      assert.equal(await brand.isVisible(), true, `brand mark is visible at ${width}px`);
      assert.equal(await brand.locator('use').getAttribute('href'), '#i-bouncer', 'brand mark uses the shared symbol');
      assert.ok(await brand.locator('use').evaluate(el => el.getBBox().width > 0), 'brand vector renders');
      const dialog = page.locator('#welcome-tour');
      assert.equal(await dialog.evaluate(el => el.open), false, 'first visit is not blocked by a modal');
      await page.locator('[data-open-tour]').click();
      assert.equal(await dialog.evaluate(el => el.open), true, 'tour opens on request');
      assert.match(await page.locator('#tour-count').innerText(), /STEP 1 OF 4/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `tour page overflows at ${width}px`);
      assert.equal(await page.locator('#tour-next').evaluate(el => el === document.activeElement), true, 'tour receives focus');
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'focus stays in the tour');
      }
      await page.locator('#tour-next').click();
      assert.match(await page.locator('#tour-title').innerText(), /need to a result/);
      await page.locator('#tour-back').click();
      assert.match(await page.locator('#tour-title').innerText(), /resource agent/);
      for (let i = 0; i < 3; i++) await page.locator('#tour-next').click();
      assert.match(await page.locator('#tour-count').innerText(), /STEP 4 OF 4/);
      assert.match(await page.locator('#tour-next').innerText(), /Finish tour/);
      await page.locator('#tour-next').click();
      assert.equal(await dialog.evaluate(el => el.open), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('bouncer:tour:v1')), 'seen');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await dialog.evaluate(el => el.open), false, 'tour does not reappear after completion');
      await page.locator('[data-open-tour]').click();
      assert.equal(await dialog.evaluate(el => el.open), true);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.evaluate(el => el.open), false);
      assert.equal(await page.locator('[data-open-tour]').evaluate(el => el === document.activeElement), true, 'focus returns to opener');

      // The workspace destinations actually switch views, work with browser
      // history, and keep a single visible section at each viewport size.
      const nav = width < 650 ? '.mobile-nav' : '.side-nav';
      const route = name => page.locator(`[data-route-view="${name}"]`);
      assert.equal(await route('overview').isVisible(), true);
      for (const [hash, name] of [['capabilities', 'resources'], ['guardrails', 'guardrails'], ['proof', 'proof'], ['connect', 'connect']]) {
        await page.locator(`${nav} a[href="#${hash}"]`).click();
        await route(name).waitFor({ state: 'visible' });
        assert.equal(await route(name).isVisible(), true, `${name} is visible at ${width}px`);
        assert.equal(await page.locator('[data-route-view]:visible').count(), 1, 'only one workspace view is visible');
        assert.equal(await page.locator(`${nav} a[href="#${hash}"]`).getAttribute('aria-current'), 'page');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflows at ${width}px`);
      }
      await page.goBack();
      await route('proof').waitFor({ state: 'visible' });
      assert.equal(await route('proof').isVisible(), true, 'Back returns to the preceding view');
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await route('proof').isVisible(), true, 'deep-linked view survives a refresh');

      // The picker itself opens without selecting a wallet or making writes.
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
      await page.locator('.top-connect').click();
      const picker = page.locator('#wallet-dialog');
      assert.equal(await picker.evaluate(el => el.open), true);
      assert.equal(await page.locator('[data-wallet-id]').count(), 7);
      assert.equal(await page.locator('[data-wallet-id="near-mobile"]').isEnabled(), true);
      assert.equal(await page.locator('[data-wallet-id="meteor-wallet"]').isEnabled(), true);
      assert.equal(await page.locator('[data-wallet-id="wallet-connect"]').isDisabled(), true, 'blank configuration must not connect');
      assert.match(await page.locator('#wallet-dialog-description').innerText(), /login message/);
      if (process.env.BOUNCER_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOUNCER_SCREENSHOTS, `wallet-picker-${width}.png`) });
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        assert.equal(await picker.evaluate(el => el.contains(document.activeElement)), true, 'focus stays in the wallet picker');
      }
      await page.keyboard.press('Escape');
      assert.equal(await picker.evaluate(el => el.open), false);
      assert.equal(await page.locator('.top-connect').evaluate(el => el === document.activeElement), true, 'picker returns focus');

      await page.locator(`${nav} a[href="#capabilities"]`).click();
      assert.equal(await page.locator('.resource-card').count(), 3);
      await page.locator('[data-resource-story="storage"]').click();
      assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
      await page.locator('[data-story-tab="storage"]').click();
      assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
      await page.locator('[data-story-tab="api"]').click();
      assert.match(await page.locator('#story-result').innerText(), /4 words and 27 bytes/);
      await page.locator('[data-story-tab="api"]').press('Home');
      assert.equal(await page.locator('[data-story-tab="compute"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflows at ${width}px`);
      await page.goto(`${url}#how-it-works`, { waitUntil: 'networkidle' });
      await route('guardrails').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#how-it-works').isVisible(), true, 'old flow links open the guardrails view');
      await page.goto(`${url}#resources`, { waitUntil: 'networkidle' });
      await route('resources').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#resources').isVisible(), true, 'old recorded-resource links still work');
      await page.goto(`${url}#constructor`, { waitUntil: 'networkidle' });
      await route('overview').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-route-view]:visible').count(), 1, 'unknown fragments safely fall back to overview');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('.hero-noise').evaluate(el => getComputedStyle(el).animationName), 'none', 'reduced motion disables decorative animation');
      assert.deepEqual(writes, [], 'tour and historical story must not send write requests');
      assert.deepEqual(pageErrors, []);
      if (process.env.BOUNCER_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOUNCER_SCREENSHOTS, `bouncer-${width}.png`), fullPage: true });
      console.log(`Tour, keyboard, historical story and layout passed at ${width}px`);
    } finally { await browser.close(); }
  }

  const browser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    // Mock ONLY the wallet executor, while exercising the real bundled NEAR
    // Connect, sandbox iframe, events, UI and no-add-key parameters.
    const body = mockMeteor('browser-test.testnet');
    await allowMockMeteor(page, body);
    await page.route('**/meteor-near-connect-latest.js*', async route => {
      calls.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/javascript', body });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click();
    await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('browser-test.testnet'));
    assert.match(await page.locator('#wallet-status').textContent(), /wallet-reported.*no vault or spending access/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /53a8b39d1aaaf067502c11e49ebb050c75df019e/);
    await page.locator('.top-connect').click();
    assert.match(await page.locator('#wallet-dialog-status').innerText(), /browser-test\.testnet/);
    assert.match(await page.locator('#wallet-dialog-title').innerText(), /Wallet connected/);
    await page.locator('#wallet-disconnect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('disconnected'));
    assert.deepEqual(errors, []);
    console.log('Real connector + sandbox bridge passed with a MOCK wallet executor (not a real sign-in).');
  } finally { await browser.close(); }

  // Exercise the exact production origin locally through intercepted static
  // assets and the real sandbox bridge. The wallet itself remains mocked.
  const productionBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await productionBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('https://bouncer-near.vercel.app/**', async route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (!allowed.has(name)) return route.abort();
      return route.fulfill({ status: 200, contentType: types[path.extname(name)], body: fs.readFileSync(path.join(web, name)) });
    });
    const body = mockMeteor('production-test.testnet');
    await allowMockMeteor(page, body);
    await page.route('**/meteor-near-connect-latest.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
    await page.goto('https://bouncer-near.vercel.app/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    await page.locator('.top-connect').click();
    await page.locator('[data-wallet-id="meteor-wallet"]').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('production-test.testnet'));
    assert.equal(await page.locator('[data-wallet-label]').first().innerText(), 'Connected');
    assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
    assert.match(await page.locator('.top-connect').getAttribute('aria-label'), /production-test\.testnet/);
    await page.locator('.top-connect').click();
    await page.locator('#wallet-disconnect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected.'));
    assert.match(await page.locator('#wallet-dialog-status').innerText(), /disconnected/i);
    console.log('Exact Vercel origin passed with mocked wallet executor; not a real sign-in or deployed-site test.');
  } finally { await productionBrowser.close(); }

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
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="meteor-wallet"]').click();
      const walletFrame = page.frameLocator('iframe').first();
      await walletFrame.getByRole('button', { name: 'Meteor Web' }).waitFor({ timeout: 20_000 });
      await walletFrame.getByRole('button', { name: 'Close Meteor Connect' }).click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cancelled or unavailable'));
      assert.deepEqual(errors, []);
      console.log('Pinned real Meteor wallet UI opened and cancelled; no account sign-in or upstream service was tested.');
    } finally { await browserReal.close(); }
  }

  // The actual separately built Intear adapter plus its pinned upstream picker
  // fixture, with a synthetic web wallet. This checks sandbox nesting and
  // permissions without opening or signing in to the provider's live service.
  const intearBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await intearBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], calls = [], consoleMessages = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
    await page.addInitScript(() => {
      window.__intearTopTrace = [];
      window.addEventListener('message', event => {
        if (event.data?.type === 'bouncer-test-intear-payload') window.__intearTestPayload = event.data.payload;
        if (event.data?.method === 'open') window.__intearTopTrace.push({ method: event.data.method, params: event.data.params, origin: event.data.origin });
      });
    });
    const picker = fs.readFileSync(new URL('../web-src/vendor/intear/web/public/hot-wallet-connector-iframe.html', import.meta.url));
    await page.context().route('https://wallet.intear.tech/**', route => {
      const url = new URL(route.request().url()); calls.push(url.pathname);
      if (url.pathname === '/hot-wallet-connector-iframe.html') return route.fulfill({ status: 200, contentType: 'text/html', body: picker });
      if (url.pathname === '/connect') return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>
        window.opener.postMessage({type:'ready'}, '*');
        window.addEventListener('message', event => {
          if (event.data.type !== 'signIn') return;
          window.opener.postMessage({type:'bouncer-test-intear-payload',payload:event.data.data}, '*');
          window.opener.postMessage({type:'connected',accountId:'intear-synthetic.testnet',walletUrl:'https://wallet.intear.tech'}, '*');
        });
      </script>` });
      throw new Error(`Unexpected Intear call: ${url.pathname}`);
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="intear-wallet"]').disabled);
    await page.locator('.top-connect').click();
    await page.locator('[data-wallet-id="intear-wallet"]').click();
    const pickerHandle = await page.frameLocator('iframe').first().locator('iframe').elementHandle({ timeout: 20_000 });
    const pickerDocument = await pickerHandle.contentFrame();
    assert.ok(pickerDocument, 'Intear picker document exists');
    // The upstream picker must receive its connector origin before it can
    // proxy a popup. Automated clicks can otherwise outrun initialization.
    await pickerDocument.waitForFunction(() => typeof hotConnector !== 'undefined' && !!hotConnector.origin && !!hotConnector.location, null, { timeout: 20_000 });
    await pickerDocument.evaluate(() => {
      window.__pickerInputTrace = [];
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
        document.addEventListener(type, event => window.__pickerInputTrace.push({ type, target: event.target?.className || event.target?.tagName }), true);
      }
    });
    const pickerFrame = page.frameLocator('iframe').first().frameLocator('iframe');
    const webCard = pickerFrame.locator('.card-title').getByText('Web', { exact: true }).locator('..');
    if (process.env.BOUNCER_INTEAR_PROGRAMMATIC_TEST !== '1') {
      await webCard.tap({ timeout: 20_000 }).catch(async error => {
        console.error('Intear browser diagnostic:', { calls, errors, consoleMessages, status: await page.locator('#wallet-status').textContent(), frames: page.frames().map(frame => frame.url()) });
        throw error;
      });
      // Some hosted headless Chromium versions report a successful nested-frame
      // tap without delivering any input events. Preserve the protocol test,
      // but say explicitly when it needed programmatic activation.
      if (!pickerDocument.isDetached()) {
        const delivered = await pickerDocument.waitForFunction(() => window.__pickerInputTrace.some(event => event.type === 'click'), null, { timeout: 1000 }).then(() => true, () => false);
        if (!delivered && !pickerDocument.isDetached()) {
          console.warn('Intear nested-frame touch was not delivered; using DOM activation for the synthetic protocol check. Touch input was not verified in this run.');
          await webCard.evaluate(element => element.click());
        }
      }
    } else {
      console.warn('Using DOM activation for the synthetic Intear protocol check.');
      await webCard.evaluate(element => element.click());
    }
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('intear-synthetic.testnet'), null, { timeout: 20_000 }).catch(async error => {
      console.error('Intear connection diagnostic:', {
        calls, errors, consoleMessages,
        status: await page.locator('#wallet-status').textContent(),
        dialogStatus: await page.locator('#wallet-dialog-status').textContent(),
        payload: await page.evaluate(() => window.__intearTestPayload || null),
        topTrace: await page.evaluate(() => window.__intearTopTrace),
        pickerState: await pickerDocument.evaluate(() => ({
          origin: hotConnector.origin, location: hotConnector.location,
          waiting: getComputedStyle(document.querySelector('#waiting-screen')).display,
          hasPopup: !!currentWebPopup, inputs: window.__pickerInputTrace,
          clickHandler: typeof document.querySelector('.card').onclick,
        })),
        frames: page.frames().map(frame => frame.url()),
        pages: page.context().pages().map(item => ({ url: item.url(), closed: item.isClosed() })),
      });
      throw error;
    });
    const request = await page.evaluate(() => window.__intearTestPayload);
    assert.equal(request.networkId, 'testnet');
    assert.equal(request.contractId, undefined);
    assert.equal(JSON.parse(request.message).functionCallPublicKey, undefined);
    assert.ok(calls.includes('/connect'));
    await page.locator('.top-connect').click();
    await page.locator('#wallet-disconnect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected.'));
    assert.match(await page.locator('#wallet-status').textContent(), /disconnected/i);
    assert.deepEqual(errors, []);
    console.log('Vendored Intear executor and pinned picker fixture connected to a MOCK web wallet without AddKey; no real wallet was tested.');
  } finally { await intearBrowser.close(); }

  if (process.env.BOUNCER_CLI_EXECUTOR) {
    const executor = fs.readFileSync(process.env.BOUNCER_CLI_EXECUTOR);
    assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), WALLET_EXECUTOR_SHA256['near-cli']);
    const cliBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await cliBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const errors = [], writes = [], rpc = [];
      const pair = KeyPair.fromRandom('ed25519'); // synthetic key, never submitted to a real network
      const publicKey = pair.getPublicKey().toString();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.url()); });
      await page.route('**/near-cli-connect/*/dist/near-cli.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }));
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      await page.route('https://test.rpc.fastnear.com/**', async route => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = route.request().postDataJSON(); rpc.push(body);
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { permission: 'FullAccess' } }) });
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-cli"]').disabled);
      async function submitCliSignature(corrupt = false) {
        await page.locator('.top-connect').click();
        await page.locator('[data-wallet-id="near-cli"]').click();
        const frame = page.frameLocator('iframe').first();
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
        if (!corrupt && process.env.BOUNCER_REAL_CLI_PATH) {
          // An ephemeral, synthetic credential exercises the real CLI command
          // offline. Never use, print, or copy a user's key in this test.
          const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-cli-fixture-'));
          try {
            const dir = path.join(home, '.near-credentials', 'testnet');
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(dir, 'cli-synthetic.testnet.json'), JSON.stringify({ account_id: 'cli-synthetic.testnet', public_key: publicKey, private_key: pair.toString() }), { mode: 0o600 });
            const stdout = execFileSync(process.env.BOUNCER_REAL_CLI_PATH, [
              'message', 'sign-nep413', 'utf8', message, 'nonce', nonce, 'recipient', recipient,
              'sign-as', 'cli-synthetic.testnet', 'sign-with-legacy-keychain', 'network-config', 'testnet',
            ], { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1' }, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            output = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
            assert.equal(output.accountId, 'cli-synthetic.testnet');
            assert.equal(output.publicKey, publicKey);
            assert.match(output.signature, /^ed25519:/);
          } finally { fs.rmSync(home, { recursive: true, force: true }); }
        }
        await frame.locator('#sign-output').fill(JSON.stringify(output));
        await frame.locator('#submit-sign-btn').click();
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
      console.log(process.env.BOUNCER_REAL_CLI_PATH
        ? 'Real near-cli-rs signed a synthetic off-chain login; mock RPC accepted it and forgery was rejected. No real wallet or transaction was used.'
        : 'Pinned NEAR CLI executor + synthetic signer and RPC: valid off-chain login accepted, forgery rejected; no real CLI wallet or transaction tested.');
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
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-mobile"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="near-mobile"]').click();
      const mobileFrame = page.frameLocator('iframe').first();
      await mobileFrame.locator('#qr-code svg').waitFor({ timeout: 20_000 }).catch(async error => {
        console.error('Mobile browser diagnostic:', { calls, errors, consoleMessages, failures, status: await page.locator('#wallet-status').textContent(), frames: page.frames().map(frame => frame.url()) });
        throw error;
      });
      assert.equal(messageRequest.network, 'testnet');
      assert.equal(messageRequest.receiver, new URL(url).host);
      assert.equal(messageRequest.nonce.length, 32);
      assert.match(messageRequest.message, /login message does not approve a transaction, transfer funds, or add an access key/i);
      // The upstream generic label is misleading for this message-only flow.
      const mobileButton = mobileFrame.locator('#approve-button');
      assert.equal(await mobileButton.innerText(), 'Open NEAR Mobile');
      // The phone button must be permitted to open the exact signer deep-link.
      // Headless Chromium can miss taps inside its sandboxed frame, so retain
      // the protocol check with an explicitly reported programmatic fallback.
      let popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
      await mobileButton.tap();
      let popup = await popupPromise;
      if (!popup) {
        console.warn('Mobile nested-frame touch did not open a popup; using DOM activation for the synthetic protocol check. Touch input was not verified in this run.');
        popupPromise = page.waitForEvent('popup', { timeout: 10_000 });
        await mobileButton.evaluate(element => element.click());
        popup = await popupPromise;
      }
      await popup.waitForURL(url => url.hostname === 'near-mobile-signer-backend_production.peersyst.tech', { timeout: 10_000 }).catch(error => {
        console.error('Mobile deep-link diagnostic:', { popupUrl: popup.url(), calls, errors, consoleMessages, failures });
        throw error;
      });
      await popup.close();
      approved = true;
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('synthetic.testnet'), null, { timeout: 20_000 });
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
      await page.frameLocator('iframe').first().locator('#qr-code svg').waitFor({ timeout: 20_000 });
      approved = true;
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cancelled or unavailable'), null, { timeout: 20_000 });
      assert.equal(await page.locator('#wallet-disconnect').isVisible(), false);
      assert.equal(rpc.length, 1, 'invalid signature must not reach RPC verification');
      assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.pathname), ['/api/signer-request/message', '/api/signer-request/message']);
      assert.deepEqual(errors, []);
      console.log('Pinned NEAR Mobile executor verified a synthetic signed login and rejected a forgery; QR/deep-link and local disconnect passed. No real wallet or transaction tested.');
    } finally { await mobileBrowser.close(); }
  }

  const browserError = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    for (const tampered of [false, true]) {
      const page = await browserError.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const poison = `window.parent.postMessage({ type: 'bouncer-test-poison' }, '*'); window.selector.ready({});`;
      await page.addInitScript(() => window.addEventListener('message', event => { if (event.data?.type === 'bouncer-test-poison') window.__untrustedExecuted = true; }));
      await page.route('**/meteor-near-connect-latest.js*', route => route.fulfill(tampered
        ? { status: 200, contentType: 'text/javascript', body: poison }
        : { status: 503, body: 'unavailable' }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(async poison => {
        const open = indexedDB.open('hot-connector', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('wallets');
        const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        const tx = db.transaction('wallets', 'readwrite');
        tx.objectStore('wallets').put(poison, 'meteor-wallet:1.1.1');
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
      }, poison);
      await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
      await page.locator('.top-connect').click();
      await page.locator('[data-wallet-id="meteor-wallet"]').click();
      await page.waitForFunction(() => document.querySelector('#wallet-dialog-status').textContent.includes('cancelled or unavailable'));
      assert.equal(await page.locator('#wallet-dialog').evaluate(el => el.open), true);
      assert.equal(await page.locator('#wallet-disconnect').isVisible(), false);
      assert.equal(await page.evaluate(() => window.__untrustedExecuted === true), false, 'stale or tampered executor must not run');
      assert.deepEqual(errors, [], 'executor failure must not leave an unhandled background fetch');
      await page.close();
    }
    console.log('Wallet executor outage and tampered response fail closed; poisoned IndexedDB is ignored.');
  } finally { await browserError.close(); }

  // Render the actual bundled QR library with a synthetic WalletConnect
  // client. No Reown relay or real wallet is contacted by this browser test.
  const wcBrowser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await wcBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [], writes = []; let bundleLoads = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    await page.route('**/walletconnect-config.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projectId: '1234567890abcdef1234567890abcdef' }) }));
    await page.route('**/walletconnect.bundle.js?*', route => {
      if (route.request().url().includes('?real-fixture')) return route.continue();
      bundleLoads++;
      const body = `import { renderPairingCode } from './walletconnect.bundle.js?real-fixture';
        export { renderPairingCode };
        export async function connect(options) {
          window.__wcApprove = null;
          window.__wcInputs = { projectId: options.projectId, origin: options.origin };
          await options.onUri('wc:' + 'a'.repeat(64) + '@2?relay-protocol=irn&symKey=' + 'b'.repeat(64));
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            window.__wcApprove = () => resolve({ accountId: 'synthetic.testnet', async disconnect() { window.__wcDisconnected = true; } });
          });
        }`;
      return route.fulfill({ status: 200, contentType: 'text/javascript', body });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="wallet-connect"]').disabled);
    assert.equal(bundleLoads, 0, 'WalletConnect code is lazy-loaded');
    await page.locator('.top-connect').click();
    await page.locator('[data-wallet-id="wallet-connect"]').click();
    await page.locator('#walletconnect-qr').waitFor({ state: 'visible' });
    assert.equal(bundleLoads, 1);
    assert.match(await page.locator('#walletconnect-open').getAttribute('href'), /^wc:[a-f0-9]{64}@2\?/);
    assert.equal(await page.evaluate(() => {
      const canvas = document.querySelector('#walletconnect-canvas');
      const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0, light = 0;
      for (let i = 0; i < rgba.length; i += 4) { if (rgba[i] < 80) dark++; if (rgba[i] > 230) light++; }
      return dark > 500 && light > 500;
    }), true, 'real QR library renders visible dark and light modules');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'pairing view does not overflow');
    await page.locator('#walletconnect-cancel').click();
    await page.locator('[data-wallet-id="wallet-connect"]').waitFor({ state: 'visible' });
    assert.match(await page.locator('#wallet-dialog-status').innerText(), /cancelled/i);
    assert.equal(await page.locator('#walletconnect-open').getAttribute('href'), null, 'pairing secret is removed on cancel');
    await page.locator('[data-wallet-id="wallet-connect"]').click();
    await page.locator('#walletconnect-qr').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof window.__wcApprove === 'function');
    await page.evaluate(() => window.__wcApprove());
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('synthetic.testnet'));
    await page.locator('.top-connect').click();
    await page.locator('#wallet-disconnect').click();
    assert.equal(await page.evaluate(() => window.__wcDisconnected), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log('Synthetic WalletConnect pairing rendered the real QR library, cancelled and disconnected; no live relay or wallet was tested.');
  } finally { await wcBrowser.close(); }

  const browser2 = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await browser2.newPage();
    await page.goto(url + 'embed.html', { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe');
    await frame.locator('.top-connect').click();
    assert.equal(await frame.locator('[data-wallet-id="meteor-wallet"]').isDisabled(), true);
    assert.match(await frame.locator('#wallet-dialog-status').innerText(), /new tab/);
    assert.equal(await frame.locator('#wallet-open-site').isVisible(), true);
    console.log('Embedded preview offers a direct top-level link instead of a wallet session.');
  } finally { await browser2.close(); }
} finally { await new Promise(resolve => httpServer.close(resolve)); }
