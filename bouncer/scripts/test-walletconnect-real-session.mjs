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
let browser, page, wallet, activeTopic, pairingTopic, bridgeServer, phase = 'browser startup';
let bridgePort = 0;
const bridgeDiagnostics = Object.create(null);
const localBridge = process.env.BOUNCER_GATEWAY_LOCAL === '1';
const liveBridge = process.env.BOUNCER_GATEWAY_LIVE === '1';
const testBridgeHost = process.env.BOUNCER_GATEWAY_TEST_HOST || '';
const testBridge = Boolean(testBridgeHost);
try {
  // A dispatch-only test target receives only a throwaway synthetic session,
  // never a real user pairing or wallet. No arbitrary protocol/path is allowed.
  if (testBridge && (!/^[a-z0-9-]{1,63}\.vercel\.app$/.test(testBridgeHost) || process.env.BOUNCER_CANDIDATE_SITE !== '1' || process.env.BOUNCER_BLOCK_BOTH_WC !== '1')) throw new Error('Invalid test gateway');
  if (localBridge) {
    if (process.env.BOUNCER_CANDIDATE_SITE !== '1' || process.env.BOUNCER_BLOCK_BOTH_WC !== '1') throw new Error('Invalid bridge test mode');
    const response = await fetch('https://bouncer-near.vercel.app/walletconnect-config.json', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Public WalletConnect configuration unavailable');
    const { projectId } = await response.json();
    const { createRelayBridge } = await import('../walletconnect/relay-bridge.mjs');
    bridgeServer = createRelayBridge({ projectId, onDiagnostic: name => { bridgeDiagnostics[name] = (bridgeDiagnostics[name] || 0) + 1; } });
    await new Promise((resolve, reject) => { bridgeServer.once('error', reject); bridgeServer.listen(0, '127.0.0.1', resolve); });
    bridgePort = bridgeServer.address().port;
  }
  browser = await playwright.chromium.launch({ executablePath, args: ['--no-sandbox'], headless: true });
  page = await browser.newPage(process.env.BOUNCER_SHORT_VIEWPORT === '1'
    ? { viewport: { width: 683, height: 304 }, deviceScaleFactor: 2 }
    : process.platform === 'win32'
      ? { viewport: { width: 1365, height: 768 } }
      : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (process.env.BOUNCER_POISON_BUFFER === '1') {
    // A hostile/incomplete Node polyfill can be injected by browser extensions.
    // The browser-only SDK must use standard Uint8Array paths instead.
    await page.addInitScript(() => {
      window.Buffer = { from() { throw new Error('synthetic Buffer must not be used'); },
        allocUnsafe() { throw new Error('synthetic Buffer must not be used'); },
        isBuffer() { throw new Error('synthetic Buffer must not be used'); } };
    });
  }
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
  if (process.env.BOUNCER_BLOCK_PRIMARY_WC === '1' || process.env.BOUNCER_BLOCK_BOTH_WC === '1') {
    // Block relay addresses only in the dapp browser. The synthetic wallet
    // remains on .org, permitting a real cross-relay pairing test.
    await page.addInitScript(({ blockBoth, gatewayPort, gatewayLive, testHost }) => {
      const NativeWebSocket = window.WebSocket;
      window.__bouncerRelayAttempts = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const parsed = new URL(url), hostname = parsed.hostname;
          const gateway = hostname === 'bouncer-near.vercel.app' && parsed.pathname === '/api/wc-relay';
          if (hostname === 'relay.walletconnect.org' || hostname === 'relay.walletconnect.com') window.__bouncerRelayAttempts.push(hostname);
          if (gateway) window.__bouncerRelayAttempts.push('bouncer-gateway');
          if (hostname === 'relay.walletconnect.org' || (blockBoth && hostname === 'relay.walletconnect.com') ||
              (gateway && blockBoth && !gatewayPort && !gatewayLive && !testHost)) throw new Error('Relay blocked by compatibility test');
          // The candidate's browser origin remains the approved production
          // origin; only the gateway socket is sent to the test server.
          const destination = gateway && gatewayPort ? `ws://127.0.0.1:${gatewayPort}/api/wc-relay`
            : gateway && testHost ? `wss://${testHost}/api/wc-relay` : url;
          if (protocols === undefined) super(destination); else super(destination, protocols);
        }
      };
    }, { blockBoth: process.env.BOUNCER_BLOCK_BOTH_WC === '1', gatewayPort: bridgePort, gatewayLive: liveBridge, testHost: testBridgeHost });
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
      !document.querySelector('#walletconnect-error').hidden, null, { timeout: 60_000 });
    if (!await page.locator('#walletconnect-qr').isVisible()) throw new Error('QR unavailable');
  };
  if (process.env.BOUNCER_BLOCK_BOTH_WC === '1' && !localBridge && !liveBridge && !testBridge) {
    phase = 'all-transports-blocked diagnostic and retry';
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator('#walletconnect-error').waitFor({ state: 'visible', timeout: 60_000 });
      const detail = await page.locator('#walletconnect-error-detail').innerText();
      assert.match(detail, /Code WC-(INIT|PAIR|START|TIMEOUT)\./);
      assert.doesNotMatch(detail, /wc:|symKey|auth=/i, 'diagnostic must not expose session secrets');
      assert.equal(await page.locator('#walletconnect-qr').isVisible(), false, 'a failed connection cannot show a pretend QR');
      assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
      if (attempt === 0) await page.locator('#walletconnect-retry').click();
    }
    await page.locator('#walletconnect-cancel').click();
    assert.equal(await page.locator('[data-wallet-id="near-mobile"]').isVisible(), true, 'other wallet options remain available');
    console.log('Both direct relays and the gateway were deliberately blocked: a sanitized diagnostic and retry were shown, no QR or connected state was faked.');
  } else {
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
    if (process.env.BOUNCER_BLOCK_PRIMARY_WC === '1' || localBridge || liveBridge || testBridge) {
      const attempts = await page.evaluate(() => window.__bouncerRelayAttempts);
      assert.ok(attempts.includes('relay.walletconnect.org') && attempts.includes('relay.walletconnect.com'), 'fallback tried both documented relays');
      if (localBridge || liveBridge || testBridge) assert.ok(attempts.includes('bouncer-gateway'), 'both blocked direct relays used the disclosed gateway');
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
  const route = localBridge ? ' (both direct relays blocked; in-runner gateway)' : testBridge ? ' (both direct relays blocked; test Vercel gateway)' : liveBridge ? ' (both direct relays blocked; deployed gateway)' : process.env.BOUNCER_BLOCK_PRIMARY_WC === '1' ? ' (primary blocked; alternate relay)' : '';
  console.log(`${process.env.BOUNCER_CANDIDATE_SITE === '1' ? 'Candidate site' : 'Live site'} connected and disconnected a synthetic wallet over the real Reown relay${route}; no real wallet, signature, or NEAR transaction was used.`);
  }
} catch (error) {
  // SDK/Playwright errors can contain bearer links, auth tokens or topics. The
  // public CI log records only a bounded phase and a safe error category.
  const kind = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name || '') ? error.name : 'Error';
  console.error(`WalletConnect probe failed during ${phase} (${kind}); no session data logged.`);
  if (localBridge) {
    const state = await page?.evaluate(() => ({
      attempted: (window.__bouncerRelayAttempts || []).filter(item => ['relay.walletconnect.org', 'relay.walletconnect.com', 'bouncer-gateway'].includes(item)),
      code: (document.querySelector('#walletconnect-error-detail')?.textContent || '').match(/WC-[A-Z]+/)?.[0] || 'none',
      qrShown: !document.querySelector('#walletconnect-qr')?.hidden,
    })).catch(() => null);
    console.error('Synthetic bridge diagnostic:', JSON.stringify({ state, events: bridgeDiagnostics }));
  }
  process.exitCode = 1;
} finally {
  if (wallet) {
    if (activeTopic) await withTimeout(wallet.disconnect({ topic: activeTopic, reason: { code: 6000, message: 'Test complete' } }).catch(() => {}), 3000, 'Wallet disconnect').catch(() => {});
    if (pairingTopic) await withTimeout(wallet.core.pairing.disconnect({ topic: pairingTopic }).catch(() => {}), 3000, 'Pairing cleanup').catch(() => {});
    try { wallet.core?.heartbeat?.stop?.(); } catch { /* best effort */ }
    await withTimeout(Promise.resolve().then(() => wallet.core?.relayer?.transportClose?.()).catch(() => {}), 3000, 'Relay close').catch(() => {});
  }
  if (browser) await browser.close();
  if (bridgeServer) await withTimeout(new Promise(resolve => bridgeServer.close(resolve)), 3000, 'Bridge close').catch(() => {});
}
