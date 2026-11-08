import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import nearApi from 'near-api-js';
import { openNativeOracleDeviceKey } from '../web-src/native-oracle-device-key.mjs';
import { V3_OWNER } from '../agent/v3-faucet-github-fence.mjs';

const origin = 'https://bouncer-near.vercel.app';
const setup = (changes = {}) => ({ indexedDB: new IDBFactory(), storage: { persisted: async () => true },
  crypto: webcrypto, origin, isTopLevel: true, ...changes });
const params = { owner: 'alice.testnet', vault: 'native.alice.testnet' };
const open = (env, store = 'device-keys') => new Promise((resolve, reject) => {
  const request = env.indexedDB.open('bouncer-native-oracle-device-key-v1', 1);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const get = (db, owner = params.owner) => new Promise((resolve, reject) => {
  const request = db.transaction('device-keys', 'readonly').objectStore('device-keys').get(owner);
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const put = (db, row) => new Promise((resolve, reject) => {
  const tx = db.transaction('device-keys', 'readwrite'); tx.objectStore('device-keys').put(row);
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
});

test('non-extractable device key survives local reopen and matches a caller-supplied public key', async () => {
  const env = setup(), first = await openNativeOracleDeviceKey(env);
  const missing = await first.inspect(params);
  assert.equal(missing.status, 'NO_LOCAL_DEVICE_KEY');
  assert.equal(missing.prior_installation_disproved, false); assert.equal(missing.signing_authorized, false);
  const created = await first.create(params);
  assert.equal(created.status, 'LOCAL_DEVICE_KEY_AVAILABLE');
  assert.equal(created.expected_public_key_matched, false, 'generation does not independently anchor the public key');
  assert.equal(created.private_key_exportable, false); assert.equal(created.independent_backup_verified, false);
  assert.equal(created.independently_retained_review_verified, false); assert.equal(created.signing_authorized, false);
  assert.match(created.public_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const db = await open(env), row = await get(db);
  assert.equal(row.private_key.extractable, false); assert.equal(row.private_key.type, 'private');
  await assert.rejects(webcrypto.subtle.exportKey('pkcs8', row.private_key));
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', row.public_crypto_key));
  assert.equal(created.public_key, `ed25519:${nearApi.utils.serialize.base_encode(raw)}`);
  assert.equal(JSON.stringify(created).includes('private_key'), true, 'only a non-secret exportability flag is returned');
  assert.equal(Object.hasOwn(created, 'public_crypto_key'), false); assert.equal(Object.hasOwn(created, 'private_key'), false);
  db.close(); first.close();
  await assert.rejects(first.inspect(params), /closed/);
  const second = await openNativeOracleDeviceKey(env);
  const recovered = await second.inspect({ ...params, expected_public_key: created.public_key });
  assert.equal(recovered.public_key, created.public_key); assert.equal(recovered.expected_public_key_matched, true);
  assert.equal(recovered.independent_backup_verified, false); assert.equal(recovered.on_chain_state_verified, false);
  assert.equal(recovered.independently_retained_review_verified, false);
  assert.deepEqual(Object.keys(second).sort(), ['close', 'create', 'inspect', 'inspectNativeOracleOriginal', 'signNativeOracleTrial']);
  await assert.rejects(second.inspect({ ...params, expected_public_key: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) }), /mismatched/);
  await assert.rejects(second.create(params), /already exists/);
  second.close();
});

test('cross-tab creation races leave one immutable local key for the owner', async () => {
  const env = setup(), a = await openNativeOracleDeviceKey(env), b = await openNativeOracleDeviceKey(env);
  const attempts = await Promise.allSettled([a.create(params), b.create(params)]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(attempts.find(x => x.status === 'rejected').reason.message, /already exists/);
  const pub = attempts.find(x => x.status === 'fulfilled').value.public_key;
  assert.equal((await a.inspect({ ...params, expected_public_key: pub })).public_key, pub);
  await assert.rejects(b.create({ owner: params.owner, vault: 'other.alice.testnet' }), /already exists/);
  a.close(); b.close();
});

test('unsafe origins, missing persistence, invalid owners, V3 and extra fields are rejected', async () => {
  for (const bad of [
    { origin: 'http://bouncer-near.vercel.app' }, { isTopLevel: false }, { origin: 'https://example.github.io' },
    { origin: 'https://a.madethis.website' }, { storage: { persisted: async () => false } }, { crypto: {} },
  ]) await assert.rejects(openNativeOracleDeviceKey(setup(bad)), /required/);
  const env = setup(), vault = await openNativeOracleDeviceKey(env);
  for (const bad of [
    { owner: 'alice.near', vault: 'native.alice.near' },
    { owner: V3_OWNER, vault: `native.${V3_OWNER}` },
    { owner: params.owner, vault: 'a.b.alice.testnet' },
    { owner: params.owner, vault: 'native.bob.testnet' },
    { ...params, secret_key: 'never-store-me' }, { ...params, network: 'mainnet' },
  ]) await assert.rejects(vault.create(bad), /named testnet owner/);
  await assert.rejects(vault.inspect({ ...params, expected_public_key: 'invalid' }), /canonical expected/);
  vault.close();
  const testOnly = await openNativeOracleDeviceKey(setup({ origin: 'http://127.0.0.1:1234', allowLoopbackForTests: true }));
  testOnly.close();
  await assert.rejects(openNativeOracleDeviceKey(setup({ origin: 'http://example.com', allowLoopbackForTests: true })), /required/);
});

test('corrupted or replaced stored keys fail closed rather than being recreated', async () => {
  const env = setup(), vault = await openNativeOracleDeviceKey(env), created = await vault.create(params);
  const db = await open(env), row = await get(db);
  const other = await webcrypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  await put(db, { ...row, private_key: other.privateKey });
  await assert.rejects(vault.inspect({ ...params, expected_public_key: created.public_key }), /unusable/);
  await assert.rejects(vault.create(params), /already exists/);
  const extractable = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  await put(db, { ...row, private_key: extractable.privateKey });
  await assert.rejects(vault.inspect(params), /unusable/);
  await put(db, { ...row, origin: 'https://elsewhere.example' });
  await assert.rejects(vault.inspect(params), /mismatched/);
  await put(db, { ...row, public_key: String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey()) });
  await assert.rejects(vault.inspect(params), /mismatched/);
  db.close(); vault.close();
});

test('failed cryptographic self-check and uncertain persistence never return a usable key', async () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes), subtle: {
    generateKey: (...args) => webcrypto.subtle.generateKey(...args), exportKey: (...args) => webcrypto.subtle.exportKey(...args),
    sign: (...args) => webcrypto.subtle.sign(...args), verify: async () => false,
  } };
  const env = setup({ crypto }), vault = await openNativeOracleDeviceKey(env);
  await assert.rejects(vault.create(params), /generation unavailable/);
  assert.equal((await vault.inspect(params)).status, 'NO_LOCAL_DEVICE_KEY');
  vault.close();
});
