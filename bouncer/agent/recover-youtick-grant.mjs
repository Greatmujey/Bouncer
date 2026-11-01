#!/usr/bin/env node
/** Key-free testnet owner-grant reconciliation. The original encrypted file
 * journal and its key are still required; no signing key or source is loaded.
 * This never signs or broadcasts and never replaces an unknown transaction. */
import os from 'node:os';
import path from 'node:path';
import { isTestnetAccount } from '../shared/account-id.mjs';
import { openConfiguredFileJournal } from './procurement.mjs';
import { PaymentRpcProvider } from './near-account.mjs';
import { recoverYoutickPlayGrant } from './youtick-grant-runner.mjs';

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--state', '--vault', '--owner', '--grant', '--rpc'].includes(flag) || !value || value.startsWith('--') || Object.hasOwn(values, flag)) {
      throw new Error('unknown, duplicate or incomplete argument; use --help');
    }
    values[flag] = value;
  }
  if (!values['--state'] || !isTestnetAccount(values['--vault']) || !isTestnetAccount(values['--owner']) ||
      values['--vault'] === values['--owner'] || !/^[A-Za-z0-9_-]{1,64}$/.test(values['--grant'] || '')) {
    throw new Error('original journal, testnet vault, owner and grant ID are required');
  }
  if (!process.env.BOUNCER_FILE_JOURNAL_KEY_FILE) throw new Error('original BOUNCER_FILE_JOURNAL_KEY_FILE is required');
  return values;
}
function expand(file) { return path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file); }
async function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node agent/recover-youtick-grant.mjs --state ORIGINAL_JOURNAL --vault VAULT.testnet --owner OWNER.testnet --grant GRANT_ID [--rpc URL]');
    console.log('Requires BOUNCER_FILE_JOURNAL_KEY_FILE. Reads the original hash and FINAL evidence; never signs or sends.');
    return;
  }
  // Construct provider only after parsing; open strictly existing original
  // encrypted journal, never an empty replacement, before making RPC calls.
  const provider = new PaymentRpcProvider(args['--rpc'] || process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
  const journal = openConfiguredFileJournal(expand(args['--state']), args['--vault'], args['--owner'], { requireExisting: true });
  try {
    const result = await recoverYoutickPlayGrant({ journal, grantId: args['--grant'], provider });
    console.log(JSON.stringify(result, null, 2));
  } finally { journal.close(); }
}
main().catch(error => { console.error(`[recover-youtick-grant] ${String(error.message).slice(0, 1000)}`); process.exitCode = 1; });
