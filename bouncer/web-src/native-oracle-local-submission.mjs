/**
 * One local, write-ahead submission claim for a witnessed native trial.
 * This record contains only public identifiers, never signed bytes or keys.
 * IndexedDB arbitrates cooperating tabs in this browser profile; deletion,
 * rollback, other devices and bypassing clients are not covered. The
 * independently anchored original remains essential. A missing record is
 * never evidence that a transaction was not sent.
 */
const DB = 'bouncer-native-oracle-submission-v1', STORE = 'submissions';
const fail = () => new Error('native submission unavailable or already claimed; stop and reconcile the original');
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const fields = ['review_sha256', 'operation_id', 'owner', 'original_hash'];
function valid(row) {
  return plain(row) && Object.keys(row).length === fields.length && fields.every(k => Object.hasOwn(row, k)) &&
    /^[a-f0-9]{64}$/.test(row.review_sha256 ?? '') && /^[a-f0-9]{32}$/.test(row.operation_id ?? '') &&
    typeof row.owner === 'string' && row.owner.endsWith('.testnet') &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.original_hash ?? '');
}
function open(indexedDB) {
  return new Promise((resolve, reject) => {
    let request, settled = false;
    try { request = indexedDB.open(DB, 1); } catch { reject(fail()); return; }
    request.onupgradeneeded = event => {
      if (event.oldVersion !== 0) { request.transaction.abort(); return; }
      request.result.createObjectStore(STORE, { keyPath: 'review_sha256' });
    };
    const unavailable = () => { if (!settled) { settled = true; reject(fail()); } };
    request.onerror = unavailable; request.onblocked = unavailable;
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(STORE)) {
        db.close(); reject(fail()); return;
      }
      db.onversionchange = () => db.close(); resolve(db);
    };
  });
}
function transaction(db, mode, action) {
  return new Promise((resolve, reject) => {
    let tx, result;
    try {
      tx = db.transaction(STORE, mode, { durability: 'strict' });
      if (tx.durability !== 'strict') { tx.abort(); reject(fail()); return; }
      const store = tx.objectStore(STORE);
      if (store.keyPath !== 'review_sha256' || store.indexNames.length !== 0) { tx.abort(); reject(fail()); return; }
      const request = action(store);
      request.onsuccess = () => { result = request.result; };
      request.onerror = event => { event.preventDefault(); tx.abort(); };
    } catch { try { tx?.abort(); } catch {} reject(fail()); return; }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(fail()); tx.onerror = () => {};
  });
}

/** Claim BEFORE the single fetch. Unknown commits and duplicate claims stop. */
export async function retainLocalNativeSubmission(indexedDB, raw) {
  const row = structuredClone(raw);
  if (!indexedDB || !valid(row)) throw fail();
  const db = await open(indexedDB);
  try {
    await transaction(db, 'readwrite', store => store.add(row));
    const saved = await transaction(db, 'readonly', store => store.get(row.review_sha256));
    if (!valid(saved) || fields.some(k => saved[k] !== row[k])) throw fail();
    return structuredClone(saved);
  } finally { db.close(); }
}

/** Read-only; absence cannot authorize signing or another submission. */
export async function inspectLocalNativeSubmission(indexedDB, reviewSha256) {
  if (!indexedDB || !/^[a-f0-9]{64}$/.test(reviewSha256 ?? '')) throw fail();
  const db = await open(indexedDB);
  try {
    const row = await transaction(db, 'readonly', store => store.get(reviewSha256));
    if (row === undefined) return null;
    if (!valid(row) || row.review_sha256 !== reviewSha256) throw fail();
    return structuredClone(row);
  } finally { db.close(); }
}
