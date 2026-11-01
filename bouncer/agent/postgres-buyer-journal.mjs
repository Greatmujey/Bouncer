/**
 * Experimental testnet direct seller-v3 buyer journal.
 *
 * One authoritative PostgreSQL primary stores the original signed hash and an
 * encrypted claim BEFORE broadcast. Unique constraints arbitrate across worker
 * processes; advisory session locks protect each journal and serialize all
 * participating direct payments for an owner account. Pending rows quarantine
 * that owner until the original hash is reconciled. No lease takeover,
 * deletion, automatic retry or resend.
 *
 * This protects only upgraded callers using this database and the supported
 * direct v3 runner. Optional strict owner intent IDs can prevent reuse across
 * journals only when operators keep the same ID for the same economic action.
 * This cannot protect a second database, a restored stale backup, a file
 * journal, a bypassing worker, a changed intent ID or a stale primary.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validatePlan, requestFingerprint, normalizeProviderRoute } from './procurement.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { validBuyerIntentId } from '../shared/buyer-intent.mjs';
import { canonicalClaimOrigin, verifyClaimAuthorization } from '../packages/provider-sdk/lib/resource-claim.mjs';

const SCHEMA = 'bouncer_buyer_v1';
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_ENTRIES = 10_000;
// One short, all-or-nothing re-encryption transaction; large journals need a
// separately reviewed offline migration, never a partially rotated journal.
const MAX_ROTATION_ENTRIES = 256;
const MAX_ROTATION_BYTES = 8 * 1024 * 1024;
const MAX_ROTATION_MS = 20_000;
// A portable, authenticated forensic snapshot is deliberately bounded. It is
// not a replacement for a consistent, externally protected PostgreSQL backup.
const MAX_SNAPSHOT_ENTRIES = 256;
const MAX_SNAPSHOT_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_BUYER_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const own = (obj, key) => Object.hasOwn(obj, key);

export class BuyerJournalError extends Error {
  constructor(code, message) { super(message); this.name = 'BuyerJournalError'; this.code = code; }
}
const conflict = () => new BuyerJournalError('CONFLICT', 'request, seller challenge or transaction is already reserved; never pay it again');

function validateScope({ contractId, ownerAccountId, journalId }) {
  if (!isTestnetAccount(contractId) || !isTestnetAccount(ownerAccountId) || typeof journalId !== 'string' || !idPattern.test(journalId)) {
    throw new Error('invalid shared buyer testnet account or stable journal ID');
  }
  return Object.freeze({ contractId, ownerAccountId, journalId });
}
function scopeValues(scope) { return [scope.contractId, scope.ownerAccountId, scope.journalId]; }
function keyCheck(key, scope) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(['bouncer-buyer-key-v1', ...scopeValues(scope)])).digest();
}
function lockWordsFor(parts) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(parts)).digest();
  return { signed: [hash.readInt32BE(0), hash.readInt32BE(4)], unsigned: [hash.readUInt32BE(0), hash.readUInt32BE(4)] };
}
function lockWords(scope) { return lockWordsFor(['bouncer-buyer-lock-v1', ...scopeValues(scope)]); }
// NEAR access-key nonces belong to the signer account, not the target Bouncer
// contract or journal. Conservatively serialize *all* its participating keys.
function ownerLockWords(owner) { return lockWordsFor(['bouncer-buyer-owner-fence-v1', 'near:testnet', owner]); }
function aad(scope, metadata) {
  return Buffer.from(JSON.stringify(['bouncer-buyer-record-v1', ...scopeValues(scope), metadata.id,
    metadata.fingerprint, metadata.status, metadata.tx_hash, metadata.seller_origin, metadata.challenge, metadata.revision]), 'utf8');
}
function encrypt(key, scope, metadata, entry) {
  const bytes = Buffer.from(JSON.stringify(entry), 'utf8');
  if (bytes.length > MAX_RECORD_BYTES) throw new Error('shared buyer entry exceeds its size limit');
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(scope, metadata));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}
function decrypt(key, scope, metadata, row) {
  try {
    if (!Buffer.isBuffer(row.nonce) || row.nonce.length !== 12 || !Buffer.isBuffer(row.tag) || row.tag.length !== 16 ||
        !Buffer.isBuffer(row.ciphertext) || row.ciphertext.length > MAX_RECORD_BYTES) throw new Error();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, row.nonce);
    cipher.setAAD(aad(scope, metadata)); cipher.setAuthTag(row.tag);
    return JSON.parse(Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString('utf8'));
  } catch { throw new BuyerJournalError('CORRUPT', 'shared buyer entry or its metadata failed authentication'); }
}

function entryMetadata(scope, id, raw, revision) {
  if (!plain(raw) || typeof id !== 'string' || !idPattern.test(id) || (own(raw, 'id') && raw.id !== id) ||
      !['pending', 'completed'].includes(raw.status) || !fingerprintPattern.test(raw.fingerprint ?? '') ||
      raw.payment_version !== 'direct-signed-v1' || !isTransactionHash(raw.tx_hash) ||
      typeof raw.agent_public_key !== 'string' || typeof raw.started_at !== 'string' ||
      !Number.isFinite(Date.parse(raw.started_at))) throw new Error('invalid signed shared buyer entry');
  const allowed = ['id', 'fingerprint', 'status', 'request', 'provider_route', 'started_at', 'payment_version',
    'agent_public_key', 'tx_hash', 'resource_authorization', 'settlement', 'completed_at', 'delivery', 'intent_id'];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || (own(raw, 'intent_id') && !validBuyerIntentId(raw.intent_id))) {
    throw new Error('unsupported shared buyer entry fields or invalid intent ID');
  }
  const request = validatePlan({ contract_id: scope.contractId, owner_account_id: scope.ownerAccountId, requests: [raw.request] }).requests[0];
  if (!isDeepStrictEqual(request, raw.request) || request.id !== id || requestFingerprint(request) !== raw.fingerprint) {
    throw new Error('shared buyer request does not match its fingerprint');
  }
  const route = normalizeProviderRoute(raw.provider_route);
  if (!route.provider_origin) throw new Error('shared buyer requires a pinned seller origin');
  const origin = canonicalClaimOrigin(new URL(route.provider_origin).origin);
  const match = new RegExp(`^bouncer-order-v3:${request.resource}:([a-f0-9]{32}):[a-f0-9]{64}$`).exec(request.memo);
  if (!match || !['compute', 'storage', 'api'].includes(request.resource)) throw new Error('shared buyer supports only seller-v3 orders');
  verifyClaimAuthorization({ network: 'near:testnet', contract_id: scope.contractId, owner_account_id: scope.ownerAccountId,
    seller_origin: origin, resource: request.resource, policy_id: request.policy_id, token: request.token,
    payee: request.payee, amount: request.amount, memo: request.memo, tx_hash: raw.tx_hash }, raw.resource_authorization, raw.agent_public_key);
  if (raw.status === 'pending') {
    if (own(raw, 'settlement') || own(raw, 'completed_at') || own(raw, 'delivery')) throw new Error('pending shared buyer entry has completed fields');
  } else {
    const settlement = raw.settlement;
    if (!plain(settlement) || Object.keys(settlement).length !== 5 || settlement.tx_hash !== raw.tx_hash ||
        settlement.token !== request.token || settlement.payee !== request.payee || settlement.amount !== request.amount ||
        settlement.verification !== 'FINAL trusted-RPC Bouncer and token receipts; provider delivery not established' ||
        typeof raw.completed_at !== 'string' || !Number.isFinite(Date.parse(raw.completed_at))) {
      throw new Error('completed shared buyer entry lacks the matching verified settlement');
    }
    if (raw.delivery !== undefined && (!plain(raw.delivery) || !['unverified', 'verified'].includes(raw.delivery.status))) {
      throw new Error('invalid shared buyer delivery status');
    }
  }
  return { id, fingerprint: raw.fingerprint, status: raw.status, tx_hash: raw.tx_hash,
    seller_origin: origin, challenge: match[1], revision };
}

function assertTransition(previous, next) {
  for (const key of ['id', 'fingerprint', 'request', 'provider_route', 'started_at', 'payment_version',
    'agent_public_key', 'tx_hash', 'resource_authorization', 'intent_id']) {
    if (!isDeepStrictEqual(previous[key], next[key])) throw new Error('shared buyer payment identity is immutable');
  }
  if (previous.status === 'completed') {
    if (next.status !== 'completed' || !isDeepStrictEqual(previous.settlement, next.settlement) || previous.completed_at !== next.completed_at) {
      throw new Error('a completed shared payment cannot be changed or reset');
    }
    if (previous.delivery?.status === 'verified' && !isDeepStrictEqual(previous.delivery, next.delivery)) {
      throw new Error('a verified delivery receipt cannot be changed or reset');
    }
  } else if (next.status !== 'completed') {
    throw new Error('a reserved shared payment cannot be replaced or reset');
  }
}

const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const snapshotInvalid = () => new BuyerJournalError('SNAPSHOT_INVALID', 'encrypted buyer snapshot failed authentication or validation');
function decodeSnapshotBytes(value, length) {
  if (typeof value !== 'string' || value.length > Math.ceil(length / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw snapshotInvalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value) throw snapshotInvalid();
  return bytes;
}
function snapshotMac(key, payload) {
  // Separate the snapshot authentication key from the AES-GCM encryption key.
  const macKey = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from('bouncer-buyer-snapshot-mac-v1'), 32));
  try { return crypto.createHmac('sha256', macKey).update(JSON.stringify(payload), 'utf8').digest(); }
  finally { macKey.fill(0); }
}
function parseBuyerSnapshot(serialized, inputKey) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BUYER_SNAPSHOT_BYTES ||
      !Buffer.isBuffer(inputKey) || inputKey.length !== 32) throw snapshotInvalid();
  const key = Buffer.from(inputKey);
  try {
    const envelope = JSON.parse(serialized);
    if (!exact(envelope, ['format', 'payload', 'mac']) || envelope.format !== 'bouncer-buyer-snapshot-v1' ||
        !exact(envelope.payload, ['network', 'scope', 'key_check', 'entries'])) throw snapshotInvalid();
    const payload = envelope.payload;
    const mac = decodeSnapshotBytes(envelope.mac, 32), expected = snapshotMac(key, payload);
    if (!crypto.timingSafeEqual(mac, expected)) throw snapshotInvalid();
    if (payload.network !== 'near:testnet' || !exact(payload.scope, ['contract_id', 'owner_account_id', 'journal_id']) ||
        !Array.isArray(payload.entries) || payload.entries.length > MAX_SNAPSHOT_ENTRIES) throw snapshotInvalid();
    const scope = validateScope({ contractId: payload.scope.contract_id, ownerAccountId: payload.scope.owner_account_id, journalId: payload.scope.journal_id });
    const storedCheck = decodeSnapshotBytes(payload.key_check, 32), expectedCheck = keyCheck(key, scope);
    if (!crypto.timingSafeEqual(storedCheck, expectedCheck)) throw snapshotInvalid();
    const entries = new Map(), hashes = new Set(), challenges = new Set(); let bytes = 0, previousId = null;
    for (const row of payload.entries) {
      if (!exact(row, ['id', 'fingerprint', 'status', 'tx_hash', 'seller_origin', 'challenge', 'revision', 'nonce', 'tag', 'ciphertext']) ||
          typeof row.id !== 'string' || (previousId !== null && row.id <= previousId) ||
          !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.ciphertext !== 'string') throw snapshotInvalid();
      previousId = row.id;
      const cipherLength = Math.floor(row.ciphertext.length * 3 / 4) - (row.ciphertext.endsWith('==') ? 2 : row.ciphertext.endsWith('=') ? 1 : 0);
      if (!Number.isSafeInteger(cipherLength) || cipherLength < 0 || cipherLength > MAX_RECORD_BYTES ||
          (bytes += cipherLength) > MAX_SNAPSHOT_CIPHERTEXT_BYTES) throw snapshotInvalid();
      const encrypted = { nonce: decodeSnapshotBytes(row.nonce, 12), tag: decodeSnapshotBytes(row.tag, 16),
        ciphertext: decodeSnapshotBytes(row.ciphertext, cipherLength) };
      const meta = { id: row.id, fingerprint: row.fingerprint, status: row.status, tx_hash: row.tx_hash,
        seller_origin: row.seller_origin, challenge: row.challenge, revision: row.revision };
      const entry = decrypt(key, scope, meta, encrypted);
      if (!isDeepStrictEqual(entryMetadata(scope, meta.id, entry, meta.revision), meta) || hashes.has(meta.tx_hash) || challenges.has(meta.challenge)) throw snapshotInvalid();
      hashes.add(meta.tx_hash); challenges.add(meta.challenge);
      entries.set(meta.id, { entry, revision: meta.revision });
    }
    return { scope, entries };
  } catch { throw snapshotInvalid(); }
  finally { key.fill(0); }
}
function snapshotSummary(snapshot) {
  const records = [...snapshot.entries].map(([id, row]) => ({ id, status: row.entry.status, tx_hash: row.entry.tx_hash, revision: row.revision }));
  return { network: 'near:testnet', contract_id: snapshot.scope.contractId, owner_account_id: snapshot.scope.ownerAccountId,
    journal_id: snapshot.scope.journalId, count: records.length, entries: records,
    warning: 'Authenticated snapshot only; it may be stale and does not prove chain settlement or delivery.' };
}
/** Authenticate/decrypt in memory; return only safe metadata, never bearer claims. */
export function verifyEncryptedBuyerSnapshot(serialized, key) {
  return snapshotSummary(parseBuyerSnapshot(serialized, key));
}
/**
 * Compare two independently authenticated snapshots, including snapshots across
 * a key rotation. This detects rollback relative to the supplied checkpoint;
 * it does not prove that checkpoint is the latest, or cover other journals.
 */
