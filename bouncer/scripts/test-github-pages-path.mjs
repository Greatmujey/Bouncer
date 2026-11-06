// Offline simulation of GitHub Pages' shared origin and /Bouncer/ project path.
// This does NOT publish a Pages site or claim that the target URL is live.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PUBLIC_WEB_FILES, stagePublicWeb } from './stage-public-web.mjs';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-pages-test-'));
const site = path.join(tempRoot, 'site');
const origin = 'https://greatmujey.github.io';
const prefix = '/Bouncer/';
const target = `${origin}${prefix}?page=overview`;
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const staged = new Set(PUBLIC_WEB_FILES);
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
let browser;
try {
  stagePublicWeb(site);
  const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
  const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
  if (!executablePath) throw new Error('No Chromium executable found');
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], served = [], rejected = [];
  page.on('pageerror', error => errors.push(error.message));
  // Intercept everything: this check exercises the exact GitHub Pages origin
  // without using the network, exposing secrets or publishing any site.
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const name = url.pathname === prefix ? 'index.html' : url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
    if (request.method() === 'GET' && url.origin === origin && name === 'api/google-session') {
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{\"error\":\"Static site has no session API\"}' });
    }
    if (request.method() !== 'GET' || url.origin !== origin || !staged.has(name)) {
      rejected.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    served.push(name);
    return route.fulfill({ status: 200, contentType: types[path.extname(name)], body: fs.readFileSync(path.join(site, name)) });
  });
  const response = await page.goto(target, { waitUntil: 'networkidle', timeout: 20_000 });
  assert.equal(response.status(), 200);
  assert.equal(await page.evaluate(() => location.origin + location.pathname), `${origin}${prefix}`);
  assert.equal(await page.evaluate(() => document.styleSheets.length > 0), true, 'nested-path stylesheet did not load');
  for (const asset of ['index.html', 'styles.css', 'app.mjs', 'evidence.mjs', 'tour.mjs', 'google-signin.mjs', 'manrope-latin.woff2']) {
    assert.ok(served.includes(asset), `nested-path asset did not load: ${asset}`);
  }
  assert.equal(await page.locator('#welcome-tour').evaluate(el => el.open), false);
  await page.locator('[data-open-tour]').click();
  await page.locator('#tour-skip').click();
  await page.locator('.top-connect').click();
  await page.locator('[data-route-view="connect"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('not configured'));
  assert.equal(await page.locator('#google-signout').isVisible(), false, 'shared static origin cannot sign in');
  assert.equal(await page.locator('#wallet-dialog, [data-wallet-open]').count(), 0);
  await page.locator('.mobile-nav a[href="#capabilities"]').click();
  await page.locator('[data-route-view="resources"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-route-view="resources"]').isVisible(), true);
  assert.equal(await page.locator('.resource-card').count(), 3);
  await page.locator('[data-story-tab="storage"]').click();
  assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page overflows');
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, [], 'offline Pages simulation made an unexpected request');
  console.log('GitHub Pages path simulation passed: staged assets, mobile layout and disabled sign-in. This was offline; no Pages site was published.');
  console.log('::notice title=GitHub Pages path simulation::Staged assets and account safety passed at the nested project path. This offline simulation did not publish a site.');
} finally {
  if (browser) await browser.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
