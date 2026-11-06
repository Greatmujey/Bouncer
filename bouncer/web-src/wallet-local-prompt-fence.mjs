/**
 * Experimental local-only, pre-wallet-prompt write-ahead fence. It does not
 * call a wallet, sign, send, contact an RPC, verify a review or prove consent.
 * A same-origin IndexedDB unique key serializes tabs in ONE browser profile.
 * The reservation is committed BEFORE its promise resolves; neither timeout,
 * rejected wallet UI nor a missing hash permits a retry. There is deliberately
 * no unlock, delete or expiry API.
 *
 * IMPORTANT: browser storage can be cleared, rolled back, evicted, corrupted,
 * unavailable, or separate on another device/profile. Persistent-storage and
 * strict-durability flags do not provide an independent backup or global
 * exclusion. A missing local record is NOT proof no transaction was sent.
 * Do not connect this primitive to live spending until an independently
 * durable owner-scoped fence, identity authentication, original-hash receipt
 * reconciliation and all fresh execution checks are implemented.
 */
const DB_NAME = 'bouncer-wallet-prompt-fence-v1', STORE = 'pending-prompts';
const FIELDS = ['owner', 'network', 'operation_id', 'stage_id', 'review_sha256',
  'action_commitment_sha256', 'created_at_ms', 'status', 'tx_hash'];
const HEX64 = /^[a-f0-9]{64}$/, HEX32 = /^[a-f0-9]{32}$/;
const hex64 = x => typeof x === 'string' && HEX64.test(x);
const hex32 = x => typeof x === 'string' && HEX32.test(x);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, fields) => record(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const stage = x => typeof x === 'string' && /^[a-z0-9_-]{1,64}$/.test(x);
function ownerId(value) {
  return typeof value === 'string' && value.length <= 64 && (
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(value) ||
    /^[a-f0-9]{64}$/.test(value) || /^0x[a-f0-9]{40}$/.test(value));
}
// Canonical base58 for exactly 32 bytes, without a browser Buffer dependency.
function transactionHash(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char); if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  let leading = 0;
  while (value[leading] === '1') leading++;
  return leading + bytes === 32;
}
function checkedRow(value, expectedOwner) {
  if (!exact(value, FIELDS) || value.owner !== expectedOwner || !ownerId(value.owner) || value.network !== 'testnet' ||
      !hex32(value.operation_id) || !stage(value.stage_id) || !hex64(value.review_sha256) ||
      !hex64(value.action_commitment_sha256) || !Number.isSafeInteger(value.created_at_ms) || value.created_at_ms < 1 ||
      !Number.isFinite(new Date(value.created_at_ms).getTime()) ||
      !((value.status === 'PROMPT_RESERVED_NO_HASH' && value.tx_hash === null) ||
        (value.status === 'ORIGINAL_HASH_RECORDED' && transactionHash(value.tx_hash)))) {
    throw new Error('local wallet fence is malformed; stop and reconcile');
  }
  return value;
}
function publicRow(row) {
  return { ...row, do_not_retry: true, local_storage_only: true, independently_durable: false,
    current_chain_state_verified: false, wallet_approval_verified: false, execution_authorized: false };
}
function empty(owner) {
  return { owner, network: 'testnet', status: 'NO_LOCAL_RECORD', do_not_retry: true,
    local_storage_only: true, independently_durable: false, prior_attempts_disproved: false, execution_authorized: false };
}
function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch { reject(new Error('local wallet fence unavailable')); return; }
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) { request.transaction.abort(); return; }
      request.result.createObjectStore(STORE, { keyPath: 'owner' });
    };
    let settled = false;
    const unavailable = () => { if (!settled) { settled = true; reject(new Error('local wallet fence unavailable')); } };
    request.onerror = unavailable;
    request.onblocked = unavailable;
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
        db.close(); reject(new Error('local wallet fence schema mismatch')); return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
