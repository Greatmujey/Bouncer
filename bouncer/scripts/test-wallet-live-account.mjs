// Opt-in public read-only phone-sized browser smoke. This contacts only the
// NEAR testnet RPC for the selected public account; no wallet, key or signing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';
import { TESTNET_RPC, CIRCLE_TEST_USDC } from '../web-src/account-view.mjs';

const account = 'great_mujey.testnet';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const allowed = new Set(PUBLIC_WEB_FILES);
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!allowed.has(name)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(name)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(web, name)).pipe(res);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const req = route.request(), target = new URL(req.url());
    if (target.origin === new URL(TESTNET_RPC).origin) {
      if (req.method() === 'OPTIONS') return route.continue();
      const body = req.postDataJSON();
      if (req.method() !== 'POST' || body?.method !== 'query' ||
          !['view_account', 'call_function'].includes(body.params?.request_type) ||
          (body.params.request_type === 'view_account' && body.params.account_id !== account) ||
          (body.params.request_type === 'call_function' && (body.params.account_id !== CIRCLE_TEST_USDC || body.params.method_name !== 'ft_balance_of'))) {
        return route.abort('blockedbyclient');
      }
      requests.push(body);
      return route.continue();
    }
    if (target.origin === `http://127.0.0.1:${server.address().port}` && req.method() === 'GET') return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-cli"]').disabled);
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="near-cli"]').click();
  await page.locator('#wallet-account-id').fill(account);
  await page.locator('#wallet-account-id').press('Enter');
  await page.waitForFunction(() => /final block|Could not load|No native account/i.test(document.querySelector('#wallet-account-balance-status').textContent), { timeout: 30_000 });
  const status = await page.locator('#wallet-account-balance-status').textContent();
  assert.match(status, /Public testnet RPC · final block \d+/);
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'view-only');
  assert.equal(await page.locator('#wallet-account-name').textContent(), account);
  assert.match(await page.locator('#wallet-account-near').textContent(), /^≈?\d+(?:\.\d+)?$/);
  assert.match(await page.locator('#wallet-account-usdc').textContent(), /^\d+(?:\.\d+)?$/);
  assert.deepEqual(requests.map(request => request.params.request_type), ['view_account', 'call_function']);
  assert.equal(requests[0].params.finality, 'final');
  assert.equal(typeof requests[1].params.block_id, 'string');
  assert.deepEqual(errors, []);
  console.log(`Public ${account}: ${await page.locator('#wallet-account-near').textContent()} NEAR (includes storage reserve), ${await page.locator('#wallet-account-usdc').textContent()} Circle test USDC. ${status} No wallet, signature or transaction was used.`);
} finally { await browser.close(); server.close(); }
