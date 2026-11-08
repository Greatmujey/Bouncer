/**
 * One local write-ahead original-hash record per reviewed native oracle trial.
 * No transaction bytes, private keys, RPC or broadcast are stored here.
 * Strict IndexedDB commits arbitrate cooperating tabs in this one browser
 * profile; browser deletion, rollback, another device/origin or a bypassing
 * client are NOT covered. A missing record is not proof of no transaction.
 * This is not a distributed journal or independent backup.
 */
const DB = 'bouncer-native-oracle-original-v1', STORE = 'originals';
const FIELDS = ['review_sha256','operation_id','owner','vault','agent_public_key','tx_hash','block_hash','nonce','created_at_ms'];
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const fail = () => new Error('native original unavailable or already recorded; stop and reconcile, never sign another attempt');
function valid(row) {
  return plain(row) && Object.keys(row).length === FIELDS.length && FIELDS.every(k => Object.hasOwn(row,k)) &&
    /^[a-f0-9]{64}$/.test(row.review_sha256 ?? '') && /^[a-f0-9]{32}$/.test(row.operation_id ?? '') &&
    typeof row.owner === 'string' && typeof row.vault === 'string' &&
    /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.agent_public_key ?? '') &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.tx_hash ?? '') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.block_hash ?? '') &&
    /^[1-9][0-9]{0,19}$/.test(row.nonce ?? '') && Number.isSafeInteger(row.created_at_ms) && row.created_at_ms > 0;
}
function open(indexedDB) {
  return new Promise((resolve,reject) => {
    let request,settled=false;
    try { request=indexedDB.open(DB,1); } catch { reject(fail());return; }
    request.onupgradeneeded = event => {
      if(event.oldVersion!==0){request.transaction.abort();return;}
      request.result.createObjectStore(STORE,{keyPath:'review_sha256'});
    };
    const unavailable=()=>{if(!settled){settled=true;reject(fail())}};
    request.onerror=unavailable;request.onblocked=unavailable;
    request.onsuccess=()=>{
      const db=request.result;
      if(settled){db.close();return;}settled=true;
      if(db.version!==1 || db.objectStoreNames.length!==1 || !db.objectStoreNames.contains(STORE)){db.close();reject(fail());return;}
      db.onversionchange=()=>db.close();resolve(db);
    };
  });
}
function transaction(db,mode,action) {
  return new Promise((resolve,reject)=>{
    let tx,result;
    try {
      tx=db.transaction(STORE,mode,{durability:'strict'});
      if(tx.durability!=='strict'){tx.abort();reject(fail());return;}
      const store=tx.objectStore(STORE);
      if(store.keyPath!=='review_sha256' || store.indexNames.length!==0){tx.abort();reject(fail());return;}
      const request=action(store);
      request.onsuccess=()=>{result=request.result};
      request.onerror=event=>{event.preventDefault();tx.abort()};
    } catch { try{tx?.abort()}catch{} reject(fail());return; }
    tx.oncomplete=()=>resolve(result);
    tx.onabort=()=>reject(fail());tx.onerror=()=>{};
  });
}

/** Commit the hash BEFORE exposing a signature; a duplicate fails closed. */
export async function retainLocalNativeOriginal(indexedDB, raw) {
  const row=structuredClone(raw);if(!valid(row))throw fail();
  const db=await open(indexedDB);
  try {
    await transaction(db,'readwrite',store=>store.add(row));
    const saved=await transaction(db,'readonly',store=>store.get(row.review_sha256));
    if(!valid(saved) || FIELDS.some(k=>saved[k]!==row[k]))throw fail();
    return structuredClone(saved);
  } finally { db.close(); }
}

/** Local evidence only; no missing record authorizes a new payment. */
export async function inspectLocalNativeOriginal(indexedDB, reviewSha256) {
  if(typeof reviewSha256!=='string' || !/^[a-f0-9]{64}$/.test(reviewSha256))throw fail();
  const db=await open(indexedDB);
  try {
    const row=await transaction(db,'readonly',store=>store.get(reviewSha256));
    if(row===undefined)return null;
    if(!valid(row) || row.review_sha256!==reviewSha256)throw fail();
    return structuredClone(row);
  } finally { db.close(); }
}