function run(db, mode, action) {
  return new Promise((resolve, reject) => {
    let tx, output, failed = 'local wallet fence unavailable';
    try {
      tx = db.transaction(STORE, mode, { durability: 'strict' });
      if (tx.durability !== 'strict') { tx.abort(); reject(new Error('strict local storage durability unavailable')); return; }
      const store = tx.objectStore(STORE);
      if (store.keyPath !== 'owner' || store.indexNames.length !== 0) { tx.abort(); reject(new Error('local wallet fence schema mismatch')); return; }
      action(store, value => { output = value; }, message => { failed = message; tx.abort(); });
    } catch { try { tx?.abort(); } catch { /* already inactive */ } reject(new Error('local wallet fence unavailable')); return; }
    tx.oncomplete = () => resolve(output);
    tx.onabort = () => reject(new Error(failed));
    tx.onerror = () => { /* abort is authoritative; no untrusted error is exposed */ };
  });
}

/** Open ONLY when the browser reports persistent storage and supports strict
 * write durability. Those reports are necessary, not sufficient for safety. */
export async function openLocalWalletPromptFence({ indexedDB, storage, crypto, now = Date.now } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function' || typeof storage?.persisted !== 'function' ||
      typeof crypto?.getRandomValues !== 'function' || typeof now !== 'function') throw new Error('persistent local wallet storage required');
  try { if (await storage.persisted() !== true) throw Error(); }
  catch { throw new Error('persistent local wallet storage required'); }
  const db = await openDatabase(indexedDB); let closed = false;
  function ensureOpen() { if (closed) throw new Error('local wallet fence is closed'); }
  // Probe the exact schema and strict transaction capability before use.
  try { await run(db, 'readwrite', (_store, done) => done(true)); }
  catch (error) { db.close(); throw error; }
  return Object.freeze({
    async inspect(owner) {
      ensureOpen(); if (!ownerId(owner)) throw new Error('invalid testnet owner');
      return run(db, 'readonly', (store, done, fail) => {
        const get = store.get(owner);
        get.onsuccess = () => { try { done(get.result === undefined ? empty(owner) : publicRow(checkedRow(get.result, owner))); }
          catch { fail('local wallet fence is malformed; stop and reconcile'); } };
      });
    },
    async reserve(input = {}) {
      ensureOpen();
      if (!exact(input, ['network', 'owner', 'stage_id', 'review_sha256', 'action_commitment_sha256'])) {
        throw new Error('exact public testnet prompt commitment required');
      }
      const { network, owner, stage_id, review_sha256, action_commitment_sha256 } = input;
      if (network !== 'testnet' || !ownerId(owner) || !stage(stage_id) || !hex64(review_sha256) ||
          !hex64(action_commitment_sha256)) throw new Error('exact public testnet prompt commitment required');
      const ms = now();
      if (!Number.isSafeInteger(ms) || ms < 1 || !Number.isFinite(new Date(ms).getTime())) throw new Error('invalid local clock');
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      if (!bytes.some(byte => byte !== 0)) throw new Error('local operation randomness unavailable');
      const operation_id = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const row = { owner, network: 'testnet', operation_id, stage_id, review_sha256, action_commitment_sha256,
        created_at_ms: ms, status: 'PROMPT_RESERVED_NO_HASH', tx_hash: null };
      return run(db, 'readwrite', (store, done, fail) => {
        const add = store.add(row);
        add.onsuccess = () => done(publicRow(row));
        add.onerror = event => { event.preventDefault(); fail('a local wallet prompt is already unresolved; stop and reconcile'); };
      });
    },
    async recordOriginalHash(input = {}) {
      ensureOpen();
      if (!exact(input, ['owner', 'operation_id', 'tx_hash'])) throw new Error('original testnet wallet hash and operation ID required');
      const { owner, operation_id, tx_hash } = input;
      if (!ownerId(owner) || !hex32(operation_id) || !transactionHash(tx_hash)) {
        throw new Error('original testnet wallet hash and operation ID required');
      }
      return run(db, 'readwrite', (store, done, fail) => {
        const get = store.get(owner);
        get.onsuccess = () => {
          let row;
          try { row = checkedRow(get.result, owner); }
          catch { fail('original local wallet fence is missing or malformed; stop and reconcile'); return; }
          if (row.operation_id !== operation_id || (row.tx_hash !== null && row.tx_hash !== tx_hash)) {
            fail('original wallet prompt or hash differs; never replace it'); return;
          }
          if (row.tx_hash === tx_hash) { done(publicRow(row)); return; }
          const next = { ...row, status: 'ORIGINAL_HASH_RECORDED', tx_hash };
          const put = store.put(next);
          put.onsuccess = () => done(publicRow(next));
        };
      });
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