export function compareEncryptedBuyerSnapshots({ previous, previousKey, current, currentKey }) {
  const older = parseBuyerSnapshot(previous, previousKey), newer = parseBuyerSnapshot(current, currentKey);
  if (!isDeepStrictEqual(older.scope, newer.scope)) throw new BuyerJournalError('SNAPSHOT_SCOPE', 'buyer snapshots belong to different journals');
  for (const [id, before] of older.entries) {
    const after = newer.entries.get(id);
    if (!after || after.revision < before.revision) throw new BuyerJournalError('SNAPSHOT_ROLLBACK', 'current journal is missing a checkpointed payment or revision; stop and reconcile');
    if (after.revision === before.revision) {
      if (!isDeepStrictEqual(before.entry, after.entry)) throw new BuyerJournalError('SNAPSHOT_ROLLBACK', 'checkpointed payment changed without a new revision');
    } else {
      try { assertTransition(before.entry, after.entry); }
      catch { throw new BuyerJournalError('SNAPSHOT_ROLLBACK', 'checkpointed payment regressed or changed identity; stop and reconcile'); }
    }
  }
  return { ...snapshotSummary(newer), checkpoint_count: older.entries.size,
    warning: 'No rollback relative to this authenticated checkpoint; it may be stale and cannot prove other journals or chain state.' };
}

