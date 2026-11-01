/**
 * Read-only, key-free shared-seller inspection. This never initializes schema,
 * creates quotes, changes order state, resets pending work or contacts NEAR.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateSellerDatabaseUrl } from '../services/shared-resource-provider.mjs';

export async function inspectSharedSeller({ pool, sellerId, limit = 100, includeIssued = false }) {
  if (!pool || typeof pool.connect !== 'function' || typeof sellerId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(sellerId) || !Number.isInteger(limit) || limit < 1 || limit > 1000 ||
      typeof includeIssued !== 'boolean') throw new Error('invalid shared-seller inspection options');
  const client = await pool.connect(); let begun = false, destroyed = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const health = await client.query('SELECT pg_catalog.pg_is_in_recovery() AS replica');
    if (health.rows[0]?.replica !== false) throw new Error('inspection requires the current primary, not a replica');
    const seller = await client.query(`SELECT issued_quotes, config ->> 'max_quotes' AS max_quotes
      FROM bouncer_seller_v3.sellers WHERE seller_id = $1`, [sellerId]);
    if (seller.rowCount !== 1) throw new Error('shared seller not found');
    const rows = await client.query(`SELECT challenge, resource, status, tx_hash, created_at, started_at, completed_at
      FROM bouncer_seller_v3.orders WHERE seller_id = $1 AND ($2::boolean OR status <> 'issued')
      ORDER BY created_at DESC, challenge DESC LIMIT $3`, [sellerId, includeIssued, limit + 1]);
    await client.query('COMMIT'); begun = false;
    return { seller_id: sellerId, issued_quotes: seller.rows[0].issued_quotes,
      max_quotes: Number(seller.rows[0].max_quotes), includes_issued: includeIssued,
      has_more: rows.rows.length > limit, orders: rows.rows.slice(0, limit),
      warning: 'Read-only snapshot; an issued quote can already be paid, and pending work requires manual reconciliation. Do not resend payments.' };
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { client.release(true); destroyed = true; } }
    throw error;
  } finally { if (!destroyed) client.release(); }
}

const USAGE = `Usage: node bouncer/scripts/inspect-shared-seller.mjs --seller ID [--limit N] [--include-issued]

Reads a shared seller's redacted order status from its PostgreSQL primary using
BOUNCER_SELLER_DATABASE_URL. It never creates, changes, resets, executes or
pays an order. It does not establish whether an external side effect occurred.
Output contains transaction hashes and seller challenges but no claim signatures,
execution tokens or stored content. Use a read-only database role when possible.
`;
function options(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const result = { limit: 100, includeIssued: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('invalid inspection arguments');
    seen.add(arg);
    if (arg === '--include-issued') { result.includeIssued = true; continue; }
    if (arg === '--seller' && args[i + 1] && !args[i + 1].startsWith('--')) { result.sellerId = args[++i]; continue; }
    if (arg === '--limit' && /^\d+$/.test(args[i + 1] ?? '')) { result.limit = Number(args[++i]); continue; }
    throw new Error('invalid inspection arguments');
  }
  return result;
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const connectionString = validateSellerDatabaseUrl(process.env.BOUNCER_SELLER_DATABASE_URL);
  let pool;
  try { pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }); }
  catch { throw new Error('cannot initialize verified database TLS settings'); }
  pool.on('error', () => {});
  try { console.log(JSON.stringify(await inspectSharedSeller({ pool, ...opts }), null, 2)); }
  catch { throw new Error('inspection failed; check the read-only database connection and seller ID'); }
  finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[inspect-shared-seller] ERROR: ${error.message}`); process.exitCode = 1; });
}
