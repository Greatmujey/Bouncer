// Browser smoke tests exercise the real bundled selector with synthetic wallet
// and Google responses. They do not claim a live sign-in or send transactions.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { baseEncode } from '@near-js/utils';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { PUBLIC_WEB_FILES } from './stage-public-web.mjs';
import { WALLET_EXECUTOR_SHA256 } from '../web-src/wallet-executor.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/zip', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain' };
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
const expected = ['near-mobile', 'meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger', 'ethereum-wallets', 'near-cli', 'wallet-connect'];
try {
  for (const [width, height] of [[320, 844], [390, 844], [1440, 844], [844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 650, hasTouch: width < 650, reducedMotion: 'reduce' });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`); });
    await page.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Google sign-in is not configured.' }) }));
    await page.goto(url, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => document.title === 'Bouncer — A workspace for autonomous agents', null, { timeout: 10_000 });
    } catch (error) { console.error('Workspace initialization errors:', errors); throw error; }
    assert.equal(await page.title(), 'Bouncer — A workspace for autonomous agents');
    assert.equal(await page.locator('#welcome-tour').evaluate(el => el.open), false);
    assert.equal(await page.locator('[data-route-view="workspace"]').isVisible(), true);
    const brand = page.locator(width < 650 ? '.mobile-brand .brand-mark svg' : '.brand .brand-mark svg');
    assert.equal(await brand.isVisible(), true);
    assert.equal(await brand.locator('use').getAttribute('href'), '#i-bouncer');
    await page.locator('[data-open-tour]').click();
    assert.match(await page.locator('#tour-count').innerText(), /STEP 1 OF 4/);
    await page.locator('#tour-next').click();
    await page.locator('#tour-next').click();
    assert.match(await page.locator('#tour-description').innerText(), /wallet.*Google/i);
    await page.locator('#tour-skip').click();
    await page.locator('[data-workspace-resource="storage"]').click();
    assert.equal(await page.locator('[data-workspace-visual]').getAttribute('data-resource'), 'storage');
    assert.match(await page.locator('[data-workspace-description]').innerText(), /Keep what your agent creates/);
    const angles = await page.locator('.orbit-node').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect(), parent = node.closest('.workspace-orbit').getBoundingClientRect();
      return Math.atan2(box.y + box.height / 2 - (parent.y + parent.height / 2), box.x + box.width / 2 - (parent.x + parent.width / 2));
    }).sort((a, b) => a - b));
    assert.equal(angles.length, 3);
    for (const gap of [angles[1] - angles[0], angles[2] - angles[1], 2 * Math.PI + angles[0] - angles[2]]) {
      assert.ok(Math.abs(gap - 2 * Math.PI / 3) < .08, 'resource icons should be evenly spaced');
    }
    await page.waitForFunction(() => [...document.querySelectorAll('[data-wallet-id]:not([data-wallet-id="wallet-connect"])')].every(button => !button.disabled));
    await page.locator('.top-connect').click();
    const picker = page.locator('#wallet-dialog');
    assert.equal(await picker.evaluate(el => el.open), true);
    assert.deepEqual(await page.locator('[data-wallet-id]').evaluateAll(nodes => nodes.map(node => node.dataset.walletId)), expected);
    assert.equal(await page.locator('#walletconnect-canvas').count(), 1);
    assert.equal(await page.locator('[data-wallet-id="wallet-connect"]').isDisabled(), true, 'blank source config must not fabricate a WalletConnect project ID');
    await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('not configured'));
    assert.equal(await page.locator('#google-signout').isVisible(), false);
    const lastWallet = page.locator('[data-wallet-id="wallet-connect"]');
    const google = page.locator('#google-start');
    assert.equal(await lastWallet.evaluate((node, other) => Boolean(node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await google.elementHandle()), true);
    await google.scrollIntoViewIfNeeded();
    assert.equal(await google.isVisible(), true, 'Google remains reachable at the bottom of the picker');
    assert.equal(await picker.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'picker must not overflow horizontally');
    if (process.env.BOUNCER_SCREENSHOTS) await picker.screenshot({ path: path.join(process.env.BOUNCER_SCREENSHOTS, `picker-${width}x${height}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await picker.evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.top-connect')), true, 'close returns focus to opener');
    for (const [id, route] of [['wallet-bootstrap-recovery-open','guardrails'],['wallet-bootstrap-budget-open','guardrails'],
      ['wallet-bootstrap-candidate-open','guardrails'],['wallet-native-setup-open','guardrails'],
      ['wallet-native-mission-open','resources'],['wallet-direct-outlayer-open','resources']]) {
      const control=page.locator(`#${id}`);assert.equal(await control.count(),1);
      assert.equal(await control.evaluate(node=>node.closest('#wallet-dialog')),null, `${id} must not be inside the wallet picker`);
      assert.equal(await control.evaluate(node=>node.closest('[data-route-view]')?.dataset.routeView),route);
    }
    await page.locator(width <= 740 ? '.mobile-nav a[href="#guardrails"]' : '.side-link[href="#guardrails"]').click();
    await page.locator('#vault-tools-title').waitFor({state:'visible'});
    assert.match(await page.locator('#workspace-vault-wallet-state').innerText(),/Connect a supported testnet wallet/i);
    if (process.env.BOUNCER_SCREENSHOTS) await page.locator('[aria-labelledby="vault-tools-title"]').screenshot({path:path.join(process.env.BOUNCER_SCREENSHOTS,`vault-${width}x${height}.png`)});
    await page.locator(width <= 740 ? '.mobile-nav a[href="#capabilities"]' : '.side-link[href="#capabilities"]').click();
    await page.locator('#resource-tools-title').waitFor({state:'visible'});
    assert.match(await page.locator('[aria-labelledby="resource-tools-title"]').innerText(),/connecting never runs a mission/i);
    await page.locator(width <= 740 ? '.mobile-nav a[href="#connect"]' : '.side-link[href="#connect"]').click();
    await page.locator('[data-route-view="connect"]').waitFor({ state: 'visible' });
    assert.match(await page.locator('.account-card').innerText(), /does not create a Bouncer vault or grant agent spending access/i);
    assert.match(await page.locator('.account-card').innerText(), /Ethereum wallet setup may require an approved testnet transaction/i);
    await page.locator('#wallet-connect').click();
    assert.equal(await picker.evaluate(el => el.open), true);
    await page.locator('#wallet-close').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}x${height}`);
    assert.deepEqual(writes, [], 'browsing without sign-in must not send mutations');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // The layout checks above use reduced motion. Separately check the actual
  // visual orbit with motion enabled, on desktop and a phone-sized viewport.
  // Compare positions relative to the orbit so the page entrance and pointer
  // parallax cannot be mistaken for resource icons moving around the center.
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const mobile = width < 650;
    const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.orbit-carrier').waitFor({ state: 'visible' });

    const offset = () => page.locator('.orbit-node-compute').evaluate(node => {
      const icon = node.getBoundingClientRect(), orbit = node.closest('.workspace-orbit').getBoundingClientRect();
      return [icon.x + icon.width / 2 - (orbit.x + orbit.width / 2), icon.y + icon.height / 2 - (orbit.y + orbit.height / 2)];
    });
    const waitForMovement = start => page.waitForFunction(([x, y]) => {
      const node = document.querySelector('.orbit-node-compute');
      const icon = node.getBoundingClientRect(), orbit = node.closest('.workspace-orbit').getBoundingClientRect();
      return Math.hypot(icon.x + icon.width / 2 - (orbit.x + orbit.width / 2) - x,
        icon.y + icon.height / 2 - (orbit.y + orbit.height / 2) - y) > 6;
    }, start, { timeout: 10_000 });

    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), false);
    await waitForMovement(await offset());
    const orbit = await page.locator('.workspace-orbit').evaluate(root => {
      const center = root.getBoundingClientRect();
      const carrier = new DOMMatrix(getComputedStyle(root.querySelector('.orbit-carrier')).transform);
      const symbol = new DOMMatrix(getComputedStyle(root.querySelector('.orbit-node svg')).transform);
      const rotation = Math.atan2(carrier.b, carrier.a) + Math.atan2(symbol.b, symbol.a);
      return {
        angles: [...root.querySelectorAll('.orbit-node')].map(node => {
          const box = node.getBoundingClientRect();
          return Math.atan2(box.y + box.height / 2 - (center.y + center.height / 2), box.x + box.width / 2 - (center.x + center.width / 2));
        }).sort((a, b) => a - b),
        symbolRotation: Math.atan2(Math.sin(rotation), Math.cos(rotation)),
      };
    });
    assert.equal(orbit.angles.length, 3);
    for (const gap of [orbit.angles[1] - orbit.angles[0], orbit.angles[2] - orbit.angles[1], 2 * Math.PI + orbit.angles[0] - orbit.angles[2]]) {
      assert.ok(Math.abs(gap - 2 * Math.PI / 3) < .08, 'moving resource icons should stay evenly spaced');
    }
    assert.ok(Math.abs(orbit.symbolRotation) < .05, 'resource symbols should stay upright while orbiting');
    await page.locator('[data-workspace-resource="storage"]').click();
    assert.equal(await page.locator('[data-workspace-visual]').getAttribute('data-resource'), 'storage');

    // Respect the browser/OS preference, including a change while the page is open.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => ['.orbit-carrier', '.orbit-ring-outer', '.orbit-ring-inner', '.orbit-center>span', '.orbit-node svg']
      .every(selector => getComputedStyle(document.querySelector(selector)).animationName === 'none'));
    const stopped = await offset();
    await page.waitForTimeout(400);
    const still = await offset();
    assert.ok(Math.hypot(still[0] - stopped[0], still[1] - stopped[1]) < .5, 'reduced motion should stop the orbit');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await waitForMovement(await offset());
    assert.deepEqual(errors, []);
    await page.close();
  }

  // The browser receives an altered digest in a test-only copy of the bundle;
  // the shipped digest and curated executor remain untouched. This runs the
  // real connector and sandbox bridge with a deliberately fake Meteor wallet.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], calls = [], walletCalls = [], ownerRpc = []; let loggedIn = false;
  page.on('pageerror', error => errors.push(error.message));
  // One throwaway browser-test key, never used outside this mocked page. The
  // real sandbox bridge still has to carry a fresh NEP-413 nonce and result.
  const synthetic = generateKeyPairSync('ed25519');
  const privatePkcs8 = synthetic.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const publicRaw = Buffer.from(synthetic.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const publicKey = `ed25519:${baseEncode(publicRaw)}`;
  const mock = `window.selector.ready({
    async signIn(params) { if (params.network !== 'testnet' || params.addFunctionCallKey) throw new Error('unsafe request'); return [{ accountId: 'browser-test.testnet' }]; },
    async signOut(params) { if (params.network !== 'testnet') throw new Error('wrong network'); },
    async getAccounts() { return [{ accountId: 'browser-test.testnet' }]; },
    async signMessage({ network, signerId, message, nonce, recipient }) {
      if (network !== 'testnet' || signerId !== 'browser-test.testnet') throw new Error('wrong account');
      const encoder = new TextEncoder(), m = encoder.encode(message), r = encoder.encode(recipient);
      const payload = new Uint8Array(4 + 4 + m.length + 32 + 4 + r.length + 1), view = new DataView(payload.buffer);
      let i = 0; view.setUint32(i, 0x80000000 + 413, true); i += 4;
      view.setUint32(i, m.length, true); i += 4; payload.set(m, i); i += m.length;
      payload.set(nonce, i); i += 32; view.setUint32(i, r.length, true); i += 4; payload.set(r, i); i += r.length;
      payload[i] = 0;
      const keyBytes = Uint8Array.from(atob('${privatePkcs8}'), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey('pkcs8', keyBytes, { name: 'Ed25519' }, false, ['sign']);
      const digest = await crypto.subtle.digest('SHA-256', payload);
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, digest));
      return { accountId: signerId, publicKey: '${publicKey}', signature: btoa(String.fromCharCode(...signature)) };
    }
  });`;
  const bundle = fs.readFileSync(path.join(web, 'wallet.bundle.js'), 'utf8');
  const pinned = WALLET_EXECUTOR_SHA256['meteor-wallet'];
  assert.ok(bundle.includes(pinned));
  const mockDigest = createHash('sha256').update(mock).digest('hex');
  await page.route('**/wallet.bundle.js?*', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle.replace(pinned, mockDigest) }));
  await page.route('**/meteor-near-connect-latest.js*', route => { walletCalls.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/javascript', body: mock }); });
  await page.route('https://test.rpc.fastnear.com/**', route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON(); ownerRpc.push(body);
    return route.fulfill({ status: 200, headers, contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { permission: 'FullAccess' } }) });
  });
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
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
  await page.locator('.top-connect').click();
  await page.getByRole('button', { name: 'Synthetic Google test' }).click();
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed in as'));
  assert.match(await page.locator('#account-status').innerText(), /<img src=x> Test Person/);
  assert.equal(await page.locator('#account-status img').count(), 0, 'profile is text, not HTML');
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected', 'Google identity must not connect a NEAR wallet');
  assert.equal(await page.locator('#wallet-options').isVisible(), true);
  await page.locator('#wallet-close').click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#account-status').textContent.includes('Signed in as'));
  await page.waitForFunction(() => !document.querySelector('[data-wallet-id="meteor-wallet"]').disabled);
  await page.locator('.top-connect').click();
  await page.locator('[data-wallet-id="meteor-wallet"]').click();
  await page.waitForFunction(() => document.querySelector('#wallet-account-badge').textContent === 'OWNER VERIFIED');
  assert.match(await page.locator('#wallet-status').textContent(), /verified.*no vault or spending access/i);
  assert.equal(await page.locator('#wallet-dialog').evaluate(el => el.open),false, 'successful verification returns to the workspace');
  assert.equal(walletCalls.length, 2, 'connection and identity prompt each load the pinned sandboxed adapter');
  assert.ok(walletCalls.every(url => /53a8b39d1aaaf067502c11e49ebb050c75df019e/.test(url)));
  await page.locator('.top-connect').click();
  assert.equal(await page.locator('#wallet-owner-verify').isVisible(), false, 'no verify button after success');
  assert.match(await page.locator('#wallet-account-warning').textContent(), /does not approve transactions.*spending access/);
  assert.equal(ownerRpc.length, 1);
  assert.deepEqual(ownerRpc[0].params, { request_type: 'view_access_key', finality: 'final', account_id: 'browser-test.testnet', public_key: publicKey });
  assert.equal(await page.locator('#google-signout').isVisible(), true);
  await page.locator('#google-signout').click();
  assert.equal(loggedIn, false);
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'connected', 'Google sign-out must not disconnect the wallet');
  await page.locator('#wallet-disconnect').click();
  await page.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('disconnected'));
  assert.equal(await page.locator('.top-connect').getAttribute('data-wallet-state'), 'disconnected');
  assert.ok(calls.some(call => call.startsWith('POST ')) && calls.some(call => call.startsWith('DELETE ')));
  assert.deepEqual(errors, []);
  await page.close();

  // Run the actual vendored, digest-checked Intear executor and its pinned
  // picker fixture against a synthetic wallet page. No provider is contacted.
  const intearPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const intearErrors = [], intearCalls = [];
  intearPage.on('pageerror', error => intearErrors.push(error.message));
  await intearPage.route('**/api/google-session**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await intearPage.addInitScript(() => window.addEventListener('message', event => {
    if (event.data?.type === 'bouncer-test-intear-payload') window.__intearTestPayload = event.data.payload;
  }));
  const intearPicker = fs.readFileSync(new URL('../web-src/vendor/intear/web/public/hot-wallet-connector-iframe.html', import.meta.url));
  await intearPage.context().route('https://wallet.intear.tech/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    intearCalls.push(pathname);
    if (pathname === '/hot-wallet-connector-iframe.html') return route.fulfill({ status: 200, contentType: 'text/html', body: intearPicker });
    if (pathname === '/connect') return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>
      window.opener.postMessage({type:'ready'}, '*');
      window.addEventListener('message', event => {
        if (event.data.type !== 'signIn') return;
        window.opener.postMessage({type:'bouncer-test-intear-payload',payload:event.data.data}, '*');
        window.opener.postMessage({type:'connected',accountId:'intear-synthetic.testnet',walletUrl:'https://wallet.intear.tech'}, '*');
      });
    </script>` });
    if (pathname === '/sign-message') return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>
      window.opener.postMessage({type:'ready'}, '*');
      window.addEventListener('message', event => {
        if (event.data.type === 'signMessage') window.opener.postMessage({type:'error',message:'User rejected the signature'}, '*');
      });
    </script>` });
    return route.fulfill({ status: 404, body: 'Blocked in synthetic test' });
  });
  await intearPage.goto(url, { waitUntil: 'networkidle' });
  await intearPage.waitForFunction(() => !document.querySelector('[data-wallet-id="intear-wallet"]').disabled);
  await intearPage.locator('.top-connect').click();
  await intearPage.locator('[data-wallet-id="intear-wallet"]').click();
  const sandbox = intearPage.frameLocator('.hot-connector-popup iframe').first();
  const handle = await sandbox.locator('iframe').elementHandle({ timeout: 20000 });
  const pickerFrame = await handle.contentFrame();
  await pickerFrame.waitForFunction(() => typeof hotConnector !== 'undefined' && !!hotConnector.origin && !!hotConnector.location, null, { timeout: 20000 });
  // Programmatic activation avoids flaky synthetic pointer events in nested
  // sandbox frames; this test does not claim real-device touch was verified.
  await sandbox.frameLocator('iframe').locator('.card-title').getByText('Web', { exact: true }).locator('..').evaluate(el => el.click());
  await intearPage.waitForFunction(() => document.querySelector('#wallet-owner-status').textContent.includes('cancelled'), null, { timeout: 20000 });
  const intearPayload = await intearPage.evaluate(() => window.__intearTestPayload);
  assert.equal(intearPayload.networkId, 'testnet');
  assert.equal(intearPayload.contractId, undefined);
  assert.equal(JSON.parse(intearPayload.message).functionCallPublicKey, undefined);
  assert.ok(intearCalls.includes('/connect'));
  assert.ok(intearCalls.includes('/sign-message'));
  assert.equal(await intearPage.locator('#wallet-account-badge').textContent(),'CONNECTED');
  assert.equal(await intearPage.locator('#wallet-owner-verify').isVisible(),true, 'a cancelled identity message remains retryable');
  await intearPage.locator('#wallet-disconnect').click();
  await intearPage.waitForFunction(() => document.querySelector('#wallet-status').textContent.includes('Wallet disconnected.'));
  assert.deepEqual(intearErrors, []);
  await intearPage.close();
  console.log('Wallet picker layouts, mock Meteor and real Intear adapter with synthetic wallet, and synthetic Google restore/sign-out passed. No real wallet or Google login was tested.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
