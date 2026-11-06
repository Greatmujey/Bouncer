/**
 * EXPERIMENTAL server-side write-ahead fence for the unsigned Buffer spending
 * review. This module has no HTTP endpoint, signer, wallet integration, chain
 * client, unlock, expiry, or payment operation. One named testnet owner may
 * reserve at most ONE wallet prompt in this database, ever. Recording the
 * first public original hash is immutable. A committed reservation without a
 * hash remains blocked, including after a crash or lost wallet response.
 *
 * The injected authenticate() is a REQUIRED TRUST BOUNDARY, not implemented
 * here: it must establish current full-access owner control, bind the exact
 * action context to a fresh single-use server challenge and approved origin,
 * and prevent replay/CSRF/session theft. Simply echoing the context is NOT
 * authentication. This prototype must not be used to authorize live prompts.
 *
 * One writable PostgreSQL primary arbitrates cooperating processes. fsync and
 * synchronous_commit are checked, but they do not prevent deleted/edited
 * rows, another DB, a stale restore, lost primary, compromised server/DB role,
 * bypassing clients, or the user's other wallets. Independent retention and
 * restore/rollback protection, real authorization, original-hash recovery,
 * verified reconciliation and operator procedures remain required.
 */
import crypto from 'node:crypto';
import { verifyBufferSpendingReview } from './buffer-wallet-spending-evidence.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';

const SCHEMA = 'bouncer_wallet_prompt_v1';
// Guard accidental writes by cooperating services/roles. A database owner can
// still disable or replace a trigger, so this is not an independent audit log.
const GUARD_SOURCE = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet prompt records cannot be deleted';
  END IF;
  IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id OR
     NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
     NEW.owner_public_key IS DISTINCT FROM OLD.owner_public_key OR
     NEW.review_sha256 IS DISTINCT FROM OLD.review_sha256 OR
     NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
     NEW.action_commitment_sha256 IS DISTINCT FROM OLD.action_commitment_sha256 OR
     NEW.review IS DISTINCT FROM OLD.review OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     OLD.original_hash IS NOT NULL OR NEW.original_hash IS NULL THEN
    RAISE EXCEPTION 'wallet prompt identity and first original hash are immutable';
  END IF;
  RETURN NEW;
END;
`;
const STAGES = Object.freeze(['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent']);
const hex32 = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message) => new WalletPromptFenceError(code, message);

export class WalletPromptFenceError extends Error {
  constructor(code, message) { super(message); this.name = 'WalletPromptFenceError'; this.code = code; }
}

async function transaction(pool, run) {
  let client, begun = false, destroy = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query("SET LOCAL synchronous_commit = 'on'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const health = await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica,
      pg_catalog.current_setting('fsync') AS fsync, pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.current_setting('synchronous_commit') AS synchronous_commit`);
    const state = health.rows[0];
    if (!state || state.replica !== false || state.fsync !== 'on' || state.read_only !== 'off' || state.synchronous_commit !== 'on') {
      throw fail('UNSAFE_DATABASE', 'a writable PostgreSQL primary with fsync and synchronous commit is required');
    }
    const result = await run(client);
    // A failed COMMIT acknowledgement is UNKNOWN even if the server may have
    // committed. Destroy the session and do not return a prompt reservation.
    await client.query('COMMIT'); begun = false;
    return result;
  } catch (error) {
    destroy = true;
    if (client && begun) { try { await client.query('ROLLBACK'); } catch { /* poisoned connection */ } }
    if (error instanceof WalletPromptFenceError) throw error;
    throw fail('DATABASE_UNKNOWN', 'wallet prompt database failed or its commit is uncertain; stop and reconcile, never open or repeat a prompt');
  } finally { client?.release(destroy); }
}

