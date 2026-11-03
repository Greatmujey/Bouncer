// Run only in the opt-in public-site smoke jobs. Chromium and playwright-core
// are provided by the GitHub runner, not needed for normal development.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WALLET_MANIFEST } from '../web-src/wallet-manifest.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';
const url = fs.readFileSync(process.env.BOUNCER_PREVIEW_URL_FILE, 'utf8').trim();
const isGuestPreview = /^https:\/\/www\.madethis\.website\/s\/[a-z2-9]{6,16}\/$/.test(url);
const isProduction = url === 'https://bouncer-near.vercel.app/';
if (!isGuestPreview && !isProduction) throw new Error('Unexpected public site URL');
const playwright = await import(pathToFileURL(path.join(process.env.RUNNER_TEMP, 'bouncer-browser/node_modules/playwright-core/index.mjs')));
const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const executablePath = candidates.find(candidate => fs.existsSync(candidate));
if (!executablePath) throw new Error('No Chromium executable on the GitHub runner');
const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
  assert.equal(response.status(), 200);
  const brand = page.locator('.mobile-brand .brand-mark svg');
  assert.equal(await brand.isVisible(), true, 'mobile brand mark is visible');
  assert.equal(await brand.locator('use').getAttribute('href'), '#i-bouncer');
  assert.ok(await brand.locator('use').evaluate(el => el.getBBox().width > 0), 'mobile brand vector renders');
  assert.equal(await page.locator('#welcome-tour').evaluate(el => el.open), false, 'tour must not block first visit');
  await page.locator('[data-open-tour]').click();
  assert.match(await page.locator('#tour-count').innerText(), /STEP 1 OF 4/);
  await page.locator('#tour-next').click();
  assert.match(await page.locator('#tour-title').innerText(), /need to a result/);
  await page.locator('#tour-skip').click();
  assert.match(await page.locator('.snapshot-note').innerText(), /not a live purchasing dashboard/);
  await page.locator('.top-connect').click();
  assert.equal(await page.locator('#wallet-dialog').evaluate(el => el.open), true, 'wallet picker opens');
  if (isProduction) {
    await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
    assert.equal(await page.locator('[data-wallet-id]').count(), 6);
    assert.equal(await page.locator('[data-wallet-id="near-mobile"]').isEnabled(), true);
    assert.equal(await page.locator('[data-wallet-id="intear-wallet"]').isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'WalletConnect, setup required' }).isDisabled(), true);
    assert.match(await page.locator('#wallet-dialog-description').innerText(), /login message/);
    assert.match(await page.locator('#wallet-dialog-status').innerText(), /testnet wallet/i);
    // Exercise the exact URLs from the public origin, including CORS and bytes.
    // This only fetches public code; it never opens a wallet or signs anything.
    const results = await Promise.all(WALLET_MANIFEST.wallets.map(async ({ id, executor }) => {
      const result = await page.evaluate(async target => {
        try {
          const response = await fetch(target, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
          const bytes = await response.arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          return { status: response.status, size: bytes.byteLength, hash: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') };
        } catch (error) { return { error: String(error) }; }
      }, new URL(executor, url).href);
      return { id, ...result };
    }));
    for (const result of results) {
      assert.equal(result.error, undefined, `${result.id} executor fetch failed: ${result.error}`);
      assert.equal(result.status, 200, `${result.id} executor response`);
      assert.ok(result.size > 0 && result.size <= 4 * 1024 * 1024, `${result.id} executor size`);
      assert.equal(result.hash, WALLET_EXECUTOR_SHA256[result.id], `${result.id} executor integrity`);
    }
  } else {
    assert.equal(await page.locator('[data-wallet-id="meteor-wallet"]').isDisabled(), true, 'shared guest origin must not enable wallets');
    assert.match(await page.locator('#wallet-dialog-status').innerText(), /new tab/);
    assert.equal(await page.locator('#wallet-open-site').isVisible(), true);
  }
  await page.locator('#wallet-close').click();
  const nav = '.mobile-nav';
  for (const [hash, name] of [['guardrails', 'guardrails'], ['connect', 'connect'], ['proof', 'proof']]) {
    await page.locator(`${nav} a[href="#${hash}"]`).click();
    await page.locator(`[data-route-view="${name}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.locator(`[data-route-view="${name}"]`).isVisible(), true);
    assert.equal(await page.locator('[data-route-view]:visible').count(), 1, 'only the selected view is visible');
    assert.equal(await page.locator(`${nav} a[href="#${hash}"]`).getAttribute('aria-current'), 'page');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page overflows');
  }
  await page.locator('#latest-mission summary').click();
  assert.match(await page.locator('#latest-mission').innerText(), /4\.27625/);
  assert.match(await page.locator('#latest-mission').innerText(), /Circle testnet USDC/);
  assert.match(await page.locator('#latest-mission').innerText(), /not independently verified for accuracy or market freshness/);
  assert.match(await page.locator('#latest-mission').innerText(), /self-hosted development examples/);
  assert.match(await page.locator('#latest-mission').innerText(), /independent execution was not paid in USDC/);
  assert.match(await page.locator('#latest-mission a').first().getAttribute('href'), /4MCH1jvtrz43trdnjvxQfkVuLXN4a9nhtyzPt8kM95yZ$/);
  assert.equal(await page.locator('.track-card').count(), 6);
  assert.deepEqual(pageErrors, []);
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.method() !== 'HEAD') writes.push(request.url()); });
  await page.locator(`${nav} a[href="#capabilities"]`).click();
  await page.locator('[data-route-view="resources"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-route-view="resources"]').isVisible(), true);
  assert.equal(await page.locator('.resource-card').count(), 3);
  assert.deepEqual(await page.locator('.resource-amount').allInnerTexts(), ['0.1 wNEAR', '1.5 storage credits', '2 API credits']);
  await page.locator('[data-resource-story="storage"]').click();
  await page.locator('[data-story-tab="storage"]').click();
  assert.equal(await page.locator('#story-title').innerText(), 'Store and retrieve a note');
  assert.match(await page.locator('#story-result').innerText(), /stored and retrieved \(42 bytes\)/);
  assert.match(await page.locator('#story-transaction').getAttribute('href'), /2oCD4escgD2JEnYRbTAKCRS3zNB13iafqsRPuEsqTQVB$/);
  assert.equal(await page.locator('[data-story-tab="storage"]').getAttribute('aria-selected'), 'true');
  await page.locator('[data-story-tab="api"]').click();
  assert.match(await page.locator('#story-result').innerText(), /4 words and 27 bytes/);
  assert.match(await page.locator('#story-transaction').getAttribute('href'), /4HL53bUj6G8u1ZEKy8Wuj52sC5h2kzYAgzaREHL5M4sd$/);
  await page.locator('[data-story-tab="api"]').press('Home');
  assert.equal(await page.locator('[data-story-tab="compute"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(writes, [], 'exploring a past run must not send requests or transactions');
  await page.locator('#refresh-balances').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-balances').disabled, null, { timeout: 25_000 });
  const status = await page.locator('#rpc-status').innerText();
  if (!/Current recorded vault balances loaded|Couldn’t reach the public testnet RPC/.test(status)) throw new Error(`Unexpected RPC status: ${status}`);
  console.log(`Mobile layout passed; browser RPC: ${status}`);
  console.log(`::notice title=Bouncer mobile browser test::Optional tour, origin-specific wallet availability and historical results work without overflow. ${status} Real wallet sign-in was not tested.`);
} finally { await browser.close(); }