async function checkPrimary(client) {
  const result = await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica,
    pg_catalog.current_setting('fsync') AS fsync, pg_catalog.current_setting('transaction_read_only') AS read_only`);
  if (!result.rows[0] || result.rows[0].replica !== false || result.rows[0].fsync !== 'on' || result.rows[0].read_only !== 'off') {
    throw new BuyerJournalError('UNSAFE_DATABASE', 'buyer database must be a writable primary with fsync enabled');
  }
}

async function transaction(client, run, verifySession = null) {
  let begun = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query("SET LOCAL synchronous_commit = 'on'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    await checkPrimary(client);
    if (verifySession) await verifySession();
    const result = await run(client);
    await client.query('COMMIT'); begun = false;
    return result;
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { /* caller destroys or poisons the session */ } }
    throw error;
  }
}

async function verifySchema(client) {
  const version = await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton = true`);
  if (version.rows.length !== 1 || version.rows[0].version !== 2) throw new BuyerJournalError('UNSAFE_SCHEMA', 'unsupported shared buyer schema version; stop all workers before upgrading');
  // IF NOT EXISTS cannot establish replay safety. Check the exact key columns of
  // all critical, valid, non-partial unique indexes at every open.
  const found = await client.query(`SELECT t.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON k.ordinality <= i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'bouncer_buyer_v1' AND t.relkind = 'r'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY i.indexrelid, t.relname`);
  const indexes = new Set(found.rows.map(row => `${row.table_name}:${row.columns.join(',')}`));
  const required = ['meta:singleton', 'journals:contract_id,owner_account_id,journal_id',
    'entries:contract_id,owner_account_id,journal_id,entry_id', 'entries:challenge', 'entries:tx_hash',
    'owner_intent_modes:owner_account_id', 'intents:owner_account_id,intent_id', 'intents:tx_hash',
    'intents:contract_id,owner_account_id,journal_id,entry_id'];
  if (required.some(index => !indexes.has(index))) throw new BuyerJournalError('UNSAFE_SCHEMA', 'shared buyer schema is missing critical replay constraints');
  // A role-filtered view of pending rows would make the owner fence unsafe.
  // Worker roles need SELECT on the whole table and RLS must remain disabled.
  const visibility = await client.query(`SELECT t.relname, t.relrowsecurity, t.relforcerowsecurity FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='bouncer_buyer_v1' AND t.relname IN ('entries','owner_intent_modes','intents') AND t.relkind='r'`);
  if (visibility.rowCount !== 3 || visibility.rows.some(row => row.relrowsecurity || row.relforcerowsecurity)) {
    throw new BuyerJournalError('UNSAFE_SCHEMA', 'shared buyer coordination tables must not use row-level security');
  }
  // The registry and the encrypted pending row must be committed together and
  // neither may be orphaned or cascade-deleted by ordinary schema operations.
  const foreign = await client.query(`SELECT s.relname AS source, r.relname AS target, c.convalidated, c.condeferrable,
      c.confdeltype, c.confupdtype,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS cols,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.ord) AS refs
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class s ON s.oid=c.conrelid
    JOIN pg_catalog.pg_class r ON r.oid=c.confrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    WHERE n.nspname='bouncer_buyer_v1' AND r.relnamespace=n.oid AND s.relname='intents' AND c.contype='f'`);
  const validFks = new Set(foreign.rows.filter(row => row.convalidated && !row.condeferrable && row.confdeltype === 'a' && row.confupdtype === 'a')
    .map(row => `${row.source}:${row.cols.join(',')}->${row.target}:${row.refs.join(',')}`));
  if (!validFks.has('intents:owner_account_id->owner_intent_modes:owner_account_id') ||
      !validFks.has('intents:contract_id,owner_account_id,journal_id,entry_id->entries:contract_id,owner_account_id,journal_id,entry_id')) {
    throw new BuyerJournalError('UNSAFE_SCHEMA', 'shared buyer intent registry is missing required foreign keys');
  }
}

/** Privileged, explicit schema setup. Does not contact a seller or NEAR. */
export async function initializePostgresBuyerSchema({ pool }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required');
  const client = await pool.connect(); let destroy = false;
  try {
    await transaction(client, async c => {
      await c.query('SELECT pg_catalog.pg_advisory_xact_lock(1702243041, 903134)');
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.meta (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL
      )`);
      await c.query(`INSERT INTO ${SCHEMA}.meta (singleton, version) VALUES (true, 1) ON CONFLICT DO NOTHING`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.journals (
        contract_id text NOT NULL, owner_account_id text NOT NULL, journal_id text NOT NULL,
        key_check bytea NOT NULL CHECK (octet_length(key_check) = 32),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (contract_id, owner_account_id, journal_id)
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.entries (
        contract_id text NOT NULL, owner_account_id text NOT NULL, journal_id text NOT NULL, entry_id text NOT NULL,
        fingerprint text NOT NULL, status text NOT NULL CHECK (status IN ('pending', 'completed')),
        tx_hash text NOT NULL UNIQUE, seller_origin text NOT NULL,
        challenge text NOT NULL UNIQUE CHECK (challenge ~ '^[a-f0-9]{32}$'),
        revision integer NOT NULL CHECK (revision > 0),
        nonce bytea NOT NULL CHECK (octet_length(nonce) = 12), tag bytea NOT NULL CHECK (octet_length(tag) = 16),
        ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) <= 131072),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (contract_id, owner_account_id, journal_id, entry_id),
        FOREIGN KEY (contract_id, owner_account_id, journal_id)
          REFERENCES ${SCHEMA}.journals (contract_id, owner_account_id, journal_id)
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.owner_intent_modes (
        owner_account_id text PRIMARY KEY, activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      await c.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.intents (
        owner_account_id text NOT NULL, intent_id text NOT NULL,
        contract_id text NOT NULL, journal_id text NOT NULL, entry_id text NOT NULL, tx_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (owner_account_id, intent_id), UNIQUE (contract_id, owner_account_id, journal_id, entry_id),
        FOREIGN KEY (owner_account_id) REFERENCES ${SCHEMA}.owner_intent_modes (owner_account_id),
        FOREIGN KEY (contract_id, owner_account_id, journal_id, entry_id)
          REFERENCES ${SCHEMA}.entries (contract_id, owner_account_id, journal_id, entry_id)
      )`);
      // Schema v2 makes old v1 workers reject startup and their later schema
      // checks. Operators must stop all old/in-flight workers before upgrading.
      await c.query(`UPDATE ${SCHEMA}.meta SET version=2 WHERE singleton=true AND version=1`);
      // Optional performance index: safety does not depend on it being present
      // in an older schema. Pending lookup otherwise remains a full-table scan.
      await c.query(`CREATE INDEX IF NOT EXISTS entries_owner_pending_idx
        ON ${SCHEMA}.entries (owner_account_id) WHERE status = 'pending'`);
      await c.query(`CREATE INDEX IF NOT EXISTS entries_owner_idx ON ${SCHEMA}.entries (owner_account_id, tx_hash)`);
      await verifySchema(c);
    });
  } catch (error) { destroy = true; throw error; }
  finally { client.release(destroy); }
}

