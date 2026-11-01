/** Read-only metadata inspection. No encryption key, seller, signer or NEAR. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerPoolFromEnvironment } from '../agent/shared-buyer-config.mjs';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { validBuyerIntentId } from '../shared/buyer-intent.mjs';

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

/** Locate unresolved rows across all journals for one owner, without decrypting them. */
export async function inspectSharedBuyerOwner({ pool, ownerAccountId, limit = 100, offset = 0 }) {
  if (!pool || typeof pool.connect !== 'function' || !isTestnetAccount(ownerAccountId) ||
      !Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new Error('invalid shared buyer owner inspection options');
  }
  const client = await pool.connect(); let begun = false, destroy = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const health = await client.query('SELECT pg_catalog.pg_is_in_recovery() AS replica');
    if (health.rows[0]?.replica !== false) throw new Error('inspection requires the current primary, not a replica');
    const visibility = await client.query(`SELECT t.relrowsecurity, t.relforcerowsecurity FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_buyer_v1' AND t.relname='entries' AND t.relkind='r'`);
    if (visibility.rowCount !== 1 || visibility.rows[0].relrowsecurity || visibility.rows[0].relforcerowsecurity) {
      throw new Error('owner inspection requires entries without row-level filtering');
    }
    const found = await client.query(`SELECT contract_id, journal_id, entry_id, tx_hash, seller_origin, challenge, created_at, updated_at
      FROM bouncer_buyer_v1.entries WHERE owner_account_id=$1 AND status='pending'
      ORDER BY created_at DESC, contract_id DESC, journal_id DESC, entry_id DESC LIMIT $2 OFFSET $3`,
    [ownerAccountId, limit + 1, offset]);
    await client.query('COMMIT'); begun = false;
    return { owner_account_id: ownerAccountId, offset, entries: found.rows.slice(0, limit), has_more: found.rows.length > limit,
      warning: 'Read-only metadata from one database, not proof of payment or delivery. Pages may change; preserve original pending hashes and never resend.' };
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
    throw error;
  } finally { client.release(destroy); }
}

/** Locate the original strict-intent payment, without decrypting its claim. */
export async function inspectSharedBuyerIntent({ pool, ownerAccountId, intentId }) {
  if (!pool || typeof pool.connect !== 'function' || !isTestnetAccount(ownerAccountId) || !validBuyerIntentId(intentId)) {
    throw new Error('invalid shared buyer intent inspection options');
  }
  const client = await pool.connect(); let begun = false, destroy = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    const health = await client.query('SELECT pg_catalog.pg_is_in_recovery() AS replica');
    if (health.rows[0]?.replica !== false) throw new Error('inspection requires the current primary, not a replica');
    const visibility = await client.query(`SELECT t.relrowsecurity, t.relforcerowsecurity FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='bouncer_buyer_v1' AND t.relname IN ('entries','intents') AND t.relkind='r'`);
    if (visibility.rowCount !== 2 || visibility.rows.some(row => row.relrowsecurity || row.relforcerowsecurity)) {
      throw new Error('intent inspection requires tables without row-level filtering');
    }
    const found = await client.query(`SELECT i.contract_id, i.journal_id, i.entry_id, i.tx_hash, e.status, e.seller_origin, e.challenge, e.created_at, e.updated_at
      FROM bouncer_buyer_v1.intents i LEFT JOIN bouncer_buyer_v1.entries e
        ON e.contract_id=i.contract_id AND e.owner_account_id=i.owner_account_id AND e.journal_id=i.journal_id
        AND e.entry_id=i.entry_id AND e.tx_hash=i.tx_hash
      WHERE i.owner_account_id=$1 AND i.intent_id=$2 LIMIT 2`, [ownerAccountId, intentId]);
    if (found.rows.length > 1 || (found.rows.length === 1 && !['pending', 'completed'].includes(found.rows[0].status))) {
      throw new Error('intent metadata is inconsistent; preserve original state and reconcile');
    }
    await client.query('COMMIT'); begun = false;
    return { owner_account_id: ownerAccountId, intent_id: intentId, entry: found.rows[0] ?? null,
      warning: 'Unauthenticated read-only metadata from one database, not proof of payment or non-payment. Recover the original journal and hash; never resend.' };
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
    throw error;
  } finally { client.release(destroy); }
}

const USAGE = `Usage: node bouncer/scripts/inspect-shared-buyer.mjs --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID [--limit N]
   or: node bouncer/scripts/inspect-shared-buyer.mjs --owner ACCOUNT.testnet --pending-owner [--limit N] [--offset N]
   or: node bouncer/scripts/inspect-shared-buyer.mjs --owner ACCOUNT.testnet --intent INTENT_ID

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
    if (arg === '--pending-owner' && !out.pendingOwner) { out.pendingOwner = true; continue; }
    if (['--contract', '--owner', '--journal', '--limit', '--offset', '--intent'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !out[arg]) {
      out[arg] = args[++i]; continue;
    }
    throw new Error('invalid buyer inspection arguments');
  }
  if (out['--limit']) {
    if (!/^\d+$/.test(out['--limit'])) throw new Error('invalid inspection limit');
    out.limit = Number(out['--limit']);
  }
  if (out['--intent']) {
    if (!out['--owner'] || out.pendingOwner || out['--contract'] || out['--journal'] || out['--limit'] || out['--offset']) {
      throw new Error('intent inspection requires only --owner and --intent');
    }
    return { intent: true, ownerAccountId: out['--owner'], intentId: out['--intent'] };
  }
  if (out.pendingOwner) {
    if (!out['--owner'] || out['--contract'] || out['--journal']) throw new Error('owner inspection requires only --owner and --pending-owner');
    if (out['--offset'] && !/^\d+$/.test(out['--offset'])) throw new Error('invalid inspection offset');
    return { pendingOwner: true, ownerAccountId: out['--owner'], limit: out.limit, offset: Number(out['--offset'] ?? 0) };
  }
  if (!out['--contract'] || !out['--owner'] || !out['--journal'] || out['--offset']) throw new Error('contract, owner and original journal ID are required');
  return { contractId: out['--contract'], ownerAccountId: out['--owner'], journalId: out['--journal'], limit: out.limit };
}
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const pool = buyerPoolFromEnvironment();
  try {
    const result = opts.intent ? await inspectSharedBuyerIntent({ pool, ...opts }) :
      opts.pendingOwner ? await inspectSharedBuyerOwner({ pool, ...opts }) : await inspectSharedBuyer({ pool, ...opts });
    console.log(JSON.stringify(result, null, 2));
  }
  catch { throw new Error('inspection failed; check the read-only database connection, primary and requested scope'); }
  finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[inspect-shared-buyer] ERROR: ${error.message}`); process.exitCode = 1; });
}
