// Browser checks use synthetic Google responses only. They do NOT prove a live
// Google login or send a NEAR transaction. The production backend is separately
// tested with generated RSA keys in google-session.test.mjs.
import assert from 'node:assert/strict';
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
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const allowed = new Set(PUBLIC_WEB_FILES);
const server = http.createServer((req, res) => {
  const filename = new URL(req.url, 'http://test.invalid').pathname.slice(1) || 'index.html';
  if (!allowed.has(filename)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(filename)], 'cache-control': 'no-store' });
  fs.createReadStream(path.join(web, filename)).pipe(res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
try {
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 650, hasTouch: width < 650, reducedMotion: 'reduce' });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`); });
    await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Google sign-in is not configured.' }) }));
    await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(await page.title(), 'Bouncer — A workspace for autonomous agents');
    assert.equal(await page.locator('#welcome-tour').evaluate(el => el.open), false);
    assert.equal(await page.locator('[data-route-view="workspace"]').isVisible(), true);
    assert.equal(await page.locator('[data-wallet-open], #wallet-dialog, #walletconnect-canvas').count(), 0);
    const brand = page.locator(width < 650 ? '.mobile-brand .brand-mark svg' : '.brand .brand-mark svg');
    assert.equal(await brand.isVisible(), true);
    assert.equal(await brand.locator('use').getAttribute('href'), '#i-bouncer');
    await page.locator('[data-open-tour]').click();
    assert.match(await page.locator('#tour-count').innerText(), /STEP 1 OF 4/);
    await page.locator('#tour-next').click();
    await page.locator('#tour-next').click();
    assert.match(await page.locator('#tour-description').innerText(), /Google/);
    await page.locator('#tour-skip').click();
    await page.locator('[data-workspace-resource="storage"]').click();
    assert.equal(await page.locator('[data-workspace-visual]').getAttribute('data-resource'), 'storage');
    assert.match(await page.locator('[data-workspace-description]').innerText(), /Keep what your agent creates/);
    const angles = await page.locator('.orbit-node').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), parent = node.closest('.workspace-orbit').getBoundingClientRect();
      return Math.atan2(box.y + box.height / 2 - (parent.y + parent.height / 2), box.x + box.width / 2 - (parent.x + parent.width / 2));
    }).sort((a, b) => a - b));
    assert.equal(angles.length, 3);
    const gaps = [angles[1] - angles[0], angles[2] - angles[1], 2 * Math.PI + angles[0] - angles[2]];
    for (const gap of gaps) assert.ok(Math.abs(gap - 2 * Math.PI / 3) < .08, 'resource icons should be evenly spaced');
    await page.locator('.top-connect').click();
    await page.locator('[data-route-view="connect"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('not configured'));
    assert.equal(await page.locator('#google-signout').isVisible(), false);
    assert.match(await page.locator('.account-card').innerText(), /does not create a vault, grant spending access or send a transaction/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}`);
    assert.deepEqual(writes, [], 'browsing without sign-in must not send mutations');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // This mock is injected only by the test route; it is never shipped or used
  // in production. It checks rendering, callback, restore and sign-out UI.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], calls = []; let loggedIn = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/google-session**', async route => {
    const request = route.request(), parsed = new URL(request.url());
    calls.push(`${request.method()} ${parsed.search}`);
    const user = { sub: '100000000000000000', name: '<img src=x> Test Person', email: 'test@example.test' };
    if (request.method() === 'POST') {
      assert.deepEqual(request.postDataJSON(), { credential: 'synthetic-test-credential' }); loggedIn = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user }) });
    }
    if (request.method() === 'DELETE') { loggedIn = false; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":false}' }); }
    if (parsed.searchParams.has('challenge')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clientId: '123-test.apps.googleusercontent.com', nonce: 'a'.repeat(43) }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: loggedIn, ...(loggedIn ? { user } : {}) }) });
  });
  await page.route('https://accounts.google.com/gsi/client', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: `
    window.google = { accounts: { id: {
      initialize(config) { window.__testGoogleCallback = config.callback; },
      renderButton(target) { const b = document.createElement('button'); b.textContent = 'Synthetic Google test'; b.onclick = () => window.__testGoogleCallback({ credential: 'synthetic-test-credential' }); target.append(b); },
      disableAutoSelect() {}
    } } };` }));
  await page.goto(`${url}#connect`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Synthetic Google test' }).click();
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed in as'));
  assert.match(await page.locator('#account-status').innerText(), /<img src=x> Test Person/);
  assert.equal(await page.locator('#account-status img').count(), 0, 'profile is text, not HTML');
  assert.equal(await page.locator('[data-account-label]').innerText(), 'My account');
  assert.equal(await page.locator('#google-signout').isVisible(), true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed in as'));
  await page.locator('#google-signout').click();
  await page.waitForFunction(() => document.querySelector('[data-account-label]').textContent === 'Sign in');
  assert.equal(loggedIn, false);
  assert.ok(calls.some(call => call.startsWith('POST ')) && calls.some(call => call.startsWith('DELETE ')));
  assert.deepEqual(errors, []);
  await page.close();
  console.log('Website browser checks passed at 320, 390 and 1440 pixels; synthetic Google UI flow and session restore passed. No real Google sign-in was tested.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
