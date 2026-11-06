// Exercise the real QR renderer and picker with synthetic WalletConnect and
// Google responses. No relay, user wallet, Google login or transaction is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const requireWallet = createRequire(new URL('../walletconnect/package.json', import.meta.url));
const jsQR = requireWallet('jsqr');
const { PNG } = requireWallet('pngjs');
const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const allowed = new Set(PUBLIC_WEB_FILES);
const server = http.createServer((req, res) => {
  const file = new URL(req.url, 'http://test.invalid').pathname.slice(1) || 'index.html';
  if (!allowed.has(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(web, file)).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
const fakeProject = '1234567890abcdef1234567890abcdef';
const fakeUri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const errors = [], writes = []; let bundleLoads = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
  await page.route('**/api/google-session**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { sub: '123456789', name: 'Synthetic Google' } }),
  }));
  await page.route('**/walletconnect-config.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projectId: fakeProject }) }));
  await page.route('**/walletconnect.bundle.js?*', route => {
    if (route.request().url().includes('?real-fixture')) return route.continue();
    bundleLoads++;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
      import { renderPairingCode } from './walletconnect.bundle.js?real-fixture';
      export { renderPairingCode };
      export async function connect(options) {
        window.__wcApprove = null;
        await options.onUri(${JSON.stringify(fakeUri)});
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          window.__wcApprove = () => resolve({ accountId: 'synthetic.testnet', async disconnect() { window.__wcDisconnected = true; } });
        });
      }` });
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="wallet-connect"]').disabled);
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed in as'));
  assert.equal(bundleLoads, 0, 'WalletConnect SDK loads only after the user chooses it');
  await page.locator('.top-connect').click();
  assert.equal(await page.locator('#google-signout').isVisible(), true);
  assert.ok(await page.locator('[data-wallet-id="wallet-connect"]').evaluate((node, other) => Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await page.locator('#google-signout').elementHandle()));
  await page.locator('[data-wallet-id="wallet-connect"]').click();
  await page.locator('#walletconnect-qr').waitFor({ state: 'visible' });
  assert.equal(bundleLoads, 1);
  assert.equal(await page.locator('.google-picker').isVisible(), false, 'Google is hidden during QR pairing');
  assert.match(await page.locator('.walletconnect-warning').innerText(), /encrypted messages pass through Bouncer’s server.*pairing keys stay in your browser/i);
  assert.match(await page.locator('#walletconnect-open').getAttribute('href'), /^wc:[a-f0-9]{64}@2\?/);
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 650 }, { width: 683, height: 304 }, { width: 500, height: 304 }]) {
    await page.setViewportSize(viewport);
    const image = PNG.sync.read(await page.locator('#walletconnect-qr').screenshot());
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    assert.equal(decoded?.data, fakeUri, `the real QR must decode at ${viewport.width}x${viewport.height}`);
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('#wallet-dialog').getBoundingClientRect();
      return ['#walletconnect-qr', '#walletconnect-cancel'].every(selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.left >= dialog.left && rect.right <= dialog.right && rect.top >= dialog.top && rect.bottom <= dialog.bottom;
      });
    }), true, `QR and navigation fit at ${viewport.width}x${viewport.height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#walletconnect-cancel').click();
  await page.locator('[data-wallet-id="wallet-connect"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('#wallet-dialog-status').innerText(), /cancelled/i);
  assert.equal(await page.locator('#walletconnect-open').getAttribute('href'), null, 'cancellation clears the pairing URI');
  assert.equal(await page.locator('#google-signout').isVisible(), true, 'cancelling a wallet does not sign out Google');
  await page.locator('[data-wallet-id="wallet-connect"]').click();
  await page.locator('#walletconnect-qr').waitFor({ state: 'visible' });
  await page.waitForFunction(() => typeof window.__wcApprove === 'function');
  await page.evaluate(() => window.__wcApprove());
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('synthetic.testnet'));
  await page.locator('.top-connect').click();
  assert.equal(await page.locator('#google-signout').isVisible(), true, 'wallet and Google sessions are independent');
  await page.locator('#wallet-disconnect').click();
  assert.equal(await page.evaluate(() => window.__wcDisconnected), true);
  assert.equal(await page.locator('#google-signout').isVisible(), true, 'disconnecting the wallet does not sign out Google');
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, [], 'the synthetic account-only flow sends no mutation');
  await page.close();

  // A stalled module load must remain cancellable and retry with a fresh URL.
  const retryPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await retryPage.clock.install();
  const urls = [], retryErrors = [];
  retryPage.on('pageerror', error => retryErrors.push(error.message));
  await retryPage.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await retryPage.route('**/walletconnect-config.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projectId: fakeProject }) }));
  await retryPage.route('**/walletconnect.bundle.js?*', route => {
    const requested = route.request().url();
    if (requested.includes('?real-fixture')) return route.continue();
    urls.push(requested);
    if (urls.length === 1) return new Promise(() => {});
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: `
      import { renderPairingCode } from './walletconnect.bundle.js?real-fixture'; export { renderPairingCode };
      export async function connect(options) {
        await options.onUri(${JSON.stringify(fakeUri)});
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }` });
  });
  await retryPage.goto(url, { waitUntil: 'domcontentloaded' });
  await retryPage.waitForFunction(() => !document.querySelector('[data-wallet-id="wallet-connect"]').disabled);
  await retryPage.locator('.top-connect').click();
  await retryPage.locator('[data-wallet-id="wallet-connect"]').click();
  await retryPage.locator('#walletconnect-loading').waitFor({ state: 'visible' });
  assert.equal(await retryPage.locator('#walletconnect-qr').isVisible(), false);
  await retryPage.clock.fastForward(50_100);
  await retryPage.locator('#walletconnect-error').waitFor({ state: 'visible' });
  assert.equal(await retryPage.locator('#walletconnect-open').getAttribute('href'), null);
  await retryPage.locator('#walletconnect-retry').click();
  await retryPage.locator('#walletconnect-qr').waitFor({ state: 'visible' });
  assert.equal(urls.length, 2);
  assert.match(urls[1], /[&?]retry=1(?:&|$)/);
  await retryPage.locator('#walletconnect-cancel').click();
  await retryPage.locator('[data-wallet-id="wallet-connect"]').waitFor({ state: 'visible' });
  assert.equal(await retryPage.locator('#walletconnect-open').getAttribute('href'), null);
  assert.deepEqual(retryErrors, []);
  await retryPage.close();
  console.log('Synthetic WalletConnect QR, cancellation, retry and Google-session independence passed. No live relay or real wallet was tested.');
} finally {
  await browser.close();
  server.close();
  await once(server, 'close');
}
