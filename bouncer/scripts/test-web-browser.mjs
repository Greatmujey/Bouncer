// Browser smoke test for a locally served static build. Wallet executor is
// deliberately mocked: this does NOT claim a real wallet sign-in was tested.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
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

try {
  for (const width of [320, 390, 1440]) {
    const browser = await chromium.launch({ executablePath, args: browserArgs, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 650, hasTouch: width < 650 });
      const pageErrors = [], writes = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
      await page.goto(url, { waitUntil: 'networkidle' });
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
      assert.equal(await page.locator('.resource-card').count(), 3);
      await page.locator('[data-story-tab="storage"]').click();
      assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
      await page.locator('[data-story-tab="api"]').click();
      assert.match(await page.locator('#story-result').innerText(), /4 words and 27 bytes/);
      await page.locator('[data-story-tab="api"]').press('Home');
      assert.equal(await page.locator('[data-story-tab="compute"]').getAttribute('aria-selected'), 'true');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflows at ${width}px`);
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
    await page.route('**/meteor-near-connect-latest.js?*', async route => {
      calls.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.selector.ready({
        async signIn(params) { if (params.network !== 'testnet' || params.addFunctionCallKey) throw new Error('unsafe request'); return [{ accountId: 'browser-test.testnet' }]; },
        async signOut(params) { if (params.network !== 'testnet') throw new Error('wrong network'); },
        async getAccounts() { return [{ accountId: 'browser-test.testnet' }]; }
      });` });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('#wallet-connect').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#wallet-connect').disabled);
    await page.locator('#wallet-connect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('browser-test.testnet'));
    assert.match(await page.locator('#wallet-status').innerText(), /wallet-reported.*no vault or spending access/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /53a8b39d1aaaf067502c11e49ebb050c75df019e/);
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
    await page.route('**/meteor-near-connect-latest.js?*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `window.selector.ready({
      async signIn(params) { if (params.network !== 'testnet' || params.addFunctionCallKey) throw new Error('unsafe request'); return [{ accountId: 'production-test.testnet' }]; },
      async signOut() {}, async getAccounts() { return [{ accountId: 'production-test.testnet' }]; }
    });` }));
    await page.goto('https://bouncer-near.vercel.app/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#wallet-connect').disabled);
    await page.locator('#wallet-connect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('production-test.testnet'));
    assert.match(await page.locator('[data-wallet-label]').first().innerText(), /Account connected/);
    await page.locator('#wallet-disconnect').click();
    assert.match(await page.locator('#wallet-status').innerText(), /disconnected/i);
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
      await page.route('**/meteor-near-connect-latest.js?*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }));
      await page.route('https://mc.meteorwallet.app/**', route => route.fulfill({ status: 503, body: 'blocked in browser test' }));
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => !document.querySelector('#wallet-connect').disabled);
      await page.locator('#wallet-connect').click();
      const walletFrame = page.frameLocator('iframe').first();
      await walletFrame.getByRole('button', { name: 'Meteor Web' }).waitFor({ timeout: 20_000 });
      await walletFrame.getByRole('button', { name: 'Close Meteor Connect' }).click();
      await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cancelled or unavailable'));
      assert.deepEqual(errors, []);
      console.log('Pinned real Meteor wallet UI opened and cancelled; no account sign-in or upstream service was tested.');
    } finally { await browserReal.close(); }
  }

  const browserError = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await browserError.newPage();
    await page.route('**/meteor-near-connect-latest.js?*', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#wallet-connect').disabled);
    await page.locator('#wallet-connect').click();
    await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('cancelled or unavailable'));
    assert.equal(await page.locator('#wallet-disconnect').isVisible(), false);
    console.log('Wallet executor outage fails closed without a fake connection.');
  } finally { await browserError.close(); }

  const browser2 = await chromium.launch({ executablePath, args: browserArgs, headless: true });
  try {
    const page = await browser2.newPage();
    await page.goto(url + 'embed.html', { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe');
    assert.equal(await frame.locator('#wallet-connect').isDisabled(), true);
    assert.match(await frame.locator('#wallet-status').innerText(), /new tab/);
    assert.equal(await frame.locator('#wallet-open-site').isVisible(), true);
    console.log('Embedded preview offers a direct top-level link instead of a wallet session.');
  } finally { await browser2.close(); }
} finally { await new Promise(resolve => httpServer.close(resolve)); }
