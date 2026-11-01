/**
 * Shared seller-v3 order book. PostgreSQL is the coordination authority: all
 * workers must use the SAME durable primary and seller identity. This module
 * never sends a payment or retries an uncertain external side effect.
 *
 * A committed pending row has exactly one execution-token hash. The plaintext
 * token remains only in the winning worker. There is deliberately no lease
 * timeout, takeover, deletion, or automatic pending-row reset: after a
 * crash an operator must reconcile the side effect before deciding what to do.
 */
import crypto from 'node:crypto';
import { canonicalClaimOrigin } from '../packages/provider-sdk/index.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';

const RESOURCES = ['compute', 'storage', 'api'];
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const sha256 = v => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const challengePattern = /^[a-f0-9]{32}$/;
const tokenPattern = /^[a-f0-9]{64}$/;

export class SellerStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'SellerStoreError'; this.code = code; }
}
const conflict = message => new SellerStoreError('CONFLICT', message);

/** Snapshot every term. Identically named workers with different prices fail. */
export function sharedSellerConfig({ sellerId, contractId, ownerAccountId = contractId, sellerOrigin, products, maxQuotes = 10000 }) {
  if (typeof sellerId !== 'string' || !idPattern.test(sellerId) || !isTestnetAccount(contractId) || !isTestnetAccount(ownerAccountId) ||
      !exact(products, RESOURCES) || !Number.isInteger(maxQuotes) || maxQuotes < 1 || maxQuotes > 1_000_000) {
    throw new Error('invalid shared seller configuration');
  }
  canonicalClaimOrigin(sellerOrigin);
  const pinned = {};
  for (const name of RESOURCES) {
    const p = products[name];
    if (!exact(p, ['policy_id', 'token', 'payee', 'amount']) || typeof p.policy_id !== 'string' || !p.policy_id.trim() ||
        Buffer.byteLength(p.policy_id) > 128 || /[\x00-\x1f\x7f]/.test(p.policy_id) || !isTestnetToken(p.token) || !isTestnetAccount(p.payee) ||
        typeof p.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(p.amount) || BigInt(p.amount) > (1n << 128n) - 1n) {
      throw new Error(`invalid ${name} seller product`);
    }
    pinned[name] = Object.freeze({ policy_id: p.policy_id, token: p.token, payee: p.payee, amount: p.amount });
  }
  Object.freeze(pinned);
  return Object.freeze({ seller_id: sellerId, network: 'near:testnet', contract_id: contractId,
    owner_account_id: ownerAccountId, seller_origin: sellerOrigin, products: pinned, max_quotes: maxQuotes });
}

// These checks do not prove durable disks, synchronous replication, fencing or
// correct backups. They refuse a read replica or explicitly disabled fsync.
async function checkPrimary(client) {
  const result = await client.query(`SELECT pg_catalog.pg_is_in_recovery() AS replica,
    pg_catalog.current_setting('fsync') AS fsync,
    pg_catalog.current_setting('transaction_read_only') AS read_only`);
  const health = result.rows[0];
  if (!health || health.replica !== false || health.fsync !== 'on' || health.read_only !== 'off') {
    throw new SellerStoreError('UNSAFE_DATABASE', 'seller database must be a writable primary with fsync enabled');
  }
}

// Every mutation is committed synchronously before its caller can perform an
// external operation. A lost COMMIT acknowledgement is propagated, NEVER
// interpreted as permission to fulfill or automatically retry.
async function transaction(pool, run) {
  const client = await pool.connect();
  let begun = false, released = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true;
    await client.query("SET LOCAL synchronous_commit = 'on'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    await checkPrimary(client);
    const result = await run(client);
    await client.query('COMMIT'); begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { await client.query('ROLLBACK'); }
      catch { client.release(true); released = true; }
    }
    throw error;
  } finally { if (!released) client.release(); }
}

