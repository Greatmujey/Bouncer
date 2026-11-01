/** Privileged schema setup only; never contacts NEAR or a seller. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerPoolFromEnvironment } from '../agent/shared-buyer-config.mjs';
import { initializePostgresBuyerSchema } from '../agent/postgres-buyer-journal.mjs';

const USAGE = `Usage: node bouncer/scripts/init-shared-buyer-db.mjs --confirm-testnet-schema

Creates the experimental bouncer_buyer_v1 schema using
BOUNCER_BUYER_DATABASE_URL. Requires a privileged schema initializer role.
Does not create a journal, contact NEAR or a seller, reset state or send funds.
`;
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(USAGE); return; }
  if (args.length !== 1 || args[0] !== '--confirm-testnet-schema') throw new Error('explicit --confirm-testnet-schema is required');
  const pool = buyerPoolFromEnvironment();
  try { await initializePostgresBuyerSchema({ pool }); }
  catch { throw new Error('schema initialization failed; check permissions, existing constraints and primary health'); }
  finally { await pool.end(); }
  console.log('[init-shared-buyer-db] Testnet buyer schema ready; no journal or payment was created.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[init-shared-buyer-db] ERROR: ${error.message}`); process.exitCode = 1; });
}
