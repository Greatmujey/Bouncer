/**
 * Encrypted browser-side copy of a V14 original checkpoint. This adapter is
 * compatible with the V14 witness store interface, but it does not itself
 * authorize a wallet prompt, verify a receipt, or provide the second copy.
 *
 * IndexedDB transactions make each compare-and-swap atomic between tabs on
 * the same origin. AES-GCM encrypts the local snapshot with the distinct
 * 32-byte witness-journal key from the owner's encrypted recovery kit; the
 * key is never written into IndexedDB. Browser storage can be evicted, rolled
 * back, cleared or compromised. The caller must compare this copy with the
 * independently retained checkpoint before each action and stop on any
 * mismatch or uncertain acknowledgement. Never recreate a missing original.
 *
 * `initializeBrandNew` is only for a genuinely new, owner-approved scope
 * after its atomic V2 enrollment has been confirmed. An empty IndexedDB cannot
 * prove that a previous scope or wallet prompt did not exist elsewhere.
 */
import { isV14CheckpointAccountPair } from './v14-checkpoint-enrollment.mjs';

const DATABASE = 'bouncer-v14-browser-witness-v1';
const STORE = 'originals';
const FORMAT = 'bouncer-v14-browser-witness-v1';
const GENESIS = '0'.repeat(64);
const HEX = /^[a-f0-9]{64}$/, SCOPE = /^[a-f0-9]{32}$/;
const MAX_EVENTS = 32, MAX_RECORD = 24_576, MAX_SNAPSHOT = 900_000, MAX_ENVELOPE = 1_210_000;
const text = new TextEncoder();
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => new Error('browser original checkpoint is missing or uncertain; preserve the original and never repeat a wallet prompt');
const fields = ['format','scope_id','owner','vault','revision','head_sha256','iv_base64'];
const snapshotFields = ['revision','head_sha256','events'];
const copy = value => structuredClone(value);
const bytesHex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function unbase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail();
  let binary;
  try { binary = atob(value); } catch { throw fail(); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.length < minimum || bytes.length > maximum || base64(bytes) !== value) throw fail();
  return bytes;
}
function fromHex(value) {
  if (!HEX.test(value ?? '')) throw fail();
  return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
}
async function sha(crypto, value) {
  return bytesHex(new Uint8Array(await crypto.subtle.digest('SHA-256', text.encode(value))));
}