/** Explicit one-time schema setup. The worker role itself does not need DDL privileges. */
export async function initializePostgresSellerSchema({ pool }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required');
  return transaction(pool, async client => {
    // Serialize CREATE IF NOT EXISTS across simultaneous first starts. This is
    // an advisory lock only for schema creation, not for paid-order execution.
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(1702243041, 903133)');
    await client.query('CREATE SCHEMA IF NOT EXISTS bouncer_seller_v3');
    await client.query(`CREATE TABLE IF NOT EXISTS bouncer_seller_v3.meta (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL
    )`);
    await client.query('INSERT INTO bouncer_seller_v3.meta (singleton, version) VALUES (true, 1) ON CONFLICT DO NOTHING');
    const version = await client.query('SELECT version FROM bouncer_seller_v3.meta WHERE singleton = true');
    if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error('unsupported shared seller schema version');
    await client.query(`CREATE TABLE IF NOT EXISTS bouncer_seller_v3.sellers (
      seller_id text PRIMARY KEY,
      identity_hash text NOT NULL UNIQUE,
      config_hash text NOT NULL,
      config jsonb NOT NULL,
      issued_quotes integer NOT NULL DEFAULT 0 CHECK (issued_quotes >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS bouncer_seller_v3.orders (
      challenge text PRIMARY KEY CHECK (challenge ~ '^[a-f0-9]{32}$'),
      seller_id text NOT NULL REFERENCES bouncer_seller_v3.sellers(seller_id),
      resource text NOT NULL CHECK (resource IN ('compute', 'storage', 'api')),
      memo text NOT NULL UNIQUE,
      product jsonb NOT NULL,
      status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'pending', 'completed')),
      tx_hash text UNIQUE,
      agent_public_key text,
      execution_token text,
      result jsonb,
      object_id text UNIQUE,
      object_content bytea,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      started_at timestamptz,
      completed_at timestamptz,
      CHECK (
        (status = 'issued' AND tx_hash IS NULL AND agent_public_key IS NULL AND execution_token IS NULL AND result IS NULL AND started_at IS NULL AND completed_at IS NULL)
        OR (status = 'pending' AND tx_hash IS NOT NULL AND agent_public_key IS NOT NULL AND execution_token IS NOT NULL AND result IS NULL AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND tx_hash IS NOT NULL AND agent_public_key IS NOT NULL AND execution_token IS NULL AND result IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL)
      ),
      CHECK (
        (status = 'completed' AND resource = 'storage' AND object_id IS NOT NULL AND object_content IS NOT NULL)
        OR ((status <> 'completed' OR resource <> 'storage') AND object_id IS NULL AND object_content IS NULL)
      )
    )`);
    await verifyReplayIndexes(client);
  });
}

async function verifyReplayIndexes(client) {
  // CREATE TABLE IF NOT EXISTS is not evidence that a pre-existing table has
  // the replay constraints. Verify the critical, non-partial single-column
  // unique indexes before allowing initialization or worker startup.
  const indexes = await client.query(`SELECT t.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE n.nspname = 'bouncer_seller_v3' AND t.relkind = 'r'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts = 1
      AND i.indpred IS NULL AND i.indexprs IS NULL`);
  const unique = new Set(indexes.rows.map(row => `${row.table_name}.${row.column_name}`));
  if (['sellers.seller_id', 'sellers.identity_hash', 'orders.challenge', 'orders.memo', 'orders.tx_hash', 'orders.object_id']
    .some(key => !unique.has(key))) throw new Error('unsafe shared seller schema: required replay constraints are missing');
}

async function registerSeller(pool, config) {
  const configJson = JSON.stringify(config), identity = JSON.stringify([config.network, config.contract_id, config.owner_account_id, config.seller_origin]);
  return transaction(pool, async client => {
    const version = await client.query('SELECT version FROM bouncer_seller_v3.meta WHERE singleton = true');
    if (version.rows.length !== 1 || version.rows[0].version !== 1) throw new Error('unsupported shared seller schema version');
    await verifyReplayIndexes(client);
    try {
      await client.query(`INSERT INTO bouncer_seller_v3.sellers (seller_id, identity_hash, config_hash, config)
        VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (seller_id) DO NOTHING`,
      [config.seller_id, sha256(identity), sha256(configJson), configJson]);
    } catch (error) {
      if (error.code === '23505') throw conflict('seller identity already belongs to another shared seller');
      throw error;
    }
    const found = await client.query(`SELECT config_hash, config = $2::jsonb AS config_matches
      FROM bouncer_seller_v3.sellers WHERE seller_id = $1`, [config.seller_id, configJson]);
    if (found.rows.length !== 1 || found.rows[0].config_hash !== sha256(configJson) || !found.rows[0].config_matches) {
      throw conflict('shared seller configuration changed; existing orders require reconciliation');
    }
  });
}

/**
 * Open one logical seller. pool must be a node-postgres-compatible Pool; it is
 * owned and closed by the caller. Never point another store/database at the
 * same externally visible seller while outstanding quotes or payments exist.
 */
