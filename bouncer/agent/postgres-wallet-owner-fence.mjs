/**
 * Experimental shared, append-only per-owner prompt exclusion. Native and FT
 * setup reservations must INSERT this row in the SAME PostgreSQL transaction
 * as their own durable reservation. A unique owner key makes concurrent
 * cooperating flows conflict, even when they use different tables/processes.
 *
 * V1 deliberately has NO release operation. This is conservative: a completed
 * native setup still blocks an FT setup for the same owner until a separately
 * designed, authenticated and independently witnessed release exists. It is
 * not a general multi-resource scheduler and must not be enabled as a finished
 * live experience. Legacy reservations are never backfilled: their prompt may
 * already have been opened. Existing originals must remain recoverable.
 *
 * This database is not an independent rollback anchor. Privileged operators,
 * noncooperating old clients, a second database, DB restore/fork, witness
 * rollback, compromised hosts or a user's other wallets can bypass this lock.
 */
import { isDeepStrictEqual } from 'node:util';
import { isTestnetAccount } from '../shared/account-id.mjs';

const SCHEMA = 'bouncer_wallet_owner_fence_v1';
const FLOWS = ['native_oracle', 'buffer_wallet'];
const GUARD = `
BEGIN
  RAISE EXCEPTION 'global wallet owner fence is immutable';
END;
`;
export class WalletOwnerFenceError extends Error {
  constructor(code) {
    super('global owner prompt fence is unavailable, conflicting or uncertain; stop and reconcile, never repeat a prompt');
    this.name = 'WalletOwnerFenceError'; this.code = code;
  }
}
const fail = code => new WalletOwnerFenceError(code);
const hex32 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validate(identity) {
  if (!identity || !isTestnetAccount(identity.owner) || !FLOWS.includes(identity.flow) ||
      !hex32(identity.operationId) || !hex64(identity.reviewSha256) || typeof identity.ownerPublicKey !== 'string' ||
      identity.ownerPublicKey.length < 20 || identity.ownerPublicKey.length > 150) throw fail('GLOBAL_FENCE_INVALID');
}

/** Verify rather than repair existing definitions. A privileged database role
 * can still change them; this is an accidental-misconfiguration guard. */
export async function verifyPostgresWalletOwnerFence(client) {
  if (!client || typeof client.query !== 'function') throw fail('GLOBAL_FENCE_UNAVAILABLE');
  const meta = await client.query(`SELECT version FROM ${SCHEMA}.meta WHERE singleton=true`);
  if (meta.rows.length !== 1 || meta.rows[0].version !== 1) throw fail('GLOBAL_FENCE_UNSAFE');
  for (const [table, expected] of [
    ['meta', ['singleton:boolean:true', 'version:integer:true']],
    ['holders', ['owner:text:true', 'flow:text:true', 'operation_id:text:true', 'owner_public_key:text:true',
      'review_sha256:text:true', 'created_at:timestamp with time zone:true']],
  ]) {
    const rel = await client.query(`SELECT t.relpersistence,t.relrowsecurity,t.relforcerowsecurity
      FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=$1 AND t.relname=$2 AND t.relkind='r'`, [SCHEMA, table]);
    const r = rel.rows[0];
    if (rel.rows.length !== 1 || r.relpersistence !== 'p' || r.relrowsecurity || r.relforcerowsecurity) throw fail('GLOBAL_FENCE_UNSAFE');
    const cols = await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2
      AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [SCHEMA, table]);
    if (!isDeepStrictEqual(cols.rows.map(c => `${c.attname}:${c.type}:${c.attnotnull}`), expected)) throw fail('GLOBAL_FENCE_UNSAFE');
    const triggers = await client.query(`SELECT g.tgname,g.tgenabled,g.tgtype::integer AS kind,g.tgisinternal,
      p.prosrc,p.pronargs,p.prosecdef,p.provolatile,p.proconfig,l.lanname,pn.nspname AS function_schema
      FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class t ON t.oid=g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND t.relname=$2 AND NOT g.tgisinternal`, [SCHEMA, table]);
    if (table === 'meta') { if (triggers.rows.length !== 0) throw fail('GLOBAL_FENCE_UNSAFE'); continue; }
    const g = triggers.rows[0];
    if (triggers.rows.length !== 1 || g.tgname !== 'holder_immutable' || !['O','A'].includes(g.tgenabled) ||
        g.kind !== 27 || g.tgisinternal || g.prosrc !== GUARD || g.pronargs !== 0 || g.prosecdef || g.provolatile !== 'v' ||
        g.lanname !== 'plpgsql' || g.function_schema !== SCHEMA || !Array.isArray(g.proconfig) ||
        g.proconfig.length !== 1 || g.proconfig[0] !== 'search_path=pg_catalog') throw fail('GLOBAL_FENCE_UNSAFE');
  }
  const unique = await client.query(`SELECT t.relname AS table_name,array_agg(a.attname::text ORDER BY k.ordinality) AS columns
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality) ON k.ordinality<=i.indnkeyatts
    JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
    WHERE n.nspname=$1 AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    GROUP BY i.indexrelid,t.relname`, [SCHEMA]);
  const keys = new Set(unique.rows.map(r => `${r.table_name}:${r.columns.join(',')}`));
  if (!['meta:singleton', 'holders:owner', 'holders:operation_id'].every(k => keys.has(k))) throw fail('GLOBAL_FENCE_UNSAFE');
}

