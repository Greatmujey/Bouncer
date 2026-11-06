// Opt-in, read-only live/guest browser smoke. Never signs into Google, never
// transmits an ID token and never sends a NEAR transaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const url = fs.readFileSync(process.env.BOUNCER_PREVIEW_URL_FILE, 'utf8').trim();
const isGuestPreview = /^https:\/\/www\.madethis\.website\/s\/[a-z2-9]{6,16}\/$/.test(url);
const isProduction = url === 'https://bouncer-near.vercel.app/';
if (!isGuestPreview && !isProduction) throw new Error('Unexpected public site URL');
const playwright = await import(pathToFileURL(path.join(process.env.RUNNER_TEMP, 'bouncer-browser/node_modules/playwright-core/index.mjs')));
const executablePath = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable on the GitHub runner');
const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
  assert.equal(response.status(), 200);
  assert.equal(await page.title(), 'Bouncer — A workspace for autonomous agents');
  assert.equal(await page.locator('[data-route-view="workspace"]').isVisible(), true);
  await page.locator('[data-workspace-resource="storage"]').click();
  assert.match(await page.locator('[data-workspace-description]').innerText(), /Keep what your agent creates/);
  const brand = page.locator('.mobile-brand .brand-mark svg');
  assert.equal(await brand.isVisible(), true);
  assert.equal(await brand.locator('use').getAttribute('href'), '#i-bouncer');
  assert.equal(await page.locator('#welcome-tour').evaluate(el => el.open), false);
  await page.locator('[data-open-tour]').click();
  assert.match(await page.locator('#tour-count').innerText(), /STEP 1 OF 4/);
  await page.locator('#tour-next').click();
  await page.locator('#tour-skip').click();
  assert.match(await page.locator('.snapshot-note').innerText(), /not a live purchasing dashboard/);
  await page.locator('.top-connect').click();
  await page.locator('[data-route-view="connect"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('.account-card').innerText(), /Sign in with Google/);
  assert.equal(await page.locator('#wallet-dialog, [data-wallet-open], #walletconnect-canvas').count(), 0);
  assert.equal(await page.locator('#google-signout').isVisible(), false, 'no signed-in state without a real login');
  for (const [hash, name] of [['guardrails', 'guardrails'], ['proof', 'proof'], ['capabilities', 'resources']]) {
    await page.locator(`.mobile-nav a[href="#${hash}"]`).click();
    await page.locator(`[data-route-view="${name}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-route-view]:visible').count(), 1);
  }
  assert.equal(await page.locator('.resource-card').count(), 3);
  await page.locator('[data-story-tab="storage"]').click();
  assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
  console.log('Public mobile workspace passed. Google sign-in and purchases were not attempted.');
} finally { await browser.close(); }
