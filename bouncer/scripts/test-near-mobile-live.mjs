// Live, non-transactional compatibility probe. It opens a synthetic message
// request on the public NEAR Mobile backend, but uses no wallet or account and
// never signs anything. Request identifiers/links are bearer data: do not log,
// screenshot, or retain them. The request is rejected as best-effort cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const playwright = await import(pathToFileURL(path.join(process.env.RUNNER_TEMP, 'bouncer-browser/node_modules/playwright-core/index.mjs')));
const executablePath = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable on the runner');
const base = 'https://near-mobile-signer-backend_production.peersyst.tech';
const browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const observed = []; let requestId;
function category(requestUrl) {
  const path = new URL(requestUrl).pathname;
  if (path === '/api/signer-request/message') return 'message-create';
  if (path.startsWith('/api/signer-request/message/')) return 'message-poll-or-cancel';
  if (path.startsWith('/assets/')) return 'asset';
  return 'other';
}
page.on('response', response => {
  try {
    if (new URL(response.url()).origin === base) observed.push({ method: response.request().method(), type: category(response.url()), status: response.status() });
  } catch { /* diagnostic must not expose URLs */ }
});
page.on('requestfailed', request => {
  try {
    if (new URL(request.url()).origin === base) observed.push({ method: request.method(), type: category(request.url()), failure: request.failure()?.errorText || 'network error' });
  } catch { /* diagnostic must not expose URLs */ }
});
try {
  await page.goto('https://bouncer-near.vercel.app/', { waitUntil: 'networkidle', timeout: 45_000 });
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="near-mobile"]').disabled);
  const posted = page.waitForResponse(response => response.url() === `${base}/api/signer-request/message` && response.request().method() === 'POST', { timeout: 35_000 }).catch(() => null);
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="near-mobile"]').click();
  const result = await Promise.race([
    page.frameLocator('iframe').first().locator('#qr-code svg').waitFor({ state: 'visible', timeout: 40_000 }).then(() => 'ready').catch(() => 'not-ready'),
    page.waitForFunction(() => /cancelled or unavailable|could not|unable/i.test(document.querySelector('#wallet-status').textContent), null, { timeout: 40_000 }).then(() => 'error').catch(() => 'not-ready'),
  ]);
  const response = await posted;
  if (response?.ok()) {
    const data = await response.json();
    if (typeof data?.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(data.id)) requestId = data.id;
  }
  console.log('NEAR Mobile backend observations (no request IDs or wallet details):', JSON.stringify(observed));
  console.log('QR result:', result);
  assert.equal(result, 'ready', `NEAR Mobile did not prepare a live off-chain message request. Status: ${await page.locator('#wallet-status').textContent()}`);
  console.log('Live NEAR Mobile backend created an unsigned message request and returned a QR; no real wallet, signature, or NEAR transaction was used.');
} finally {
  if (requestId) {
    try {
      const response = await fetch(`${base}/api/signer-request/message/${encodeURIComponent(requestId)}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000) });
      console.log('Synthetic request cleanup HTTP status:', response.status);
    } catch { console.log('Synthetic request cleanup unavailable; request will remain pending until backend expiry.'); }
  }
  await browser.close();
}
