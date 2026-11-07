// Real Chromium/WebCrypto/IndexedDB with synthetic testnet identities only.
// Localhost persistent-storage permission is stubbed; no wallet, chain RPC,
// transaction, private-key export, independent backup or real phone is tested.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

const files = new Map([
  ['/native-oracle-device-key.mjs', fs.readFileSync(new URL('../web-src/native-oracle-device-key.mjs', import.meta.url))],
  ['/wallet-utils.mjs', fs.readFileSync(new URL('../web-src/wallet-utils.mjs', import.meta.url))],
]);
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const server = http.createServer((req, res) => {
  if (files.has(req.url)) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(files.get(req.url)); return; }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><title>disposable device key test</title>'); return; }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
const params = { owner: 'browser-key-user.testnet', vault: 'native.browser-key-user.testnet' };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const a = await context.newPage(), b = await context.newPage(), errors = [], nonGets = [];
  for (const page of [a, b]) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') nonGets.push(request.method()); });
    await page.goto(url);
    await page.evaluate(async () => {
      const mod = await import('/native-oracle-device-key.mjs');
      window.__keys = await mod.openNativeOracleDeviceKey({ indexedDB, crypto, storage: { persisted: async () => true },
        origin: location.origin, isTopLevel: window === window.top, allowLoopbackForTests: true });
    });
  }
  const created = await Promise.all([a, b].map(page => page.evaluate(async value => {
    try { return { ok: true, value: await window.__keys.create(value) }; }
    catch (error) { return { ok: false, error: error.message }; }
  }, params)));
  assert.equal(created.filter(x => x.ok).length, 1, 'one tab can create an owner key');
  assert.match(created.find(x => !x.ok).error, /already exists/);
  const result = created.find(x => x.ok).value;
  assert.equal(result.status, 'LOCAL_DEVICE_KEY_AVAILABLE'); assert.equal(result.signing_authorized, false);
  assert.equal(result.private_key_exportable, false); assert.equal(result.independent_backup_verified, false);
  assert.equal(result.expected_public_key_matched, false);
  assert.match(result.public_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const keyCheck = await b.evaluate(owner => new Promise((resolve, reject) => {
    const request = indexedDB.open('bouncer-native-oracle-device-key-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('device-keys').objectStore('device-keys').get(owner);
      read.onerror = () => reject(read.error);
      read.onsuccess = async () => {
        const key = read.result.private_key;
        let exportFailed = false;
        try { await crypto.subtle.exportKey('pkcs8', key); } catch { exportFailed = true; }
        db.close(); resolve({ extractable: key.extractable, type: key.type, exportFailed });
      };
    };
  }), params.owner);
  assert.deepEqual(keyCheck, { extractable: false, type: 'private', exportFailed: true });
  for (const page of [a, b]) { await page.evaluate(() => window.__keys.close()); await page.close(); }
  const reloaded = await context.newPage(); await reloaded.goto(url);
  const inspected = await reloaded.evaluate(async value => {
    const mod = await import('/native-oracle-device-key.mjs');
    const keys = await mod.openNativeOracleDeviceKey({ indexedDB, crypto, storage: { persisted: async () => true },
      origin: location.origin, isTopLevel: window === window.top, allowLoopbackForTests: true });
    const metadata = await keys.inspect(value); keys.close(); return metadata;
  }, { ...params, expected_public_key: result.public_key });
  assert.equal(inspected.public_key, result.public_key); assert.equal(inspected.expected_public_key_matched, true);
  assert.equal(inspected.independently_retained_review_verified, false); assert.equal(inspected.on_chain_state_verified, false);
  assert.deepEqual(errors, []); assert.deepEqual(nonGets, []);
  console.log('Chromium device key: one local non-extractable key, cross-tab race, reload and public-key match passed; no transaction or wallet call.');
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