async function legacyTables(client, owner) {
  // Do not infer safety from an absent V1 holder when a pre-upgrade flow has a
  // reservation. These exact table names are fixed server code, not input.
  const known = [
    ['bouncer_wallet_prompt_v1.prompts', 'owner_account_id'],
    ['bouncer_native_wallet_prompt_v1.plans', 'owner'],
  ];
  for (const [table, column] of known) {
    const found = await client.query('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present', [table]);
    if (found.rows.length !== 1 || typeof found.rows[0].present !== 'boolean') throw fail('GLOBAL_FENCE_UNSAFE');
    if (found.rows[0].present) {
      const values = owner === undefined ? [] : [owner];
      const rows = await client.query(`SELECT 1 FROM ${table}${owner === undefined ? '' : ` WHERE ${column}=$1`} LIMIT 1`, values);
      if (rows.rows.length) return true;
    }
  }
  return false;
}

/** Called only within the existing durable initialization transaction. */
export async function initializePostgresWalletOwnerFence(client) {
  if (!client || typeof client.query !== 'function') throw fail('GLOBAL_FENCE_UNAVAILABLE');
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('bouncer-wallet-owner-fence-v1'))");
  const exists = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1', [SCHEMA]);
  if (exists.rows.length === 0) {
    // A legacy owner may have already been prompted. We cannot assign a new
    // claim or assume its absence merely because the new table is empty.
    if (await legacyTables(client)) throw fail('GLOBAL_FENCE_LEGACY_RECONCILIATION_REQUIRED');
    await client.query(`CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.meta (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),version integer NOT NULL);
      INSERT INTO ${SCHEMA}.meta(singleton,version) VALUES(true,1);
      CREATE TABLE ${SCHEMA}.holders (
        owner text PRIMARY KEY, flow text NOT NULL CHECK(flow IN ('native_oracle','buffer_wallet')),
        operation_id text NOT NULL UNIQUE, owner_public_key text NOT NULL, review_sha256 text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
      );
      CREATE FUNCTION ${SCHEMA}.guard_holder() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$${GUARD}$guard$;
      CREATE TRIGGER holder_immutable BEFORE UPDATE OR DELETE ON ${SCHEMA}.holders FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.guard_holder();`);
  }
  await verifyPostgresWalletOwnerFence(client);
}

/** Atomic with the caller's same-transaction flow reservation. */
export async function reservePostgresWalletOwnerFence(client, identity) {
  validate(identity); await verifyPostgresWalletOwnerFence(client);
  if (await legacyTables(client, identity.owner)) throw fail('GLOBAL_OWNER_FENCED');
  const result = await client.query(`INSERT INTO ${SCHEMA}.holders(owner,flow,operation_id,owner_public_key,review_sha256)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner) DO NOTHING RETURNING owner`,
  [identity.owner, identity.flow, identity.operationId, identity.ownerPublicKey, identity.reviewSha256]);
  if (result.rows.length !== 1 || result.rows[0].owner !== identity.owner) throw fail('GLOBAL_OWNER_FENCED');
}

/** Require the same owner, flow, operation, key and reviewed plan before any
 * new prompt claim. This cannot stop a client that bypasses the coordinator. */
export async function assertPostgresWalletOwnerFence(client, identity) {
  validate(identity); await verifyPostgresWalletOwnerFence(client);
  const result = await client.query(`SELECT owner,flow,operation_id,owner_public_key,review_sha256,created_at
    FROM ${SCHEMA}.holders WHERE owner=$1`, [identity.owner]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row.owner !== identity.owner || row.flow !== identity.flow || row.operation_id !== identity.operationId ||
      row.owner_public_key !== identity.ownerPublicKey || row.review_sha256 !== identity.reviewSha256 ||
      !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) throw fail('GLOBAL_OWNER_FENCED');
}