export async function openPostgresSellerStore({ pool, ...rawConfig }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool is required');
  const config = sharedSellerConfig(rawConfig);
  await registerSeller(pool, config);

  async function issue({ challenge, resource, memo, product }) {
    if (typeof challenge !== 'string' || !challengePattern.test(challenge) || !RESOURCES.includes(resource) || typeof memo !== 'string' ||
        !new RegExp(`^bouncer-order-v3:${resource}:${challenge}:[a-f0-9]{64}$`).test(memo) ||
        !exact(product, ['policy_id', 'token', 'payee', 'amount']) ||
        ['policy_id', 'token', 'payee', 'amount'].some(field => product[field] !== config.products[resource][field])) {
      throw new Error('invalid issued quote');
    }
    return transaction(pool, async client => {
      const capacity = await client.query(`UPDATE bouncer_seller_v3.sellers SET issued_quotes = issued_quotes + 1
        WHERE seller_id = $1 AND issued_quotes < $2 RETURNING issued_quotes`, [config.seller_id, config.max_quotes]);
      if (!capacity.rowCount) throw new SellerStoreError('CAPACITY', 'seller quote capacity reached; stop and reconcile, automatic eviction or resizing is not supported');
      try {
        await client.query(`INSERT INTO bouncer_seller_v3.orders (challenge, seller_id, resource, memo, product)
          VALUES ($1, $2, $3, $4, $5::jsonb)`, [challenge, config.seller_id, resource, memo, JSON.stringify(product)]);
      } catch (error) {
        if (error.code === '23505') throw new SellerStoreError('CHALLENGE_COLLISION', 'seller challenge collision');
        throw error;
      }
    });
  }

  async function find(challenge) {
    if (!challengePattern.test(challenge)) throw new Error('invalid seller challenge');
    return transaction(pool, async client => {
      const result = await client.query(`SELECT challenge, resource, memo, product, status, tx_hash, agent_public_key, result
        FROM bouncer_seller_v3.orders WHERE seller_id = $1 AND challenge = $2`, [config.seller_id, challenge]);
      return result.rows[0] ?? null;
    });
  }

  /** Called only after FINAL receipt and claim signature verification. */
  async function claim({ challenge, resource, memo, product, txHash, agentPublicKey, executionToken }) {
    if (typeof challenge !== 'string' || !challengePattern.test(challenge) || !RESOURCES.includes(resource) || typeof memo !== 'string' ||
        !exact(product, ['policy_id', 'token', 'payee', 'amount']) ||
        ['policy_id', 'token', 'payee', 'amount'].some(field => product[field] !== config.products[resource][field]) ||
        typeof txHash !== 'string' || typeof agentPublicKey !== 'string' || !tokenPattern.test(executionToken)) {
      throw new Error('invalid verified claim');
    }
    return transaction(pool, async client => {
      let result;
      try {
        result = await client.query(`UPDATE bouncer_seller_v3.orders SET status = 'pending', tx_hash = $1,
          agent_public_key = $2, execution_token = $3, started_at = clock_timestamp()
          WHERE seller_id = $4 AND challenge = $5 AND resource = $6 AND memo = $7 AND product = $8::jsonb AND status = 'issued'
          RETURNING challenge`, [txHash, agentPublicKey, sha256(executionToken), config.seller_id, challenge, resource, memo, JSON.stringify(product)]);
      } catch (error) {
        if (error.code === '23505') throw conflict('payment transaction was already claimed');
        throw error;
      }
      return result.rowCount === 1;
    });
  }

  /** Complete exactly the token returned to the winning worker; no takeover. */
  async function complete({ challenge, txHash, executionToken, result, objectId = null, objectContent = null }) {
    if (!challengePattern.test(challenge) || typeof txHash !== 'string' || !tokenPattern.test(executionToken) ||
        !result || typeof result !== 'object' || Array.isArray(result) ||
        !(objectId === null || (typeof objectId === 'string' && /^[a-f0-9]{64}$/.test(objectId))) ||
        !(objectContent === null || Buffer.isBuffer(objectContent))) throw new Error('invalid seller completion');
    return transaction(pool, async client => {
      const updated = await client.query(`UPDATE bouncer_seller_v3.orders SET status = 'completed', result = $1::jsonb,
        object_id = $2, object_content = $3, execution_token = NULL, completed_at = clock_timestamp()
        WHERE seller_id = $4 AND challenge = $5 AND tx_hash = $6 AND execution_token = $7 AND status = 'pending'
        RETURNING challenge`, [JSON.stringify(result), objectId, objectContent, config.seller_id, challenge, txHash, sha256(executionToken)]);
      if (updated.rowCount !== 1) throw conflict('paid order is not held by this worker; reconcile manually');
    });
  }

  async function storage(txHash, objectId) {
    if (typeof txHash !== 'string' || typeof objectId !== 'string' || !/^[a-f0-9]{64}$/.test(objectId)) throw new Error('invalid storage request');
    return transaction(pool, async client => {
      const result = await client.query(`SELECT challenge, resource, memo, product, status, tx_hash, agent_public_key, result, object_content
        FROM bouncer_seller_v3.orders WHERE seller_id = $1 AND tx_hash = $2 AND object_id = $3
          AND resource = 'storage' AND status = 'completed'`, [config.seller_id, txHash, objectId]);
      return result.rows[0] ?? null;
    });
  }

  /** Key-free, read-only metadata; deliberately excludes signatures, execution tokens and storage contents. */
  async function status({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid status limit');
    return transaction(pool, async client => {
      const result = await client.query(`SELECT challenge, resource, status, tx_hash, created_at, started_at, completed_at
        FROM bouncer_seller_v3.orders WHERE seller_id = $1 AND status <> 'issued'
        ORDER BY created_at DESC LIMIT $2`, [config.seller_id, limit]);
      return result.rows;
    });
  }
  return { config, issue, find, claim, complete, storage, status };
}