/**
 * Explicitly opt a NEW owner into stable cross-journal business intents.
 * An empty database history is necessary, not proof that no payment happened
 * in another database, local file, old backup or directly on chain.
 */
export async function activateBuyerOwnerIntents({ pool, ownerAccountId }) {
  if (!pool || typeof pool.connect !== 'function' || !isTestnetAccount(ownerAccountId)) throw new Error('invalid intent activation owner or pool');
  const client = await pool.connect(); let destroy = false;
  try {
    await transaction(client, async c => {
      await verifySchema(c);
      const locked = await c.query('SELECT pg_catalog.pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked', ownerLockWords(ownerAccountId).signed);
      if (locked.rows[0]?.locked !== true) throw new BuyerJournalError('OWNER_BUSY', 'owner has an active shared buyer; stop all workers before activation');
      const existing = await c.query(`SELECT EXISTS (SELECT 1 FROM ${SCHEMA}.entries WHERE owner_account_id=$1) AS has_entries,
        EXISTS (SELECT 1 FROM ${SCHEMA}.owner_intent_modes WHERE owner_account_id=$1) AS active`, [ownerAccountId]);
      if (existing.rows[0]?.active) throw new BuyerJournalError('ALREADY_EXISTS', 'owner intent mode is already active; do not reset it');
      if (existing.rows[0]?.has_entries !== false) throw new BuyerJournalError('OWNER_HAS_HISTORY', 'owner has existing shared payments; do not automatically enable intent mode or replace their history');
      await c.query(`INSERT INTO ${SCHEMA}.owner_intent_modes (owner_account_id) VALUES ($1)`, [ownerAccountId]);
    });
  } catch (error) { destroy = true; if (error instanceof BuyerJournalError) throw error;
    throw new BuyerJournalError('DATABASE', 'intent activation failed or its commit is uncertain; inspect the original database before continuing'); }
  finally { client.release(destroy); }
}

async function readOwnerIntentMode(c, owner) {
  const result = await c.query(`SELECT EXISTS (SELECT 1 FROM ${SCHEMA}.owner_intent_modes WHERE owner_account_id=$1) AS active,
    EXISTS (SELECT 1 FROM ${SCHEMA}.intents WHERE owner_account_id=$1) AS has_intents,
    EXISTS (SELECT 1 FROM ${SCHEMA}.entries e WHERE e.owner_account_id=$1 AND NOT EXISTS (
      SELECT 1 FROM ${SCHEMA}.intents i WHERE i.owner_account_id=e.owner_account_id AND i.tx_hash=e.tx_hash
        AND i.contract_id=e.contract_id AND i.journal_id=e.journal_id AND i.entry_id=e.entry_id)) AS untracked`, [owner]);
  const row = result.rows[0];
  if (!row || typeof row.active !== 'boolean' || (row.active && row.untracked) || (!row.active && row.has_intents)) {
    throw new BuyerJournalError('CORRUPT', 'owner intent mode and recorded payments disagree; stop and reconcile');
  }
  return row.active;
}

async function assertRecordedIntent(c, scope, entry) {
  const strict = await readOwnerIntentMode(c, scope.ownerAccountId);
  if (strict !== own(entry, 'intent_id')) throw new BuyerJournalError('CORRUPT', 'owner intent mode does not match the recorded payment');
  if (strict) {
    const result = await c.query(`SELECT contract_id, journal_id, entry_id, tx_hash FROM ${SCHEMA}.intents
      WHERE owner_account_id=$1 AND intent_id=$2`, [scope.ownerAccountId, entry.intent_id]);
    const mapped = result.rows[0];
    if (result.rowCount !== 1 || mapped.contract_id !== scope.contractId || mapped.journal_id !== scope.journalId ||
        mapped.entry_id !== entry.id || mapped.tx_hash !== entry.tx_hash) {
      throw new BuyerJournalError('CORRUPT', 'owner intent registry does not match the authenticated payment');
    }
  }
}

