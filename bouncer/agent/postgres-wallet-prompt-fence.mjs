/**
 * EXPERIMENTAL server-side write-ahead fence for an unsigned Buffer spending
 * review or a three-stage pinned vault setup review. This module has no HTTP
 * endpoint, signer, wallet integration, policy unlock, expiry, or payment
 * operation. One named testnet owner may reserve at most ONE setup or spending
 * review in this database, ever. New setup reservations atomically retain two
 * further one-shot stage rows. Each later setup claim requires matching FINAL
 * receipts for every preceding original and a fresh same-block trusted-RPC
 * preflight. A claim is committed at most once before a cooperating caller
 * could invoke a wallet; a returned claim cannot prevent a malicious or
 * bypassing caller from invoking a wallet twice. Public original hashes are immutable.
 * A reservation or claim without a hash remains blocked after a crash or lost
 * wallet response, and is never permission to retry.
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
import { verifyBufferWalletSetupReview, prepareBufferWalletSetupAttempt, inspectBufferWalletSetupAttempt } from './buffer-wallet-setup-evidence.mjs';
import { inspectBufferWalletSetupStage } from './buffer-wallet-setup-preflight.mjs';
import { V12_EXPECTED_BYTES, V12_EXPECTED_SHA256 } from './keyless-vault-v12-readiness.mjs';
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
// New reservations receive a separate eligibility row in the SAME commit.
// Legacy reservations lack this row and can never be claimed automatically.
const CLAIM_GUARD_SOURCE = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet prompt claim records cannot be deleted';
  END IF;
  IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id OR
     NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     OLD.claimed OR NOT NEW.claimed OR OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL THEN
    RAISE EXCEPTION 'wallet prompt claims are immutable and single use';
  END IF;
  RETURN NEW;
END;
`;
// Two subsequent setup rows are created atomically with a new first-stage
// reservation. Their identity is immutable; each may transition once from
// unclaimed to claimed, and once from no hash to its first original hash.
const SETUP_STAGE_GUARD_SOURCE = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'setup stage records cannot be deleted';
  END IF;
  IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id OR
     NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
     NEW.stage_index IS DISTINCT FROM OLD.stage_index OR
     NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
     NEW.action_commitment_sha256 IS DISTINCT FROM OLD.action_commitment_sha256 OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'setup stage identity is immutable';
  END IF;
  IF NOT OLD.claimed AND NEW.claimed AND OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL AND
     OLD.original_hash IS NULL AND NEW.original_hash IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.claimed AND NEW.claimed AND OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at AND
     OLD.original_hash IS NULL AND NEW.original_hash IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'setup stage claims and original hashes are immutable and single use';
END;
`;
const SPENDING_STAGES = Object.freeze(['configure_buffer_locked_policy', 'install_buffer_vault_agent', 'install_buffer_forwarder_agent']);
const SETUP_STAGE = 'create_keyless_vault';
const NEXT_SETUP_STAGES = Object.freeze(['register_vault_circle', 'fund_vault_circle']);
const STAGES = Object.freeze([...SPENDING_STAGES, SETUP_STAGE]);
const SETUP_RECORD = 'bouncer-buffer-setup-fence-review-v1';
// A fresh FINAL-block profile is still only a trusted RPC snapshot. Limit the
// time between completing it and committing the first claim; chain state can
// change even within this window, and it is not live execution authority.
const MAX_SETUP_PREFLIGHT_AGE_MS = 5_000;
const PREFLIGHT_METHODS = ['viewNodeStatus', 'viewBlock', 'viewAccount', 'viewAccessKey', 'viewAccessKeyList',
  'viewTestnetAccountPresenceAt', 'callFunctionRaw', 'experimental_protocolConfig'];
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
  if (!['meta:singleton', 'prompts:owner_account_id', 'prompts:operation_id', 'claims:owner_account_id', 'claims:operation_id',
    'setup_stages:owner_account_id,stage_index', 'setup_stages:operation_id,stage_index', 'setup_stages:owner_account_id,stage_id']
      .every(key => indexes.has(key))) throw fail('UNSAFE_SCHEMA', 'prompt fence is missing an essential unique index');
  for (const table of ['prompts', 'claims', 'setup_stages']) {
    const visibility = await client.query(`SELECT t.relrowsecurity, t.relforcerowsecurity
      FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname=$1 AND t.relkind='r'`, [table]);
    if (visibility.rows.length !== 1 || visibility.rows[0].relrowsecurity || visibility.rows[0].relforcerowsecurity) {
      throw fail('UNSAFE_SCHEMA', 'prompt fence requires complete row visibility and no row-level security');
    }
  }
  for (const [table, trigger, fn, source] of [
    ['prompts', 'prompt_immutable', 'guard_prompt', GUARD_SOURCE],
    ['claims', 'claim_immutable', 'guard_claim', CLAIM_GUARD_SOURCE],
    ['setup_stages', 'setup_stage_immutable', 'guard_setup_stage', SETUP_STAGE_GUARD_SOURCE],
  ]) {
    const guards = await client.query(`SELECT g.tgenabled, g.tgtype::integer AS kind, g.tgisinternal,
        p.prosrc, p.pronargs, p.prosecdef, p.provolatile, p.proconfig, lang.lanname
      FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      JOIN pg_catalog.pg_language lang ON lang.oid=p.prolang
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname=$1
        AND g.tgname=$2 AND pn.nspname='bouncer_wallet_prompt_v1' AND p.proname=$3`, [table, trigger, fn]);
    const guard = guards.rows[0];
    if (guards.rows.length !== 1 || !['O', 'A'].includes(guard.tgenabled) || guard.kind !== 27 || guard.tgisinternal ||
        guard.prosrc !== source || guard.pronargs !== 0 || guard.prosecdef || guard.lanname !== 'plpgsql' ||
        guard.provolatile !== 'v' || !Array.isArray(guard.proconfig) || guard.proconfig.length !== 1 || guard.proconfig[0] !== 'search_path=pg_catalog') {
      throw fail('UNSAFE_SCHEMA', 'prompt fence immutable-record trigger is missing or changed');
    }
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
    await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.claims (
      owner_account_id text PRIMARY KEY REFERENCES ${SCHEMA}.prompts(owner_account_id),
      operation_id text NOT NULL UNIQUE REFERENCES ${SCHEMA}.prompts(operation_id),
      claimed boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      claimed_at timestamptz
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.setup_stages (
      owner_account_id text NOT NULL REFERENCES ${SCHEMA}.prompts(owner_account_id),
      operation_id text NOT NULL REFERENCES ${SCHEMA}.prompts(operation_id),
      stage_index smallint NOT NULL CHECK (stage_index IN (1,2)), stage_id text NOT NULL,
      action_commitment_sha256 text NOT NULL, claimed boolean NOT NULL DEFAULT false,
      claimed_at timestamptz, original_hash text, created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
      PRIMARY KEY (owner_account_id,stage_index), UNIQUE (operation_id,stage_index), UNIQUE (owner_account_id,stage_id),
      CHECK ((stage_index=1 AND stage_id='register_vault_circle') OR (stage_index=2 AND stage_id='fund_vault_circle')),
      CHECK ((NOT claimed AND claimed_at IS NULL AND original_hash IS NULL) OR (claimed AND claimed_at IS NOT NULL))
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
    const claimFunctions = await client.query(`SELECT p.oid FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND p.proname='guard_claim' AND p.pronargs=0`);
    if (claimFunctions.rows.length === 0) await client.query(`CREATE FUNCTION ${SCHEMA}.guard_claim() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$${CLAIM_GUARD_SOURCE}$guard$`);
    const claimTriggers = await client.query(`SELECT g.oid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname='claims' AND g.tgname='claim_immutable'`);
    if (claimTriggers.rows.length === 0) await client.query(`CREATE TRIGGER claim_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.claims
      FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_claim()`);
    const setupFunctions = await client.query(`SELECT p.oid FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND p.proname='guard_setup_stage' AND p.pronargs=0`);
    if (setupFunctions.rows.length === 0) await client.query(`CREATE FUNCTION ${SCHEMA}.guard_setup_stage() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$${SETUP_STAGE_GUARD_SOURCE}$guard$`);
    const setupTriggers = await client.query(`SELECT g.oid FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_wallet_prompt_v1' AND t.relname='setup_stages' AND g.tgname='setup_stage_immutable'`);
    if (setupTriggers.rows.length === 0) await client.query(`CREATE TRIGGER setup_stage_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.setup_stages
      FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_setup_stage()`);
    // Existing definitions are never silently replaced; mismatch blocks use.
    // Do NOT backfill claims for legacy prompts: we cannot prove they were not opened.
    await verifySchema(client);
  });
}

const columns = `owner_account_id, operation_id, owner_public_key, review_sha256, stage_id,
  action_commitment_sha256, review, original_hash, created_at`;

function setupArtifact(input) {
  if (input === undefined) return null;
  if (!(input instanceof Uint8Array)) throw new Error('the exact pinned V12 artifact is required for setup reservations');
  const bytes = Buffer.from(input);
  if (bytes.length !== V12_EXPECTED_BYTES || crypto.createHash('sha256').update(bytes).digest('hex') !== V12_EXPECTED_SHA256 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])) ||
      !bytes.includes(Buffer.from('bouncer-agent-v12-exact-ft-testnet'))) {
    throw new Error('the exact pinned V12 artifact is required for setup reservations');
  }
  return bytes;
}
function validatedRow(row, wasmBytes) {
  try {
    if (!plain(row) || !isTestnetAccount(row.owner_account_id) || !hex32(row.operation_id) ||
        !digest(row.review_sha256) || !digest(row.action_commitment_sha256) || !STAGES.includes(row.stage_id) ||
        !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
        (row.original_hash !== null && !isTransactionHash(row.original_hash))) throw new Error();
    const setup = row.review?.kind === SETUP_RECORD;
    let review = row.review, snapshot = null, identity;
    if (setup) {
      if (!plain(row.review) || Object.keys(row.review).length !== 3 || !Object.hasOwn(row.review, 'review') ||
          !Object.hasOwn(row.review, 'snapshot') || !wasmBytes || row.stage_id !== SETUP_STAGE) throw new Error();
      review = row.review.review; snapshot = row.review.snapshot;
      identity = verifyBufferWalletSetupReview({ review, snapshot, wasmBytes, trustedReviewHash: row.review_sha256,
        trustedOwnerPublicKey: row.owner_public_key });
    } else {
      if (!SPENDING_STAGES.includes(row.stage_id)) throw new Error();
      identity = verifyBufferSpendingReview({ review, trustedReviewHash: row.review_sha256,
        trustedOwnerPublicKey: row.owner_public_key });
    }
    const stage = review.stages.find(item => item.id === row.stage_id);
    if (identity.owner !== row.owner_account_id || !stage || stage.action_commitment_sha256 !== row.action_commitment_sha256) throw new Error();
    return { version: 1, network: 'testnet', owner: row.owner_account_id, operation_id: row.operation_id,
      owner_public_key: row.owner_public_key, review_sha256: row.review_sha256, stage_id: row.stage_id,
      action_commitment_sha256: row.action_commitment_sha256, review: structuredClone(review),
      ...(setup ? { setup_snapshot: structuredClone(snapshot) } : {}),
      status: row.original_hash === null ? 'PROMPT_RESERVED_NO_HASH' : 'ORIGINAL_HASH_RECORDED',
      original_hash: row.original_hash, created_at: row.created_at.toISOString(),
      warning: 'Reservation only. No wallet approval, chain settlement, delivery or rollback protection is established.' };
  } catch { throw fail('CORRUPT', 'retained prompt record is malformed or mismatched; stop and reconcile'); }
}

function checkedClaim(row, prompt) {
  if (!plain(row) || row.owner_account_id !== prompt.owner || row.operation_id !== prompt.operation_id ||
      typeof row.claimed !== 'boolean' || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
      !((row.claimed === false && row.claimed_at === null) ||
        (row.claimed === true && row.claimed_at instanceof Date && Number.isFinite(row.claimed_at.getTime())))) {
    throw fail('CORRUPT', 'wallet prompt claim is malformed or mismatched; stop and reconcile');
  }
  return row;
}
async function claimStatus(client, prompt) {
  const selected = await client.query(`SELECT owner_account_id,operation_id,claimed,created_at,claimed_at
    FROM ${SCHEMA}.claims WHERE owner_account_id=$1`, [prompt.owner]);
  // A legacy row without an atomic eligibility record may already have been
  // used elsewhere; never convert it into a fresh claim.
  if (selected.rows.length === 0) return 'LEGACY_NOT_CLAIMABLE';
  if (selected.rows.length !== 1) throw fail('CORRUPT', 'duplicate wallet prompt claims; stop');
  const claim = checkedClaim(selected.rows[0], prompt);
  return claim.claimed ? 'CLAIMED' : prompt.original_hash ? 'ORIGINAL_ALREADY_RECORDED' : 'AVAILABLE';
}

const setupStageColumns = `owner_account_id,operation_id,stage_index,stage_id,action_commitment_sha256,
  claimed,claimed_at,original_hash,created_at`;

async function setupProgress(client, prompt, lock = false) {
  if (!prompt.setup_snapshot || prompt.stage_id !== SETUP_STAGE) throw fail('MISMATCH', 'a retained setup reservation is required');
  const firstRows = await client.query(`SELECT owner_account_id,operation_id,claimed,created_at,claimed_at
    FROM ${SCHEMA}.claims WHERE owner_account_id=$1${lock ? ' FOR UPDATE' : ''}`, [prompt.owner]);
  if (firstRows.rows.length === 0) throw fail('LEGACY_NOT_CLAIMABLE', 'legacy setup reservation has no atomic claim; stop and reconcile');
  if (firstRows.rows.length !== 1) throw fail('CORRUPT', 'duplicate setup claim records; stop');
  const first = checkedClaim(firstRows.rows[0], prompt);
  const result = await client.query(`SELECT ${setupStageColumns} FROM ${SCHEMA}.setup_stages
    WHERE owner_account_id=$1 ORDER BY stage_index${lock ? ' FOR UPDATE' : ''}`, [prompt.owner]);
  if (result.rows.length === 0) throw fail('LEGACY_NOT_CLAIMABLE', 'legacy setup has no atomic later-stage journal; stop and reconcile');
  if (result.rows.length !== NEXT_SETUP_STAGES.length) throw fail('CORRUPT', 'setup stage journal is incomplete; stop and reconcile');
  const stages = result.rows.map((row, i) => {
    const expected = prompt.review.stages[i + 1];
    if (row.owner_account_id !== prompt.owner || row.operation_id !== prompt.operation_id || row.stage_index !== i + 1 ||
        row.stage_id !== NEXT_SETUP_STAGES[i] || row.action_commitment_sha256 !== expected.action_commitment_sha256 ||
        typeof row.claimed !== 'boolean' || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime()) ||
        !((!row.claimed && row.claimed_at === null && row.original_hash === null) ||
          (row.claimed && row.claimed_at instanceof Date && Number.isFinite(row.claimed_at.getTime()) &&
            (row.original_hash === null || isTransactionHash(row.original_hash))))) {
      throw fail('CORRUPT', 'setup stage journal differs from its retained review; stop and reconcile');
    }
    return row;
  });
  if ((stages[0].claimed && (!first.claimed || !prompt.original_hash)) ||
      (stages[1].claimed && (!stages[0].claimed || !stages[0].original_hash))) {
    throw fail('CORRUPT', 'setup stage claims are out of order; stop and reconcile');
  }
  const hashes = [prompt.original_hash, ...stages.map(stage => stage.original_hash)].filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw fail('CORRUPT', 'setup originals cannot be reused across stages');
  return { first, stages };
}
function assertPriorSetupProgress(prompt, progress, index) {
  if (!progress.first.claimed || !prompt.original_hash ||
      (index >= 1 && (!progress.stages[0].claimed || !progress.stages[0].original_hash)) ||
      (index >= 2 && (!progress.stages[1].claimed || !progress.stages[1].original_hash))) {
    throw fail('PRIOR_STAGE_UNRESOLVED', 'a preceding setup prompt is unclaimed or has no original hash; stop and reconcile');
  }
  return [prompt.original_hash, ...progress.stages.slice(0, index).map(stage => stage.original_hash)];
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
export function createPostgresWalletPromptFence({ pool, authenticate, setupWasmBytes, setupReceiptProvider, setupPreflightProvider } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof authenticate !== 'function') throw new Error('PostgreSQL pool and owner authenticator required');
  // Copy the pinned artifact once into server-owned memory. It is never sent
  // to the database or returned to a browser by this prototype.
  const pinnedSetupWasm = setupArtifact(setupWasmBytes);
  if (setupReceiptProvider !== undefined && (!pinnedSetupWasm || !setupReceiptProvider ||
      typeof setupReceiptProvider.viewNodeStatus !== 'function' || typeof setupReceiptProvider.txStatusReceipts !== 'function')) {
    throw new Error('pinned V12 bytes and a trusted read-only setup receipt provider are required');
  }
  const readStatus = setupReceiptProvider?.viewNodeStatus.bind(setupReceiptProvider);
  const readReceipts = setupReceiptProvider?.txStatusReceipts.bind(setupReceiptProvider);
  if (setupPreflightProvider !== undefined && (!pinnedSetupWasm || !setupPreflightProvider ||
      PREFLIGHT_METHODS.some(method => typeof setupPreflightProvider[method] !== 'function'))) {
    throw new Error('pinned V12 bytes and a trusted read-only setup preflight provider are required');
  }
  // Bind the configured provider once. A browser cannot supply or replace it,
  // a method or the seller-code pin as part of a claim request.
  const preflightProvider = setupPreflightProvider && Object.freeze(Object.fromEntries(
    PREFLIGHT_METHODS.map(method => [method, setupPreflightProvider[method].bind(setupPreflightProvider)])));
  async function authorize(action, evidence) {
    let accepted = false;
    try { accepted = await authenticate({ action: Object.freeze(action), evidence }); } catch { /* fail closed */ }
    if (accepted !== true) throw fail('UNAUTHENTICATED', 'owner authentication failed; no prompt reservation');
  }
  const context = (purpose, owner, key, extra = {}) => Object.freeze({ format: 'bouncer-wallet-prompt-auth-v1',
    network: 'testnet', purpose, owner, owner_public_key: key, ...extra });
  async function loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 }, lock = false) {
    await verifySchema(client);
    const found = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1${lock ? ' FOR UPDATE' : ''}`, [owner]);
    if (found.rows.length !== 1) throw fail('OWNER_FENCED', 'original setup reservation missing; stop and reconcile');
    const prompt = validatedRow(found.rows[0], pinnedSetupWasm);
    if (prompt.owner_public_key !== ownerPublicKey || (operationId !== undefined && prompt.operation_id !== operationId) ||
        (reviewSha256 !== undefined && prompt.review_sha256 !== reviewSha256)) {
      throw fail('MISMATCH', 'retained setup owner, operation or review differs; stop and reconcile');
    }
    return { prompt, progress: await setupProgress(client, prompt, lock) };
  }
  function assertStageIdentity(prompt, stage, stageId, commitment) {
    if (!stage || stage.stage_id !== stageId || stage.action_commitment_sha256 !== commitment ||
        prompt.review.stages[stage.stage_index]?.action_commitment_sha256 !== commitment) {
      throw fail('MISMATCH', 'retained setup stage differs from the reviewed action; stop and reconcile');
    }
  }
  function requireSetupProviders() {
    if (!readStatus || !readReceipts || !preflightProvider) {
      throw fail('SETUP_PREFLIGHT_UNAVAILABLE', 'trusted receipt and same-block preflight providers are required; no prompt was claimed');
    }
  }
  async function setupPreflight(prompt, hashes, stageId) {
    try {
      if ((await readStatus())?.chain_id !== 'testnet') throw new Error('not testnet');
      const priorOriginals = [];
      for (let i = 0; i < hashes.length; i++) {
        const stage = [SETUP_STAGE, ...NEXT_SETUP_STAGES][i];
        const attempt = prepareBufferWalletSetupAttempt({ review: prompt.review, snapshot: prompt.setup_snapshot,
          wasmBytes: pinnedSetupWasm, trustedReviewHash: prompt.review_sha256, trustedOwnerPublicKey: prompt.owner_public_key,
          stageId: stage, trustedOriginalHash: hashes[i] });
        const result = structuredClone(await readReceipts(hashes[i], prompt.owner, 'FINAL'));
        priorOriginals.push({ trustedOriginalHash: hashes[i], attempt, result });
      }
      return await inspectBufferWalletSetupStage({ review: prompt.review, snapshot: prompt.setup_snapshot,
        wasmBytes: pinnedSetupWasm, trustedReviewHash: prompt.review_sha256, trustedOwnerPublicKey: prompt.owner_public_key,
        trustedSellerCodeHash: prompt.review.seller_code_hash_observed, stageId, priorOriginals, provider: preflightProvider });
    } catch {
      throw fail('SETUP_PREFLIGHT_UNAVAILABLE', 'preceding originals or fresh same-block setup preflight are unavailable; stop and reconcile');
    }
  }
  function assertSetupProfile(preflight, prompt, stageId, count) {
    if (preflight.status !== 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || preflight.owner !== prompt.owner ||
        preflight.review_sha256 !== prompt.review_sha256 || preflight.stage_id !== stageId ||
        preflight.seller_code_hash !== prompt.review.seller_code_hash_observed || preflight.prior_receipt_graphs_matched !== count ||
        !Array.isArray(preflight.blockers) || preflight.blockers.length !== 0) {
      throw fail('SETUP_PREFLIGHT_BLOCKED', 'fresh same-block setup checks did not all pass; no wallet prompt was claimed');
    }
  }
  function assertFreshSetupPreflight(preflight) {
    const checked = Date.parse(preflight.checked_at), now = Date.now();
    if (!Number.isSafeInteger(checked) || !Number.isSafeInteger(now) || now < checked || now - checked > MAX_SETUP_PREFLIGHT_AGE_MS) {
      throw fail('SETUP_PREFLIGHT_STALE', 'setup preflight expired before the claim; no wallet prompt was claimed');
    }
  }
  const sameHashes = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

  return Object.freeze({
    async reserve({ review: inputReview, setupSnapshot: inputSnapshot, trustedReviewHash, trustedOwnerPublicKey, stageId, evidence } = {}) {
      // Snapshot and validate the public review before the first await; neither
      // the caller nor authenticator may mutate the requested stage. Only the
      // FIRST setup stage is eligible: no multi-stage progression exists yet.
      const review = structuredClone(inputReview), setup = review?.format === 'bouncer-buffer-wallet-setup-review-v1';
      const snapshot = setup ? structuredClone(inputSnapshot) : null;
      if (setup ? stageId !== SETUP_STAGE || !pinnedSetupWasm : inputSnapshot !== undefined || !SPENDING_STAGES.includes(stageId)) {
        throw new Error('a reviewed Buffer spending stage or first pinned setup stage is required');
      }
      const identity = setup ? verifyBufferWalletSetupReview({ review, snapshot, wasmBytes: pinnedSetupWasm,
        trustedReviewHash, trustedOwnerPublicKey }) : verifyBufferSpendingReview({ review, trustedReviewHash, trustedOwnerPublicKey });
      const storedReview = setup ? { kind: SETUP_RECORD, review, snapshot } : review;
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
        [identity.owner, operation, trustedOwnerPublicKey, trustedReviewHash, stageId, stage.action_commitment_sha256, JSON.stringify(storedReview)]);
        if (inserted.rows.length !== 1) throw fail('OWNER_FENCED', 'an owner prompt is already reserved; reconcile it, never replace or retry it');
        const prompt = validatedRow(inserted.rows[0], pinnedSetupWasm);
        const eligible = await client.query(`INSERT INTO ${SCHEMA}.claims (owner_account_id,operation_id)
          VALUES ($1,$2) RETURNING owner_account_id,operation_id,claimed,created_at,claimed_at`, [identity.owner, operation]);
        if (eligible.rows.length !== 1 || checkedClaim(eligible.rows[0], prompt).claimed !== false) {
          throw fail('CORRUPT', 'prompt eligibility was not created; stop and reconcile');
        }
        if (setup) {
          for (let i = 0; i < NEXT_SETUP_STAGES.length; i++) {
            const later = review.stages[i + 1];
            const insertedStage = await client.query(`INSERT INTO ${SCHEMA}.setup_stages
              (owner_account_id,operation_id,stage_index,stage_id,action_commitment_sha256)
              VALUES ($1,$2,$3,$4,$5) RETURNING ${setupStageColumns}`,
            [identity.owner, operation, i + 1, later.id, later.action_commitment_sha256]);
            if (insertedStage.rows.length !== 1) throw fail('CORRUPT', 'setup stage journal was not created; stop');
          }
          await setupProgress(client, prompt);
        }
        return { ...prompt, claim_status: 'AVAILABLE' };
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
        const row = validatedRow(found.rows[0], pinnedSetupWasm);
        if (row.owner_public_key !== ownerPublicKey) throw fail('OWNER_KEY_MISMATCH', 'retained owner key differs; stop and reconcile');
        return { ...row, claim_status: await claimStatus(client, row) };
      });
    },

    /** Returns only journal state, never wallet invocation or execution proof. */
    async inspectSetupProgress({ owner, ownerPublicKey, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      await authorize(context('inspect_setup_progress', owner, ownerPublicKey), evidence);
      return transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey });
        return { owner, operation_id: prompt.operation_id, review_sha256: prompt.review_sha256,
          stages: [{ stage_id: SETUP_STAGE, action_commitment_sha256: prompt.action_commitment_sha256,
            claimed: progress.first.claimed, original_hash: prompt.original_hash },
          ...progress.stages.map(stage => ({ stage_id: stage.stage_id, action_commitment_sha256: stage.action_commitment_sha256,
            claimed: stage.claimed, original_hash: stage.original_hash }))],
          execution_authorized: false, independently_durable: false, wallet_invocation_verified: false,
          scope: 'database journal state only; not a wallet, consent, transaction proof, backup or delivery' };
      });
    },

    /** A later stage is claimed once only after ALL preceding originals match
     * trusted FINAL receipt graphs AND a fresh same-block profile passes. */
    async claimSetupStage({ owner, ownerPublicKey, operationId, reviewSha256, stageId, actionCommitmentSha256, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      const index = NEXT_SETUP_STAGES.indexOf(stageId);
      if (!hex32(operationId) || !digest(reviewSha256) || index < 0 || !digest(actionCommitmentSha256)) {
        throw new Error('original setup operation and exact later-stage review are required');
      }
      requireSetupProviders();
      await authorize(context('claim_setup_stage', owner, ownerPublicKey, { operation_id: operationId,
        review_sha256: reviewSha256, stage_id: stageId, action_commitment_sha256: actionCommitmentSha256 }), evidence);
      const retained = await transaction(pool, async client => {
        const value = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 });
        const stage = value.progress.stages[index];
        assertStageIdentity(value.prompt, stage, stageId, actionCommitmentSha256);
        if (stage.claimed) throw fail('ALREADY_CLAIMED', 'setup prompt was already claimed; never open it again');
        return { prompt: value.prompt, hashes: assertPriorSetupProgress(value.prompt, value.progress, index) };
      });
      const preflight = await setupPreflight(retained.prompt, retained.hashes, stageId);
      assertSetupProfile(preflight, retained.prompt, stageId, index + 1);
      assertFreshSetupPreflight(preflight);
      const claimed = await transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 }, true);
        const stage = progress.stages[index];
        assertStageIdentity(prompt, stage, stageId, actionCommitmentSha256);
        if (stage.claimed) throw fail('ALREADY_CLAIMED', 'setup prompt was already claimed; never open it again');
        if (!sameHashes(retained.hashes, assertPriorSetupProgress(prompt, progress, index))) {
          throw fail('MISMATCH', 'preceding setup originals changed; stop and reconcile');
        }
        assertFreshSetupPreflight(preflight);
        const result = await client.query(`UPDATE ${SCHEMA}.setup_stages SET claimed=true,claimed_at=pg_catalog.clock_timestamp()
          WHERE owner_account_id=$1 AND operation_id=$2 AND stage_index=$3 AND claimed=false AND original_hash IS NULL
          RETURNING ${setupStageColumns}`, [owner, operationId, index + 1]);
        if (result.rows.length !== 1) throw fail('MISMATCH', 'setup claim conflicted; stop and reconcile');
        const checked = await setupProgress(client, prompt);
        if (!checked.stages[index].claimed) throw fail('CORRUPT', 'setup claim was not retained; stop');
        return { owner, operation_id: operationId, review_sha256: reviewSha256, stage_id: stageId,
          action_commitment_sha256: actionCommitmentSha256, status: 'PROMPT_CLAIMED_NO_HASH',
          claimed_at: checked.stages[index].claimed_at.toISOString(), do_not_retry: true, execution_authorized: false,
          wallet_invocation_verified: false, independently_durable: false, preflight_block_hash: preflight.block_hash,
          preflight_checked_at: preflight.checked_at, prior_originals_matched: retained.hashes.length,
          scope: 'single database claim and trusted-RPC checks only; no wallet, consent, backup or future chain state established' };
      });
      try { assertFreshSetupPreflight(preflight); }
      catch { throw fail('CLAIM_COMMITTED_PREFLIGHT_STALE', 'the claim committed after its preflight expired; do not open or retry the prompt'); }
      return claimed;
    },

    /** Persist one first original only after the one-shot claim. A hash is not
     * proof of execution; it must subsequently match trusted FINAL receipts. */
    async recordSetupStageOriginal({ owner, ownerPublicKey, operationId, reviewSha256, stageId,
      actionCommitmentSha256, originalHash, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      const index = NEXT_SETUP_STAGES.indexOf(stageId);
      if (!hex32(operationId) || !digest(reviewSha256) || index < 0 || !digest(actionCommitmentSha256) || !isTransactionHash(originalHash)) {
        throw new Error('original setup operation, exact reviewed action and first transaction hash required');
      }
      await authorize(context('record_setup_stage_original', owner, ownerPublicKey, { operation_id: operationId,
        review_sha256: reviewSha256, stage_id: stageId, action_commitment_sha256: actionCommitmentSha256, original_hash: originalHash }), evidence);
      return transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 }, true);
        const stage = progress.stages[index];
        assertStageIdentity(prompt, stage, stageId, actionCommitmentSha256);
        if (!stage.claimed) throw fail('CLAIM_REQUIRED', 'setup prompt was never claimed; do not invent an original');
        if (stage.original_hash !== null) {
          if (stage.original_hash !== originalHash) throw fail('MISMATCH', 'original hash is immutable; never replace it');
          return { owner, operation_id: operationId, stage_id: stageId, original_hash: originalHash,
            status: 'ORIGINAL_RECORDED', do_not_retry: true, execution_authorized: false };
        }
        if ([prompt.original_hash, ...progress.stages.filter((_, i) => i !== index).map(x => x.original_hash)].includes(originalHash)) {
          throw fail('MISMATCH', 'an original hash cannot be reused across setup stages');
        }
        const updated = await client.query(`UPDATE ${SCHEMA}.setup_stages SET original_hash=$1
          WHERE owner_account_id=$2 AND operation_id=$3 AND stage_index=$4 AND claimed=true AND original_hash IS NULL
          RETURNING ${setupStageColumns}`, [originalHash, owner, operationId, index + 1]);
        if (updated.rows.length !== 1) throw fail('MISMATCH', 'original hash update conflicted; stop and reconcile');
        const verified = await setupProgress(client, prompt);
        if (verified.stages[index].original_hash !== originalHash) throw fail('CORRUPT', 'original hash was not retained; stop');
        return { owner, operation_id: operationId, stage_id: stageId, original_hash: originalHash,
          status: 'ORIGINAL_RECORDED', do_not_retry: true, execution_authorized: false };
      });
    },

    /** One durable claim is available for a newly reserved prompt. The first
     * setup stage requires a newly completed same-block preflight immediately
     * before the claim. Spending stages do not yet have this integration.
     * A caller must never retry after a lost claim acknowledgement or wallet
     * result. No wallet is invoked and a claim is NOT live spending authority. */
    async claimPrompt({ owner, ownerPublicKey, operationId, reviewSha256, stageId, actionCommitmentSha256, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      if (!hex32(operationId) || !digest(reviewSha256) || !STAGES.includes(stageId) || !digest(actionCommitmentSha256)) {
        throw new Error('original operation and exact reviewed action are required');
      }
      // Do not start a new vault setup if the backend cannot even be
      // configured to reconcile its originals for subsequent stages.
      if (stageId === SETUP_STAGE) requireSetupProviders();
      await authorize(context('claim_prompt', owner, ownerPublicKey, { operation_id: operationId,
        review_sha256: reviewSha256, stage_id: stageId, action_commitment_sha256: actionCommitmentSha256 }), evidence);
      const assertMatching = row => {
        if (row.owner_public_key !== ownerPublicKey || row.operation_id !== operationId || row.review_sha256 !== reviewSha256 ||
            row.stage_id !== stageId || row.action_commitment_sha256 !== actionCommitmentSha256 || row.original_hash !== null) {
          throw fail('MISMATCH', 'original prompt, reviewed action or hash differs; stop and reconcile');
        }
      };
      let preflight;
      if (stageId === SETUP_STAGE) {
        // Do not hold a database lock across network requests. Read the
        // immutable reservation, then re-read and lock it after the preflight.
        const retained = await transaction(pool, async client => {
          await verifySchema(client);
          const selected = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1`, [owner]);
          if (selected.rows.length !== 1) throw fail('OWNER_FENCED', 'original prompt reservation missing; stop and reconcile');
          const row = validatedRow(selected.rows[0], pinnedSetupWasm);
          assertMatching(row);
          if (!row.setup_snapshot) throw fail('CORRUPT', 'first setup prompt has no retained snapshot; stop');
          // Legacy setup reservations were not atomically given the later-stage
          // journal. Do not start a flow that cannot safely advance.
          await setupProgress(client, row);
          const status = await claimStatus(client, row);
          if (status === 'CLAIMED') throw fail('ALREADY_CLAIMED', 'wallet prompt was already claimed; never open it again');
          if (status === 'LEGACY_NOT_CLAIMABLE') throw fail('LEGACY_NOT_CLAIMABLE', 'legacy prompt may already have been opened; stop and reconcile');
          if (status !== 'AVAILABLE') throw fail('MISMATCH', 'original setup prompt is not claimable; stop and reconcile');
          return row;
        });
        try { if ((await readStatus())?.chain_id !== 'testnet') throw new Error('not testnet'); }
        catch { throw fail('SETUP_PREFLIGHT_UNAVAILABLE', 'the trusted setup receipt provider is unavailable; no wallet prompt was claimed'); }
        try {
          preflight = await inspectBufferWalletSetupStage({ review: retained.review, snapshot: retained.setup_snapshot,
            wasmBytes: pinnedSetupWasm, trustedReviewHash: reviewSha256, trustedOwnerPublicKey: ownerPublicKey,
            trustedSellerCodeHash: retained.review.seller_code_hash_observed, stageId, priorOriginals: [], provider: preflightProvider });
        } catch {
          throw fail('SETUP_PREFLIGHT_UNAVAILABLE', 'fresh setup preflight is unavailable; no wallet prompt was claimed');
        }
        if (preflight.status !== 'READ_ONLY_SETUP_STAGE_PROFILE_MATCH' || preflight.owner !== owner ||
            preflight.review_sha256 !== reviewSha256 || preflight.stage_id !== stageId ||
            preflight.seller_code_hash !== retained.review.seller_code_hash_observed ||
            !Array.isArray(preflight.blockers) || preflight.blockers.length !== 0) {
          throw fail('SETUP_PREFLIGHT_BLOCKED', 'fresh same-block setup checks did not all pass; no wallet prompt was claimed');
        }
      }
      const assertFreshPreflight = () => {
        if (!preflight) return;
        const checked = Date.parse(preflight.checked_at), now = Date.now();
        if (!Number.isSafeInteger(checked) || !Number.isSafeInteger(now) || now < checked || now - checked > MAX_SETUP_PREFLIGHT_AGE_MS) {
          throw fail('SETUP_PREFLIGHT_STALE', 'setup preflight expired before the claim; no wallet prompt was claimed');
        }
      };
      assertFreshPreflight();
      const claimed = await transaction(pool, async client => {
        await verifySchema(client);
        const selected = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1 FOR UPDATE`, [owner]);
        if (selected.rows.length !== 1) throw fail('OWNER_FENCED', 'original prompt reservation missing; stop and reconcile');
        const row = validatedRow(selected.rows[0], pinnedSetupWasm);
        assertMatching(row);
        if (stageId === SETUP_STAGE) await setupProgress(client, row, true);
        const claims = await client.query(`SELECT owner_account_id,operation_id,claimed,created_at,claimed_at
          FROM ${SCHEMA}.claims WHERE owner_account_id=$1 FOR UPDATE`, [owner]);
        if (claims.rows.length === 0) throw fail('LEGACY_NOT_CLAIMABLE', 'legacy prompt may already have been opened; stop and reconcile');
        if (claims.rows.length !== 1) throw fail('CORRUPT', 'duplicate wallet prompt claims; stop');
        if (checkedClaim(claims.rows[0], row).claimed) throw fail('ALREADY_CLAIMED', 'wallet prompt was already claimed; never open it again');
        assertFreshPreflight();
        const updated = await client.query(`UPDATE ${SCHEMA}.claims SET claimed=true,claimed_at=pg_catalog.clock_timestamp()
          WHERE owner_account_id=$1 AND operation_id=$2 AND claimed=false
          RETURNING owner_account_id,operation_id,claimed,created_at,claimed_at`, [owner, operationId]);
        if (updated.rows.length !== 1 || !checkedClaim(updated.rows[0], row).claimed) {
          throw fail('MISMATCH', 'wallet prompt claim conflicted; stop and reconcile');
        }
        return { owner, operation_id: operationId, stage_id: stageId, review_sha256: reviewSha256,
          action_commitment_sha256: actionCommitmentSha256, status: 'PROMPT_CLAIMED_NO_HASH',
          claimed_at: updated.rows[0].claimed_at.toISOString(), do_not_retry: true, execution_authorized: false,
          wallet_invocation_verified: false, independently_durable: false,
          scope: 'single database claim only; no wallet invocation, consent, backup or future chain state is established',
          ...(preflight ? { preflight_block_hash: preflight.block_hash, preflight_checked_at: preflight.checked_at,
            preflight_scope: 'trusted same-block profile only; state can change and is not approval' } : {}) };
      });
      // If a commit acknowledgement arrives after the freshness window, the
      // claim may have committed. Do not give it to a caller as usable and do
      // not claim or open the prompt again, even though no send is known.
      try { assertFreshPreflight(); }
      catch { throw fail('CLAIM_COMMITTED_PREFLIGHT_STALE', 'the claim committed after its preflight expired; do not open or retry the prompt'); }
      return claimed;
    },

    async recordOriginalHash({ owner, ownerPublicKey, operationId, originalHash, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      if (!hex32(operationId) || !isTransactionHash(originalHash)) throw new Error('original operation ID and transaction hash required');
      await authorize(context('record_original_hash', owner, ownerPublicKey, { operation_id: operationId, original_hash: originalHash }), evidence);
      return transaction(pool, async client => {
        await verifySchema(client);
        const selected = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1 FOR UPDATE`, [owner]);
        if (selected.rows.length !== 1) throw fail('OWNER_FENCED', 'original prompt reservation missing; stop and reconcile');
        const old = validatedRow(selected.rows[0], pinnedSetupWasm);
        if (old.owner_public_key !== ownerPublicKey || old.operation_id !== operationId) throw fail('MISMATCH', 'original owner or operation differs; stop and reconcile');
        if (old.original_hash !== null) {
          if (old.original_hash !== originalHash) throw fail('MISMATCH', 'original hash is immutable; never replace it');
          return old;
        }
        const updated = await client.query(`UPDATE ${SCHEMA}.prompts SET original_hash=$1
          WHERE owner_account_id=$2 AND operation_id=$3 AND original_hash IS NULL RETURNING ${columns}`,
        [originalHash, owner, operationId]);
        if (updated.rows.length !== 1) throw fail('MISMATCH', 'original hash update conflicted; stop and reconcile');
        return validatedRow(updated.rows[0], pinnedSetupWasm);
      });
    },

    /** Fetch and verify ONLY the retained first setup original. The provider is
     * a server-owned trust boundary, not a caller-supplied receipt. Successful
     * matching does not unlock a later stage or establish fresh chain state. */
    async reconcileSetupOriginal({ owner, ownerPublicKey, operationId, reviewSha256, stageId,
      actionCommitmentSha256, originalHash, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      if (!readStatus || !readReceipts) throw fail('RECEIPT_UNAVAILABLE', 'no trusted setup receipt provider is configured; stop and reconcile');
      if (!hex32(operationId) || !digest(reviewSha256) || stageId !== SETUP_STAGE || !digest(actionCommitmentSha256) || !isTransactionHash(originalHash)) {
        throw new Error('original setup operation, reviewed action and original hash are required');
      }
      await authorize(context('reconcile_setup_original', owner, ownerPublicKey, { operation_id: operationId,
        review_sha256: reviewSha256, stage_id: stageId, action_commitment_sha256: actionCommitmentSha256, original_hash: originalHash }), evidence);
      const retained = await transaction(pool, async client => {
        await verifySchema(client);
        const selected = await client.query(`SELECT ${columns} FROM ${SCHEMA}.prompts WHERE owner_account_id=$1`, [owner]);
        if (selected.rows.length !== 1) throw fail('OWNER_FENCED', 'original prompt reservation missing; stop and reconcile');
        const row = validatedRow(selected.rows[0], pinnedSetupWasm);
        if (!row.setup_snapshot || row.owner_public_key !== ownerPublicKey || row.operation_id !== operationId ||
            row.review_sha256 !== reviewSha256 || row.stage_id !== stageId || row.action_commitment_sha256 !== actionCommitmentSha256 ||
            row.original_hash !== originalHash) {
          throw fail('MISMATCH', 'retained setup original or reviewed action differs; stop and reconcile');
        }
        return row;
      });
      try {
        if ((await readStatus())?.chain_id !== 'testnet') throw new Error('not testnet');
        const attempt = prepareBufferWalletSetupAttempt({ review: retained.review, snapshot: retained.setup_snapshot,
          wasmBytes: pinnedSetupWasm, trustedReviewHash: reviewSha256, trustedOwnerPublicKey: ownerPublicKey,
          stageId, trustedOriginalHash: originalHash });
        const result = structuredClone(await readReceipts(originalHash, owner, 'FINAL'));
        const proof = inspectBufferWalletSetupAttempt({ review: retained.review, snapshot: retained.setup_snapshot,
          wasmBytes: pinnedSetupWasm, trustedReviewHash: reviewSha256, trustedOwnerPublicKey: ownerPublicKey,
          trustedOriginalHash: originalHash, attempt, result });
        return { ...proof, owner, operation_id: operationId, review_sha256: reviewSha256,
          action_commitment_sha256: actionCommitmentSha256, execution_authorized: false, later_stage_unlocked: false,
          independently_durable: false, provider_trusted_not_consensus_proof: true };
      } catch {
        throw fail('RECEIPT_UNKNOWN', 'original setup receipt is unavailable, incomplete or mismatched; preserve it and never resend');
      }
    },

    /** Reconcile a retained registration or funding original, never a retry. */
    async reconcileSetupStage({ owner, ownerPublicKey, operationId, reviewSha256, stageId,
      actionCommitmentSha256, originalHash, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      const index = NEXT_SETUP_STAGES.indexOf(stageId);
      if (!readStatus || !readReceipts) throw fail('RECEIPT_UNAVAILABLE', 'no trusted setup receipt provider is configured; stop and reconcile');
      if (!hex32(operationId) || !digest(reviewSha256) || index < 0 || !digest(actionCommitmentSha256) || !isTransactionHash(originalHash)) {
        throw new Error('original setup operation, reviewed action and original hash are required');
      }
      await authorize(context('reconcile_setup_stage', owner, ownerPublicKey, { operation_id: operationId,
        review_sha256: reviewSha256, stage_id: stageId, action_commitment_sha256: actionCommitmentSha256, original_hash: originalHash }), evidence);
      const retained = await transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 });
        const stage = progress.stages[index];
        assertStageIdentity(prompt, stage, stageId, actionCommitmentSha256);
        if (!stage.claimed || stage.original_hash !== originalHash) throw fail('MISMATCH', 'retained setup original differs; stop and reconcile');
        return prompt;
      });
      try {
        if ((await readStatus())?.chain_id !== 'testnet') throw new Error('not testnet');
        const attempt = prepareBufferWalletSetupAttempt({ review: retained.review, snapshot: retained.setup_snapshot,
          wasmBytes: pinnedSetupWasm, trustedReviewHash: reviewSha256, trustedOwnerPublicKey: ownerPublicKey,
          stageId, trustedOriginalHash: originalHash });
        const result = structuredClone(await readReceipts(originalHash, owner, 'FINAL'));
        const proof = inspectBufferWalletSetupAttempt({ review: retained.review, snapshot: retained.setup_snapshot,
          wasmBytes: pinnedSetupWasm, trustedReviewHash: reviewSha256, trustedOwnerPublicKey: ownerPublicKey,
          trustedOriginalHash: originalHash, attempt, result });
        return { ...proof, owner, operation_id: operationId, review_sha256: reviewSha256,
          action_commitment_sha256: actionCommitmentSha256, execution_authorized: false, later_stage_unlocked: false,
          independently_durable: false, provider_trusted_not_consensus_proof: true };
      } catch {
        throw fail('RECEIPT_UNKNOWN', 'original setup receipt is unavailable, incomplete or mismatched; preserve it and never resend');
      }
    },

    /** After all three originals, verify fresh funded state. This does not
     * unlock policy configuration, a wallet prompt or spending. */
    async verifySetupFunded({ owner, ownerPublicKey, operationId, reviewSha256, evidence } = {}) {
      requiredOwner(owner, ownerPublicKey);
      if (!hex32(operationId) || !digest(reviewSha256)) throw new Error('original setup operation and review required');
      requireSetupProviders();
      await authorize(context('verify_setup_funded', owner, ownerPublicKey, { operation_id: operationId, review_sha256: reviewSha256 }), evidence);
      const retained = await transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 });
        return { prompt, hashes: assertPriorSetupProgress(prompt, progress, 2) };
      });
      const preflight = await setupPreflight(retained.prompt, retained.hashes, 'verify_funded_vault');
      assertSetupProfile(preflight, retained.prompt, 'verify_funded_vault', 3);
      assertFreshSetupPreflight(preflight);
      await transaction(pool, async client => {
        const { prompt, progress } = await loadSetup(client, { owner, ownerPublicKey, operationId, reviewSha256 }, true);
        if (!sameHashes(retained.hashes, assertPriorSetupProgress(prompt, progress, 2))) {
          throw fail('MISMATCH', 'setup originals changed; stop and reconcile');
        }
        assertFreshSetupPreflight(preflight);
      });
      assertFreshSetupPreflight(preflight);
      return { ...preflight, owner, operation_id: operationId, execution_authorized: false,
        spending_unlocked: false, independently_durable: false, provider_trusted_not_consensus_proof: true };
    },
  });
}
