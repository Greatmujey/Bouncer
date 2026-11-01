/** Read-only metadata inspection. No encryption key, seller, signer or NEAR. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerPoolFromEnvironment } from '../agent/shared-buyer-config.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';

export async function inspectSharedBuyer({ pool, contractId, ownerAccountId, journalId, limit = 100 }) {
  if (!pool || typeof pool.connect !== 'function' || !isTestnetAccount(contractId) || !isTestnetAccount(ownerAccountId) ||
      typeof journalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(journalId) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('invalid shared buyer inspection options');
  }
  const client = await pool.connect(); let begun = false, destroy = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const health = await client.query('SELECT pg_catalog.pg_is_in_recovery() AS replica');
    if (health.rows[0]?.replica !== false) throw new Error('inspection requires the current primary, not a replica');
    const scope = [contractId, ownerAccountId, journalId];
    const journal = await client.query(`SELECT journal_id FROM bouncer_buyer_v1.journals
      WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3`, scope);
    if (journal.rowCount !== 1) throw new Error('original shared buyer journal not found');
    const found = await client.query(`SELECT entry_id, status, tx_hash, seller_origin, challenge, created_at, updated_at
      FROM bouncer_buyer_v1.entries WHERE contract_id=$1 AND owner_account_id=$2 AND journal_id=$3
      ORDER BY created_at DESC, entry_id DESC LIMIT $4`, [...scope, limit + 1]);
    await client.query('COMMIT'); begun = false;
    return { contract_id: contractId, owner_account_id: ownerAccountId, journal_id: journalId,
      entries: found.rows.slice(0, limit), has_more: found.rows.length > limit,
      warning: 'Read-only metadata, not proof of payment or delivery. Preserve every pending hash; never automatically resend.' };
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
    throw error;
  } finally { client.release(destroy); }
}

const USAGE = `Usage: node bouncer/scripts/inspect-shared-buyer.mjs --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID [--limit N]

Read-only metadata from the original primary using BOUNCER_BUYER_DATABASE_URL.
No journal encryption key, signer, seller, NEAR call, reset or payment is used.
Results include public transaction hashes and seller challenges, not claims,
task contents or encrypted records. An incomplete snapshot proves nothing paid.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const out = { limit: 100 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--contract', '--owner', '--journal', '--limit'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !out[arg]) {
      out[arg] = args[++i]; continue;
    }
    throw new Error('invalid buyer inspection arguments');
  }
  if (!out['--contract'] || !out['--owner'] || !out['--journal']) throw new Error('contract, owner and original journal ID are required');
  if (out['--limit']) {
    if (!/^\d+$/.test(out['--limit'])) throw new Error('invalid inspection limit');
    out.limit = Number(out['--limit']);
  }
  return { contractId: out['--contract'], ownerAccountId: out['--owner'], journalId: out['--journal'], limit: out.limit };
}
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const pool = buyerPoolFromEnvironment();
  try { console.log(JSON.stringify(await inspectSharedBuyer({ pool, ...opts }), null, 2)); }
  catch { throw new Error('inspection failed; check the read-only database connection and original journal ID'); }
  finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[inspect-shared-buyer] ERROR: ${error.message}`); process.exitCode = 1; });
}
