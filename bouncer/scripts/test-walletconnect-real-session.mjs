// Opt-in live protocol smoke: a synthetic SignClient acts as a wallet. This
// creates no real wallet account, signs nothing and sends no NEAR transaction.
// Pairing URIs are bearer secrets and must never appear in logs or artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createMemoryStorage } from '../web-src/walletconnect-core.mjs';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireWalletConnect = createRequire(new URL('../walletconnect/package.json', import.meta.url));
const jsQR = requireWalletConnect('jsqr');
const { PNG } = requireWalletConnect('pngjs');
const playwright = await import(pathToFileURL(path.join(process.env.RUNNER_TEMP, 'bouncer-browser/node_modules/playwright-core/index.mjs')));
process.env.DISABLE_GLOBAL_CORE = 'true';
const { default: SignClient } = await import(pathToFileURL(path.join(root, 'walletconnect/node_modules/@walletconnect/sign-client/dist/index.js')));
const executablePath = (process.platform === 'win32'
  ? [path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe')]
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']).find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable on runner');
const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
};
let browser, wallet, activeTopic, pairingTopic, phase = 'browser startup';
try {
  browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
  const page = await browser.newPage(process.platform === 'win32'
    ? { viewport: { width: 1365, height: 768 } }
    : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (process.env.BOUNCER_CANDIDATE_SITE === '1') {
    // Exercise the checked-out candidate at the approved production origin,
    // while routing only its static assets to local files. The ID is read from
    // the live public configuration; neither wallet keys nor private data are
    // involved. The WalletConnect relay remains genuinely remote.
    const response = await fetch('https://bouncer-near.vercel.app/walletconnect-config.json', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Public WalletConnect configuration unavailable');
    const config = await response.text();
    const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.zip': 'application/zip' };
    const files = new Set(PUBLIC_WEB_FILES);
    await page.route('https://bouncer-near.vercel.app/**', route => {
      const name = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (!files.has(name)) return route.abort();
      if (name === 'walletconnect-config.json') return route.fulfill({ status: 200, contentType: 'application/json', body: config });
      return route.fulfill({ status: 200, contentType: types[path.extname(name)], body: fs.readFileSync(path.join(root, 'web', name)) });
    });
  }
  if (process.env.BOUNCER_BLOCK_PRIMARY_WC === '1') {
    // Simulate a blocked primary only in the dapp browser. The synthetic
    // wallet stays on .org, proving that .com can pair across the relays.
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__bouncerRelayAttempts = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const hostname = new URL(url).hostname;
          if (hostname === 'relay.walletconnect.org' || hostname === 'relay.walletconnect.com') window.__bouncerRelayAttempts.push(hostname);
          if (hostname === 'relay.walletconnect.org') throw new Error('Primary relay blocked by compatibility test');
          if (protocols === undefined) super(url); else super(url, protocols);
        }
      };
    });
  }
  phase = 'site load';
  await page.goto('https://bouncer-near.vercel.app/', { waitUntil: 'networkidle', timeout: 45_000 });
  const projectId = await page.evaluate(async () => (await (await fetch('./walletconnect-config.json', { cache: 'no-store' })).json()).projectId);
  assert.ok(typeof projectId === 'string' && /^[a-f0-9]{32}$/i.test(projectId), 'project must be configured');
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="wallet-connect"]').disabled);
  phase = 'synthetic wallet initialization';
  wallet = await withTimeout(SignClient.init({
    projectId, storage: createMemoryStorage(), logger: 'silent', telemetryEnabled: false,
    metadata: { name: 'Bouncer synthetic test wallet', description: 'No keys or transactions', url: 'https://bouncer-near.vercel.app', icons: ['https://bouncer-near.vercel.app/favicon.svg'] },
  }), 30_000, 'Synthetic wallet initialization');
  let walletRequests = 0;
  wallet.on('session_request', () => { walletRequests++; });
  const proposal = new Promise(resolve => wallet.once('session_proposal', resolve));
  phase = 'first QR';
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="wallet-connect"]').click();
  const awaitQr = async () => {
    await page.waitForFunction(() => !document.querySelector('#walletconnect-qr').hidden ||
      !document.querySelector('#walletconnect-error').hidden, null, { timeout: 45_000 });
    if (!await page.locator('#walletconnect-qr').isVisible()) throw new Error(`QR unavailable: ${await page.locator('#walletconnect-error-detail').innerText()}`);
  };
  await awaitQr();
  if (process.env.BOUNCER_CANDIDATE_SITE === '1' || process.env.BOUNCER_LIVE_RETRY === '1') {
    phase = 'cancel and retry QR';
    const first = await page.locator('#walletconnect-open').getAttribute('href');
    await page.locator('#walletconnect-cancel').click();
    await page.locator('[data-wallet-id="wallet-connect"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('[data-wallet-id="wallet-connect"]').click();
    await awaitQr();
    const second = await page.locator('#walletconnect-open').getAttribute('href');
    assert.ok(first && second && first !== second, 'retry must create a fresh private pairing');
    assert.deepEqual(await page.evaluate(() => Object.keys(window).filter(key => key.startsWith('_walletConnectCore_'))), [], 'SDK Core must not be cached on the browser global');
    if (process.env.BOUNCER_BLOCK_PRIMARY_WC === '1') {
      const attempts = await page.evaluate(() => window.__bouncerRelayAttempts);
      assert.ok(attempts.includes('relay.walletconnect.org') && attempts.includes('relay.walletconnect.com'), 'fallback tried both documented relays');
    }
  }
  const uri = await page.locator('#walletconnect-open').getAttribute('href');
  assert.ok(typeof uri === 'string' && /^wc:[a-f0-9]{64}@2\?/.test(uri), 'a private pairing URI was generated');
  // Decode the actual rendered CSS-sized screenshot in memory. Never persist or
  // print the bearer URI (including on assertion failure).
  const image = PNG.sync.read(await page.locator('#walletconnect-qr').screenshot());
  const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  assert.ok(decoded?.data === uri, 'the displayed live QR decodes to the pairing link');
  phase = 'cross-relay pairing and proposal';
  const pairing = await withTimeout(wallet.pair({ uri }), 30_000, 'Synthetic wallet pairing');
  pairingTopic = pairing.topic;
  const event = await withTimeout(proposal, 30_000, 'Session proposal');
  // SignClient 2.26 moves required namespaces to optional on the wire.
  // Bouncer still fails closed unless the approved session is exactly this.
  assert.deepEqual(Object.keys(event.params.requiredNamespaces || {}), []);
  assert.deepEqual(Object.keys(event.params.optionalNamespaces || {}), ['near']);
  assert.deepEqual(event.params.optionalNamespaces.near, { chains: ['near:testnet'], methods: ['near_getAccounts'], events: [] });
  phase = 'synthetic approval';
  const approval = await wallet.approve({ id: event.id, namespaces: {
    near: { accounts: ['near:testnet:wc-synthetic.testnet'], methods: ['near_getAccounts'], events: [] },
  } });
  activeTopic = approval.topic;
  await withTimeout(approval.acknowledged(), 30_000, 'Session approval');
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('wc-synthetic.testnet'), null, { timeout: 30_000 });
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected');
  assert.equal(await page.locator('.top-connect [data-wallet-label]').innerText(), 'Connected');
  assert.match(await page.locator('#wallet-status').textContent(), /wallet-reported/);
  phase = 'disconnect';
  const deleted = new Promise(resolve => wallet.once('session_delete', resolve));
  await page.locator('.top-connect').click();
  await page.locator('#wallet-disconnect').click();
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected'), null, { timeout: 20_000 });
  await withTimeout(deleted, 20_000, 'Remote disconnect');
  activeTopic = null;
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
  assert.equal(walletRequests, 0, 'Bouncer must not invoke wallet RPC methods');
  console.log(`${process.env.BOUNCER_CANDIDATE_SITE === '1' ? 'Candidate site' : 'Live site'} connected and disconnected a synthetic wallet over the real Reown relay${process.env.BOUNCER_BLOCK_PRIMARY_WC === '1' ? ' (primary blocked, alternate used)' : ''}; no real wallet, signature, or NEAR transaction was used.`);
} catch (error) {
  // SDK/Playwright errors can contain bearer links, auth tokens or topics. The
  // public CI log records only a bounded phase and a safe error category.
  const kind = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name || '') ? error.name : 'Error';
  console.error(`WalletConnect probe failed during ${phase} (${kind}); no session data logged.`);
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
