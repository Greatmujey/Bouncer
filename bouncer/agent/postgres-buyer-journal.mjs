/**
 * Experimental testnet direct seller-v3 buyer journal.
 *
 * One authoritative PostgreSQL primary stores the original signed hash and an
 * encrypted claim BEFORE broadcast. Unique constraints arbitrate across worker
 * processes; an advisory session lock also prevents concurrent use of the same
 * logical journal. No lease takeover, deletion, automatic retry or resend.
 *
 * This protects only callers using this journal and the supported direct v3
 * runner. It cannot protect a second database, a restored stale backup, a file
 * journal, a different mission ID for a newly issued quote, or a stale primary.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validatePlan, requestFingerprint, normalizeProviderRoute } from './procurement.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { canonicalClaimOrigin, verifyClaimAuthorization } from '../packages/provider-sdk/lib/resource-claim.mjs';

const SCHEMA = 'bouncer_buyer_v1';
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_ENTRIES = 10_000;
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
function lockWords(scope) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(['bouncer-buyer-lock-v1', ...scopeValues(scope)])).digest();
  return { signed: [hash.readInt32BE(0), hash.readInt32BE(4)], unsigned: [hash.readUInt32BE(0), hash.readUInt32BE(4)] };
}
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
    'agent_public_key', 'tx_hash', 'resource_authorization', 'settlement', 'completed_at', 'delivery'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('unsupported shared buyer entry fields');
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
    'agent_public_key', 'tx_hash', 'resource_authorization']) {
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
  if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error('unsupported shared buyer schema version');
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
    'entries:contract_id,owner_account_id,journal_id,entry_id', 'entries:challenge', 'entries:tx_hash'];
  if (required.some(index => !indexes.has(index))) throw new BuyerJournalError('UNSAFE_SCHEMA', 'shared buyer schema is missing critical replay constraints');
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
      await verifySchema(c);
    });
  } catch (error) { destroy = true; throw error; }
  finally { client.release(destroy); }
}

/** Open a single logical journal. The caller owns and later closes pool. */
export async function openPostgresBuyerJournal({ pool, contractId, ownerAccountId, journalId, key, createNew = false }) {
  if (!pool || typeof pool.connect !== 'function' || !Buffer.isBuffer(key) || key.length !== 32 || typeof createNew !== 'boolean') {
    throw new Error('shared buyer requires a PostgreSQL pool and a random 32-byte encryption key');
  }
  const scope = validateScope({ contractId, ownerAccountId, journalId }), secret = Buffer.from(key), words = lockWords(scope);
  let client;
  try { client = await pool.connect(); } catch { secret.fill(0); throw new BuyerJournalError('DATABASE', 'cannot connect to the shared buyer database'); }
  let failed = false, closing = false, closed = false, locked = false, pid;
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
        AND mode = 'ExclusiveLock' AND granted) AS locked`, words.unsigned);
    if (found.rows[0]?.pid !== pid || found.rows[0]?.locked !== true) {
      throw new BuyerJournalError('SESSION_LOST', 'shared buyer database session lock was lost; reconcile before continuing');
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
    // Unsupported runners call put() without awaiting it. Throw synchronously,
    // before they can send a payment; only explicitly adapted direct paths work.
    put() { throw new Error('shared buyer journal cannot be used by this payment runner'); },
    reservePending(id, value) {
      if (!plain(value) || (own(value, 'id') && value.id !== id)) throw new Error('shared buyer entry ID does not match its key');
      const entry = clone({ ...value, id });
      return enqueue(async () => {
        if (entries.has(id)) throw conflict();
        if (entries.size >= MAX_ENTRIES) throw new Error('shared buyer journal capacity reached; stop and reconcile');
        const meta = entryMetadata(scope, id, entry, 1);
        if (meta.status !== 'pending') throw new Error('new shared buyer entries must be pending');
        const encrypted = encrypt(secret, scope, meta, entry);
        try {
          await transaction(client, async c => {
            const result = await c.query(`INSERT INTO ${SCHEMA}.entries
              (contract_id, owner_account_id, journal_id, entry_id, fingerprint, status, tx_hash, seller_origin, challenge, revision, nonce, tag, ciphertext)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING entry_id`,
            [...scopeValues(scope), id, meta.fingerprint, meta.status, meta.tx_hash, meta.seller_origin, meta.challenge,
              meta.revision, encrypted.nonce, encrypted.tag, encrypted.ciphertext]);
            if (result.rowCount !== 1) throw conflict();
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
    async close() {
      if (closed || closing) return;
      closing = true;
      await tail;
      let destroy = failed;
      if (locked && !failed) {
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
