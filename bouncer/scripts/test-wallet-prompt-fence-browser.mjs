// Real Chromium/IndexedDB; all identities, review hashes and transaction hashes
// are synthetic. The browser persistence report is stubbed, so this does NOT
// establish storage survival, a backup, any real wallet or a transaction.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import nearApi from 'near-api-js';

const source = fs.readFileSync(new URL('../web-src/wallet-local-prompt-fence.mjs', import.meta.url));
const playwrightPath = process.env.BOUNCER_PLAYWRIGHT_PATH || path.join(process.env.RUNNER_TEMP || '', 'bouncer-browser/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath)));
const executablePath = process.env.CHROMIUM_PATH || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(fs.existsSync);
if (!executablePath) throw new Error('No Chromium executable found');
const server = http.createServer((req, res) => {
  if (req.url === '/fence.mjs') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(source); return; }
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><title>isolated fence test</title>'); return; }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'], headless: true });
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
const owner = 'fence-user.testnet';
const input = { network: 'testnet', owner, stage_id: 'configure_buffer_locked_policy', review_sha256: 'a'.repeat(64), action_commitment_sha256: 'b'.repeat(64) };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page1 = await context.newPage(), page2 = await context.newPage();
  const errors = [], nonGets = [];
  for (const p of [page1, page2]) {
    p.on('pageerror', error => errors.push(error.message));
    p.on('request', request => { if (request.method() !== 'GET') nonGets.push(request.method()); });
    await p.goto(url);
    await p.evaluate(async () => {
      const mod = await import('/fence.mjs');
      window.__fenceModule = mod;
      window.__localFence = await mod.openLocalWalletPromptFence({ indexedDB, storage: { persisted: async () => true }, crypto });
    });
  }
  const [a, b] = await Promise.all([page1, page2].map(page => page.evaluate(async value => {
    try { return { ok: true, record: await window.__localFence.reserve(value) }; }
    catch (error) { return { ok: false, message: error.message }; }
  }, input)));
  assert.equal([a, b].filter(x => x.ok).length, 1, `same owner can reserve in only one tab: ${JSON.stringify([a, b])}`);
  assert.match([a, b].find(x => !x.ok).message, /already unresolved/);
  const original = (a.ok ? a : b).record;
  assert.equal(original.status, 'PROMPT_RESERVED_NO_HASH');
  assert.equal(original.tx_hash, null); assert.equal(original.do_not_retry, true);
  assert.equal(original.independently_durable, false); assert.equal(original.execution_authorized, false);
  assert.deepEqual(await page2.evaluate(owner => window.__localFence.inspect(owner), owner), original);
  for (const patch of [
    { network: 'mainnet' }, { owner: 'buyer.near' }, { stage_id: 'unsafe stage' }, { review_sha256: 'bad' },
    { action_commitment_sha256: 'A'.repeat(64) }, { private_key: 'never-store-me' },
  ]) {
    const result = await page1.evaluate(async value => { try { await window.__localFence.reserve(value); return 'accepted'; } catch (e) { return e.message; } }, { ...input, ...patch });
    assert.match(result, /commitment required/);
  }
  const other = await page2.evaluate(value => window.__localFence.reserve({ ...value, owner: `0x${'a'.repeat(40)}` }), input);
  assert.equal(other.status, 'PROMPT_RESERVED_NO_HASH', 'a different owner is separately fenced');
  assert.equal(other.network, 'testnet', 'implicit identities do not establish the chain on their own');
  const racingHashes = await Promise.all([page1, page2].map((page, i) => page.evaluate(async value => {
    try { return { ok: true, record: await window.__localFence.recordOriginalHash(value) }; }
    catch (e) { return { ok: false, message: e.message }; }
  }, { owner: other.owner, operation_id: other.operation_id, tx_hash: hash(10 + i) })));
  assert.equal(racingHashes.filter(x => x.ok).length, 1, 'competing original hashes cannot overwrite each other');
  assert.match(racingHashes.find(x => !x.ok).message, /differs.*never replace/);
  const winningHash = racingHashes.find(x => x.ok).record.tx_hash;
  assert.equal((await page2.evaluate(owner => window.__localFence.inspect(owner), other.owner)).tx_hash, winningHash);
  for (const page of [page1, page2]) { await page.evaluate(() => window.__localFence.close()); await page.close(); }

  const page3 = await context.newPage();
  await page3.goto(url);
  await page3.evaluate(async () => {
    const mod = await import('/fence.mjs');
    window.__localFence = await mod.openLocalWalletPromptFence({ indexedDB, storage: { persisted: async () => true }, crypto });
  });
  const afterReload = await page3.evaluate(owner => window.__localFence.inspect(owner), owner);
  assert.equal(afterReload.operation_id, original.operation_id, 'unresolved reservation survives a page reload');
  const args = { owner, operation_id: original.operation_id, tx_hash: hash(7) };
  const withHash = await page3.evaluate(value => window.__localFence.recordOriginalHash(value), args);
  assert.equal(withHash.status, 'ORIGINAL_HASH_RECORDED'); assert.equal(withHash.tx_hash, hash(7));
  assert.deepEqual(await page3.evaluate(value => window.__localFence.recordOriginalHash(value), args), withHash, 'recording the identical hash is idempotent');
  for (const patch of [{ tx_hash: hash(8) }, { operation_id: '0'.repeat(32) }, { tx_hash: '1'.repeat(31) }, { tx_hash: '0'.repeat(40) }]) {
    const result = await page3.evaluate(async value => { try { await window.__localFence.recordOriginalHash(value); return 'accepted'; } catch (e) { return e.message; } }, { ...args, ...patch });
    assert.notEqual(result, 'accepted', 'an original must never be replaced or fabricated');
  }
  assert.equal((await page3.evaluate(owner => window.__localFence.inspect(owner), owner)).tx_hash, hash(7));
  assert.deepEqual(await page3.evaluate(() => Object.keys(window.__localFence).sort()), ['close', 'inspect', 'recordOriginalHash', 'reserve']);
  const noPersistent = await page3.evaluate(async () => {
    const mod = await import('/fence.mjs');
    try { await mod.openLocalWalletPromptFence({ indexedDB, storage: { persisted: async () => false }, crypto }); return 'accepted'; }
    catch (e) { return e.message; }
  });
  assert.match(noPersistent, /persistent local wallet storage required/);
  // Simulate local corruption: a malformed record must block inspection and
  // hash updates, not be treated as an empty slot or silently repaired.
  await page3.evaluate(owner => new Promise((resolve, reject) => {
    const open = indexedDB.open('bouncer-wallet-prompt-fence-v1', 1);
    open.onerror = () => reject(Error('synthetic corruption setup failed'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('pending-prompts', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('pending-prompts'), get = store.get(owner);
      get.onsuccess = () => store.put({ ...get.result, tx_hash: 'invalid-corrupt-hash' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(Error('synthetic corruption setup failed')); };
    };
  }), owner);
  for (const action of ['inspect', 'recordOriginalHash']) {
    const message = await page3.evaluate(async ({ owner, args, action }) => {
      try { await window.__localFence[action](action === 'inspect' ? owner : args); return 'accepted'; }
      catch (e) { return e.message; }
    }, { owner, args, action });
    assert.match(message, /malformed.*reconcile/);
  }
  const blockedAfterCorruption = await page3.evaluate(async value => {
    try { await window.__localFence.reserve(value); return 'accepted'; } catch (e) { return e.message; }
  }, input);
  assert.match(blockedAfterCorruption, /already unresolved/);

  // A caller that clears browser storage can erase this local fence. The API
  // explicitly refuses to interpret absence as proof of no earlier attempt.
  await page3.evaluate(() => window.__localFence.close());
  await page3.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('bouncer-wallet-prompt-fence-v1');
    request.onsuccess = resolve; request.onerror = () => reject(Error('synthetic cleanup failed'));
  }));
  const missing = await page3.evaluate(async owner => {
    const mod = await import('/fence.mjs');
    const fence = await mod.openLocalWalletPromptFence({ indexedDB, storage: { persisted: async () => true }, crypto });
    const result = await fence.inspect(owner); fence.close(); return result;
  }, owner);
  assert.equal(missing.status, 'NO_LOCAL_RECORD');
  assert.equal(missing.prior_attempts_disproved, false); assert.equal(missing.do_not_retry, true);
  assert.deepEqual(nonGets, []); assert.deepEqual(errors, []);
  console.log('Two-tab local IndexedDB fence, reload, immutable original hash and explicit storage-loss limitation passed with synthetic data. No wallet or transaction was used.');
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
