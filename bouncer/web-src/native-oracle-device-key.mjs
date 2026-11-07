/**
 * EXPERIMENTAL, local-only custody for ONE testnet agent key per owner.
 *
 * Generates an Ed25519 WebCrypto private CryptoKey as non-extractable and
 * stores it in IndexedDB. Only public metadata is returned; this module cannot
 * sign transactions, invoke a wallet, call an RPC or authorize spending. It
 * signs a fixed domain-separated possession challenge internally and verifies
 * it against the stored public key before reporting local availability.
 *
 * This is NOT a backup, independent fence, secure enclave guarantee or proof
 * of an on-chain grant. The browser/OS may lose or roll back storage; clearing
 * data, changing devices/origins or a crash may permanently lose the key. Any
 * same-origin script or XSS with database access can use the CryptoKey to sign
 * even though it is non-extractable. Persistent-storage and strict-durability
 * reports do not prove recoverability. A missing local record does not mean a
 * key was never installed. Owner-controlled on-chain revocation, independently
 * retained public identity/review and original-hash fencing must be completed
 * before any real deployment or spending UI uses this module.
 */
import { isTestnetAccount } from './wallet-utils.mjs';

const DB_NAME = 'bouncer-native-oracle-device-key-v1', STORE = 'device-keys';
// This previously used owner has unresolved original hashes; it is excluded
// from the unsigned plan too. This is a public account ID, not a credential.
const EXCLUDED_OWNER = 'bouncer-owner-12f343b795633e357ae5560d.testnet';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FIELDS = ['version', 'network', 'owner', 'vault', 'origin', 'public_key', 'private_key', 'public_crypto_key', 'created_at_ms'];
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, fields) => plain(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const fail = message => new Error(message);

function directChild(vault, owner) {
  if (!isTestnetAccount(owner) || !owner.endsWith('.testnet') || owner === EXCLUDED_OWNER ||
      !isTestnetAccount(vault) || !vault.endsWith(`.${owner}`)) return false;
  const child = vault.slice(0, -owner.length - 1);
  return !!child && !child.includes('.');
}
function base58(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let encoded = '';
  while (n) { encoded = BASE58[Number(n % 58n)] + encoded; n /= 58n; }
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + encoded;
}
function safeOrigin(origin, isTopLevel, allowLoopbackForTests) {
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || isTopLevel !== true ||
        url.hostname === 'github.io' || url.hostname.endsWith('.github.io') ||
        url.hostname === 'madethis.website' || url.hostname.endsWith('.madethis.website')) return false;
    return url.protocol === 'https:' || (allowLoopbackForTests === true && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
function safeCryptoKey(key, type, usage) {
  return key && typeof key === 'object' && key.type === type && key.algorithm?.name === 'Ed25519' &&
    key.extractable === (type === 'public') && Array.isArray(key.usages) && key.usages.length === 1 && key.usages[0] === usage;
}
function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch { reject(fail('device key storage unavailable')); return; }
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) { request.transaction.abort(); return; }
      request.result.createObjectStore(STORE, { keyPath: 'owner' });
    };
    let settled = false;
    const unavailable = () => { if (!settled) { settled = true; reject(fail('device key storage unavailable')); } };
    request.onerror = unavailable; request.onblocked = unavailable;
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
        db.close(); reject(fail('device key storage schema mismatch')); return;
      }
      db.onversionchange = () => db.close(); resolve(db);
    };
  });
}
function run(db, mode, operation) {
  return new Promise((resolve, reject) => {
    let tx, output, message = 'device key storage unavailable';
    try {
      tx = db.transaction(STORE, mode, { durability: 'strict' });
      if (tx.durability !== 'strict') { tx.abort(); reject(fail('strict device key durability unavailable')); return; }
      const store = tx.objectStore(STORE);
      if (store.keyPath !== 'owner' || store.indexNames.length !== 0) {
        tx.abort(); reject(fail('device key storage schema mismatch')); return;
      }
      operation(store, value => { output = value; }, reason => { message = reason; tx.abort(); });
    } catch { try { tx?.abort(); } catch { /* already inactive */ } reject(fail('device key storage unavailable')); return; }
    tx.oncomplete = () => resolve(output);
    tx.onabort = () => reject(fail(message));
    tx.onerror = () => { /* abort is authoritative */ };
  });
}
function publicResult(row, expectedPublicKey) {
  return { version: 1, network: 'testnet', owner: row.owner, vault: row.vault, origin: row.origin,
    public_key: row.public_key, created_at_ms: row.created_at_ms, status: 'LOCAL_DEVICE_KEY_AVAILABLE',
    expected_public_key_matched: expectedPublicKey !== undefined,
    private_key_exportable: false, local_storage_only: true, independent_backup_verified: false,
    independently_retained_review_verified: false, prior_installation_disproved: false, on_chain_state_verified: false, signing_authorized: false };
}

/** Call only with the browser's trusted primitives and dedicated top-level
 * origin. `allowLoopbackForTests` exists exclusively for disposable tests. */
