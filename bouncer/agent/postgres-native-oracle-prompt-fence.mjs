/**
 * EXPERIMENTAL native-oracle write-ahead wallet-prompt fence. Four-stage is
 * the default; the reviewed two-stage atomic variant requires explicit opt-in.
 * It does not invoke a wallet, sign, submit, unlock a policy or pay a provider.
 *
 * Each named testnet owner can reserve ONE canonical review in this schema.
 * All single-use stage rows are created in the same DB transaction.
 * A claim requires injected replay-resistant owner authentication, trusted-RPC
 * receipt checks for every preceding original, and a fresh same-block native
 * preflight. A claim commits before it can be returned. Unknown acknowledgments,
 * missing wallet responses or failed transactions NEVER permit another claim.
 *
 * A PostgreSQL primary is not an independent rollback witness; a privileged
 * DB owner can alter/delete data, disable guards, restore snapshots or fork a
 * second primary. The caller must also require the separate native Git CAS
 * witness, independently retain its latest head, and implement authenticated
 * owner sessions, recovery, real-phone tests and explicit owner approval before
 * any live prompt. These APIs alone are not authority to spend.
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { NATIVE_ORACLE_V9_BYTES, NATIVE_ORACLE_V9_SHA256 } from './native-oracle-wallet-plan.mjs';
import { verifyNativeOracleWalletReview, prepareNativeOracleWalletAttempt } from './native-oracle-wallet-evidence.mjs';
import { verifyAtomicNativeOracleWalletReview, prepareAtomicNativeOracleWalletAttempt } from './native-oracle-atomic-wallet.mjs';
import { inspectNativeOracleWalletStage, inspectNativeOracleWalletCompletion,
  inspectAtomicNativeOracleWalletStage, inspectAtomicNativeOracleWalletCompletion } from './native-oracle-wallet-preflight.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { WalletOwnerFenceError, initializePostgresWalletOwnerFence, reservePostgresWalletOwnerFence,
  assertPostgresWalletOwnerFence, verifyPostgresWalletOwnerFence } from './postgres-wallet-owner-fence.mjs';

const SCHEMA = 'bouncer_native_wallet_prompt_v1';
const STAGES = Object.freeze(['create_keyless_native_vault', 'configure_native_oracle_policy', 'fund_native_vault', 'install_native_oracle_agent']);
const ATOMIC_STAGES = Object.freeze(['create_configure_fund_native_vault', 'install_native_oracle_agent']);
// The atomic branch is intentionally opt-in and is not enabled by the live
// service. Both plans use the same owner hold and immutable witness namespace.
function reviewOps(review, enableAtomic) {
  if (review?.format === 'bouncer-native-oracle-wallet-review-v1') return { stages: STAGES,
    verify: verifyNativeOracleWalletReview, prepare: prepareNativeOracleWalletAttempt,
    inspectStage: inspectNativeOracleWalletStage, inspectCompletion: inspectNativeOracleWalletCompletion,
    completionStatus: 'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED' };
  if (enableAtomic === true && review?.format === 'bouncer-atomic-native-oracle-wallet-review-v1') return { stages: ATOMIC_STAGES,
    verify: verifyAtomicNativeOracleWalletReview, prepare: prepareAtomicNativeOracleWalletAttempt,
    inspectStage: inspectAtomicNativeOracleWalletStage, inspectCompletion: inspectAtomicNativeOracleWalletCompletion,
    completionStatus: 'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED' };
  throw fail('INVALID_REQUEST');
}
const PRE_METHODS = ['viewNodeStatus', 'viewBlock', 'query', 'viewTestnetAccountPresenceAt', 'callFunctionRaw', 'experimental_protocolConfig', 'gasPrice'];
const PLAN_GUARD = `
BEGIN
  RAISE EXCEPTION 'native wallet prompt review is immutable';
END;
`;
const STAGE_GUARD = `
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'native wallet prompt stages cannot be deleted'; END IF;
  IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
     NEW.stage_index IS DISTINCT FROM OLD.stage_index OR NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
     NEW.action_commitment_sha256 IS DISTINCT FROM OLD.action_commitment_sha256 OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'native wallet prompt identity is immutable';
  END IF;
  IF NOT OLD.claimed AND NEW.claimed AND OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL AND
     OLD.original_hash IS NULL AND NEW.original_hash IS NULL THEN RETURN NEW; END IF;
  IF OLD.claimed AND NEW.claimed AND OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS NOT DISTINCT FROM OLD.claimed_at AND
     OLD.original_hash IS NULL AND NEW.original_hash IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'native wallet prompt claims and first original hashes are immutable';
END;
`;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hex32 = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const hex64 = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const validDate = x => x instanceof Date && Number.isFinite(x.getTime());
export class NativePromptFenceError extends Error {
  constructor(code) { super('native wallet prompt is unavailable, conflicting or uncertain; stop and reconcile, never repeat a claimed prompt'); this.name = 'NativePromptFenceError'; this.code = code; }
}
const fail = code => new NativePromptFenceError(code);

async function transaction(pool, work) {
  let client, begun = false, destroy = false;
  try {
    client = await pool.connect(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query("SET LOCAL synchronous_commit = 'on'"); await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'"); await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const health = await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica, pg_catalog.current_setting('fsync') AS fsync,
      pg_catalog.current_setting('transaction_read_only') AS read_only, pg_catalog.current_setting('synchronous_commit') AS synchronous_commit`);
    const h = health.rows[0];
    if (!h || h.replica !== false || h.fsync !== 'on' || h.read_only !== 'off' || h.synchronous_commit !== 'on') throw fail('UNSAFE_DATABASE');
    const result = await work(client); await client.query('COMMIT'); begun = false; return result;
  } catch (error) {
    destroy = true; if (client && begun) { try { await client.query('ROLLBACK'); } catch { /* poisoned/unknown connection */ } }
    if (error instanceof NativePromptFenceError) throw error;
    if (error instanceof WalletOwnerFenceError) throw fail(error.code === 'GLOBAL_OWNER_FENCED' ? 'OWNER_FENCED' : error.code);
    throw fail('DATABASE_UNKNOWN');
  } finally { client?.release(destroy); }
}
async function verifySchema(client) {
  const meta = await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton=true`);
  if (meta.rows.length !== 1 || meta.rows[0].version !== 1) throw fail('UNSAFE_SCHEMA');
  for (const [table, expected] of [
    ['meta', ['singleton:boolean:true','version:integer:true']],
    ['plans', ['owner:text:true','operation_id:text:true','owner_public_key:text:true','review_sha256:text:true','review:jsonb:true','created_at:timestamp with time zone:true']],
    ['stages', ['owner:text:true','operation_id:text:true','stage_index:smallint:true','stage_id:text:true','action_commitment_sha256:text:true',
      'claimed:boolean:true','claimed_at:timestamp with time zone:false','original_hash:text:false','created_at:timestamp with time zone:true']],
  ]) {
    const relation = await client.query(`SELECT t.relpersistence,t.relrowsecurity,t.relforcerowsecurity
      FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname=$2 AND t.relkind='r'`, [SCHEMA, table]);
    const r = relation.rows[0];
    if (relation.rows.length !== 1 || r.relpersistence !== 'p' || r.relrowsecurity || r.relforcerowsecurity) throw fail('UNSAFE_SCHEMA');
    const cols = await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [SCHEMA, table]);
    if (!isDeepStrictEqual(cols.rows.map(c => `${c.attname}:${c.type}:${c.attnotnull}`), expected)) throw fail('UNSAFE_SCHEMA');
    const trigger = await client.query(`SELECT g.tgname,g.tgenabled,g.tgtype::integer AS kind,g.tgisinternal,
      p.prosrc,p.pronargs,p.prosecdef,p.provolatile,p.proconfig,l.lanname,pn.nspname AS function_schema
      FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND t.relname=$2 AND NOT g.tgisinternal`, [SCHEMA, table]);
    if (table === 'meta') { if (trigger.rows.length !== 0) throw fail('UNSAFE_SCHEMA'); continue; }
    const g = trigger.rows[0], name = table === 'plans' ? 'plan_immutable' : 'stage_immutable', source = table === 'plans' ? PLAN_GUARD : STAGE_GUARD;
    if (trigger.rows.length !== 1 || g.tgname !== name || !['O','A'].includes(g.tgenabled) || g.kind !== 27 || g.tgisinternal ||
        g.prosrc !== source || g.pronargs !== 0 || g.prosecdef || g.provolatile !== 'v' || g.lanname !== 'plpgsql' ||
        g.function_schema !== SCHEMA || !Array.isArray(g.proconfig) || g.proconfig.length !== 1 || g.proconfig[0] !== 'search_path=pg_catalog') {
      throw fail('UNSAFE_SCHEMA');
    }
  }
  const indexes = await client.query(`SELECT t.relname AS table_name,array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality) ON k.ordinality<=i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE n.nspname=$1 AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY i.indexrelid,t.relname`, [SCHEMA]);
  const keys = new Set(indexes.rows.map(r => `${r.table_name}:${r.columns.join(',')}`));
  if (!['meta:singleton','plans:owner','plans:operation_id','stages:owner,stage_index','stages:operation_id,stage_index','stages:owner,stage_id']
      .every(k => keys.has(k))) throw fail('UNSAFE_SCHEMA');
}

/** Check existing native and shared-owner fences without creating, repairing,
 * reserving or releasing anything. This is not rollback or consent proof. */
export async function inspectPostgresNativeOraclePromptFenceSchema({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw fail('UNSAFE_DATABASE');
  return transaction(pool, async client => {
    await verifySchema(client);
    await verifyPostgresWalletOwnerFence(client);
    return { status: 'SCHEMA_CHECKED', prompt_authorized: false };
  });
}

/** Privileged setup ONLY for a dedicated disposable/testnet database. Existing
 * schema is checked, never silently repaired or upgraded. */
export async function initializePostgresNativeOraclePromptFence({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw fail('UNSAFE_DATABASE');
  return transaction(pool, async client => {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bouncer-native-wallet-prompt-v1'))");
    await initializePostgresWalletOwnerFence(client);
    const found = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1', [SCHEMA]);
    if (found.rows.length === 0) await client.query(`
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.meta (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL);
      INSERT INTO ${SCHEMA}.meta(singleton,version) VALUES(true,1);
      CREATE TABLE ${SCHEMA}.plans (
        owner text PRIMARY KEY, operation_id text NOT NULL UNIQUE, owner_public_key text NOT NULL,
        review_sha256 text NOT NULL, review jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
        CHECK(octet_length(review::text)<=131072)
      );
      CREATE TABLE ${SCHEMA}.stages (
        owner text NOT NULL REFERENCES ${SCHEMA}.plans(owner), operation_id text NOT NULL REFERENCES ${SCHEMA}.plans(operation_id),
        stage_index smallint NOT NULL CHECK(stage_index BETWEEN 0 AND 3), stage_id text NOT NULL, action_commitment_sha256 text NOT NULL,
        claimed boolean NOT NULL DEFAULT false, claimed_at timestamptz, original_hash text,
        created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
        PRIMARY KEY(owner,stage_index), UNIQUE(operation_id,stage_index), UNIQUE(owner,stage_id),
        CHECK((NOT claimed AND claimed_at IS NULL AND original_hash IS NULL) OR (claimed AND claimed_at IS NOT NULL))
      );
      CREATE FUNCTION ${SCHEMA}.guard_plan() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$${PLAN_GUARD}$guard$;
      CREATE TRIGGER plan_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.plans FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_plan();
      CREATE FUNCTION ${SCHEMA}.guard_stage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$${STAGE_GUARD}$guard$;
      CREATE TRIGGER stage_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.stages FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_stage();`);
    await verifySchema(client); return { initialized: true, network: 'testnet', execution_authorized: false };
  });
}

const PLAN_COLUMNS = 'owner,operation_id,owner_public_key,review_sha256,review,created_at';
const STAGE_COLUMNS = 'owner,operation_id,stage_index,stage_id,action_commitment_sha256,claimed,claimed_at,original_hash,created_at';
function validated(plan, stages, wasm, enableAtomic) {
  try {
    const ops = reviewOps(plan?.review, enableAtomic);
    if (!plain(plan) || !isTestnetAccount(plan.owner) || !hex32(plan.operation_id) || !hex64(plan.review_sha256) || !validDate(plan.created_at) ||
        !Array.isArray(stages) || stages.length !== ops.stages.length) throw Error();
    const identity = ops.verify({ review: plan.review, wasmBytes: wasm,
      trustedReviewHash: plan.review_sha256, trustedOwnerPublicKey: plan.owner_public_key });
    if (identity.owner !== plan.owner) throw Error();
    let gap = false; const hashes = new Set();
    stages.forEach((row, i) => {
      if (!plain(row) || row.owner !== plan.owner || row.operation_id !== plan.operation_id || row.stage_index !== i ||
          row.stage_id !== ops.stages[i] || row.action_commitment_sha256 !== plan.review.stages[i].action_commitment_sha256 ||
          typeof row.claimed !== 'boolean' || !validDate(row.created_at) ||
          (!row.claimed && (row.claimed_at !== null || row.original_hash !== null)) ||
          (row.claimed && (!validDate(row.claimed_at) || (row.original_hash !== null && !isTransactionHash(row.original_hash)))) ||
          (gap && row.claimed) || (row.original_hash !== null && hashes.has(row.original_hash))) throw Error();
      if (row.original_hash !== null) hashes.add(row.original_hash);
      if (!row.claimed || row.original_hash === null) gap = true;
    });
    return { ...plan, stages };
  } catch { throw fail('CORRUPT'); }
}
function publicPlan(row) {
  return { owner: row.owner, owner_public_key: row.owner_public_key, operation_id: row.operation_id,
    review_sha256: row.review_sha256, review: structuredClone(row.review), created_at: row.created_at.toISOString(),
    stages: row.stages.map(s => ({ stage_id: s.stage_id, action_commitment_sha256: s.action_commitment_sha256,
      claimed: s.claimed, original_hash: s.original_hash, claimed_at: s.claimed_at?.toISOString() ?? null })),
    execution_authorized: false, wallet_invocation_verified: false, independently_durable: false };
}
function requireIdentity(value) {
  if (!plain(value) || !isTestnetAccount(value.owner) || typeof value.ownerPublicKey !== 'string' ||
      !hex32(value.operationId) || !hex64(value.reviewSha256) || ![...STAGES, ...ATOMIC_STAGES].includes(value.stageId) || !hex64(value.actionCommitmentSha256)) {
    throw fail('INVALID_REQUEST');
  }
}

/** `authenticate({action,evidence})` is a mandatory trust boundary and must
 * verify a fresh single-use owner challenge for the exact action. Providers,
 * pinned artifact and clock are server configuration, never browser input. */
export function createPostgresNativeOraclePromptFence({ pool, authenticate, wasmBytes, receiptProvider, preflightProvider,
  now = Date.now, enableAtomic = false } = {}) {
  if (typeof enableAtomic !== 'boolean' || !pool || typeof pool.connect !== 'function' || typeof authenticate !== 'function' || typeof now !== 'function' ||
      !(wasmBytes instanceof Uint8Array) || wasmBytes.length !== NATIVE_ORACLE_V9_BYTES ||
      crypto.createHash('sha256').update(wasmBytes).digest('hex') !== NATIVE_ORACLE_V9_SHA256 ||
      !receiptProvider || ['viewNodeStatus','txStatusReceipts'].some(m => typeof receiptProvider[m] !== 'function') ||
      !preflightProvider || PRE_METHODS.some(m => typeof preflightProvider[m] !== 'function')) throw fail('UNSAFE_CONFIGURATION');
  const wasm = Buffer.from(wasmBytes), readStatus = receiptProvider.viewNodeStatus.bind(receiptProvider),
    readReceipts = receiptProvider.txStatusReceipts.bind(receiptProvider);
  const provider = Object.freeze(Object.fromEntries(PRE_METHODS.map(m => [m, preflightProvider[m].bind(preflightProvider)])));
  const action = (purpose, owner, publicKey, extra = {}) => Object.freeze({ format: 'bouncer-wallet-prompt-auth-v1', network: 'testnet',
    purpose, owner, owner_public_key: publicKey, ...extra });
  async function authorize(context, evidence) {
    try { if (await authenticate({ action: context, evidence }) === true) return; } catch { /* fail closed */ }
    throw fail('UNAUTHENTICATED');
  }
  async function load(client, owner, lock = false) {
    await verifySchema(client);
    const p = await client.query(`SELECT ${PLAN_COLUMNS} FROM ${SCHEMA}.plans WHERE owner=$1${lock ? ' FOR UPDATE' : ''}`, [owner]);
    if (p.rows.length !== 1) throw fail('OWNER_FENCED');
    const s = await client.query(`SELECT ${STAGE_COLUMNS} FROM ${SCHEMA}.stages WHERE owner=$1 ORDER BY stage_index${lock ? ' FOR UPDATE' : ''}`, [owner]);
    return validated(p.rows[0], s.rows, wasm, enableAtomic);
  }
  function target(row, request, alreadyClaimed = false) {
    const index = row.stages.findIndex(stage => stage.stage_id === request.stageId), stage = row.stages[index];
    if (row.owner_public_key !== request.ownerPublicKey || row.operation_id !== request.operationId || row.review_sha256 !== request.reviewSha256 ||
        !stage || stage.action_commitment_sha256 !== request.actionCommitmentSha256) throw fail('MISMATCH');
    if (alreadyClaimed ? !stage.claimed || stage.original_hash !== null : stage.claimed) {
      throw fail(alreadyClaimed ? 'CLAIM_NO_LONGER_RECHECKABLE' : 'ALREADY_CLAIMED');
    }
    const prior = row.stages.slice(0, index);
    if (prior.some(s => !s.claimed || !s.original_hash)) throw fail('PRIOR_UNRESOLVED');
    return { index, hashes: prior.map(s => s.original_hash) };
  }
  const checkFresh = preflight => {
    const checked = Date.parse(preflight?.observed_at), clock = now();
    if (!Number.isSafeInteger(clock) || !Number.isSafeInteger(checked) || clock < checked || clock - checked > 5000) throw fail('PREFLIGHT_STALE');
  };
  // Independently re-fetch every earlier original and a single FINAL state.
  // This helper never claims a stage, signs or submits a transaction.
  async function stagePreflight(retained, request) {
    const { owner, ownerPublicKey, reviewSha256, stageId, actionCommitmentSha256 } = request;
    let preflight;
    try {
      if ((await readStatus())?.chain_id !== 'testnet') throw Error();
      const prior = [], ops = reviewOps(retained.row.review, enableAtomic);
      for (let i = 0; i < retained.target.hashes.length; i++) {
        const trustedOriginalHash = retained.target.hashes[i];
        const attempt = ops.prepare({ review: retained.row.review, wasmBytes: wasm, trustedReviewHash: reviewSha256,
          trustedOwnerPublicKey: ownerPublicKey, stageId: ops.stages[i], trustedOriginalHash });
        const result = structuredClone(await readReceipts(trustedOriginalHash, owner, 'FINAL'));
        prior.push({ attempt, trustedOriginalHash, result });
      }
      preflight = await ops.inspectStage({ review: retained.row.review, wasmBytes: wasm, trustedReviewHash: reviewSha256,
        trustedOwnerPublicKey: ownerPublicKey, stageId, prior, provider, now });
    } catch { throw fail('PREFLIGHT_UNAVAILABLE'); }
    if (preflight.status !== 'STATE_CHECKS_PASSED_NOT_AUTHORIZED' || preflight.owner !== owner || preflight.review_sha256 !== reviewSha256 ||
        preflight.stage_id !== stageId || preflight.action_commitment_sha256 !== actionCommitmentSha256 ||
        !isDeepStrictEqual(preflight.prior_original_hashes, retained.target.hashes) || !Array.isArray(preflight.blockers) || preflight.blockers.length) {
      throw fail('PREFLIGHT_BLOCKED');
    }
    checkFresh(preflight);
    return preflight;
  }
  return Object.freeze({
    async reserve({ review: rawReview, trustedReviewHash, trustedOwnerPublicKey, evidence } = {}) {
      const review = structuredClone(rawReview); let id, ops;
      try { ops = reviewOps(review, enableAtomic); id = ops.verify({ review, wasmBytes: wasm, trustedReviewHash, trustedOwnerPublicKey });
        if (!id.owner_public_key.startsWith('ed25519:')) throw Error(); }
      catch { throw fail('INVALID_REQUEST'); }
      await authorize(action('reserve_native_setup', id.owner, id.owner_public_key, { review_sha256: trustedReviewHash,
        stage_id: ops.stages[0], action_commitment_sha256: review.stages[0].action_commitment_sha256 }), evidence);
      const operation = crypto.randomBytes(16).toString('hex');
      return transaction(pool, async client => {
        await verifySchema(client);
        await reservePostgresWalletOwnerFence(client, { owner: id.owner, flow: 'native_oracle', operationId: operation,
          ownerPublicKey: id.owner_public_key, reviewSha256: trustedReviewHash });
        const inserted = await client.query(`INSERT INTO ${SCHEMA}.plans(owner,operation_id,owner_public_key,review_sha256,review)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING owner`,
        [id.owner, operation, id.owner_public_key, trustedReviewHash, JSON.stringify(review)]);
        if (inserted.rows.length !== 1) throw fail('OWNER_FENCED');
        for (let i = 0; i < ops.stages.length; i++) {
          await client.query(`INSERT INTO ${SCHEMA}.stages(owner,operation_id,stage_index,stage_id,action_commitment_sha256)
            VALUES($1,$2,$3,$4,$5)`, [id.owner, operation, i, ops.stages[i], review.stages[i].action_commitment_sha256]);
        }
        const row = await load(client, id.owner);
        return { ...publicPlan(row), status: 'RESERVED_NOT_CLAIMED' };
      });
    },
    async inspect({ owner, ownerPublicKey, evidence } = {}) {
      if (!isTestnetAccount(owner) || typeof ownerPublicKey !== 'string') throw fail('INVALID_REQUEST');
      await authorize(action('inspect_native_setup', owner, ownerPublicKey), evidence);
      return transaction(pool, async client => {
        const row = await load(client, owner);
        if (row.owner_public_key !== ownerPublicKey) throw fail('MISMATCH');
        return publicPlan(row);
      });
    },
    async claim(request = {}) {
      requireIdentity(request);
      const { owner, ownerPublicKey, operationId, reviewSha256, stageId, actionCommitmentSha256, evidence } = request;
      await authorize(action('claim_native_setup_stage', owner, ownerPublicKey, { operation_id: operationId, review_sha256: reviewSha256,
        stage_id: stageId, action_commitment_sha256: actionCommitmentSha256 }), evidence);
      const globalIdentity = { owner, flow: 'native_oracle', operationId, ownerPublicKey, reviewSha256 };
      const retained = await transaction(pool, async client => { const row = await load(client, owner);
        await assertPostgresWalletOwnerFence(client, globalIdentity); return { row, target: target(row, request) }; });
      const preflight = await stagePreflight(retained, request);
      const claimed = await transaction(pool, async client => {
        const row = await load(client, owner, true), current = target(row, request);
        await assertPostgresWalletOwnerFence(client, globalIdentity);
        if (!isDeepStrictEqual(current.hashes, retained.target.hashes)) throw fail('MISMATCH');
        checkFresh(preflight);
        const updated = await client.query(`UPDATE ${SCHEMA}.stages SET claimed=true,claimed_at=pg_catalog.clock_timestamp()
          WHERE owner=$1 AND operation_id=$2 AND stage_index=$3 AND claimed=false AND original_hash IS NULL RETURNING ${STAGE_COLUMNS}`,
        [owner, operationId, current.index]);
        if (updated.rows.length !== 1 || updated.rows[0].claimed !== true) throw fail('MISMATCH');
        return { owner, operation_id: operationId, review_sha256: reviewSha256, stage_id: stageId,
          action_commitment_sha256: actionCommitmentSha256, status: 'PROMPT_CLAIMED_NO_HASH', claimed_at: updated.rows[0].claimed_at.toISOString(),
          preflight_block_hash: preflight.block_hash, preflight_checked_at: preflight.observed_at,
          do_not_retry: true, execution_authorized: false, wallet_invocation_verified: false, independently_durable: false };
      });
      try { checkFresh(preflight); } catch { throw fail('CLAIM_COMMITTED_PREFLIGHT_STALE'); }
      return claimed;
    },
    /** Coordinator-only read. After the existing one-shot DB and Git claims
     * have committed, independently recheck the same stage, its prior originals
     * and the owner hold. This does not create or reissue a claim and has no
     * HTTP route. If it fails, the claimed stage remains consumed. */
    async recheckClaimBeforePrompt(request = {}) {
      requireIdentity(request);
      const { owner, ownerPublicKey, operationId, reviewSha256, stageId, actionCommitmentSha256 } = request;
      const globalIdentity = { owner, flow:'native_oracle', operationId, ownerPublicKey, reviewSha256 };
      const retained = await transaction(pool, async client => {
        const row = await load(client, owner);
        await assertPostgresWalletOwnerFence(client, globalIdentity);
        return { row, target:target(row, request, true) };
      });
      const preflight = await stagePreflight(retained, request);
      await transaction(pool, async client => {
        const row = await load(client, owner), current = target(row, request, true);
        await assertPostgresWalletOwnerFence(client, globalIdentity);
        if (!isDeepStrictEqual(current.hashes, retained.target.hashes)) throw fail('MISMATCH');
        checkFresh(preflight);
      });
      checkFresh(preflight);
      return { owner, operation_id:operationId, review_sha256:reviewSha256, stage_id:stageId,
        action_commitment_sha256:actionCommitmentSha256, status:'CLAIM_PREFLIGHT_RECHECKED_NOT_AUTHORIZED',
        preflight_block_hash:preflight.block_hash, preflight_checked_at:preflight.observed_at,
        do_not_retry:true, execution_authorized:false };
    },
    /** Read-only verification of ALL retained originals and installed
     * state. This never authorizes or sends a provider request. */
    async verifyCompletion({ owner, ownerPublicKey, operationId, reviewSha256, evidence } = {}) {
      if (!isTestnetAccount(owner) || typeof ownerPublicKey !== 'string' || !hex32(operationId) || !hex64(reviewSha256)) throw fail('INVALID_REQUEST');
      await authorize(action('verify_native_setup_completion', owner, ownerPublicKey, { operation_id: operationId, review_sha256: reviewSha256 }), evidence);
      const completeHashes = row => {
        if (row.owner_public_key !== ownerPublicKey || row.operation_id !== operationId || row.review_sha256 !== reviewSha256) throw fail('MISMATCH');
        if (row.stages.some(stage => !stage.claimed || !stage.original_hash)) throw fail('PRIOR_UNRESOLVED');
        return row.stages.map(stage => stage.original_hash);
      };
      const retained = await transaction(pool, async client => { const row = await load(client, owner); return { row, hashes: completeHashes(row) }; });
      let result;
      try {
        if ((await readStatus())?.chain_id !== 'testnet') throw Error();
        const prior = [], ops = reviewOps(retained.row.review, enableAtomic);
        for (let i = 0; i < ops.stages.length; i++) {
          const trustedOriginalHash = retained.hashes[i];
          const attempt = ops.prepare({ review: retained.row.review, wasmBytes: wasm, trustedReviewHash: reviewSha256,
            trustedOwnerPublicKey: ownerPublicKey, stageId: ops.stages[i], trustedOriginalHash });
          const chainResult = structuredClone(await readReceipts(trustedOriginalHash, owner, 'FINAL'));
          prior.push({ attempt, trustedOriginalHash, result: chainResult });
        }
        result = await ops.inspectCompletion({ review: retained.row.review, wasmBytes: wasm, trustedReviewHash: reviewSha256,
          trustedOwnerPublicKey: ownerPublicKey, prior, provider, now });
      } catch { throw fail('PREFLIGHT_UNAVAILABLE'); }
      const currentHashes = await transaction(pool, async client => completeHashes(await load(client, owner)));
      if (!isDeepStrictEqual(currentHashes, retained.hashes) || !isDeepStrictEqual(result?.prior_original_hashes, retained.hashes) ||
          result.owner !== owner || result.review_sha256 !== reviewSha256 ||
          !['BLOCKED_OR_UNKNOWN', reviewOps(retained.row.review, enableAtomic).completionStatus].includes(result.status)) {
        throw fail('MISMATCH');
      }
      return { ...result, execution_authorized: false, independently_witnessed: false };
    },
    async recordOriginal(request = {}) {
      requireIdentity(request);
      const { owner, ownerPublicKey, operationId, reviewSha256, stageId, actionCommitmentSha256, originalHash, evidence } = request;
      if (!isTransactionHash(originalHash)) throw fail('INVALID_REQUEST');
      await authorize(action('record_native_setup_original', owner, ownerPublicKey, { operation_id: operationId, review_sha256: reviewSha256,
        stage_id: stageId, action_commitment_sha256: actionCommitmentSha256, original_hash: originalHash }), evidence);
      return transaction(pool, async client => {
        const row = await load(client, owner, true), index = row.stages.findIndex(stage => stage.stage_id === stageId), stage = row.stages[index];
        if (row.owner_public_key !== ownerPublicKey || row.operation_id !== operationId || row.review_sha256 !== reviewSha256 ||
            !stage || stage.action_commitment_sha256 !== actionCommitmentSha256 || !stage.claimed) throw fail('MISMATCH');
        if (stage.original_hash !== null) {
          if (stage.original_hash !== originalHash) throw fail('MISMATCH');
        } else {
          if (row.stages.some(s => s.original_hash === originalHash)) throw fail('MISMATCH');
          const updated = await client.query(`UPDATE ${SCHEMA}.stages SET original_hash=$1
            WHERE owner=$2 AND operation_id=$3 AND stage_index=$4 AND claimed=true AND original_hash IS NULL RETURNING original_hash`,
          [originalHash, owner, operationId, index]);
          if (updated.rows.length !== 1 || updated.rows[0].original_hash !== originalHash) throw fail('MISMATCH');
        }
        return { owner, operation_id: operationId, stage_id: stageId, original_hash: originalHash,
          status: 'ORIGINAL_RECORDED', do_not_retry: true, execution_authorized: false, current_state_verified: false };
      });
    },
  });
}
