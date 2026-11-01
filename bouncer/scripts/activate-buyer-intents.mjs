/** Explicit, irreversible opt-in for a NEW testnet owner's business intents. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerPoolFromEnvironment } from '../agent/shared-buyer-config.mjs';
import { activateBuyerOwnerIntents } from '../agent/postgres-buyer-journal.mjs';

const USAGE = `Usage: node bouncer/scripts/activate-buyer-intents.mjs --owner ACCOUNT.testnet --confirm-new-owner

Enables strict stable business-intent IDs for one NEW testnet owner in this
PostgreSQL primary. Stop all old workers and upgrade the schema first. This
checks for existing shared entries, but cannot detect payments made through
other databases, files, protocols or direct chain calls. Do not use a new owner
or database to escape an uncertain payment. There is no automatic deactivation,
migration, payment, signing or NEAR/seller request. Use BOUNCER_BUYER_DATABASE_URL.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let owner, confirm = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--confirm-new-owner' && !confirm) { confirm = true; continue; }
    if (args[i] === '--owner' && !owner && args[i + 1] && !args[i + 1].startsWith('--')) { owner = args[++i]; continue; }
    throw new Error('invalid intent activation arguments');
  }
  if (!confirm || !owner) throw new Error('--owner and --confirm-new-owner are required');
  return { owner };
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  const pool = buyerPoolFromEnvironment();
  try { await activateBuyerOwnerIntents({ pool, ownerAccountId: options.owner }); }
  catch (error) {
    const safe = new Set(['OWNER_BUSY', 'OWNER_HAS_HISTORY', 'ALREADY_EXISTS', 'UNSAFE_SCHEMA', 'UNSAFE_DATABASE', 'DATABASE']);
    if (safe.has(error?.code)) throw error;
    throw new Error('intent activation failed; inspect the original database before continuing');
  } finally { await pool.end(); }
  console.log('[activate-buyer-intents] Strict owner intent mode activated; no seller or NEAR was contacted.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[activate-buyer-intents] ERROR: ${error.message}`); process.exitCode = 1; });
}
