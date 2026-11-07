// Real Chromium/WebCrypto/IndexedDB with synthetic testnet identities only.
// Localhost persistent-storage permission is stubbed. Signatures use fabricated
// review/completion data; no wallet, chain RPC, broadcast, independent backup
// or real phone is tested.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import nearApi from 'near-api-js';
import { buildNativeOracleWalletPlan, NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE } from '../agent/native-oracle-wallet-plan.mjs';

const files = new Map([
  ['/native-oracle-device-key.mjs', fs.readFileSync(new URL('../web-src/native-oracle-device-key.mjs', import.meta.url))],
  ['/native-oracle-setup-wallet-prompt.mjs', fs.readFileSync(new URL('../web-src/native-oracle-setup-wallet-prompt.mjs', import.meta.url))],
  ['/native-oracle-transaction.mjs', fs.readFileSync(new URL('../web-src/native-oracle-transaction.mjs', import.meta.url))],
  ['/native-oracle-local-attempt.mjs', fs.readFileSync(new URL('../web-src/native-oracle-local-attempt.mjs', import.meta.url))],
  ['/native-oracle-completion.mjs', fs.readFileSync(new URL('../web-src/native-oracle-completion.mjs', import.meta.url))],
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
  // Synthetic setup evidence: exercise real browser signing without an RPC or wallet.
  const review=buildNativeOracleWalletPlan({wasmBytes:fs.readFileSync(new URL('../../bouncer.wasm',import.meta.url)),terms:{
    owner:params.owner,vault:params.vault,policy_id:'price',agent_public_key:result.public_key,
    per_tx_cap_yocto:'100000000000000000000000',daily_cap_yocto:'100000000000000000000000',
    vault_deposit_yocto:'100000000000000000000000',agent_gas_allowance_yocto:NATIVE_ORACLE_DEFAULT_GAS_ALLOWANCE}}).review;
  const identity={owner:params.owner,owner_public_key:String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()),operation_id:'a'.repeat(32),
    review_sha256:review.review_sha256,stages:review.stages.map(s=>({stage_id:s.id,action_commitment_sha256:s.action_commitment_sha256}))};
  const hash=n=>nearApi.utils.serialize.base_encode(Buffer.alloc(32,n));
  const checks=Object.fromEntries(['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
    'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
    'native_policy_state','vault_native_balance','onchain_policy_check'].map(k=>[k,true]));
  const now=Date.now(),completion={version:1,network:'testnet',status:'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED',
    stage_id:'verify_native_setup_completion',owner:params.owner,vault:params.vault,review_sha256:review.review_sha256,
    independently_witnessed:true,witness_head:'c'.repeat(40),execution_authorized:false,signing_authorized:false,transaction_sent:false,
    owner_approval_obtained:false,wallet_prompt_authorized:false,
    prior_original_hashes:[hash(1),hash(2),hash(3),hash(4)],checks,blockers:[],observed_at:new Date(now).toISOString(),block_hash:hash(9),
    block_height:100,block_timestamp_nanosec:(BigInt(now)*1_000_000n).toString(),agent_key_nonce:'77'};
  const args={policy_id:review.policy_id,amount:review.per_tx_cap_yocto,
    expected_route:{project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true}};
  const tx=nearApi.transactions.createTransaction(params.owner,nearApi.utils.PublicKey.from(result.public_key),params.vault,78n,
    [nearApi.transactions.functionCall('execute_outlayer_native_project',args,300n*10n**12n,0n)],Buffer.alloc(32,9));
  const expectedHash=nearApi.utils.serialize.base_encode(createHash('sha256').update(nearApi.transactions.encodeTransaction(tx)).digest());
  const input={review,identity,completion,ownerConfirmed:true,expectedTransactionHash:expectedHash};
  const signed=await Promise.all([a,b].map(page=>page.evaluate(async value=>{
    try {const out=await window.__keys.signNativeOracleTrial(value);return {ok:true,hash:out.tx_hash,bytes:Array.from(out.signed_transaction)}}
    catch(error){return {ok:false,error:error.message}}
  },input)));
  assert.equal(signed.filter(x=>x.ok).length,1);assert.equal(signed.filter(x=>!x.ok).length,1);
  const winner=signed.find(x=>x.ok),decoded=nearApi.transactions.SignedTransaction.decode(Uint8Array.from(winner.bytes));
  const digest=createHash('sha256').update(nearApi.transactions.encodeTransaction(decoded.transaction)).digest();
  assert.equal(winner.hash,expectedHash);assert.equal(nearApi.utils.serialize.base_encode(digest),expectedHash);
  assert.equal(nearApi.utils.PublicKey.from(result.public_key).verify(digest,Uint8Array.from(decoded.signature.ed25519Signature.data)),true);
  const original=await b.evaluate(id=>window.__keys.inspectNativeOracleOriginal({reviewSha256:id}),review.review_sha256);
  assert.equal(original.status,'LOCAL_ORIGINAL_RETAINED');assert.equal(original.record.tx_hash,expectedHash);
  for (const page of [a, b]) { await page.evaluate(() => window.__keys.close()); await page.close(); }
  const reloaded = await context.newPage(); await reloaded.goto(url);
  const inspected = await reloaded.evaluate(async value => {
    const mod = await import('/native-oracle-device-key.mjs');
    const keys = await mod.openNativeOracleDeviceKey({ indexedDB, crypto, storage: { persisted: async () => true },
      origin: location.origin, isTopLevel: window === window.top, allowLoopbackForTests: true });
    const metadata = await keys.inspect(value.input);
    const original = await keys.inspectNativeOracleOriginal({reviewSha256:value.reviewSha256});
    keys.close(); return {metadata,original};
  }, { input:{ ...params, expected_public_key: result.public_key },reviewSha256:review.review_sha256 });
  assert.equal(inspected.metadata.public_key, result.public_key); assert.equal(inspected.metadata.expected_public_key_matched, true);
  assert.equal(inspected.metadata.independently_retained_review_verified, false); assert.equal(inspected.metadata.on_chain_state_verified, false);
  assert.equal(inspected.original.record.tx_hash,expectedHash);
  assert.deepEqual(errors, []); assert.deepEqual(nonGets, []);
  console.log('Chromium: synthetic native transaction signed once across tabs, verified with NEAR SDK and retained locally; no broadcast, wallet or real phone.');
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
