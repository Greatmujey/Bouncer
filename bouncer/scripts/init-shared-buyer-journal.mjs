/** Explicitly register a NEW empty logical buyer journal; no payments. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openConfiguredBuyerJournal } from '../agent/shared-buyer-config.mjs';

const USAGE = `Usage: node bouncer/scripts/init-shared-buyer-journal.mjs --contract ACCOUNT.testnet --owner ACCOUNT.testnet --journal STABLE_ID --confirm-new

Registers one new, empty encrypted testnet journal. Supply
BOUNCER_BUYER_DATABASE_URL and BOUNCER_BUYER_JOURNAL_KEY_FILE securely.
Do not create a replacement for an existing file journal, uncertain payment or
lost database. This never replaces an existing journal or sends a payment.
`;
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--confirm-new' && !opts.confirm) { opts.confirm = true; continue; }
    if (['--contract', '--owner', '--journal'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !opts[arg]) {
      opts[arg] = args[++i]; continue;
    }
    throw new Error('invalid journal initialization arguments');
  }
  if (!opts.confirm || !opts['--contract'] || !opts['--owner'] || !opts['--journal']) throw new Error('contract, owner, stable journal ID and --confirm-new are required');
  return opts;
}
async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return; }
  const { journal, pool } = await openConfiguredBuyerJournal({ contractId: opts['--contract'], ownerAccountId: opts['--owner'], journalId: opts['--journal'], createNew: true });
  try { console.log('[init-shared-buyer-journal] New empty testnet journal registered; no seller or NEAR was contacted.'); }
  finally { await journal.close(); await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`[init-shared-buyer-journal] ERROR: ${error.message}`); process.exitCode = 1; });
}