export async function openNativeOracleDeviceKey({ indexedDB, storage, crypto, origin, isTopLevel, now = Date.now,
  allowLoopbackForTests = false } = {}) {
  if (!safeOrigin(origin, isTopLevel, allowLoopbackForTests) || !indexedDB || typeof indexedDB.open !== 'function' ||
      typeof storage?.persisted !== 'function' || typeof crypto?.getRandomValues !== 'function' ||
      typeof crypto?.subtle?.generateKey !== 'function' || typeof crypto.subtle.exportKey !== 'function' ||
      typeof crypto.subtle.sign !== 'function' || typeof crypto.subtle.verify !== 'function' || typeof now !== 'function') {
    throw fail('trusted top-level origin and persistent device key storage required');
  }
  try { if (await storage.persisted() !== true) throw Error(); }
  catch { throw fail('persistent device key storage required'); }
  const db = await openDatabase(indexedDB); let closed = false;
  const ensureOpen = () => { if (closed) throw fail('device key storage is closed'); };
  async function publicKey(key) {
    const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    if (bytes.length !== 32) throw Error();
    return `ed25519:${base58(bytes)}`;
  }
  async function validate(row, owner, vault, expectedPublicKey) {
    try {
      if (!exact(row, FIELDS) || row.version !== 1 || row.network !== 'testnet' || row.owner !== owner ||
          row.vault !== vault || !directChild(row.vault, row.owner) || row.origin !== origin ||
          !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 1 ||
          !Number.isFinite(new Date(row.created_at_ms).getTime()) ||
          !safeCryptoKey(row.private_key, 'private', 'sign') || !safeCryptoKey(row.public_crypto_key, 'public', 'verify') ||
          typeof row.public_key !== 'string' || await publicKey(row.public_crypto_key) !== row.public_key ||
          (expectedPublicKey !== undefined && expectedPublicKey !== row.public_key)) throw Error();
      const random = new Uint8Array(32); crypto.getRandomValues(random);
      if (!random.some(b => b !== 0)) throw Error();
      const label = new TextEncoder().encode(`bouncer-native-oracle-device-key-check-v1\n${origin}\n${owner}\n${vault}\n${row.public_key}\n`);
      const challenge = new Uint8Array(label.length + random.length); challenge.set(label); challenge.set(random, label.length);
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', row.private_key, challenge));
      if (signature.length !== 64 || await crypto.subtle.verify('Ed25519', row.public_crypto_key, signature, challenge) !== true) throw Error();
      return publicResult(row, expectedPublicKey);
    } catch { throw fail('device key is missing, mismatched or unusable; stop and reconcile'); }
  }
  const input = value => {
    if (!exact(value, ['owner', 'vault']) || !directChild(value.vault, value.owner)) throw fail('named testnet owner and direct-child vault required');
  };
  try { await run(db, 'readwrite', (_store, done) => done(true)); }
  catch (error) { db.close(); throw error; }
  return Object.freeze({
    async create(value) {
      ensureOpen(); input(value);
      const { owner, vault } = value, created = now();
      if (!Number.isSafeInteger(created) || created < 1 || !Number.isFinite(new Date(created).getTime())) throw fail('invalid device clock');
      let pair, row;
      try {
        pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
        if (!safeCryptoKey(pair.privateKey, 'private', 'sign') || !safeCryptoKey(pair.publicKey, 'public', 'verify')) throw Error();
        row = { version: 1, network: 'testnet', owner, vault, origin, public_key: await publicKey(pair.publicKey),
          private_key: pair.privateKey, public_crypto_key: pair.publicKey, created_at_ms: created };
        await validate(row, owner, vault, row.public_key);
      } catch { throw fail('non-extractable Ed25519 device key generation unavailable'); }
      // Unique owner keyPath + strict commit is the local cross-tab arbiter.
      // Do not delete or replace an existing record, even if it appears stale.
      await run(db, 'readwrite', (store, done, reject) => {
        const add = store.add(row);
        add.onsuccess = () => done(true);
        add.onerror = event => { event.preventDefault(); reject('a device key already exists or storage is uncertain; stop and reconcile'); };
      });
      // A successful write acknowledgement alone is not enough. Re-read and
      // verify the committed private/public pair before returning metadata.
      let saved;
      try {
        saved = await run(db, 'readonly', (store, done) => { const get = store.get(owner); get.onsuccess = () => done(get.result); });
        const result = await validate(saved, owner, vault, row.public_key);
        // A freshly generated local key is not independently anchored yet.
        return { ...result, expected_public_key_matched: false };
      } catch { throw fail('device key write is uncertain; stop and reconcile, do not generate another key'); }
    },
    async inspect(value) {
      ensureOpen();
      if (!plain(value) || !Object.keys(value).every(k => ['owner', 'vault', 'expected_public_key'].includes(k)) ||
          !Object.hasOwn(value, 'owner') || !Object.hasOwn(value, 'vault')) throw fail('named testnet owner and direct-child vault required');
      const { owner, vault, expected_public_key: expected } = value;
      input({ owner, vault });
      if (expected !== undefined && (typeof expected !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expected))) {
        throw fail('canonical expected agent public key required');
      }
      const row = await run(db, 'readonly', (store, done) => { const get = store.get(owner); get.onsuccess = () => done(get.result); });
      if (row === undefined) return { network: 'testnet', owner, vault, status: 'NO_LOCAL_DEVICE_KEY',
        local_storage_only: true, prior_installation_disproved: false, independent_backup_verified: false, signing_authorized: false };
      return validate(row, owner, vault, expected);
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