async function verifySchema(client) {
  const version = await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton = true`);
  if (version.rows.length !== 1 || version.rows[0].version !== 1) throw fail('UNSAFE_SCHEMA', 'unsupported prompt fence schema');
  const found = await client.query(`SELECT t.relname AS table_name, array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON k.ordinality <= i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'bouncer_wallet_prompt_v1' AND t.relkind = 'r'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY i.indexrelid, t.relname`);
  const indexes = new Set(found.rows.map(row => `${row.table_name}:${row.columns.join(',')}`));
  if (!indexes.has('meta:singleton') || !indexes.has('prompts:owner_account_id') || !indexes.has('prompts:operation_id')) {
    throw fail('UNSAFE_SCHEMA', 'prompt fence is missing an essential unique index');
  }
  const visibility = await client.query(`SELECT t.relrowsecurity, t.relforcerowsecurity
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname='prompts' AND t.relkind='r'`);
  if (visibility.rows.length !== 1 || visibility.rows[0].relrowsecurity || visibility.rows[0].relforcerowsecurity) {
    throw fail('UNSAFE_SCHEMA', 'prompt fence requires complete row visibility and no row-level security');
  }
  const guards = await client.query(`SELECT g.tgenabled, g.tgtype::integer AS kind, g.tgisinternal,
      p.prosrc, p.pronargs, p.prosecdef, p.provolatile, p.proconfig, lang.lanname
    FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    JOIN pg_catalog.pg_language lang ON lang.oid=p.prolang
    WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname='prompts'
      AND g.tgname='prompt_immutable' AND pn.nspname='bouncer_wallet_prompt_v1' AND p.proname='guard_prompt'`);
  const guard = guards.rows[0];
  if (guards.rows.length !== 1 || !['O', 'A'].includes(guard.tgenabled) || guard.kind !== 27 || guard.tgisinternal ||
      guard.prosrc !== GUARD_SOURCE || guard.pronargs !== 0 || guard.prosecdef || guard.lanname !== 'plpgsql' ||
      guard.provolatile !== 'v' || !Array.isArray(guard.proconfig) || guard.proconfig.length !== 1 || guard.proconfig[0] !== 'search_path=pg_catalog') {
    throw fail('UNSAFE_SCHEMA', 'prompt fence immutable-record trigger is missing or changed');
  }
}

/** Privileged testnet schema initialization; does not contact NEAR or wallets. */
export async function initializePostgresWalletPromptFence({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool required');
  await transaction(pool, async client => {
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1702243041, 903135)');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.meta (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL
    )`);
    await client.query(`INSERT INTO ${SCHEMA}.meta (singleton,version) VALUES (true,1) ON CONFLICT DO NOTHING`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.prompts (
      owner_account_id text CONSTRAINT prompts_owner_primary PRIMARY KEY,
      operation_id text NOT NULL CONSTRAINT prompts_operation_unique UNIQUE,
      owner_public_key text NOT NULL, review_sha256 text NOT NULL, stage_id text NOT NULL,
      action_commitment_sha256 text NOT NULL, review jsonb NOT NULL, original_hash text,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
    )`);
    const functions = await client.query(`SELECT p.oid FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND p.proname='guard_prompt' AND p.pronargs=0`);
    if (functions.rows.length === 0) await client.query(`CREATE FUNCTION ${SCHEMA}.guard_prompt() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$${GUARD_SOURCE}$guard$`);
    const triggers = await client.query(`SELECT g.oid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname='prompts' AND g.tgname='prompt_immutable'`);
    if (triggers.rows.length === 0) await client.query(`CREATE TRIGGER prompt_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.prompts
      FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_prompt()`);
    // Existing definitions are never silently replaced; mismatch blocks use.
    await verifySchema(client);
  });
}

const columns = `owner_account_id, operation_id, owner_public_key, review_sha256, stage_id,
  action_commitment_sha256, review, original_hash, created_at`;

function validatedRow(row) {
  try {
    if (!plain(row) || !isTestnetAccount(row.owner_account_id) || !hex32(row.operation_id) ||
        !digest(row.review_sha256) || !digest(row.action_commitment_sha256) || !STAGES.includes(row.stage_id) ||
        !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
        (row.original_hash !== null && !isTransactionHash(row.original_hash))) throw new Error();
    const identity = verifyBufferSpendingReview({ review: row.review, trustedReviewHash: row.review_sha256,
      trustedOwnerPublicKey: row.owner_public_key });
    const stage = row.review.stages.find(item => item.id === row.stage_id);
    if (identity.owner !== row.owner_account_id || !stage || stage.action_commitment_sha256 !== row.action_commitment_sha256) throw new Error();
    return { version: 1, network: 'testnet', owner: row.owner_account_id, operation_id: row.operation_id,
      owner_public_key: row.owner_public_key, review_sha256: row.review_sha256, stage_id: row.stage_id,
      action_commitment_sha256: row.action_commitment_sha256, review: structuredClone(row.review),
      status: row.original_hash === null ? 'PROMPT_RESERVED_NO_HASH' : 'ORIGINAL_HASH_RECORDED',
      original_hash: row.original_hash, created_at: row.created_at.toISOString(),
      warning: 'Reservation only. No wallet approval, chain settlement, delivery or rollback protection is established.' };
  } catch { throw fail('CORRUPT', 'retained prompt record is malformed or mismatched; stop and reconcile'); }
}

function requiredOwner(owner, ownerPublicKey) {
  // Key validation also occurs via the complete review. The name format alone
  // does not prove account existence or ownership.
  if (!isTestnetAccount(owner) || typeof ownerPublicKey !== 'string' || ownerPublicKey.length < 20 || ownerPublicKey.length > 150) {
    throw new Error('named testnet owner and public key required');
  }
}

/**
 * authenticate({ action, evidence }) MUST return true only after verifying a
 * real, fresh, replay-resistant owner authorization bound to every action
 * field. The action object is immutable; evidence is never persisted or logged.
 * No production authenticator is supplied here. The caller must also protect
 * its browser/server channel, credentials, backups and trusted RPC.
 */
export function createPostgresWalletPromptFence({ pool, authenticate } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof authenticate !== 'function') throw new Error('PostgreSQL pool and owner authenticator required');
  async function authorize(action, evidence) {
    let accepted = false;
    try { accepted = await authenticate({ action: Object.freeze(action), evidence }); } catch { /* fail closed */ }
    if (accepted !== true) throw fail('UNAUTHENTICATED', 'owner authentication failed; no prompt reservation');
  }
  const context = (purpose, owner, key, extra = {}) => Object.freeze({ format: 'bouncer-wallet-prompt-auth-v1',
    network: 'testnet', purpose, owner, owner_public_key: key, ...extra });

  return Object.freeze({
    async reserve({ review: inputReview, trustedReviewHash, trustedOwnerPublicKey, stageId, evidence } = {}) {
      // Snapshot and validate the entire public review before the first await;
      // neither the caller nor an authenticator may mutate the requested stage.
      const review = structuredClone(inputReview);
      const identity = verifyBufferSpendingReview({ review, trustedReviewHash, trustedOwnerPublicKey });
      if (!STAGES.includes(stageId)) throw new Error('reviewed Buffer spending stage required');
      const stage = review.stages.find(item => item.id === stageId);
      requiredOwner(identity.owner, trustedOwnerPublicKey);
      const auth = context('reserve', identity.owner, trustedOwnerPublicKey, { review_sha256: trustedReviewHash,
        stage_id: stageId, action_commitment_sha256: stage.action_commitment_sha256 });
      await authorize(auth, evidence);
      const operation = crypto.randomBytes(16).toString('hex');
      return transaction(pool, async client => {
        await verifySchema(client);
        const inserted = await client.query(`INSERT INTO ${SCHEMA}.prompts
          (owner_account_id,operation_id,owner_public_key,review_sha256,stage_id,action_commitment_sha256,review)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (owner_account_id) DO NOTHING RETURNING ${columns}`,
        [identity.owner, operation, trustedOwnerPublicKey, trustedReviewHash, stageId, stage.action_commitment_sha256, JSON.stringify(review)]);
        if (inserted.rows.length !== 1) throw fail('OWNER_FENCED', 'an owner prompt is already reserved; reconcile it, never replace or retry it');
        return validatedRow(inserted.rows[0]);
      });
    },

    async inspect({ owner, ownerPublicKey, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      await authorize(context('inspect', owner, ownerPublicKey), evidence);
      return transaction(pool, async client => {
        await verifySchema(client);
        const found = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1`, [owner]);
        if (found.rows.length === 0) return null; // never evidence of no prior prompt elsewhere
        if (found.rows.length !== 1) throw fail('CORRUPT', 'duplicate owner prompt records; stop');
        const row = validatedRow(found.rows[0]);
        if (row.owner_public_key !== ownerPublicKey) throw fail('OWNER_KEY_MISMATCH', 'retained owner key differs; stop and reconcile');
        return row;
      });
    },

    async recordOriginalHash({ owner, ownerPublicKey, operationId, originalHash, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      if (!hex32(operationId) || !isTransactionHash(originalHash)) throw new Error('original operation ID and transaction hash required');
      await authorize(context('record_original_hash', owner, ownerPublicKey, { operation_id: operationId, original_hash: originalHash }), evidence);
      return transaction(pool, async client => {
        await verifySchema(client);
        const selected = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1 FOR UPDATE`, [owner]);
        if (selected.rows.length !== 1) throw fail('OWNER_FENCED', 'original prompt reservation missing; stop and reconcile');
        const old = validatedRow(selected.rows[0]);
        if (old.owner_public_key !== ownerPublicKey || old.operation_id !== operationId) throw fail('MISMATCH', 'original owner or operation differs; stop and reconcile');
        if (old.original_hash !== null) {
          if (old.original_hash !== originalHash) throw fail('MISMATCH', 'original hash is immutable; never replace it');
          return old;
        }
        const updated = await client.query(`UPDATE ${SCHEMA}.prompts SET original_hash=$1
          WHERE owner_account_id=$2 AND operation_id=$3 AND original_hash IS NULL RETURNING ${columns}`,
        [originalHash, owner, operationId]);
        if (updated.rows.length !== 1) throw fail('MISMATCH', 'original hash update conflicted; stop and reconcile');
        return validatedRow(updated.rows[0]);
      });
    },
  });
}