// Validates the canonical hash chain and bounds. The V14 witness additionally
// validates the complete reviewed binding and allowed state transitions.
async function checkedSnapshot(value, crypto) {
  if (!exact(value, snapshotFields) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      value.revision > MAX_EVENTS || !HEX.test(value.head_sha256 ?? '') || !Array.isArray(value.events) ||
      value.events.length !== value.revision) throw fail();
  let head = GENESIS, total = 0;
  for (let index = 0; index < value.events.length; index++) {
    const line = value.events[index];
    if (typeof line !== 'string' || !line || /[\r\n]/.test(line)) throw fail();
    const size = text.encode(line).length;
    if (size > MAX_RECORD || (total += size) > MAX_SNAPSHOT) throw fail();
    let event;
    try { event = JSON.parse(line); } catch { throw fail(); }
    if (!exact(event, ['format','seq','previous_sha256','type','data']) || JSON.stringify(event) !== line ||
        event.format !== 'bouncer-v14-original-event-v1' || event.seq !== index + 1 ||
        event.previous_sha256 !== head || typeof event.type !== 'string') throw fail();
    head = await sha(crypto, line);
  }
  if (head !== value.head_sha256 || text.encode(JSON.stringify(value)).length > MAX_SNAPSHOT) throw fail();
  return copy(value);
}
function openDatabase(indexedDB, allowCreate) {
  return new Promise((resolve, reject) => {
    let request, settled = false;
    try { request = indexedDB.open(DATABASE, 1); } catch { reject(fail()); return; }
    const bad = () => { if (!settled) { settled = true; reject(fail()); } };
    request.onupgradeneeded = event => {
      try {
        // Opening for recovery must not manufacture a missing local original.
        if (!allowCreate || event.oldVersion !== 0) {
          request.transaction.abort(); return;
        }
        request.result.createObjectStore(STORE);
      } catch { try { request.transaction.abort(); } catch { /* already aborted */ } }
    };
    request.onblocked = bad;
    request.onerror = bad;
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      if (!db.objectStoreNames.contains(STORE)) { db.close(); bad(); return; }
      settled = true;
      resolve(db);
    };
  });
}
function getRecord(db, scopeId) {
  return new Promise((resolve, reject) => {
    let transaction, request, value;
    try { transaction = db.transaction(STORE, 'readonly'); request = transaction.objectStore(STORE).get(scopeId); }
    catch { reject(fail()); return; }
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = transaction.onabort = () => reject(fail());
  });
}
function addRecord(db, scopeId, value) {
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = db.transaction(STORE, 'readwrite'); transaction.objectStore(STORE).add(value, scopeId); }
    catch { reject(fail()); return; }
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(fail());
  });
}
function compareAndReplace(db, scopeId, expected, replacement) {
  return new Promise((resolve, reject) => {
    let transaction, request;
    try { transaction = db.transaction(STORE, 'readwrite'); request = transaction.objectStore(STORE).get(scopeId); }
    catch { reject(fail()); return; }
    request.onsuccess = () => {
      try {
        // The read and write are in ONE IndexedDB transaction. Never overwrite
        // a concurrently changed or missing original, even if it decrypts.
        if (JSON.stringify(request.result) !== JSON.stringify(expected)) { transaction.abort(); return; }
        transaction.objectStore(STORE).put(replacement, scopeId);
      } catch { try { transaction.abort(); } catch { /* already aborted */ } }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(fail());
  });
}

/** Explicitly open a new local copy, or require the existing encrypted copy. */
export async function createV14BrowserWitnessStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto,
    owner, vault, scopeId, journalKeyHex, initializeBrandNew = false } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function' || !crypto?.subtle || typeof crypto.getRandomValues !== 'function' ||
      !isV14CheckpointAccountPair(vault, owner) || !SCOPE.test(scopeId ?? '') || !HEX.test(journalKeyHex ?? '') ||
      typeof initializeBrandNew !== 'boolean') throw fail();
  let keyBytes = fromHex(journalKeyHex), key, db, failed = false, closed = false;
  try { key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt','decrypt']); }
  catch { throw fail(); } finally { keyBytes.fill(0); keyBytes = null; }
  db = await openDatabase(indexedDB, initializeBrandNew);
  const header = value => Object.fromEntries(fields.map(field => [field, value[field]]));
  async function seal(snapshot) {
    const checked = await checkedSnapshot(snapshot, crypto), iv = crypto.getRandomValues(new Uint8Array(12));
    const meta = {format:FORMAT,scope_id:scopeId,owner,vault,revision:checked.revision,
      head_sha256:checked.head_sha256,iv_base64:base64(iv)};
    const plaintext = text.encode(JSON.stringify(checked));
    try {
      const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:text.encode(JSON.stringify(meta)),tagLength:128}, key, plaintext);
      return {...meta,ciphertext_base64:base64(new Uint8Array(ciphertext))};
    } finally { plaintext.fill(0); }
  }
  async function open(value) {
    if (!exact(value, [...fields,'ciphertext_base64']) || value.format !== FORMAT || value.scope_id !== scopeId ||
        value.owner !== owner || value.vault !== vault || !Number.isSafeInteger(value.revision) ||
        value.revision < 0 || value.revision > MAX_EVENTS || !HEX.test(value.head_sha256 ?? '') ||
        typeof value.ciphertext_base64 !== 'string' || value.ciphertext_base64.length > MAX_ENVELOPE) throw fail();
    const iv = unbase64(value.iv_base64, 12, 12), ciphertext = unbase64(value.ciphertext_base64, 17, MAX_SNAPSHOT + 16);
    let plaintext;
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,
        additionalData:text.encode(JSON.stringify(header(value))),tagLength:128}, key, ciphertext));
      if (plaintext.length > MAX_SNAPSHOT) throw fail();
      const parsed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
      const result = await checkedSnapshot(parsed, crypto);
      if (result.revision !== value.revision || result.head_sha256 !== value.head_sha256) throw fail();
      return result;
    } catch { throw fail(); } finally { plaintext?.fill(0); }
  }
  async function readRecord() {
    if (failed || closed) throw fail();
    try {
      const envelope = await getRecord(db, scopeId);
      if (envelope === undefined) throw fail();
      return {envelope,snapshot:await open(envelope)};
    } catch { failed = true; throw fail(); }
  }
  try {
    if (initializeBrandNew) {
      const initial = {revision:0,head_sha256:GENESIS,events:[]};
      await addRecord(db, scopeId, await seal(initial));
      const current = await readRecord();
      if (JSON.stringify(current.snapshot) !== JSON.stringify(initial)) throw fail();
    } else await readRecord();
  } catch { failed = true; db.close(); throw fail(); }
  return Object.freeze({
    read:async () => (await readRecord()).snapshot,
    append:async ({expected_revision,expected_head_sha256,record} = {}) => {
      if (failed || closed || !Number.isSafeInteger(expected_revision) || expected_revision < 0 || expected_revision >= MAX_EVENTS ||
          !HEX.test(expected_head_sha256 ?? '') || typeof record !== 'string' || !record || /[\r\n]/.test(record) ||
          text.encode(record).length > MAX_RECORD) throw fail();
      try {
        const previous = await readRecord();
        if (previous.snapshot.revision !== expected_revision || previous.snapshot.head_sha256 !== expected_head_sha256) throw fail();
        const next = {revision:expected_revision + 1,head_sha256:await sha(crypto,record),events:[...previous.snapshot.events,record]};
        const replacement = await seal(next);
        await compareAndReplace(db, scopeId, previous.envelope, replacement);
        const confirmed = await readRecord();
        if (JSON.stringify(confirmed.snapshot) !== JSON.stringify(next)) throw fail();
        return copy(next);
      } catch { failed = true; throw fail(); }
    },
    close:() => { if (!closed) { closed = true; db.close(); } },
  });
}
