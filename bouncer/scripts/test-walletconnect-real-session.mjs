// Opt-in live protocol smoke: a synthetic SignClient acts as a wallet. This
// creates no real wallet account, signs nothing and sends no NEAR transaction.
// Pairing URIs are bearer secrets and must never appear in logs or artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../web-src/walletconnect-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const playwright = await import(pathToFileURL(path.join(process.env.RUNNER_TEMP, 'bouncer-browser/node_modules/playwright-core/index.mjs')));
process.env.DISABLE_GLOBAL_CORE = 'true';
const { default: SignClient } = await import(pathToFileURL(path.join(root, 'walletconnect/node_modules/@walletconnect/sign-client/dist/index.js')));
const executablePath = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable on runner');
const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
};
let browser, wallet, activeTopic, pairingTopic;
try {
  browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto('https://bouncer-near.vercel.app/', { waitUntil: 'networkidle', timeout: 45_000 });
  const projectId = await page.evaluate(async () => (await (await fetch('./walletconnect-config.json', { cache: 'no-store' })).json()).projectId);
  assert.ok(typeof projectId === 'string' && /^[a-f0-9]{32}$/i.test(projectId), 'project must be configured');
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="wallet-connect"]').disabled);
  wallet = await withTimeout(SignClient.init({
    projectId, storage: createMemoryStorage(), logger: 'silent', telemetryEnabled: false,
    metadata: { name: 'Bouncer synthetic test wallet', description: 'No keys or transactions', url: 'https://bouncer-near.vercel.app', icons: ['https://bouncer-near.vercel.app/favicon.svg'] },
  }), 30_000, 'Synthetic wallet initialization');
  let walletRequests = 0;
  wallet.on('session_request', () => { walletRequests++; });
  const proposal = new Promise(resolve => wallet.once('session_proposal', resolve));
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="wallet-connect"]').click();
  await page.locator('#walletconnect-qr').waitFor({ state: 'visible', timeout: 60_000 });
  const uri = await page.locator('#walletconnect-open').getAttribute('href');
  assert.ok(typeof uri === 'string' && /^wc:[a-f0-9]{64}@2\?/.test(uri), 'a private pairing URI was generated');
  const pairing = await withTimeout(wallet.pair({ uri }), 30_000, 'Synthetic wallet pairing');
  pairingTopic = pairing.topic;
  const event = await withTimeout(proposal, 30_000, 'Session proposal');
  // SignClient 2.26 moves required namespaces to optional on the wire.
  // Bouncer still fails closed unless the approved session is exactly this.
  assert.deepEqual(Object.keys(event.params.requiredNamespaces || {}), []);
  assert.deepEqual(Object.keys(event.params.optionalNamespaces || {}), ['near']);
  assert.deepEqual(event.params.optionalNamespaces.near, { chains: ['near:testnet'], methods: ['near_getAccounts'], events: [] });
  const approval = await wallet.approve({ id: event.id, namespaces: {
    near: { accounts: ['near:testnet:wc-synthetic.testnet'], methods: ['near_getAccounts'], events: [] },
  } });
  activeTopic = approval.topic;
  await withTimeout(approval.acknowledged(), 30_000, 'Session approval');
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('wc-synthetic.testnet'), null, { timeout: 30_000 });
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
  assert.equal(await page.locator('.top-connect [data-wallet-label]').innerText(), 'Connected');
  assert.match(await page.locator('#wallet-status').textContent(), /wallet-reported/);
  const deleted = new Promise(resolve => wallet.once('session_delete', resolve));
  await page.locator('.top-connect').click();
  await page.locator('#wallet-disconnect').click();
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected'), null, { timeout: 20_000 });
  await withTimeout(deleted, 20_000, 'Remote disconnect');
  activeTopic = null;
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
  assert.equal(walletRequests, 0, 'Bouncer must not invoke wallet RPC methods');
  console.log('Live Reown session connected and disconnected a synthetic test wallet; no real wallet, signature, or NEAR transaction was used.');
} catch (error) {
  // Never reveal an ephemeral pairing secret if a library includes it in an error.
  const message = String(error?.message || error).replace(/wc:[^\s'"`]+/g, '[redacted pairing URI]');
  console.error(`WalletConnect session probe failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (wallet) {
    if (activeTopic) await withTimeout(wallet.disconnect({ topic: activeTopic, reason: { code: 6000, message: 'Test complete' } }).catch(() => {}), 3000, 'Wallet disconnect').catch(() => {});
    if (pairingTopic) await withTimeout(wallet.core.pairing.disconnect({ topic: pairingTopic }).catch(() => {}), 3000, 'Pairing cleanup').catch(() => {});
    try { wallet.core?.heartbeat?.stop?.(); } catch { /* best effort */ }
    await withTimeout(Promise.resolve().then(() => wallet.core?.relayer?.transportClose?.()).catch(() => {}), 3000, 'Relay close').catch(() => {});
  }
  if (browser) await browser.close();
}
