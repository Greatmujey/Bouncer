/**
 * EXPERIMENTAL, local-only custody for ONE testnet agent key per owner.
 *
 * Generates an Ed25519 WebCrypto private CryptoKey as non-extractable and
 * stores it in IndexedDB. The opt-in trial method can sign exactly one pinned
 * native-oracle transaction after a checked setup snapshot and a local original
 * hash record. It never invokes a wallet, calls an RPC or broadcasts. It also
 * signs a domain-separated possession challenge internally before reporting
 * local availability. The experimental UI connects it only through the
 * separately disabled-by-default testnet trial flow, not a live deployment.
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
import { verifyNativeOracleSetupReview } from './native-oracle-setup-wallet-prompt.mjs';
import { buildNativeOracleTrialBytes, appendNativeOracleSignature, encodeBase58 } from './native-oracle-transaction.mjs';
import { retainLocalNativeOriginal, inspectLocalNativeOriginal } from './native-oracle-local-attempt.mjs';
import { assertNativeOracleCompletion } from './native-oracle-completion.mjs';

const DB_NAME = 'bouncer-native-oracle-device-key-v1', STORE = 'device-keys';
// This previously used owner has unresolved original hashes; it is excluded
// from the unsigned plan too. This is a public account ID, not a credential.
const EXCLUDED_OWNER = 'bouncer-owner-12f343b795633e357ae5560d.testnet';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FIELDS = ['version', 'network', 'owner', 'vault', 'origin', 'public_key', 'private_key', 'public_crypto_key', 'created_at_ms'];
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, fields) => plain(x) && Object.keys(x).length === fields.length && fields.every(k => Object.hasOwn(x, k));
const fail = message => new Error(message);
const unavailable = () => fail('native oracle signing unavailable or uncertain; stop and reconcile, never retry automatically');
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
    /** Signs only the reviewed 0.1-NEAR-maximum pinned oracle call, not an
     * arbitrary transaction. The UI must separately show the terms and obtain
     * explicit owner consent. This method records the original hash locally
     * before releasing the signature and never broadcasts. Local storage is
     * NOT independent durable recovery; a live caller still needs an external
     * original-hash fence and must reconcile any uncertain result. */
    async signNativeOracleTrial(value) {
      ensureOpen();
      const base=['review','identity','completion','ownerConfirmed','expectedTransactionHash'];
      const witnessed=exact(value,[...base,'freshCompletion','witness']);
      if ((!witnessed && !exact(value,base)) || value.ownerConfirmed!==true || typeof value.expectedTransactionHash!=='string') throw unavailable();
      const review=structuredClone(value.review),identity=structuredClone(value.identity),completion=structuredClone(value.completion);
      const fresh=witnessed?structuredClone(value.freshCompletion):completion, witness=witnessed?structuredClone(value.witness):null;
      input({owner:review?.owner,vault:review?.vault});
      const row=await run(db,'readonly',(store,done)=>{const get=store.get(review.owner);get.onsuccess=()=>done(get.result)});
      const device=await validate(row,review.owner,review.vault,review.agent_public_key);
      const canonical=await verifyNativeOracleSetupReview({review,identity,deviceKey:device,origin,crypto});
      const checkFresh=clock=>{
        // Witnessing the original can take longer than five seconds. Keep the
        // original block/nonce, but demand a new five-second state recheck with
        // the SAME nonce and original setup receipts after that witness.
        assertNativeOracleCompletion(completion,review,clock,witnessed?{maxAgeMs:120_000}:undefined);
        assertNativeOracleCompletion(fresh,review,clock);
        if(witnessed && (fresh.agent_key_nonce!==completion.agent_key_nonce || fresh.block_height<completion.block_height ||
            (fresh.block_height===completion.block_height && (fresh.block_hash!==completion.block_hash ||
              fresh.block_timestamp_nanosec!==completion.block_timestamp_nanosec)) ||
            (fresh.block_height>completion.block_height && (fresh.block_hash===completion.block_hash ||
              BigInt(fresh.block_timestamp_nanosec)<BigInt(completion.block_timestamp_nanosec))) ||
            Date.parse(fresh.observed_at)<Date.parse(completion.observed_at) ||
            JSON.stringify(fresh.prior_original_hashes)!==JSON.stringify(completion.prior_original_hashes)))throw unavailable();
      };
      checkFresh(now());
      if(witnessed) {
        const fields=['status','owner','operation_id','review_sha256','goal_id','goal_sha256','agent_public_key','original_hash',
          'witness_head','independently_witnessed','do_not_retry','execution_authorized','transaction_sent'];
        if(!exact(witness,fields) || witness.status!=='TRIAL_ORIGINAL_WITNESSED' || witness.owner!==review.owner ||
            witness.operation_id!==identity.operation_id || witness.review_sha256!==review.review_sha256 ||
            witness.agent_public_key!==review.agent_public_key || witness.original_hash!==value.expectedTransactionHash ||
            typeof witness.goal_id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(witness.goal_id) ||
            !/^[a-f0-9]{64}$/.test(witness.goal_sha256??'') || !/^[a-f0-9]{40}$/.test(witness.witness_head??'') ||
            witness.witness_head!==fresh.witness_head || witness.witness_head===completion.witness_head ||
            witness.independently_witnessed!==true || witness.do_not_retry!==true || witness.execution_authorized!==false ||
            witness.transaction_sent!==false)throw unavailable();
        const goal={id:witness.goal_id,contract_id:canonical.vault,owner_account_id:canonical.owner,policy_id:canonical.policy_id,
          amount:canonical.per_tx_cap_yocto,route:{project:canonical.project,route_revision:1,policy_revision:1,payee_revision:1,active:true},
          max_age_seconds:300};
        const goalDigest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(goal))));
        const goalHex=Array.from(goalDigest,b=>b.toString(16).padStart(2,'0')).join('');
        if(goalHex!==witness.goal_sha256)throw unavailable();
      }
      const built=buildNativeOracleTrialBytes(canonical,completion);
      if (typeof crypto.subtle.digest!=='function') throw unavailable();
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',built.unsigned));
      if (hash.length!==32) throw unavailable();
      const txHash=encodeBase58(hash),created=now();
      if(txHash!==value.expectedTransactionHash)throw unavailable();
      checkFresh(created);
      const record={review_sha256:review.review_sha256,operation_id:identity.operation_id,
        owner:canonical.owner,vault:canonical.vault,agent_public_key:canonical.agent_public_key,tx_hash:txHash,
        block_hash:built.block_hash,nonce:built.nonce,created_at_ms:created};
      // A committed or uncertain local claim is never cleared or replaced.
      await retainLocalNativeOriginal(indexedDB,record);
      checkFresh(now());
      const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',row.private_key,hash));
      if(signature.length!==64 || await crypto.subtle.verify('Ed25519',row.public_crypto_key,signature,hash)!==true)throw unavailable();
      const saved=await inspectLocalNativeOriginal(indexedDB,record.review_sha256);
      if(!saved || Object.keys(record).some(k=>saved[k]!==record[k]))throw unavailable();
      const current=await run(db,'readonly',(store,done)=>{const get=store.get(review.owner);get.onsuccess=()=>done(get.result)});
      await validate(current,review.owner,review.vault,review.agent_public_key);
      checkFresh(now());
      return {status:'SIGNED_NOT_BROADCAST',tx_hash:txHash,signed_transaction:appendNativeOracleSignature(built.unsigned,signature),
        owner:canonical.owner,vault:canonical.vault,review_sha256:review.review_sha256,maximum_native_yocto:canonical.per_tx_cap_yocto,
        attached_deposit_yocto:'0',do_not_retry:true,local_original_retained:true,independent_backup_verified:false,
        witnessed_original_matched:witnessed,
        broadcast_authorized:false,transaction_sent:false,provider_delivery_verified:false};
    },
    /** Local-only original inspection. Missing local state never proves that
     * the original did not exist or that another signature is safe. */
    async inspectNativeOracleOriginal({reviewSha256}={}) {
      ensureOpen();const record=await inspectLocalNativeOriginal(indexedDB,reviewSha256);
      return {status:record?'LOCAL_ORIGINAL_RETAINED':'NO_LOCAL_ORIGINAL',record,do_not_retry:true,
        independent_backup_verified:false,transaction_sent:false};
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}
