// Run only in the opt-in guest-publication job. Chromium and playwright-core
// are provided by the GitHub runner, not needed for normal development.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const url = fs.readFileSync(process.env.BOUNCER_PREVIEW_URL_FILE, 'utf8').trim();
if (!/^https:\/\/www\.madethis\.website\/s\/[a-z2-9]{6,16}\/$/.test(url)) throw new Error('Unexpected public preview URL');
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
  assert.equal(await page.locator('.resource-card').count(), 3);
  assert.deepEqual(await page.locator('.resource-amount').allInnerTexts(), ['0.1 wNEAR', '1.5 storage credits', '2 API credits']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page overflows');
  assert.match(await page.locator('.snapshot-note').innerText(), /not a running agent/);
  assert.deepEqual(pageErrors, []);
  await page.locator('#refresh-balances').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-balances').disabled, null, { timeout: 25_000 });
  const status = await page.locator('#rpc-status').innerText();
  if (!/Current recorded vault balances loaded|Couldn’t reach the public testnet RPC/.test(status)) throw new Error(`Unexpected RPC status: ${status}`);
  console.log(`Mobile layout passed; browser RPC: ${status}`);
  console.log(`::notice title=Bouncer mobile browser test::Three cards rendered without overflow. ${status}`);
} finally { await browser.close(); }
