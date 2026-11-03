// Optional, no-credential probe of Meteor's real testnet login UI. It does not
// import or connect a wallet, solve challenges, sign, or submit transactions.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const playwright = process.env.BOUNCER_PLAYWRIGHT_PATH;
const executorPath = process.env.BOUNCER_METEOR_EXECUTOR;
if (!playwright || !executorPath) throw new Error('Provide BOUNCER_PLAYWRIGHT_PATH and BOUNCER_METEOR_EXECUTOR');
const { chromium } = await import(pathToFileURL(path.resolve(playwright)).href);
const executor = fs.readFileSync(executorPath);
assert.equal(crypto.createHash('sha256').update(executor).digest('hex'), 'b55347ec700b9d55b71aa6450aac24548045cb4cf0005700dab08e5326c7cfab');
const web = fileURLToPath(new URL('../web/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const filename = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || !fs.existsSync(path.join(web, filename))) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream' });
  fs.createReadStream(path.join(web, filename)).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/google-chrome-stable', args: ['--no-sandbox'], headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/meteor-near-connect-latest.js*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: executor }));
  const requested = process.env.BOUNCER_WALLET_PROBE_ORIGIN;
  if (requested && requested !== 'https://bouncer-near.vercel.app/') throw new Error('unexpected wallet probe origin');
  const target = requested || `http://127.0.0.1:${server.address().port}/`;
  await page.goto(target, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="meteor-wallet"]').click();
  const button = page.frameLocator('iframe').first().getByRole('button', { name: 'Meteor Web' });
  await button.waitFor({ timeout: 30_000 });
  const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  await button.click();
  const popup = await popupPromise;
  await popup.waitForURL(url => url.hostname === 'wallet.meteorwallet.app', { timeout: 30_000 });
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForFunction(() => document.querySelectorAll('button, input').length > 0, null, { timeout: 20_000 }).catch(() => {});
  const location = new URL(popup.url());
  const controls = await popup.locator('button:visible, input:visible, a:visible').evaluateAll(elements => elements.slice(0, 25).map(el => ({
    tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim().slice(0, 70), type: el.getAttribute('type') || '',
  })));
  const text = (await popup.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1000);
  const summary = JSON.stringify({ origin: location.origin, path: location.pathname, controls, text }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=Meteor testnet external-page probe::${summary}`);
  if (/sorry, you have been blocked|cloudflare ray id|recaptcha requires verification/i.test(text)) {
    console.log('::warning title=Meteor wallet unavailable to this runner::The external wallet returned an access block or challenge. No wallet sign-in was tested.');
  } else {
    console.log('The external page loaded; no account, secret, sign-in, or transaction was tested.');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