/** Open a single logical journal. The caller owns and later closes pool. */
export async function openPostgresBuyerJournal({ pool, contractId, ownerAccountId, journalId, key, createNew = false }) {
  if (!pool || typeof pool.connect !== 'function' || !Buffer.isBuffer(key) || key.length !== 32 || typeof createNew !== 'boolean') {
    throw new Error('shared buyer requires a PostgreSQL pool and a random 32-byte encryption key');
  }
  const scope = validateScope({ contractId, ownerAccountId, journalId }), secret = Buffer.from(key), words = lockWords(scope);
  const ownerWords = ownerLockWords(scope.ownerAccountId);
  let client;
  try { client = await pool.connect(); } catch { secret.fill(0); throw new BuyerJournalError('DATABASE', 'cannot connect to the shared buyer database'); }
  let failed = false, closing = false, closed = false, locked = false, pid;
  // Session advisory locks are reentrant. A local guard is also necessary so
  // two asynchronous calls on this *same* journal cannot share one owner lock.
  let ownerBusy = false, ownerLocked = false, rotating = false;
  const onError = () => { failed = true; };
  client.on?.('error', onError);
  const entries = new Map(), revisions = new Map();
  let tail = Promise.resolve();
  function assertAvailable() {
    if (closed || closing) throw new BuyerJournalError('CLOSED', 'shared buyer journal is closed');
    if (failed) throw new BuyerJournalError('FAILED', 'shared buyer journal failed; close, reopen and reconcile before continuing');
  }
  async function verifySession() {
    const found = await client.query(`SELECT pg_catalog.pg_backend_pid() AS pid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid = pg_catalog.pg_backend_pid()
        AND locktype = 'advisory' AND classid::bigint = $1 AND objid::bigint = $2 AND objsubid = 2
        AND mode = 'ExclusiveLock' AND granted) AS locked,
      EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid = pg_catalog.pg_backend_pid()
        AND locktype = 'advisory' AND classid::bigint = $3 AND objid::bigint = $4 AND objsubid = 2
        AND mode = 'ExclusiveLock' AND granted) AS owner_locked`, [...words.unsigned, ...ownerWords.unsigned]);
    if (found.rows[0]?.pid !== pid || found.rows[0]?.locked !== true ||
        (ownerLocked && found.rows[0]?.owner_locked !== true)) {
      throw new BuyerJournalError('SESSION_LOST', 'shared buyer database session lock was lost; reconcile before continuing');
    }
  }
  async function assertNoOwnerPending(c) {
    const result = await c.query(`SELECT EXISTS (SELECT 1 FROM ${SCHEMA}.entries
      WHERE owner_account_id=$1 AND status='pending') AS pending`, [scope.ownerAccountId]);
    if (result.rows[0]?.pending !== false) {
      throw new BuyerJournalError('OWNER_UNRESOLVED', 'owner has an unresolved shared buyer payment; recover its original hash before any new payment');
    }
  }
  function enqueue(fn) {
    assertAvailable();
    const result = tail.then(async () => { assertAvailable(); return fn(); });
    tail = result.catch(() => {});
    return result;
  }
  try {
    const acquired = await client.query('SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS locked, pg_catalog.pg_backend_pid() AS pid', words.signed);
    if (acquired.rows[0]?.locked !== true) throw new BuyerJournalError('BUSY', 'shared buyer journal is already in use by another worker');
    locked = true; pid = acquired.rows[0].pid;
    await transaction(client, async c => {
      await verifySchema(c);
      if (createNew) {
        const inserted = await c.query(`INSERT INTO ${SCHEMA}.journals (contract_id, owner_account_id, journal_id, key_check)
          VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING journal_id`, [...scopeValues(scope), keyCheck(secret, scope)]);
        if (inserted.rowCount !== 1) throw new BuyerJournalError('ALREADY_EXISTS', 'shared buyer journal already exists; never replace or reset it');
      }
      const journal = await c.query(`SELECT key_check FROM ${SCHEMA}.journals
        WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3`, scopeValues(scope));
      if (journal.rowCount !== 1) throw new BuyerJournalError('NOT_FOUND', 'original shared buyer journal not found; do not create a replacement for an existing payment');
      const expected = keyCheck(secret, scope), stored = journal.rows[0]?.key_check;
      if (!Buffer.isBuffer(stored) || stored.length !== expected.length || !crypto.timingSafeEqual(stored, expected)) {
        throw new BuyerJournalError('KEY_MISMATCH', 'shared buyer encryption key does not match the original journal');
      }
      const rows = await c.query(`SELECT entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext
        FROM ${SCHEMA}.entries WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 ORDER BY entry_id LIMIT $4`,
      [...scopeValues(scope), MAX_ENTRIES + 1]);
      if (rows.rows.length > MAX_ENTRIES) throw new Error('shared buyer journal exceeds its capacity; stop and reconcile');
      for (const row of rows.rows) {
        const meta = { id: row.entry_id, fingerprint: row.fingerprint, status: row.status, tx_hash: row.tx_hash,
          seller_origin: row.seller_origin, challenge: row.challenge, revision: row.revision };
        const entry = decrypt(secret, scope, meta, row);
        if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 || !isDeepStrictEqual(entryMetadata(scope, meta.id, entry, meta.revision), meta)) {
          throw new BuyerJournalError('CORRUPT', 'shared buyer record does not match its authenticated metadata');
        }
        entries.set(meta.id, entry); revisions.set(meta.id, meta.revision);
      }
      const strict = await readOwnerIntentMode(c, scope.ownerAccountId);
      const mapped = await c.query(`SELECT entry_id, intent_id, tx_hash FROM ${SCHEMA}.intents
        WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 LIMIT $4`, [...scopeValues(scope), MAX_ENTRIES + 1]);
      if (mapped.rows.length !== (strict ? entries.size : 0)) throw new BuyerJournalError('CORRUPT', 'shared buyer intent registry is incomplete');
      for (const row of mapped.rows) {
        const entry = entries.get(row.entry_id);
        if (!entry || entry.intent_id !== row.intent_id || entry.tx_hash !== row.tx_hash) {
          throw new BuyerJournalError('CORRUPT', 'shared buyer intent registry does not match the authenticated payment');
        }
      }
      if ([...entries.values()].some(entry => strict !== own(entry, 'intent_id'))) {
        throw new BuyerJournalError('CORRUPT', 'shared buyer intent mode does not match the authenticated payment');
      }
    }, verifySession);
  } catch (error) {
    secret.fill(0);
    // Destroy even on a lock conflict/unknown COMMIT: it guarantees release of
    // any acquired session lock without relying on another SQL round trip.
    client.removeListener?.('error', onError); client.release(true);
    if (error instanceof BuyerJournalError) throw error;
    throw new BuyerJournalError('DATABASE', 'cannot open shared buyer journal; check schema, primary and encrypted state');
  }

  return Object.freeze({
    sharedDirectV3: true,
    assertScope(contract, owner) {
      assertAvailable();
      if (contract !== scope.contractId || owner !== scope.ownerAccountId) throw new Error('shared buyer journal belongs to a different contract or owner');
    },
    get(id) { assertAvailable(); return entries.has(id) ? clone(entries.get(id)) : undefined; },
    list() { assertAvailable(); return [...entries.values()].map(clone); },
    /** Fail before seller quotes when a reviewed intent is already reserved. */
    checkOwnerIntents(goals) {
      if (!Array.isArray(goals) || !goals.length || goals.length > MAX_ENTRIES) throw new Error('invalid shared buyer intent batch');
      const reviewed = goals.map(goal => ({ id: goal?.id, hasIntent: goal && own(goal, 'intent_id'), intent: goal?.intent_id }));
      return enqueue(async () => {
        try {
          return await transaction(client, async c => {
            await verifySchema(c);
            const strict = await readOwnerIntentMode(c, scope.ownerAccountId);
            if (strict && reviewed.some(item => !item.hasIntent || !validBuyerIntentId(item.intent))) {
              throw new BuyerJournalError('INTENT_REQUIRED', 'strict owner mode requires a stable intent_id for every goal');
            }
            if (!strict && reviewed.some(item => item.hasIntent)) {
              throw new BuyerJournalError('INTENT_MODE_REQUIRED', 'activate strict owner intent mode before using intent_id');
            }
            if (!strict) return false;
            const byIntent = new Map(reviewed.map(item => [item.intent, item])), ids = [...byIntent.keys()];
            if (ids.length !== reviewed.length) throw new BuyerJournalError('INTENT_CONFLICT', 'an intent ID is duplicated in this batch');
            const found = await c.query(`SELECT intent_id, contract_id, journal_id, entry_id, tx_hash FROM ${SCHEMA}.intents
              WHERE owner_account_id=$1 AND intent_id=ANY($2::text[])`, [scope.ownerAccountId, ids]);
            for (const row of found.rows) {
              const item = byIntent.get(row.intent_id), previous = item && entries.get(item.id);
              if (!item || row.contract_id !== scope.contractId || row.journal_id !== scope.journalId || row.entry_id !== item.id ||
                  !previous || previous.intent_id !== row.intent_id || previous.tx_hash !== row.tx_hash) {
                throw new BuyerJournalError('INTENT_CONFLICT', 'owner intent is already reserved in another payment; recover the original journal and hash');
              }
            }
            return true;
          }, verifySession);
        } catch (error) {
          if (error instanceof BuyerJournalError && ['INTENT_REQUIRED', 'INTENT_MODE_REQUIRED', 'INTENT_CONFLICT'].includes(error.code)) throw error;
          failed = true;
          if (error instanceof BuyerJournalError) throw error;
          throw new BuyerJournalError('DATABASE', 'shared buyer intent check failed; do not request a quote or send a payment');
        }
      });
    },
    /**
     * Hold one database-wide owner fence around transaction preparation,
     * reservation, its only broadcast and durable completion. On a crash the
     * advisory lock vanishes but the committed pending row quarantines the owner.
     * This is serialization, not a distributed nonce allocator.
     */
    async withOwnerFence(run) {
      assertAvailable();
      if (typeof run !== 'function') throw new Error('owner fence requires a payment operation');
      if (rotating) throw new BuyerJournalError('BUSY', 'shared buyer journal encryption key rotation is in progress');
      if (ownerBusy) throw new BuyerJournalError('OWNER_BUSY', 'another shared buyer payment is using this owner account');
      ownerBusy = true;
      let operationError;
      try {
        await enqueue(async () => {
          try {
            await transaction(client, async c => {
              await verifySchema(c);
              const result = await c.query('SELECT pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS locked, pg_catalog.pg_backend_pid() AS pid', ownerWords.signed);
              if (result.rows[0]?.pid !== pid || typeof result.rows[0]?.locked !== 'boolean') {
                throw new BuyerJournalError('SESSION_LOST', 'shared buyer database session lock was lost; reconcile before continuing');
              }
              if (!result.rows[0].locked) throw new BuyerJournalError('OWNER_BUSY', 'another shared buyer payment is using this owner account');
              ownerLocked = true;
              await verifySession();
              await assertNoOwnerPending(c);
            }, verifySession);
          } catch (error) {
            if (error instanceof BuyerJournalError && ['OWNER_BUSY', 'OWNER_UNRESOLVED'].includes(error.code)) throw error;
            failed = true;
            if (error instanceof BuyerJournalError) throw error;
            throw new BuyerJournalError('DATABASE', 'shared buyer owner fence failed; no new payment may be sent');
          }
        });
        return await run();
      } catch (error) { operationError = error; throw error; }
      finally {
        // Closing or a poisoned connection destroys the entire session, which
        // releases both locks. A durable pending row remains the crash fence.
        try {
          if (ownerLocked && !closed && !closing && !failed) {
            await enqueue(async () => {
              await verifySession();
              const result = await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked', ownerWords.signed);
              if (result.rows[0]?.unlocked !== true) throw new BuyerJournalError('SESSION_LOST', 'shared buyer owner fence was lost; reconcile before continuing');
              ownerLocked = false;
            });
          }
        } catch {
          failed = true;
          if (!operationError) throw new BuyerJournalError('SESSION_LOST', 'shared buyer owner fence could not be released; reconcile before continuing');
        } finally { ownerBusy = false; }
      }
    },
    // Unsupported runners call put() without awaiting it. Throw synchronously,
    // before they can send a payment; only explicitly adapted direct paths work.
    put() { throw new Error('shared buyer journal cannot be used by this payment runner'); },
    reservePending(id, value) {
      if (!plain(value) || (own(value, 'id') && value.id !== id)) throw new Error('shared buyer entry ID does not match its key');
      if (!ownerBusy || !ownerLocked) throw new BuyerJournalError('OWNER_FENCE_REQUIRED', 'shared buyer reservation requires the owner payment fence');
      const entry = clone({ ...value, id });
      return enqueue(async () => {
        if (!ownerBusy || !ownerLocked) throw new BuyerJournalError('OWNER_FENCE_REQUIRED', 'shared buyer reservation requires the owner payment fence');
        if (entries.has(id)) throw conflict();
        if (entries.size >= MAX_ENTRIES) throw new Error('shared buyer journal capacity reached; stop and reconcile');
        const meta = entryMetadata(scope, id, entry, 1);
        if (meta.status !== 'pending') throw new Error('new shared buyer entries must be pending');
        const encrypted = encrypt(secret, scope, meta, entry);
        try {
          await transaction(client, async c => {
            await verifySchema(c);
            // Also enforce the quarantine for manual API callers and a batch:
            // a later reservation must wait for the prior FINAL completion.
            await assertNoOwnerPending(c);
            const strict = await readOwnerIntentMode(c, scope.ownerAccountId);
            if (strict && !own(entry, 'intent_id')) throw new BuyerJournalError('INTENT_REQUIRED', 'strict owner mode requires a stable intent ID');
            if (!strict && own(entry, 'intent_id')) throw new BuyerJournalError('INTENT_MODE_REQUIRED', 'activate strict owner intent mode before using intent ID');
            const result = await c.query(`INSERT INTO ${SCHEMA}.entries
              (contract_id, owner_account_id, journal_id, entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING entry_id`,
            [...scopeValues(scope), id, meta.fingerprint, meta.status, meta.tx_hash, meta.seller_origin, meta.challenge,
              meta.revision, encrypted.nonce, encrypted.tag, encrypted.ciphertext]);
            if (result.rowCount !== 1) throw conflict();
            if (strict) {
              const intent = await c.query(`INSERT INTO ${SCHEMA}.intents
                (owner_account_id,intent_id,contract_id,journal_id,entry_id,tx_hash) VALUES ($1,$2,$3,$4,$5,$6)
                ON CONFLICT DO NOTHING RETURNING intent_id`,
              [scope.ownerAccountId, entry.intent_id, scope.contractId, scope.journalId, id, meta.tx_hash]);
              if (intent.rowCount !== 1) throw new BuyerJournalError('INTENT_CONFLICT', 'owner intent is already reserved; recover the original journal and hash');
            }
          }, verifySession);
        } catch (error) {
          failed = true;
          if (error instanceof BuyerJournalError) throw error;
          throw new BuyerJournalError('DATABASE', 'shared buyer reservation failed or its commit is uncertain; do not broadcast or retry');
        }
        entries.set(id, entry); revisions.set(id, 1);
      });
    },
    writeDurable(id, value) {
      if (!plain(value) || (own(value, 'id') && value.id !== id)) throw new Error('shared buyer entry ID does not match its key');
      const entry = clone({ ...value, id });
      return enqueue(async () => {
        const previous = entries.get(id), revision = revisions.get(id);
        if (!previous || !Number.isSafeInteger(revision) || revision >= 2147483647) throw new Error('shared buyer entry is missing or exhausted');
        assertTransition(previous, entry);
        const meta = entryMetadata(scope, id, entry, revision + 1), encrypted = encrypt(secret, scope, meta, entry);
        try {
          await transaction(client, async c => {
            await verifySchema(c);
            await assertRecordedIntent(c, scope, previous);
            const result = await c.query(`UPDATE ${SCHEMA}.entries SET status=$5, revision=$6, nonce=$7, tag=$8, ciphertext=$9, updated_at=clock_timestamp()
              WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 AND entry_id=$4 AND revision=$10 AND tx_hash=$11 RETURNING entry_id`,
            [...scopeValues(scope), id, meta.status, meta.revision, encrypted.nonce, encrypted.tag, encrypted.ciphertext, revision, meta.tx_hash]);
            if (result.rowCount !== 1) throw new BuyerJournalError('STALE', 'shared buyer state changed; close and reconcile before continuing');
          }, verifySession);
        } catch (error) {
          failed = true;
          if (error instanceof BuyerJournalError) throw error;
          throw new BuyerJournalError('DATABASE', 'shared buyer update failed or its commit is uncertain; retain the original transaction and reconcile');
        }
        entries.set(id, entry); revisions.set(id, meta.revision);
      });
    },
    /** Recheck the owner/session fences and the exact pending row immediately
     * before the final synchronous guard and one broadcast. */
    assertPendingForBroadcast(id, txHash) {
      assertAvailable();
      if (!ownerBusy || !ownerLocked) throw new BuyerJournalError('OWNER_FENCE_REQUIRED', 'shared buyer broadcast requires the owner payment fence');
      return enqueue(async () => {
        try {
          await transaction(client, async c => {
            await verifySchema(c);
            const rows = await c.query(`SELECT entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext
              FROM ${SCHEMA}.entries WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 AND entry_id=$4`, [...scopeValues(scope), id]);
            const row = rows.rows[0], cached = entries.get(id);
            if (rows.rowCount !== 1 || !cached || cached.status !== 'pending' || cached.tx_hash !== txHash ||
                row.status !== 'pending' || row.tx_hash !== txHash || row.revision !== revisions.get(id)) {
              throw new BuyerJournalError('STALE', 'original pending payment changed before broadcast; stop and reconcile');
            }
            const meta = { id: row.entry_id, fingerprint: row.fingerprint, status: row.status, tx_hash: row.tx_hash,
              seller_origin: row.seller_origin, challenge: row.challenge, revision: row.revision };
            const original = decrypt(secret, scope, meta, row);
            if (!isDeepStrictEqual(original, cached) || !isDeepStrictEqual(entryMetadata(scope, meta.id, original, meta.revision), meta)) {
              throw new BuyerJournalError('CORRUPT', 'original pending payment changed before broadcast; stop and reconcile');
            }
            await assertRecordedIntent(c, scope, original);
            const ownerPending = await c.query(`SELECT tx_hash FROM ${SCHEMA}.entries
              WHERE owner_account_id=$1 AND status='pending' LIMIT 2`, [scope.ownerAccountId]);
            if (ownerPending.rows.length !== 1 || ownerPending.rows[0].tx_hash !== txHash) {
              throw new BuyerJournalError('OWNER_UNRESOLVED', 'owner has another unresolved payment; stop and reconcile');
            }
          }, verifySession);
        } catch (error) {
          failed = true;
          if (error instanceof BuyerJournalError) throw error;
          throw new BuyerJournalError('DATABASE', 'shared buyer pre-broadcast check failed; retain the pending hash and reconcile');
        }
      });
    },
    /**
     * Export one bounded, authenticated forensic checkpoint while holding the
     * journal session lock. Encrypted entries remain encrypted in the result.
     * This does not capture other journals, WAL, or the rest of the database.
     */
    exportEncryptedSnapshot() {
      assertAvailable();
      if (rotating) throw new BuyerJournalError('BUSY', 'shared buyer journal encryption key rotation is in progress');
      return enqueue(async () => {
        try {
          return await transaction(client, async c => {
            await verifySchema(c);
            const original = await c.query(`SELECT key_check FROM ${SCHEMA}.journals
              WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3`, scopeValues(scope));
            const check = keyCheck(secret, scope), stored = original.rows[0]?.key_check;
            if (original.rowCount !== 1 || !Buffer.isBuffer(stored) || stored.length !== check.length || !crypto.timingSafeEqual(stored, check)) {
              throw new BuyerJournalError('CORRUPT', 'shared buyer key check changed; stop and reconcile');
            }
            const selected = await c.query(`SELECT entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext
              FROM ${SCHEMA}.entries WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 ORDER BY entry_id LIMIT $4`,
            [...scopeValues(scope), MAX_SNAPSHOT_ENTRIES + 1]);
            if (selected.rows.length > MAX_SNAPSHOT_ENTRIES) throw new BuyerJournalError('SNAPSHOT_LIMIT', 'buyer snapshot exceeds 256 entries; use a full protected PostgreSQL backup');
            if (selected.rows.length !== entries.size) throw new BuyerJournalError('CORRUPT', 'shared buyer entries changed during the session; stop and reconcile');
            let totalBytes = 0;
            const rows = selected.rows.map(row => {
              const meta = { id: row.entry_id, fingerprint: row.fingerprint, status: row.status, tx_hash: row.tx_hash,
                seller_origin: row.seller_origin, challenge: row.challenge, revision: row.revision };
              if (!Buffer.isBuffer(row.ciphertext) || (totalBytes += row.ciphertext.length) > MAX_SNAPSHOT_CIPHERTEXT_BYTES) {
                throw new BuyerJournalError('SNAPSHOT_LIMIT', 'buyer snapshot exceeds 8 MiB ciphertext; use a full protected PostgreSQL backup');
              }
              const entry = decrypt(secret, scope, meta, row);
              if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 || !isDeepStrictEqual(entryMetadata(scope, meta.id, entry, meta.revision), meta) ||
                  !entries.has(meta.id) || !isDeepStrictEqual(entries.get(meta.id), entry) || revisions.get(meta.id) !== meta.revision) {
                throw new BuyerJournalError('CORRUPT', 'shared buyer entry changed during the session; stop and reconcile');
              }
              return { ...meta, nonce: row.nonce.toString('base64'), tag: row.tag.toString('base64'), ciphertext: row.ciphertext.toString('base64') };
            });
            // PostgreSQL's configured collation may differ from byte ordering.
            rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            const payload = { network: 'near:testnet', scope: { contract_id: scope.contractId, owner_account_id: scope.ownerAccountId,
              journal_id: scope.journalId }, key_check: stored.toString('base64'), entries: rows };
            const serialized = JSON.stringify({ format: 'bouncer-buyer-snapshot-v1', payload, mac: snapshotMac(secret, payload).toString('base64') });
            if (Buffer.byteLength(serialized, 'utf8') > MAX_BUYER_SNAPSHOT_BYTES) throw new BuyerJournalError('SNAPSHOT_LIMIT', 'buyer snapshot exceeds its file size limit');
            return serialized;
          }, verifySession);
        } catch (error) {
          if (error instanceof BuyerJournalError && error.code === 'SNAPSHOT_LIMIT') throw error;
          failed = true;
          if (error instanceof BuyerJournalError) throw error;
          throw new BuyerJournalError('DATABASE', 'buyer snapshot failed; stop and reconcile the original journal');
        }
      });
    },
    /**
     * Re-encrypt one entire journal under a new key in a single bounded DB
     * transaction. The same journal session lock excludes cooperating workers;
     * no seller, signer or NEAR call is involved. A lost COMMIT acknowledgement
     * poisons this session: preserve BOTH keys and reopen the original journal.
     */
    async rotateEncryptionKey(newKey) {
      assertAvailable();
      if (!Buffer.isBuffer(newKey) || newKey.length !== 32) throw new Error('new buyer journal key must contain exactly 32 bytes');
      if (rotating || ownerBusy || ownerLocked) throw new BuyerJournalError('BUSY', 'stop active journal operations before key rotation');
      if (crypto.timingSafeEqual(secret, newKey)) throw new Error('new buyer journal key must differ from the current key');
      if (entries.size > MAX_ROTATION_ENTRIES) throw new BuyerJournalError('ROTATION_LIMIT', 'journal exceeds the atomic rotation entry limit; do not partially rotate it');
      const next = Buffer.from(newKey);
      rotating = true;
      try {
        return await enqueue(async () => {
          try {
            let count = 0;
            const start = performance.now();
            const checkTime = () => {
              if (performance.now() - start > MAX_ROTATION_MS) throw new BuyerJournalError('ROTATION_LIMIT', 'key rotation exceeded its time limit; do not partially rotate the journal');
            };
            await transaction(client, async c => {
              await verifySchema(c); checkTime();
              const oldCheck = keyCheck(secret, scope), newCheck = keyCheck(next, scope);
              const stored = await c.query(`SELECT key_check FROM ${SCHEMA}.journals
                WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 FOR UPDATE`, scopeValues(scope));
              const actual = stored.rows[0]?.key_check;
              if (stored.rowCount !== 1 || !Buffer.isBuffer(actual) || actual.length !== oldCheck.length || !crypto.timingSafeEqual(actual, oldCheck)) {
                throw new BuyerJournalError('KEY_MISMATCH', 'the journal key changed; close and reconcile before continuing');
              }
              const rows = await c.query(`SELECT entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext
                FROM ${SCHEMA}.entries WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3
                ORDER BY entry_id LIMIT $4 FOR UPDATE`, [...scopeValues(scope), MAX_ROTATION_ENTRIES + 1]);
              if (rows.rows.length > MAX_ROTATION_ENTRIES) throw new BuyerJournalError('ROTATION_LIMIT', 'journal exceeds the atomic rotation entry limit; do not partially rotate it');
              if (rows.rows.length !== entries.size) throw new BuyerJournalError('CORRUPT', 'journal changed during key rotation; close and reconcile');
              let bytes = 0;
              for (const row of rows.rows) {
                if (!Buffer.isBuffer(row.ciphertext)) throw new BuyerJournalError('CORRUPT', 'journal ciphertext is invalid');
                bytes += row.ciphertext.length;
                if (bytes > MAX_ROTATION_BYTES) throw new BuyerJournalError('ROTATION_LIMIT', 'journal exceeds the atomic rotation byte limit; do not partially rotate it');
              }
              for (const row of rows.rows) {
                checkTime();
                const meta = { id: row.entry_id, fingerprint: row.fingerprint, status: row.status, tx_hash: row.tx_hash,
                  seller_origin: row.seller_origin, challenge: row.challenge, revision: row.revision };
                const entry = decrypt(secret, scope, meta, row);
                if (!Number.isSafeInteger(meta.revision) || meta.revision < 1 || revisions.get(meta.id) !== meta.revision ||
                    !isDeepStrictEqual(entry, entries.get(meta.id)) || !isDeepStrictEqual(entryMetadata(scope, meta.id, entry, meta.revision), meta)) {
                  throw new BuyerJournalError('CORRUPT', 'journal changed during key rotation; close and reconcile');
                }
                const encrypted = encrypt(next, scope, meta, entry);
                const updated = await c.query(`UPDATE ${SCHEMA}.entries SET nonce=$5, tag=$6, ciphertext=$7
                  WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 AND entry_id=$4 AND revision=$8 AND tx_hash=$9
                  RETURNING nonce, tag, ciphertext`, [...scopeValues(scope), meta.id, encrypted.nonce, encrypted.tag, encrypted.ciphertext, meta.revision, meta.tx_hash]);
                if (updated.rowCount !== 1 || !isDeepStrictEqual(decrypt(next, scope, meta, updated.rows[0]), entry)) {
                  throw new BuyerJournalError('CORRUPT', 'journal re-encryption did not preserve the original entry');
                }
              }
              checkTime();
              const changed = await c.query(`UPDATE ${SCHEMA}.journals SET key_check=$4
                WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3 AND key_check=$5 RETURNING key_check`,
              [...scopeValues(scope), newCheck, oldCheck]);
              if (changed.rowCount !== 1 || !Buffer.isBuffer(changed.rows[0]?.key_check) ||
                  changed.rows[0].key_check.length !== newCheck.length || !crypto.timingSafeEqual(changed.rows[0].key_check, newCheck)) {
                throw new BuyerJournalError('CORRUPT', 'journal key check changed during rotation');
              }
              await verifySession(); checkTime();
              count = rows.rows.length;
            }, verifySession);
            secret.fill(0); next.copy(secret);
            return { rotated_entries: count };
          } catch (error) {
            failed = true;
            if (error instanceof BuyerJournalError && ['ROTATION_LIMIT', 'CORRUPT', 'KEY_MISMATCH', 'UNSAFE_SCHEMA', 'UNSAFE_DATABASE', 'SESSION_LOST'].includes(error.code)) throw error;
            throw new BuyerJournalError('ROTATION_UNCERTAIN', 'key rotation failed or its commit is uncertain; preserve BOTH keys, close and reopen the original journal');
          }
        });
      } finally { next.fill(0); rotating = false; }
    },
    async close() {
      if (closed || closing) return;
      closing = true;
      await tail;
      // Never return a pooled session carrying an in-flight owner lock. Even
      // if a caller closes while an RPC is outstanding, a committed pending
      // row quarantines later workers; before commit, no broadcast is allowed.
      let destroy = failed || ownerBusy || ownerLocked;
      if (locked && !destroy) {
        try {
          const result = await client.query('SELECT pg_catalog.pg_advisory_unlock($1::integer, $2::integer) AS unlocked', words.signed);
          if (result.rows[0]?.unlocked !== true) destroy = true;
        } catch { destroy = true; }
      }
      closed = true; secret.fill(0); entries.clear(); revisions.clear();
      client.removeListener?.('error', onError); client.release(destroy);
    },
  });
}
