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

const account = 'great_mujey.testnet', otherAccount = 'great_mujey.near';
const allowedAccounts = new Set([account, otherAccount]);
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
      const isBlock = body?.method === 'block' && body.params?.finality === 'final';
      const isAccount = body?.method === 'query' && body.params?.request_type === 'view_account' && allowedAccounts.has(body.params.account_id);
      let isToken = false;
      try {
        isToken = body?.method === 'query' && body.params?.request_type === 'call_function' && body.params.account_id === CIRCLE_TEST_USDC &&
          body.params.method_name === 'ft_balance_of' && allowedAccounts.has(JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8')).account_id);
      } catch { /* malformed token view is blocked */ }
      if (req.method() !== 'POST' || !(isBlock || isAccount || isToken)) return route.abort('blockedbyclient');
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
  assert.deepEqual(requests.map(request => request.method === 'block' ? 'block' : request.params.request_type), ['block', 'view_account', 'call_function']);
  assert.equal(requests[0].params.finality, 'final');
  assert.equal(requests[1].params.block_id, requests[2].params.block_id);
  console.log(`Public ${account}: ${await page.locator('#wallet-account-near').textContent()} NEAR (includes storage reserve), ${await page.locator('#wallet-account-usdc').textContent()} Circle test USDC. ${status}`);
  // The exact .near spelling is a separate ledger entry on testnet. Check the
  // UI displays its token view even if the native account is absent, without
  // claiming that a token-ledger entry proves that anyone can spend it.
  await page.locator('.top-connect').click();
  await page.locator('#wallet-disconnect').click();
  await page.locator('[data-wallet-id="near-cli"]').click();
  await page.locator('#wallet-account-id').fill(otherAccount);
  await page.locator('#wallet-account-id').press('Enter');
  await page.waitForFunction(() => /final block|Could not load/i.test(document.querySelector('#wallet-account-balance-status').textContent), { timeout: 30_000 });
  const otherStatus = await page.locator('#wallet-account-balance-status').textContent();
  assert.match(otherStatus, /final block \d+/i);
  assert.equal(await page.locator('#wallet-account-name').textContent(), otherAccount);
  assert.match(await page.locator('#wallet-account-usdc').textContent(), /^\d+(?:\.\d+)?$/);
  if (/No native account/i.test(otherStatus)) assert.match(otherStatus, /not proof of control or spendability/);
  assert.deepEqual(requests.slice(3).map(request => request.method === 'block' ? 'block' : request.params.request_type), ['block', 'view_account', 'call_function']);
  assert.equal(requests[4].params.account_id, otherAccount);
  assert.equal(requests[4].params.block_id, requests[5].params.block_id);
  assert.deepEqual(errors, []);
  console.log(`Public ${otherAccount}: native ${await page.locator('#wallet-account-near').textContent()}, Circle ledger ${await page.locator('#wallet-account-usdc').textContent()} test USDC. ${otherStatus} No wallet, signature or transaction was used.`);
} finally { await browser.close(); server.close(); }
