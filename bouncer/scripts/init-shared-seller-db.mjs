/** Explicit schema setup; no NEAR RPC, quotes, payments or order execution. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initializePostgresSellerSchema } from '../services/postgres-seller-store.mjs';
import { validateSellerDatabaseUrl } from '../services/shared-resource-provider.mjs';

const USAGE = `Usage: node bouncer/scripts/init-shared-seller-db.mjs --confirm-testnet-schema

Creates the versioned bouncer_seller_v3 schema if absent, using
BOUNCER_SELLER_DATABASE_URL. This requires a database role allowed to create the
schema and tables. It does not contact NEAR, send payments or delete orders.
Use a separate, less-privileged worker role after initialization.
`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 1 || args[0] !== '--confirm-testnet-schema') throw new Error('explicit --confirm-testnet-schema is required');
  const connectionString = validateSellerDatabaseUrl(process.env.BOUNCER_SELLER_DATABASE_URL);
  let pool;
  try { pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }); }
  catch { throw new Error('cannot initialize verified database TLS settings'); }
  pool.on('error', () => {});
  try { await initializePostgresSellerSchema({ pool }); }
  catch { throw new Error('schema initialization failed; check database permissions and primary health'); }
  finally { await pool.end(); }
  console.log('[init-shared-seller-db] Testnet seller schema is ready; no payment or quote was created.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[init-shared-seller-db] ERROR: ${error.message}`); process.exitCode = 1; });
}
